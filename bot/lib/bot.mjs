// 오늘 비서: 텔레그램으로 묻고, 답을 앱과 같은 기록에 남기고, 정한 시각에 먼저 말을 건다.
// 기록은 앱의 store.js/sync.js를 그대로 써서 폰과 같은 방식으로 합쳐진다.
import crypto from 'node:crypto';
import * as C from '../../js/core.js';
import * as GM from '../../js/game.js';
import { planPings, btn } from './planner.mjs';
import { parseMessage, findTime } from './parse.mjs';

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
  '· 약 먹었어 / 일어났어 / 나왔어',
  '· 오늘 → 지금 상태',
  '명령: /focus 50 (집중 타이머), /stop, /pause (오늘 알림 끄기), /resume',
].join('\n');

export function newPairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// state: { owner, pairCode, offset, sent: {day: {key: ts}}, awaiting, focus, paused, routineOff: {day: 1} }
export function createBot({ store, sync, tg, llm = null, state, save = () => {}, now = Date.now, log = () => {}, opts = {} }) {
  const R = () => store.config().prefs?.rollover ?? 4;
  const today = () => C.dayKey(now(), R());
  let lastPull = 0;
  state.sent ||= {};
  state.routineOff ||= {};

  // ----- 동기화 -----
  async function pull(force = false) {
    if (!force && now() - lastPull < FRESH) return;
    lastPull = now();
    await sync.syncNow({ pull: true });
  }
  const push = () => sync.syncNow({ pull: false }).catch(e => log('sync', e?.message));

  // ----- 보내기 -----
  async function say(text, buttons) {
    if (!state.owner) return null;
    return tg.send(state.owner, text, buttons);
  }
  function setAwait(a) {
    state.awaiting = a ? { ...a, until: now() + AWAIT_MS } : null;
    save();
  }
  const awaiting = () => (state.awaiting && state.awaiting.until > now() ? state.awaiting : null);

  // ----- 읽기 도우미 -----
  const items = (key = today()) => C.activeItems(store.config(), key);
  const itemById = (id, key) => items(key).find(i => i.id === id);
  const game = () => store.game();
  const routineSteps = key => GM.routineState(GM.routineFor(game()?.routine, key), store.day(key), { focusOn: !!state.focus });
  const outStepId = () => game()?.routineGo?.step || 'out';
  const hasEv = (key, id) => C.live(store.day(key)).some(e => e.item === id);

  // ----- 행동 -----
  function startFocus(min, key = today()) {
    const m = Math.max(1, Math.min(180, Math.round(+min || 25)));
    const open = C.top3Of(store.day(key)).filter(t => !t.done).sort((a, b) => (a.due || Infinity) - (b.due || Infinity))[0];
    state.focus = { start: now(), dur: m, label: open?.text || '', t3: open?.id || '' };
    save();
    return `⏱️ ${m}분 시작! ${fmt(now() + m * MIN)}에 알려 드릴게요.${open ? ` (${open.text})` : ''} 폰은 뒤집어 두세요.`;
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
  async function apply(actions, { llmReply = '' } = {}) {
    const key = today();
    const lines = [];
    let nextAwait = null;
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
          lines.push(logMed(key, it.id));
          continue;
        }
        if (it.type === 'check' && C.itemState(store.day(key), it).count) {
          lines.push(`${it.name}은 이미 기록돼 있어요.`);
          continue;
        }
        store.logEvent(key, it.id, { note: a.note || undefined, autoWake: true });
        push();
        const n = C.live(store.day(key)).filter(e => e.item === it.id).length;
        lines.push(`${it.icon || '📝'} ${it.name} 남겼어요 (오늘 ${n}번째).`);
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
          lines.push(`${fmt(a.due)}는 이미 지났어요. 다른 시각으로 보내 주세요.`);
          nextAwait = { kind: 'due', id: a.id };
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
        const patch = { out: a.out || t.out || '' };
        if (!t.done) patch.done = now();
        store.setTop3(key, t.id, patch);
        push();
        if (a.out) lines.push(`✅ 끝! "${t.text}" → ${a.out}`);
        else {
          lines.push(`✅ 끝! "${t.text}" 결과물 한 줄 남길래요? 답장으로 보내 주세요.`);
          nextAwait = { kind: 'out', id: t.id };
        }
        if (t.to && !t.done) lines.push(`📨 ${t.to}에게 보고: "${t.text} 끝냈어요${a.out ? ` (${a.out})` : ''}"`);
      } else if (a.type === 'wake') {
        const day = store.day(key), w = C.wakeOf(day);
        if (w && !day.wake?.auto) lines.push(`☀️ 이미 ${fmt(w)}에 일어난 걸로 돼 있어요.`);
        else {
          store.setWake(key, now());
          push();
          lines.push(`☀️ ${fmt(now())} 기상. ${nextStepText(key)}`);
        }
      } else if (a.type === 'out') {
        lines.push(markStep(key, outStepId()));
      } else if (a.type === 'med') {
        lines.push(logMed(key));
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
    if (nextAwait || actions.some(a => !['park', 'status'].includes(a.type))) setAwait(nextAwait);
    return lines.filter(Boolean).join('\n');
  }

  function nextStepText(key) {
    const next = routineSteps(key).find(s => !s.done);
    const w = C.wakeOf(store.day(key));
    if (!next) return '';
    return `다음: ${next.icon ? `${next.icon} ` : ''}${next.text}${next.min != null && w ? ` (${fmt(w + next.min * MIN)}까지)` : ''}`;
  }

  function markStep(key, stepId) {
    const id = `rt:${stepId}`;
    if (!hasEv(key, id)) {
      store.logEvent(key, id, { autoWake: true });
      push();
    }
    const day = store.day(key), w = C.wakeOf(day);
    if (stepId === outStepId()) {
      const go = game()?.routineGo;
      const mins = w ? Math.round((now() - w) / MIN) : null;
      const goal = go ? go.min || 60 : null;
      const diff = mins != null && goal ? mins - goal : null;
      return `🚪 출발 ${fmt(now())}${mins != null ? ` · 일어나고 ${mins}분` : ''}${diff != null ? (diff <= 0 ? ` (목표보다 ${-diff}분 빨라요!)` : ` (목표보다 ${diff}분 늦었어요)`) : ''}`;
    }
    const s = routineSteps(key).find(x => x.id === stepId);
    return `✅ ${s ? s.text : '했어요'}. ${nextStepText(key)}`.trim();
  }

  function logMed(key, id) {
    const day = store.day(key);
    const meds = items(key).filter(i => i.cat === 'med' && i.type === 'check');
    let it = id ? meds.find(i => i.id === id) : null;
    if (!it) {
      const open = meds.filter(i => !C.itemState(day, i).count && !C.itemState(day, i).skipped);
      it = open.find(i => ['due', 'overdue'].includes(C.doseState(i, day, { now: now(), rollover: R() }).kind)) || open[0];
    }
    if (!it) return '💊 오늘 약은 다 기록돼 있어요.';
    if (C.itemState(day, it).count) return `💊 ${it.name}은 이미 ${fmt(C.itemState(day, it).last)}에 기록돼 있어요.`;
    store.logEvent(key, it.id, { autoWake: true });
    push();
    return `💊 ${it.name} ${fmt(now())} 기록했어요.`;
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
    const cmd = t.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (cmd) {
      const [, c, arg = ''] = cmd;
      if (c === 'start' || c === 'help') return say(HELP);
      if (c === 'today') return say(statusText(key));
      if (c === 'focus') return say(startFocus(parseInt(arg, 10) || 25, key));
      if (c === 'stop') {
        const r = endFocus();
        return say(r ? `⏱️ ${r.min}분 집중으로 남겼어요.` : '돌아가는 집중 타이머가 없어요.');
      }
      if (c === 'pause') {
        state.paused = key;
        save();
        return say('🔕 오늘은 먼저 말 걸지 않을게요. 내일 아침에 다시 켜져요. (/resume)');
      }
      if (c === 'resume') {
        state.paused = null;
        save();
        return say('🔔 다시 챙길게요.');
      }
      return say(HELP);
    }
    await pull().catch(() => {});
    const ctx = { now: now(), key, rollover: R(), awaiting: awaiting() };
    let parsed = parseMessage(t, ctx);
    let llmReply = '';
    if (!parsed && llm) {
      try {
        const day = store.day(key);
        const r = await llm.parse(t, {
          key,
          nowText: `${C.fmtDate(key)} ${fmt(now())}`,
          items: items(key).filter(i => i.cat !== 'med').map(i => ({ id: i.id, name: i.name })), // 약 항목은 AI에게 보내지 않는다
          top3: C.top3Of(day).map(x => ({ id: x.id, text: x.text, due: x.due ? fmt(x.due) : '', done: !!x.done })),
        });
        if (r) {
          parsed = { actions: r.actions };
          llmReply = r.reply;
        }
      } catch (e) {
        log('llm', e?.message);
        return say(`${e?.message || 'AI가 답하지 못했어요'}\n\n${HELP}`);
      }
    }
    if (!parsed) return say(`잘 못 알아들었어요.\n\n${HELP}`);
    const reply = await apply(parsed.actions, { llmReply });
    return say(reply || llmReply || '알겠어요.');
  }

  async function onCallback(q) {
    const data = String(q.data || '');
    const key = today();
    let toast = '';
    let reply = '';
    const [kind, a, b] = data.split(':');
    // 어제 알림의 버튼으로 오늘 기록을 바꾸지 않는다
    const msgKey = q.message?.date ? C.dayKey(q.message.date * 1000, R()) : key;
    if (msgKey !== key && kind !== 'noop') {
      await tg.answer(q.id, '지난 알림이에요').catch(() => {});
      if (q.message?.message_id) tg.clearButtons(state.owner, q.message.message_id).catch(() => {});
      return;
    }
    if (kind === 'wake') reply = await apply([{ type: 'wake' }]);
    else if (kind === 'log') {
      const it = itemById(a, key);
      if (!it) toast = '항목을 찾지 못했어요';
      else if (it.cat === 'med') reply = logMed(key, a);
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
        reply = `${it.name}은 오늘 건너뛰는 걸로 남겼어요. 이유는 앱에서 고칠 수 있어요.`;
      }
    } else if (kind === 'fx') reply = startFocus(+a || 25, key);
    else if (kind === 'noop') toast = '수고했어요';
    try {
      await tg.answer(q.id, toast || undefined);
    } catch {
      /* 오래된 버튼이면 응답이 실패할 수 있다 */
    }
    // 같은 버튼을 두 번 누르지 않게 누른 메시지의 버튼은 지운다
    if (q.message?.message_id) tg.clearButtons(state.owner, q.message.message_id).catch(() => {});
    if (reply) await say(reply);
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
    if (q) return onCallback(q);
    if (msg?.text) return onText(msg.text);
  }

  // ----- 먼저 말 걸기 (30초마다) -----
  async function tick() {
    if (now() - lastPull >= PULL_EVERY) await pull(true).catch(e => log('pull', e?.message));
    if (!state.owner) return;
    const key = today();
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
        state: { focus: state.focus, routineOff: !!state.routineOff[key] },
        opts,
      }).filter(p => !state.sent[key]?.[p.key] && (state.paused !== key || p.kind === 'focus'));
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
      if (p.effect?.type === 'focus_end') {
        const r = endFocus();
        if (r) setAwait({ kind: 'fnote', ev: r.ev.id, key: r.key });
      } else if (p.await) setAwait(p.await);
      save();
    }
    // 오래된 기록 정리 (3일)
    for (const k of Object.keys(state.sent)) if (k < C.addDays(key, -3)) delete state.sent[k];
    for (const k of Object.keys(state.routineOff)) if (k < C.addDays(key, -3)) delete state.routineOff[k];
  }

  return { handleUpdate, tick, apply, statusText, startFocus, endFocus, pull };
}
