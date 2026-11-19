// 오늘 비서: 텔레그램으로 묻고, 답을 앱과 같은 기록에 남기고, 정한 시각에 먼저 말을 건다.
// 기록은 앱의 store.js/sync.js를 그대로 써서 폰과 같은 방식으로 합쳐진다.
import crypto from 'node:crypto';
import * as C from '../../js/core.js';
import * as GM from '../../js/game.js';
import { planPings, btn } from './planner.mjs';
import { parseMessage, findTime } from './parse.mjs';
import * as B from './brain.mjs';
import * as M from './memory.mjs';
import * as Q from './quiet.mjs';

const { MIN, HOUR } = C;
const fmt = C.fmtTime;
const AWAIT_MS = 2 * HOUR;
const PULL_EVERY = 3 * MIN;
const FRESH = 60 * 1000;

export const HELP = [
  '오늘 비서예요. 이렇게 말하면 돼요:',
  '· 코테 2문제 21시 → 오늘 핵심 + 마감 (30분 전, 마감, 지나서 물어봐요)',
  '· 끝 풀이 올림 → 끝낸 걸로 + 결과물 한 줄',
  '· 걱정: … → 주차장에 넣고 걱정 시간에 같이 봐요',
  '· 불편: … → 사장님 불편 한 줄',
  '· 약 먹었어 / 일어났어 / 나왔어 (지난 일은 시각을 붙이면 그 시각으로: 3시 10분에 약 먹었어, 10시 반에 일어났어)',
  '· 오늘 → 지금 상태',
  '· 되돌려 → 방금 남긴 기록 취소',
  '· 기억해: … → 오래 기억할 사실 (기억 = 목록, 잊어 m3 = 지우기. 두뇌 모드에서만)',
  '· 브리핑 → 날씨·일정·식단·소식 다시 보기',
  '명령: /focus 50 (집중 타이머), /stop, /pause (오늘 알림 끄기), /resume, /brief, /update (새 버전 받기)',
].join('\n');

export function newPairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// state: { owner, pairCode, offset, sent: {day: {key: ts}}, awaiting, focus, paused, routineOff: {day: 1} }
export function createBot({ store, sync, tg, llm = null, brief = null, memory = null, state, save = () => {}, now = Date.now, log = () => {}, opts = {} }) {
  const R = () => store.config().prefs?.rollover ?? 4;
  const today = () => C.dayKey(now(), R());
  let lastPull = 0;
  state.sent ||= {};
  state.routineOff ||= {};
  state.q ||= {};

  // ----- 동기화 -----
  async function pull(force = false) {
    if (!force && now() - lastPull < FRESH) return;
    lastPull = now();
    await sync.syncNow({ pull: true });
  }
  const push = () => sync.syncNow({ pull: false }).catch(e => log('sync', e?.message));

  // 주고받은 말을 남긴다: 최근 대화(AI가 앞뒤를 알게)와 그날 대화(밤 정리 재료, 기억을 쓸 때만)
  // 이 대화는 AI에게 보낼 때만 쓰므로 약 이름을 가려서 남긴다 (나중에 약 항목 이름을 바꿔도 예전 이름이 새지 않게).
  // 캘린더 알림의 장소 줄은 뺀다
  function note(who, text) {
    const s = B.redact(String(text || '').replace(/\n📍[^\n]*/g, ''), masksFor(today()));
    B.remember(state, who, s, now());
    if (memory) M.logDay(state, today(), who, s, now());
  }
  // 약 이름 가리개: 지금 약 항목 + 예전에 가렸던 말 (state.maskTerms에 쌓아 둔다)
  function masksFor(key) {
    const masks = B.medMasks(medList(key));
    state.maskTerms ||= {};
    for (const m of masks) for (const t of m.terms) state.maskTerms[t] = m.label;
    // 어느 약 항목에도 안 묶인 약 이름, 지운 약 항목의 이름·별명도 "[약]"으로 가린다
    const generic = [];
    for (const d of store.meds() || []) generic.push(...String(d.name || '').split(/[\s·,()+/]+/));
    for (const i of store.config().items || []) {
      if (i.cat !== 'med') continue;
      generic.push(...String(i.name || '').split(/[\s·,()+/]+/).filter(w => !GENERIC_MED.test(w)), ...(i.aliases || []).map(String));
    }
    for (const w of generic) if (w.length >= 2 && !/^\d+(?:\.\d+)?(?:mg)?$/i.test(w) && !state.maskTerms[w]) state.maskTerms[w] = '약';
    return B.withPast(masks, state.maskTerms);
  }

  // ----- 보내기 -----
  // 보낸 말은 최근 대화로 남긴다 (AI가 "지금 일어난 건 아니고" 같은 말을 앞뒤 맥락으로 알아듣게)
  async function say(text, buttons, o) {
    if (!state.owner) return null;
    const r = await tg.send(state.owner, text, buttons, o);
    if (!o?.private) note('bot', text); // 위기 답장 같은 건 AI에게 갈 대화에 남기지 않는다
    return r;
  }
  // 아침 브리핑: 하루 한 번 (달라고 하면 언제든). 만들다 실패하면 조용히 넘어가고 다음에 다시 한다
  async function sendBrief(key, { asked = false } = {}) {
    if (!brief || !state.owner) return asked ? say('브리핑이 꺼져 있어요.') : null;
    if (!asked && (state.sent[key]?.brief || !brief.enabled() || now() - (state.briefTry || 0) < 5 * MIN)) return null;
    state.briefTry = now(); // 실패해도 5분에 한 번만 다시 해 본다
    state.sent[key] = { ...(state.sent[key] || {}), brief: now() }; // 만드는 동안 두 번 보내지 않게 먼저 표시
    save();
    try {
      const text = await brief.build(key);
      await say(text, undefined, { html: true });
    } catch (e) {
      log('brief', e?.message);
      if (!asked) delete state.sent[key].brief;
      else await say('브리핑을 만들지 못했어요. 잠시 뒤에 다시 해 주세요.');
      save();
    }
  }
  function setAwait(a) {
    state.awaiting = a ? { ...a, until: now() + AWAIT_MS } : null;
    save();
  }
  const awaiting = () => (state.awaiting && state.awaiting.until > now() ? state.awaiting : null);
  // 답장에 붙일 버튼 (apply·logMed가 정하고, 보낼 때 한 번 쓴다)
  let replyButtons = null;
  const takeButtons = () => {
    const b = replyButtons;
    replyButtons = null;
    return b || undefined;
  };
  // 약 알림이 기다리는 답은 따로 둔다 (다른 질문을 덮어쓰지 않게)
  const doseAwait = () => (state.doseAwait && state.doseAwait.until > now() ? state.doseAwait : null);
  const clearDose = id => {
    if (state.doseAwait && (!id || state.doseAwait.item === id)) {
      state.doseAwait = null;
      save();
    }
  };

  // ----- 읽기 도우미 -----
  const items = (key = today()) => C.activeItems(store.config(), key);
  const itemById = (id, key) => items(key).find(i => i.id === id);
  const game = () => store.game();
  const routineSteps = key => GM.routineState(GM.routineFor(game()?.routine, key), store.day(key), { focusOn: !!state.focus });
  const outStepId = () => game()?.routineGo?.step || 'out';
  const hasEv = (key, id) => C.live(store.day(key)).some(e => e.item === id);
  // 메시지에서 약을 알아보는 말: 항목 이름에서 흔한 말(아침·오후·약…)을 뺀 것 + 연결된 약 이름. 기기 밖으로 보내지 않는다
  const GENERIC_MED = /^(?:아침|오전|오후|점심|저녁|밤|낮|자기|자기전|전|후|약|알약|\d+시|\d+mg)$/i;
  function medList(key) {
    const drugs = store.meds() || [];
    const day = store.day(key);
    return items(key)
      .filter(i => i.cat === 'med' && i.type === 'check')
      .map(i => {
        const words = new Set();
        for (const w of String(i.name || '').split(/[\s·,()+/]+/)) if (w.length >= 2 && !GENERIC_MED.test(w)) words.add(w);
        for (const d of i.drugs || []) for (const w of String(drugs.find(x => x.id === d.id)?.name || '').split(/\s+/)) if (w.length >= 2) words.add(w);
        for (const a of i.aliases || []) if (a) words.add(String(a));
        return { id: i.id, name: i.name, block: i.block, words: [...words], taken: C.itemState(day, i).count > 0 };
      });
  }

  // ----- 행동 -----
  function startFocus(min, key = today()) {
    const m = Math.max(1, Math.min(180, Math.round(+min || 25)));
    const prev = state.focus ? endFocus() : null; // 돌던 타이머는 한 만큼 먼저 남긴다
    const open = C.top3Of(store.day(key)).filter(t => !t.done).sort((a, b) => (a.due || Infinity) - (b.due || Infinity))[0];
    state.focus = { start: now(), dur: m, label: open?.text || '', t3: open?.id || '' };
    save();
    return `${prev ? `⏱️ 앞 집중 ${prev.min}분은 남겼어요.\n` : ''}⏱️ ${m}분 시작! ${fmt(now() + m * MIN)}에 알려 드릴게요.${open ? ` (${open.text})` : ''} 폰은 뒤집어 두세요.`;
  }
  function endFocus(key) {
    const fx = state.focus;
    if (!fx) return null;
    state.focus = null;
    const min = Math.max(1, Math.round(Math.min(now() - fx.start, fx.dur * MIN) / MIN));
    const ev = store.logEvent(key || C.dayKey(fx.start, R()), 'focus', { t: fx.start, min, note: fx.label || undefined, autoWake: true });
    save();
    push();
    return { ev, min, key: key || C.dayKey(fx.start, R()) };
  }

  function setTop3(text, due, key) {
    const day = store.day(key);
    const list = C.top3Of(day);
    const same = list.find(t => t.text === text && !t.done);
    const id = same?.id || ['t1', 't2', 't3'].find(x => !list.some(t => t.id === x));
    if (!id) return { error: '핵심 3가지가 꽉 찼어요. 하나를 끝내거나 앱에서 비우고 다시 보내 주세요.' };
    // 같은 일을 다시 말했는데 새 마감이 없으면 기존 마감을 건드리지 않는다
    if (same && !due) return { id, kept: !!same.due };
    store.setTop3(key, id, { text, due: due || 0, done: 0 });
    push();
    return { id };
  }

  // 행동 목록을 기록에 반영하고, 사용자에게 보낼 답을 만든다
  // 되돌리기: 기록을 바꾼 행동마다 바꾸기 전 모습을 셋까지 남긴다 (오늘과 내일)
  function undoLast() {
    const u = (state.undo || []).pop();
    save();
    if (!u || now() - u.at > 6 * HOUR) return '되돌릴 기록이 없어요.';
    let n = 0;
    for (const [k, d] of Object.entries(u.days)) n += B.revert(store, k, d.before, d.after);
    if (u.routineOff !== undefined) {
      if (u.routineOff) state.routineOff[u.key] = 1;
      else delete state.routineOff[u.key];
      n++;
    }
    // 그 행동이 걸어 둔 질문과 타이머도 되돌린다 (그 뒤로 바뀌지 않았을 때만)
    if (u.await && state.awaiting && state.awaiting.kind === u.await.kind && (state.awaiting.id || '') === (u.await.id || '') && (state.awaiting.ev || '') === (u.await.ev || '')) setAwait(null);
    if (u.focus && JSON.stringify(state.focus || null) === JSON.stringify(u.focus.after)) {
      const b = u.focus.before;
      state.focus = b && b.start + b.dur * MIN > now() ? b : null;
      n++;
    }
    const stored = Object.keys(u.days).length;
    if (stored) push();
    save();
    return n ? `↩️ 되돌렸어요: ${u.what}` : '되돌릴 기록이 없어요.';
  }
  // apply를 거치지 않고 기록을 바꾼 뒤(버튼, /focus, 타이머 끝)에는 되돌리기 목록을 비운다 (엉뚱한 옛 기록을 되돌리지 않게)
  function forgetUndo() {
    if (state.undo?.length) state.undo = [];
  }

  async function apply(actions, { llmReply = '' } = {}) {
    const key = today();
    const lines = [];
    let nextAwait = null;
    const keys = [key, C.addDays(key, 1)];
    // 되돌리기가 섞여 있으면 먼저 한다. 그 뒤의 행동은 새 기록으로 남아 다시 되돌릴 수 있다
    for (const a of actions.filter(x => x.type === 'undo')) {
      // AI가 고른 되돌리기는 방금(10분 안) 남긴 기록에만 (몇 시간 전 약 기록을 지우지 않게)
      const last = (state.undo || []).at(-1);
      lines.push(a.recent && !(last && now() - last.at < 10 * MIN) ? '되돌릴 최근 기록이 없어요. 지울 기록을 말해 주세요.' : undoLast());
    }
    actions = actions.filter(x => x.type !== 'undo');
    const before = Object.fromEntries(keys.map(k => [k, B.snapshot(store.day(k))]));
    const routineBefore = !!state.routineOff[key];
    const focusBefore = state.focus ? { ...state.focus } : null;
    const firstLine = lines.length;
    for (const a of actions) {
      if (a.type === 'park') {
        // 앱에 주차장 항목이 없어도 기록은 남긴다 (항목이 생기면 앱에도 보인다)
        store.logEvent(key, 'park', { note: a.note, autoWake: true });
        push();
        lines.push('🅿️ 주차장에 넣었어요. 걱정 시간에 같이 봐요. 지금은 하던 거로 돌아가요.');
      } else if (a.type === 'note') {
        const it = itemById(a.item, key);
        if (!it) {
          lines.push('그 항목을 앱 설정에서 찾지 못했어요.');
          continue;
        }
        if (it.cat === 'med') {
          lines.push(logMed(key, it.id, a.at));
          continue;
        }
        if (it.type === 'check' && C.itemState(store.day(key), it).count) {
          lines.push(`${it.name}은 이미 기록돼 있어요.`);
          continue;
        }
        const t = a.at && a.at <= now() ? a.at : undefined;
        store.logEvent(key, it.id, { t, note: a.note || undefined, autoWake: true });
        push();
        const n = C.live(store.day(key)).filter(e => e.item === it.id).length;
        lines.push(`${it.icon || '📝'} ${it.name}${t ? ` ${fmt(t)}로` : ''} 남겼어요 (오늘 ${n}번째).`);
      } else if (a.type === 'focus_start') {
        lines.push(startFocus(a.min, key));
      } else if (a.type === 'focus_stop') {
        const r = endFocus();
        lines.push(r ? `⏱️ ${r.min}분 집중으로 남겼어요.` : '돌아가는 집중 타이머가 없어요.');
        if (r) nextAwait = { kind: 'fnote', ev: r.ev.id, key: r.key };
      } else if (a.type === 'routine') {
        if (a.on) delete state.routineOff[key];
        else state.routineOff[key] = 1;
        save();
        lines.push(a.on ? '🔔 오늘 아침 루틴 알림을 다시 켰어요.' : '🔕 오늘 아침 루틴 알림은 그만할게요.');
      } else if (a.type === 'top3_set') {
        const k = a.key || key;
        let due = a.due || 0;
        if (!due && a.dueText) due = findTime(a.dueText, { now: now(), key: k, rollover: R() })?.at || 0;
        if (due && due <= now() && k === key) {
          lines.push(`${fmt(due)}는 이미 지났어요. 마감 몇 시로 할까요?`);
          const r = setTop3(a.text, 0, k);
          if (r.id) nextAwait = { kind: 'due', id: r.id };
          continue;
        }
        const r = setTop3(a.text, due, k);
        if (r.error) {
          lines.push(r.error);
          continue;
        }
        if (r.kept) {
          lines.push(`"${a.text}"은 이미 있어요. 마감은 그대로 둘게요.`);
          continue;
        }
        if (due) lines.push(`🎯 ${k !== key ? '내일 ' : ''}"${a.text}" ${fmt(due)} 마감으로 잡았어요. 30분 전에 알려 드릴게요.`);
        else {
          lines.push(`🎯 ${k !== key ? '내일 ' : ''}"${a.text}" 넣었어요. 마감 몇 시로 할까요? (예: 21시)`);
          if (k === key) nextAwait = { kind: 'due', id: r.id };
        }
      } else if (a.type === 'top3_due') {
        const t = C.top3Of(store.day(key)).find(x => x.id === a.id);
        if (!t) continue;
        if (a.due <= now()) {
          // 두 번째도 지난 시각이면 더 묻지 않는다 (같은 질문을 계속 되풀이하지 않게)
          if ((a.n || 0) >= 1) {
            if (t.due) {
              store.setTop3(key, a.id, { due: 0 });
              push();
            }
            lines.push(`${fmt(a.due)}도 이미 지났어요. "${t.text}" 마감은 비워 둘게요.`);
            continue;
          }
          lines.push(`${fmt(a.due)}는 이미 지났어요. 다른 시각으로 보내 주세요. (그만하려면 "취소")`);
          nextAwait = { kind: 'due', id: a.id, n: (a.n || 0) + 1 };
          continue;
        }
        store.setTop3(key, a.id, { due: a.due });
        push();
        lines.push(`⏰ "${t.text}" ${fmt(a.due)} 마감. 30분 전에 알려 드릴게요.`);
      } else if (a.type === 'top3_done') {
        const open = C.top3Of(store.day(key)).filter(t => !t.done).sort((x, y) => (x.due || Infinity) - (y.due || Infinity));
        const t = (a.id && C.top3Of(store.day(key)).find(x => x.id === a.id)) || open[0];
        if (!t) {
          lines.push('끝낼 핵심이 없어요. "코테 2문제 21시"처럼 먼저 정해요.');
          continue;
        }
        // t는 저장소 안의 그 객체라 setTop3 뒤엔 done이 바뀐다. 먼저 기억해 둔다
        const wasDone = !!t.done;
        const patch = { out: a.out || t.out || '' };
        if (!wasDone) patch.done = now();
        store.setTop3(key, t.id, patch);
        push();
        if (a.out) lines.push(`✅ 끝! "${t.text}" → ${a.out}`);
        else {
          lines.push(`✅ 끝! "${t.text}" 결과물 한 줄 남길래요? 답장으로 보내 주세요.`);
          nextAwait = { kind: 'out', id: t.id };
        }
        if (t.to && !wasDone) lines.push(`📨 ${t.to}에게 보고: "${t.text} 끝냈어요${a.out ? ` (${a.out})` : ''}"`);
      } else if (a.type === 'wake') {
        const day = store.day(key), w = C.wakeOf(day);
        if (a.at) {
          const t = Math.min(a.at, now());
          const manual = w && !day.wake?.auto;
          // 직접 남긴 기상 시각을 그냥 말로 바꾸지는 않는다 ("아기 6시에 깼어" 같은 말일 수 있으니 한 번 묻는다)
          if (manual && !a.fix && Math.abs(w - t) > 10 * MIN) {
            lines.push(`☀️ 기상을 ${fmt(w)} → ${fmt(t)}로 고칠까요? 맞으면 "응"이라고 보내 주세요.`);
            nextAwait = { kind: 'wake_confirm', at: t };
            continue;
          }
          // 지난 시각으로 남기거나 고친다. 한 시간 넘게 지났으면 아침 루틴 알림은 그날 쉰다 (지난 단계를 몰아서 묻지 않게)
          store.setWake(key, t);
          push();
          const was = manual && Math.abs(w - t) >= MIN ? ` (${fmt(w)} → ${fmt(t)})` : '';
          if (now() - t > HOUR) {
            state.routineOff[key] = 1;
            save();
            lines.push(`☀️ 기상 ${fmt(t)}로 남겼어요${was}. 지난 아침 루틴 알림은 오늘은 쉴게요. (다시 켜려면 /resume)`);
          } else {
            if (state.routineOff[key]) {
              delete state.routineOff[key];
              save();
            }
            lines.push(`☀️ 기상 ${fmt(t)}로 남겼어요${was}. ${nextStepText(key)}`.trim());
          }
        } else if (w && !day.wake?.auto) lines.push(`☀️ 이미 ${fmt(w)}에 일어난 걸로 돼 있어요. 다른 시각이면 "10시에 일어났어"처럼 보내 주세요.`);
        else {
          store.setWake(key, now());
          push();
          lines.push(`☀️ ${fmt(now())} 기상. ${nextStepText(key)}`.trim());
          // 일어나는 목표 시각보다 2시간 넘게 지나서 눌렀으면, 더 일찍 일어났는데 이제 누른 건지 묻는다
          const plan = GM.isWeekend(key) ? opts.wakeWeekend : opts.wakeWeekday;
          if (plan && now() - C.tsFor(key, plan, R()) > 2 * HOUR) {
            lines.push('더 일찍 일어났으면 몇 시였는지 보내 주세요 (예: 10시 반). 그 시각으로 고칠게요.');
            nextAwait = { kind: 'wake_at' };
          }
        }
      } else if (a.type === 'wake_ask') {
        lines.push('몇 시쯤 일어났어요? (예: 10시 반) 그 시각으로 고칠게요.');
        nextAwait = { kind: 'wake_at' };
      } else if (a.type === 'cancel') {
        lines.push('알겠어요. 그 질문은 넘길게요.');
      } else if (a.type === 'out') {
        lines.push(markStep(key, outStepId(), a.at));
      } else if (a.type === 'med') {
        lines.push(logMed(key, a.item, a.at));
        clearDose(a.item);
      } else if (a.type === 'focus_note') {
        if (a.ev && a.key) {
          store.updateEvent(a.key, a.ev, { note: a.note });
          push();
          lines.push('⏱️ 집중 기록에 남겼어요.');
        }
      } else if (a.type === 'status') {
        lines.push(statusText(key));
      }
    }
    if (llmReply) lines.push(llmReply);
    // 주차장·상태 보기만 한 경우엔 기다리던 질문을 지우지 않는다
    // (약 기록은 다른 질문의 답이 아니다. 약 알림의 답은 따로 기다린다)
    if (nextAwait || actions.some(a => !['park', 'status', 'med'].includes(a.type))) setAwait(nextAwait);
    // 기록이 바뀌었으면 되돌릴 수 있게 바꾸기 전 모습을 남긴다
    {
      const days = Object.fromEntries(keys.filter(k => B.changed(before[k], store.day(k))).map(k => [k, { before: before[k], after: B.snapshot(store.day(k)) }]));
      const routineChanged = routineBefore !== !!state.routineOff[key];
      const focusAfter = state.focus ? { ...state.focus } : null;
      const focusChanged = JSON.stringify(focusBefore) !== JSON.stringify(focusAfter);
      if (Object.keys(days).length || routineChanged || focusChanged) {
        const what = (lines[firstLine] || '').replace(/\n[\s\S]*/, '').slice(0, 60);
        state.undo = [...(state.undo || []), { at: now(), key, days, routineOff: routineChanged ? routineBefore : undefined, await: nextAwait || undefined, focus: focusChanged ? { before: focusBefore, after: focusAfter } : undefined, what }].slice(-3);
        save();
      }
    }
    return lines.filter(Boolean).join('\n');
  }

  function nextStepText(key) {
    const next = routineSteps(key).find(s => !s.done);
    const w = C.wakeOf(store.day(key));
    if (!next) return '';
    return `다음: ${next.icon ? `${next.icon} ` : ''}${next.text}${next.min != null && w ? ` (${fmt(w + next.min * MIN)}까지)` : ''}`;
  }

  function markStep(key, stepId, at = 0) {
    const id = `rt:${stepId}`;
    let t = at && at <= now() ? at : now();
    const ev = C.live(store.day(key)).find(e => e.item === id);
    if (!ev) {
      store.logEvent(key, id, { t, autoWake: true });
      push();
    } else if (at && Math.abs(ev.t - t) > 2 * MIN) {
      // 이미 눌렀는데 시각을 말하면 그 시각으로 고친다
      store.updateEvent(key, ev.id, { t });
      push();
    } else t = ev.t;
    const day = store.day(key), w = C.wakeOf(day);
    if (stepId === outStepId()) {
      const go = game()?.routineGo;
      const mins = w ? Math.round((t - w) / MIN) : null;
      const goal = go ? go.min || 60 : null;
      const diff = mins != null && goal ? mins - goal : null;
      return `🚪 출발 ${fmt(t)}${mins != null ? ` · 일어나고 ${mins}분` : ''}${diff != null ? (diff <= 0 ? ` (목표보다 ${-diff}분 빨라요!)` : ` (목표보다 ${diff}분 늦었어요)`) : ''}`;
    }
    const s = routineSteps(key).find(x => x.id === stepId);
    return `✅ ${s ? s.text : '했어요'}. ${nextStepText(key)}`.trim();
  }

  // 약 기록. at이 있으면 그 시각으로 (이미 기록돼 있으면 시각만 고친다)
  function logMed(key, id, at = 0) {
    const day = store.day(key);
    const meds = items(key).filter(i => i.cat === 'med' && i.type === 'check');
    let it = id ? meds.find(i => i.id === id) : null;
    const t = at && at <= now() ? at : now();
    if (!it) {
      // 어느 약인지 말하지 않았으면:
      // 시각을 말했고 그때(아침·낮·자기 전)의 약이 이미 기록돼 있으면 그 약의 시각 고치기 →
      // 지금 먹을 때인 약 → 그 시각이 속한 때의 안 먹은 약 → 안 먹은 약이 하나뿐이면 그 약. 그래도 모르면 묻는다
      const open = meds.filter(i => !C.itemState(day, i).count && !C.itemState(day, i).skipped);
      const block = C.blockAt(day, t);
      it = (at && meds.find(i => C.itemState(day, i).count && i.block === block)) ||
        open.find(i => ['due', 'overdue'].includes(C.doseState(i, day, { now: t, rollover: R() }).kind)) ||
        open.find(i => i.block === block) ||
        (open.length === 1 ? open[0] : null);
      if (!it && open.length > 1) {
        replyButtons = [open.map(i => btn(`💊 ${i.name}`, `medat:${i.id}:${Math.round(t / 1000)}`))];
        return `💊 ${fmt(t)}에 먹은 약이 어느 거예요?`;
      }
    }
    if (!it) return '💊 오늘 약은 다 기록돼 있어요.';
    const st = C.itemState(day, it);
    if (st.count) {
      const { id: evId, t: was } = st.evs[0];
      if (at && Math.abs(was - t) > 2 * MIN) {
        store.updateEvent(key, evId, { t });
        push();
        return `💊 ${it.name} 시각을 ${fmt(was)} → ${fmt(t)}로 고쳤어요.`;
      }
      return `💊 ${it.name}은 이미 ${fmt(st.last)}에 기록돼 있어요.`;
    }
    if (st.skipped) store.setSkip(key, it.id, false);
    store.logEvent(key, it.id, { t, autoWake: true });
    push();
    return `💊 ${it.name} ${fmt(t)} 기록했어요.`;
  }

  function statusText(key) {
    const day = store.day(key), w = C.wakeOf(day);
    const out = [`📋 ${C.fmtDate(key)} ${fmt(now())}`];
    const steps = routineSteps(key);
    if (w) out.push(`☀️ 기상 ${fmt(w)}${steps.length ? ` · 아침 루틴 ${steps.filter(s => s.done).length}/${steps.length}` : ''}`);
    for (const t of C.top3Of(day)) {
      const due = t.due ? (t.done ? ` (${fmt(t.due)} 마감)` : t.due > now() ? ` (${fmt(t.due)} 마감 · ${C.fmtDur((t.due - now()) / MIN)} 남음)` : ` (${fmt(t.due)} 마감 지남)`) : '';
      out.push(`${t.done ? '✅' : '🎯'} ${t.text}${due}${t.out ? ` → ${t.out}` : ''}`);
    }
    const meds = items(key).filter(i => i.cat === 'med' && i.type === 'check');
    if (meds.length) out.push(`💊 ${meds.map(i => { const s = C.itemState(day, i); return `${i.name} ${s.count ? `✓ ${fmt(s.last)}` : s.skipped ? '건너뜀' : '·'}`; }).join(' / ')}`);
    const focusMin = C.live(day).filter(e => e.item === 'focus').reduce((a, e) => a + (e.min || 0), 0);
    if (focusMin) out.push(`⏱️ 집중 ${C.fmtDur(focusMin)}`);
    if (state.focus) out.push(`⏱️ 지금 집중 중 · ${fmt(state.focus.start + state.focus.dur * MIN)}에 끝나요`);
    if (state.paused === key) out.push('🔕 오늘 먼저 말 걸기는 꺼져 있어요 (/resume)');
    return out.join('\n');
  }

  // ----- 받은 메시지 -----
  async function onText(text) {
    const t = String(text || '').trim();
    const key = today();
    state.hold = 0; // 내가 말했으니 밀어 둔 알림을 다시 보낸다
    const cmd = t.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (cmd) {
      const [, c, arg = ''] = cmd;
      if (c === 'start' || c === 'help') return say(HELP);
      if (c === 'today') return say(statusText(key));
      if (c === 'focus') {
        forgetUndo();
        return say(startFocus(parseInt(arg, 10) || 25, key));
      }
      if (c === 'stop') {
        forgetUndo();
        const r = endFocus();
        return say(r ? `⏱️ ${r.min}분 집중으로 남겼어요.` : '돌아가는 집중 타이머가 없어요.');
      }
      if (c === 'pause') {
        state.paused = key;
        save();
        return say('🔕 오늘은 먼저 말 걸지 않을게요. 내일 아침에 다시 켜져요. (/resume)');
      }
      if (c === 'brief') return sendBrief(key, { asked: true });
      if (c === 'update') {
        if (!opts.requestUpdate) return say('자동 업데이트 없이 켜져 있어요. install.cmd를 다시 실행하면 켜져요.');
        opts.requestUpdate();
        return say(`새 버전이 있는지 볼게요.${opts.version?.() ? ` (지금 ${opts.version()})` : ''}`);
      }
      if (c === 'resume') {
        state.paused = null;
        delete state.routineOff[key];
        state.rest = null;
        state.hold = 0;
        Q.unmute(state.q);
        save();
        return say('🔔 다시 챙길게요.');
      }
      return say(HELP);
    }
    if (/^(?:오늘\s*)?브리핑[!.?]*$/.test(t)) return sendBrief(key, { asked: true });
    // 위기 신호는 AI에게 보내지 않고 정해진 글로 답한다. 그날 먼저 말 걸기는 멈춘다
    if (B.isCrisis(t)) {
      state.paused = key;
      save();
      return say(B.CRISIS_REPLY, undefined, { private: true });
    }
    // 되돌리기: "되돌려", "방금 거 취소". 그냥 "취소"는 기다리던 질문이 없고 10분 안에 남긴 기록이 있을 때만 되돌리기
    const lastUndo = (state.undo || []).at(-1);
    if (/^(?:되돌려|되돌리기|되돌려\s*줘|방금\s*(?:거|것|기록)\s*(?:취소|지워)|그거\s*(?:취소|지워)|undo)[!.~]*$/i.test(t) || (/^취소[!.~]*$/.test(t) && !awaiting() && !doseAwait() && !state.focus && lastUndo && now() - lastUndo.at < 10 * MIN)) {
      note('me', t);
      await pull(true).catch(() => {}); // 그 사이 폰에서 고친 기록을 덮지 않게 먼저 받아 온다
      return say(undoLast());
    }
    // 기억: "기억해: …"로 넣고, "기억"으로 보고, "잊어 m3"으로 지운다 (비공개 저장소의 brain/memory.md)
    const mem = t.match(/^기억해(?:\s*줘)?\s*[:：]\s*([\s\S]{2,})$/); // 쌍점이 있어야 ("기억해줘서 고마워"를 기억으로 넣지 않게)
    const forget = t.match(/^(?:잊어|잊어\s*줘|기억\s*지워)\s*[:：]?\s*\[?(m\d+)\]?$/i);
    if (mem || forget || /^(?:\/memory|기억|기억\s*보여\s*줘)$/.test(t)) {
      if (!memory) return say('기억은 두뇌 모드(Claude)에서만 써요.');
      note('me', t);
      try {
        if (mem) {
          const r = await memory.add(mem[1], key);
          const f = r.applied.find(a => a.op === 'add');
          const out = r.applied.find(a => a.full);
          return say(f ? `🧠 기억했어요 [${f.id}]: ${f.text}${out ? `\n(꽉 차서 가장 오래된 [${out.id}] "${out.was}"는 뺐어요)` : ''}` : '이미 기억하고 있어요.');
        }
        if (forget) {
          const r = await memory.forget(forget[1].toLowerCase(), key);
          return say(r.applied.length ? `🧠 지웠어요: ${r.applied[0].was}` : '그 번호의 기억이 없어요. "기억"이라고 보내면 목록을 보여 드려요.');
        }
        await memory.load(C.addDays(key, -1), true);
        const facts = memory.facts();
        return say(facts.length ? `🧠 기억하는 것 (${facts.length})\n${facts.map(f => `[${f.id}] ${f.text}`).join('\n')}\n\n지우려면 "잊어 m번호"` : '아직 기억해 둔 게 없어요. "기억해: …"로 넣을 수 있어요.');
      } catch (e) {
        log('memory', e?.message);
        return say(e?.message || '기억 파일을 다루지 못했어요.');
      }
    }
    await pull().catch(() => {});
    const ctx = { now: now(), key, rollover: R(), awaiting: awaiting(), dose: doseAwait(), meds: medList(key) };
    note('me', t); // 내 말 (AI에게 보낼 땐 "새 메시지"로 따로 붙인다)
    save();
    let parsed = null;
    let llmReply = '';
    // 머리말(걱정:, 불편:)과 "오늘"은 규칙이 바로 받는다
    const fixed = /^(?:걱정|주차장?|🅿️|🅿|불편)\s*[:：]|^(?:오늘\s*(?:어때|상태)?|상태|뭐\s*남았|남은\s*거)[?？]?$/.test(t) ? parseMessage(t, ctx) : null;
    // 비서가 물어본 질문의 답(메모·결과물·집중 메모·기상 시각·고칠지 여부·약)은 규칙이 먼저 받는다. 아니면 AI에게
    const answer = !fixed && llm?.full && (ctx.awaiting || ctx.dose) ? parseMessage(t, { ...ctx, onlyAnswers: true }) : null;
    if (fixed) parsed = fixed;
    else if (answer) parsed = answer;
    else if (llm?.full) {
      // 두뇌 모드: 모든 말을 AI가 먼저 읽는다 (오늘 상태 + 최근 대화, 약 이름은 가려서)
      try {
        const r = await askBrain(t, ctx);
        // AI 답을 못 읽었거나, 하려던 행동이 검사에서 다 버려졌으면 규칙으로 다시 풀어 본다
        // (AI가 일부러 아무것도 안 한 것은 그대로 둔다. 규칙이 대신 기록하지 않는다)
        const lost = !r || (!r.actions.length && r.dropped > 0);
        const byRule = lost ? parseMessage(t, ctx) : null;
        if (byRule) parsed = byRule;
        else if (r) {
          parsed = { actions: r.actions };
          llmReply = r.reply;
          if (ctx.awaiting && !r.actions.length) setAwait(null);
        } else if (ctx.awaiting) setAwait(null);
      } catch (e) {
        log('llm', e?.message);
        parsed = parseMessage(t, ctx); // AI가 안 되면 규칙으로
        if (!parsed) return say(`${e?.message || 'AI가 답하지 못했어요'}. 규칙으로도 못 알아들었어요.\n\n${HELP}`);
      }
    } else {
      parsed = parseMessage(t, ctx);
      // 기다리던 답이 아니면 그 질문은 놓아준다 (2시간 동안 엉뚱한 말을 그 답으로 잡지 않게)
      if (!parsed && ctx.awaiting) setAwait(null);
      if (!parsed && llm) {
        try {
          const day = store.day(key);
          const masks = masksFor(key); // 기본 모드에서도 약 이름은 가려서 보낸다
          const r = unmaskActions(await llm.parse(B.redact(t, masks), {
            key,
            now: now(),
            rollover: R(),
            nowText: `${C.fmtDate(key)} ${fmt(now())}`,
            items: items(key).filter(i => i.cat !== 'med').map(i => ({ id: i.id, name: i.name })), // 약 항목은 AI에게 보내지 않는다
            top3: C.top3Of(day).map(x => ({ id: x.id, text: B.redact(x.text, masks), due: x.due ? fmt(x.due) : '', done: !!x.done })),
          }), masks, t);
          if (r) {
            parsed = { actions: r.actions };
            llmReply = r.reply;
          }
        } catch (e) {
          log('llm', e?.message);
          return say(`${e?.message || 'AI가 답하지 못했어요'}\n\n${HELP}`);
        }
      }
    }
    if (!parsed) return say(`잘 못 알아들었어요.\n\n${HELP}`);
    const reply = await apply(parsed.actions, { llmReply });
    await say(reply || llmReply || '알겠어요.', takeButtons());
    if (parsed.actions.some(a => a.type === 'wake')) await sendBrief(today()); // 일어났다고 하면 바로 브리핑
  }

  // 두뇌 모드의 질문: 오늘 상태 + 최근 대화(방금 내 말 빼고) + 새 메시지. 약 이름은 이름표로 가린다
  async function askBrain(text, ctx) {
    const key = ctx.key;
    const day = store.day(key);
    const masks = masksFor(key);
    const its = items(key);
    const stateText = B.buildState({
      now: ctx.now,
      key,
      rollover: ctx.rollover,
      day,
      items: its,
      masks,
      steps: routineSteps(key),
      routineOff: !!state.routineOff[key],
      awaiting: ctx.awaiting,
      dose: ctx.dose,
      focus: state.focus,
      calendar: brief?.calendarFor?.(key, ctx.rollover) || null,
      paused: state.paused === key,
      lastUndo: (state.undo || []).at(-1) || null,
    });
    const hist = B.recentHistory(state, ctx.now).slice(0, -1); // 마지막은 방금 보낸 내 말
    // 기억 3층: 나에 대해(profile), 기억하는 사실, 어제 일지. 못 읽어도 대화는 그대로 한다
    if (memory) await memory.load(C.addDays(key, -1)).catch(e => log('memory', e?.message));
    const prompt = B.buildPrompt({ stateText, history: hist, message: text, now: ctx.now, masks, memory: memory?.context(s => B.redact(s, masks)) || '' });
    const r = await llm.parse(text, {
      key,
      now: ctx.now,
      rollover: ctx.rollover,
      prompt,
      items: its.filter(i => i.cat !== 'med').map(i => ({ id: i.id, name: i.name })),
      top3: C.top3Of(day).map(x => ({ id: x.id, text: x.text, done: !!x.done })),
      masks: masks.filter(m => m.code),
      persona: game()?.secretary || null, // 비서의 이름·호칭·말투 (비공개 설정)
    });
    return unmaskActions(r, masks, text);
  }
  // AI는 이름표만 봤으니, AI가 쓴 글(할 일·결과물·메모)의 이름표를 내가 쓴 말로 되돌려 기록한다
  function unmaskActions(r, masks, text) {
    for (const a of r?.actions || []) for (const f of ['text', 'out', 'note']) if (typeof a[f] === 'string' && a[f].includes('[')) a[f] = B.unmask(a[f], masks, text);
    return r;
  }

  async function onCallback(q) {
    const data = String(q.data || '');
    const key = today();
    let toast = '';
    let reply = '';
    const [kind, a, b] = data.split(':');
    // 어제 알림의 버튼으로 오늘 기록을 바꾸지 않는다
    const msgKey = q.message?.date ? C.dayKey(q.message.date * 1000, R()) : key;
    if (msgKey !== key && !['noop', 'unmute', 'one', 'rest'].includes(kind)) {
      await tg.answer(q.id, '지난 알림이에요').catch(() => {});
      if (q.message?.message_id) tg.clearButtons(state.owner, q.message.message_id).catch(() => {});
      return;
    }
    // 누른 버튼도 최근 대화로 남긴다 ("일어났어요"를 누르고 "지금 일어난 건 아니고"라고 하면 AI가 앞뒤를 안다)
    const label = (q.message?.reply_markup?.inline_keyboard || []).flat().find(x => x?.callback_data === data)?.text;
    note('me', `(버튼) ${label || data}`);
    const wokeNow = kind === 'wake';
    if (kind === 'wake') reply = await apply([{ type: 'wake' }]);
    else if (kind === 'log') {
      const it = itemById(a, key);
      if (!it) toast = '항목을 찾지 못했어요';
      else if (it.cat === 'med') {
        reply = logMed(key, a);
        clearDose(a);
      }
      else if (it.type === 'check' && C.itemState(store.day(key), it).count) toast = '이미 기록돼 있어요';
      else {
        store.logEvent(key, a, { autoWake: true });
        push();
        reply = `${it.icon || '✅'} ${it.name} ${fmt(now())} 기록했어요.`;
      }
    } else if (kind === 'rt') reply = markStep(key, a);
    else if (kind === 'rtoff') {
      state.routineOff[key] = 1;
      save();
      toast = '오늘 아침 루틴 알림은 그만할게요';
    } else if (kind === 't3d') reply = await apply([{ type: 'top3_done', id: a, out: '' }]);
    else if (kind === 't3s') {
      const t = C.top3Of(store.day(key)).find(x => x.id === a);
      if (t && !t.done) {
        const due = Math.max(t.due || 0, now()) + (+b || 15) * MIN;
        store.setTop3(key, a, { due });
        push();
        reply = `⏰ "${t.text}" 마감 ${fmt(due)}로 미뤘어요. 이번엔 끝내요.`;
      }
    } else if (kind === 't3x') {
      const t = C.top3Of(store.day(key)).find(x => x.id === a);
      if (t) {
        store.setTop3(key, a, { due: 0 });
        push();
        reply = `"${t.text}" 마감을 풀었어요. 내일 첫 결과물로 할지 밤에 물어볼게요.`;
      }
    } else if (kind === 'skip') {
      const it = itemById(a, key);
      if (it) {
        store.setSkip(key, a, true, 'other');
        push();
        clearDose(a);
        reply = `${it.name}은 오늘 건너뛰는 걸로 남겼어요. 이유는 앱에서 고칠 수 있어요.`;
      }
    } else if (kind === 'medat') {
      // "몇 시에 먹은 약이 어느 거예요?"의 버튼: 그 약을 그 시각으로
      if (itemById(a, key)?.cat === 'med') {
        reply = logMed(key, a, (+b || 0) * 1000);
        clearDose(a);
      }
    } else if (kind === 'unmute') {
      Q.unmute(state.q, a);
      save();
      reply = `🔔 ${Q.KIND_NAME[a] || '그'} 알림을 다시 보낼게요.`;
    } else if (kind === 'one') {
      // 조용했던 뒤의 "하나만 정하기"
      setAwait({ kind: 'top3' });
      state.hold = now() + 10 * MIN; // 답을 기다리는 10분 동안은 밀려 있던 알림을 보내지 않는다 (그 알림이 답을 가로채지 않게)
      save();
      reply = '오늘 끝낼 것 하나만 보내 주세요. 예: 코테 1문제 21시';
    } else if (kind === 'rest') {
      state.rest = key; // 약·마감·일정 알림은 그대로 간다
      save();
      reply = '알겠어요. 오늘은 쉬어요. 약·마감·일정 알림만 보낼게요.';
    } else if (kind === 'fx') reply = startFocus(+a || 25, key);
    else if (kind === 'noop') toast = '수고했어요';
    // 버튼으로 바꾼 기록은 되돌리기 목록에 없으니, 옛 기록을 엉뚱하게 되돌리지 않게 목록을 비운다
    if (['log', 'rt', 't3s', 't3x', 'skip', 'medat', 'fx'].includes(kind)) forgetUndo();
    try {
      await tg.answer(q.id, toast || undefined);
    } catch {
      /* 오래된 버튼이면 응답이 실패할 수 있다 */
    }
    // 같은 버튼을 두 번 누르지 않게 누른 메시지의 버튼은 지운다
    if (q.message?.message_id) tg.clearButtons(state.owner, q.message.message_id).catch(() => {});
    if (reply) await say(reply, takeButtons());
    if (wokeNow) await sendBrief(key);
  }

  async function handleUpdate(u) {
    const msg = u.message;
    const q = u.callback_query;
    const chatId = msg?.chat?.id ?? q?.message?.chat?.id;
    const fromId = msg?.from?.id ?? q?.from?.id;
    if (!state.owner) {
      // 처음 한 번: 설치 창에 나온 6자리 코드로 주인을 정한다
      const m = msg?.text?.trim().match(/^\/start(?:@\w+)?\s+(\d{6})$/);
      if (m && state.pairCode && m[1] === state.pairCode && msg.chat?.type === 'private') {
        state.owner = chatId;
        state.ownerUser = fromId;
        state.pairCode = null;
        save();
        await tg.send(chatId, `연결됐어요! 이제 이 대화에서만 움직여요.\n\n${HELP}`);
      } else if (msg?.text?.startsWith('/start')) {
        // 코드를 마구 찍어 보는 걸 막는다: 10번 틀리면 코드를 버린다 (비서를 다시 켜면 새 코드)
        state.pairFails = (state.pairFails || 0) + 1;
        if (state.pairFails >= 10) state.pairCode = null;
        save();
        await tg.send(chatId, state.pairCode ? '설치할 때 나온 6자리 코드를 "/start 123456"처럼 보내 주세요.' : '여러 번 틀려서 코드를 버렸어요. PC에서 비서를 다시 켜면 새 코드가 나와요.');
      }
      return;
    }
    // 주인이 아닌 사람의 메시지와 버튼은 무시한다
    if (chatId !== state.owner || (state.ownerUser && fromId !== state.ownerUser)) return;
    Q.onSeen(state.q, now()); // 반응이 있었다 (조용한 점검: 쉬던 알림이 돌아오고, 방금 알림은 답한 걸로 친다)
    if (q) return onCallback(q);
    if (msg?.text) return onText(msg.text);
  }

  let dreaming = null;
  // ----- 밤 정리: 하루가 바뀌면 어제 대화로 일지를 쓰고 기억을 다듬는다 (하루 한 번, 메시지는 안 보낸다) -----
  async function dream(key) {
    if (!memory || !llm?.full || !llm.json) return;
    state.dayLog ||= {};
    for (const k of Object.keys(state.dayLog)) if (k < C.addDays(key, -7)) delete state.dayLog[k];
    // 내가 한 말이 없던 날은 AI를 부르지 않고 지운다
    for (const k of Object.keys(state.dayLog)) if (k < key && !state.dayLog[k].some(h => h.who === 'me')) delete state.dayLog[k];
    // 밀린 날 중 가장 오래된 날부터 하나씩 (비서가 하루 넘게 꺼져 있었어도 놓치지 않게)
    const yk = Object.keys(state.dayLog).filter(k => k < key).sort()[0];
    if (!yk) return;
    let tr = state.dreamTry?.key === yk ? state.dreamTry : { key: yk, n: 0, at: 0 };
    // 30분 간격으로 여섯 번까지. 그래도 안 되면 그날은 건너뛴다 (한 날이 막혀서 뒤의 날들까지 밀리지 않게)
    if (tr.n >= 6) {
      log('dream', `${yk} 밤 정리를 건너뛰어요 (여섯 번 실패)`);
      delete state.dayLog[yk];
      state.dreamTry = null;
      return save();
    }
    if (now() - tr.at < 30 * MIN) return;
    state.dreamTry = { ...tr, n: tr.n + 1, at: now() };
    save();
    try {
      const masks = masksFor(yk);
      const end = C.dayStartTs(key, R()) - 1;
      const stateText = B.buildState({ now: end, key: yk, rollover: R(), day: store.day(yk), items: items(yk), masks, steps: routineSteps(yk), routineOff: !!state.routineOff[yk] });
      await memory.dream({
        key: yk,
        stateText,
        logText: M.dayLogText(state, yk),
        redact: s => B.redact(s, masks),
        ask: (system, user, schema) => llm.json(key, system, user, schema),
        out: state.dreamTry.out || null, // 앞선 시도에서 받은 답이 있으면 AI를 다시 부르지 않는다
        onOut: o => {
          state.dreamTry.out = o;
          save();
        },
      });
      state.dreamed = yk;
      state.dreamTry = null;
      delete state.dayLog[yk];
      save();
    } catch (e) {
      log('dream', e?.message);
    }
  }

  // ----- 먼저 말 걸기 (30초마다) -----
  async function tick() {
    if (now() - lastPull >= PULL_EVERY) await pull(true).catch(e => log('pull', e?.message));
    if (!state.owner) return;
    const key = today();
    // 밤 정리는 뒤에서 돌린다 (AI와 저장소를 기다리느라 알림이 밀리지 않게)
    if (!dreaming) {
      dreaming = dream(key)
        .catch(e => log('dream', e?.message))
        .finally(() => {
          dreaming = null;
        });
    }
    // 폰 앱에서 남긴 기록도 반응으로 친다
    const dd = store.day(key);
    const act = Math.max(0, dd.wake?.m || 0, ...(dd.events || []).map(e => e.m || 0), ...(dd.top3 || []).map(x => x.m || 0), ...(dd.skips || []).map(x => x.m || 0));
    if (act > (state.q.seen || 0) && act <= now()) Q.onSeen(state.q, now(), act);
    // 조용한 점검: 이틀 연속 답이 없던 종류는 3일 쉬고, 24시간 조용했으면 한 번만 가볍게 묻는다
    const rv = Q.review(state.q, key, now());
    if (state.paused !== key) {
      if (rv.notice.length) {
        // 쉬게 된 종류는 낮에 한 번, 한 메시지로. 보내기에 성공해야 알린 걸로 친다
        const names = rv.notice.map(k => Q.KIND_NAME[k] || k);
        const rows = rv.notice.map(k => [btn(`${Q.KIND_NAME[k] || k} 다시 받기`, `unmute:${k}`)]);
        await say(`🔕 사흘째 답이 없던 알림은 3일 쉴게요: ${names.join(', ')}. 약과 마감 알림은 그대로 가요.`, rows)
          .then(() => Q.noticeSent(state.q))
          .catch(e => log('send', e?.message));
      }
      if (rv.reentry) await say('한동안 조용했네요. 괜찮아요. 약·마감·일정 알림만 남기고 나머지는 쉬고 있을게요.', [[btn('하나만 정하기', 'one'), btn('오늘은 쉬기', 'rest')]]).catch(e => log('send', e?.message));
    }
    if (rv.notice.length || rv.reentry) save();
    if (brief) await brief.refresh().catch(() => {});
    // 일어난 기록이 생겼는데 (폰 앱에서 눌렀을 수도) 아직 브리핑을 안 보냈으면 보낸다. 일어난 지 4시간 안에만
    const wokeAt = C.wakeOf(store.day(key));
    if (brief && wokeAt && now() - wokeAt <= 4 * HOUR && state.paused !== key) await sendBrief(key);
    const build = () => {
      const day = store.day(key);
      const prevKey = C.addDays(key, -1);
      const week = C.lastDays(key, 7).filter(k => store.hasDay(k)).map(k => store.day(k));
      return planPings({
        now: now(),
        cfg: store.config(),
        day,
        prevDay: store.hasDay(prevKey) ? store.day(prevKey) : null,
        recentDays: week,
        game: game(),
        profiles: store.meds(),
        state: { focus: state.focus, routineOff: !!state.routineOff[key], sent: state.sent[key] || {} },
        opts,
        calendar: brief?.calendarFor(key, R()) || null,
      }).filter(p => !state.sent[key]?.[p.key] && (state.paused !== key || p.kind === 'focus') && Q.allow(state.q, p, now()) && (Q.isExempt(p) || (state.rest !== key && !(state.hold > now()))));
    };
    let pings = build();
    if (!pings.length) return;
    // 안 했다고 말하기 전에 폰에서 방금 남긴 기록이 있는지 한 번 더 받아 온다
    if (now() - lastPull > FRESH) {
      await pull(true).catch(() => {});
      pings = build();
    }
    // 한 번에 두 개까지. 보내기에 성공한 것만 보낸 걸로 친다 (실패하면 다음 차례에 다시)
    for (const p of pings.slice(0, 2)) {
      try {
        await say(p.text, p.buttons);
      } catch (e) {
        log('send', e?.message);
        break;
      }
      state.sent[key] = { ...(state.sent[key] || {}), [p.key]: now() };
      Q.onSent(state.q, p, key, now());
      if (p.effect?.type === 'focus_end') {
        forgetUndo();
        const r = endFocus();
        if (r) setAwait({ kind: 'fnote', ev: r.ev.id, key: r.key });
      } else if (p.await?.kind === 'dose') {
        // 약 알림의 답은 따로 기다린다 (기상 시각·집중 메모·결과물 질문을 덮어쓰지 않게)
        state.doseAwait = { ...p.await, until: now() + AWAIT_MS };
      } else if (p.await) setAwait(p.await);
      save();
    }
    // 오래된 기록 정리 (3일)
    for (const k of Object.keys(state.sent)) if (k < C.addDays(key, -3)) delete state.sent[k];
    for (const k of Object.keys(state.routineOff)) if (k < C.addDays(key, -3)) delete state.routineOff[k];
  }

  // idle: 뒤에서 도는 밤 정리가 끝나기를 기다린다 (시험용)
  return { handleUpdate, tick, apply, statusText, startFocus, endFocus, pull, sendBrief, idle: () => dreaming || Promise.resolve() };
}
