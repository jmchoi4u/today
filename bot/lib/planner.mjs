// 지금 먼저 말을 걸어야 할 것들을 고른다. 부수 효과 없는 순수 함수라서 시각만 바꿔 가며 시험할 수 있다.
// 각 알림은 하루에 한 번만 (key로 구분). 이미 한 일은 묻지 않는다.
import * as C from '../../js/core.js';
import * as GM from '../../js/game.js';
import * as PK from '../../js/pk.js';

const { MIN, HOUR } = C;
const fmt = C.fmtTime;
export const btn = (text, data) => ({ text, callback_data: String(data).slice(0, 64) });

const PRI = { focus: 0, due: 1, dose: 2, go: 3, routine: 4, wake: 5, plan: 6, peak: 7, daily: 8, hint: 9, report: 10 };

// opts: { wakeWeekday, wakeWeekend, quietFrom, quietTo, appUrl }
// state: { focus, routineOff }
export function planPings({ now, cfg, day, prevDay = null, recentDays = [], game = null, profiles = [], state = {}, opts = {} }) {
  const R = cfg?.prefs?.rollover ?? 4;
  const key = day.date;
  const at = hhmm => C.tsFor(key, hhmm, R);
  const items = C.activeItems(cfg, key);
  const byId = id => items.find(i => i.id === id);
  const out = [];
  const push = (kind, k, p) => out.push({ kind, key: k, pri: PRI[kind] ?? 20, ...p });

  // 집중 타이머 끝: 조용한 시간에도 알린다
  const fx = state.focus;
  if (fx && now >= fx.start + fx.dur * MIN) {
    const rows = [];
    if (fx.t3) rows.push([btn('✅ 그 일 끝냈어요', `t3d:${fx.t3}`)]);
    rows.push([btn('⏱️ 25분 더', 'fx:25'), btn('그만', 'noop')]);
    push('focus', `fxend:${fx.start}`, {
      text: `⏱️ ${fx.dur}분 끝!${fx.label ? ` (${fx.label})` : ''}\n뭐 했는지 한 줄 답장하면 같이 남길게요.`,
      buttons: rows,
      effect: { type: 'focus_end' },
    });
  }

  const quiet = inQuiet(now, key, R, opts);
  if (quiet) return out.sort(byPri);

  const evs = C.live(day);
  const w = C.wakeOf(day);
  const weekend = GM.isWeekend(key);

  // 1) 일어났는지
  if (!w) {
    const wakeAt = weekend ? opts.wakeWeekend : opts.wakeWeekday;
    if (wakeAt) {
      const t = at(wakeAt);
      if (now >= t + 5 * MIN && now < t + 3 * HOUR) push('wake', 'wake1', { text: '☀️ 일어났어요? 눌러 주면 아침 스피드런 시작할게요.', buttons: [[btn('☀️ 일어났어요', 'wake')]] });
      if (now >= t + 35 * MIN && now < t + 3 * HOUR) push('wake', 'wake2', { text: '☀️ 아직 자요? 일어나면 바로 눌러 주세요. 늦은 날도 그대로 시작하면 돼요.', buttons: [[btn('☀️ 일어났어요', 'wake')]] });
    }
  }

  // 2) 아침 루틴 (일어나고 4시간 안): 지금 할 단계의 목표 시각이 되면 한 번
  const steps = GM.routineState(GM.routineFor(game?.routine, key), day, { focusOn: !!fx });
  if (w && now - w <= 4 * HOUR && !state.routineOff) {
    const next = steps.find(s => !s.done);
    if (next && next.min != null && now >= w + next.min * MIN) {
      const p = stepPing(next, w + next.min * MIN, { byId, day });
      if (p) push('routine', `rt:${next.id}`, p);
    }
    // 집 밖으로 나가는 마감
    const go = game?.routineGo;
    const outStep = go && steps.find(s => s.id === (go.step || 'out'));
    if (outStep && !outStep.done) {
      const goal = w + (go.min || 60) * MIN;
      const cap = go.weekday && !weekend ? at(go.weekday) : null;
      const hard = cap && w < cap ? cap : null;
      const target = hard ? Math.min(goal, hard) : goal;
      const b = [[btn('🚪 나갔어요', `rt:${outStep.id}`)]];
      if (now >= target - 10 * MIN && now < target) push('go', `go10:${target}`, { text: `🚪 ${fmt(target)}까지 집 밖으로. ${Math.ceil((target - now) / MIN)}분 남았어요.`, buttons: b });
      if (now >= target && now < target + HOUR) push('go', `go0:${target}`, { text: `🚪 출발 시간이에요 (${fmt(target)}). 남은 단계는 건너뛰고 지금 나가요.`, buttons: b });
    }
  }

  // 3) 핵심 3가지의 외부 마감: 30분 전, 마감, 1시간 지남
  for (const t of C.top3Of(day)) {
    if (t.done || !t.due) continue;
    const d = t.due;
    const to = t.to ? ` · ${t.to}에게 보고` : '';
    if (now >= d - 30 * MIN && now < d) push('due', `due30:${t.id}:${d}`, { text: `⏰ ${Math.ceil((d - now) / MIN)}분 남았어요: ${t.text} (${fmt(d)} 마감${to})`, buttons: [[btn('✅ 끝냈어요', `t3d:${t.id}`), btn('+15분', `t3s:${t.id}:15`)]] });
    if (now >= d && now < d + HOUR) push('due', `due0:${t.id}:${d}`, { text: `⏰ 마감 시간이에요: ${t.text}\n끝났으면 결과물 한 줄을 답장으로 보내 주세요.`, buttons: [[btn('✅ 끝냈어요', `t3d:${t.id}`), btn('+30분', `t3s:${t.id}:30`)]], await: { kind: 'out', id: t.id } });
    if (now >= d + HOUR && now < d + 4 * HOUR) push('due', `due60:${t.id}:${d}`, { text: `마감이 1시간 지났어요: ${t.text}\n새 마감을 답장으로 보내 주세요 (예: 21시). 아니면 오늘은 접어요.`, buttons: [[btn('✅ 사실 끝냈어요', `t3d:${t.id}`), btn('오늘은 접기', `t3x:${t.id}`)]], await: { kind: 'due', id: t.id } });
  }

  // 4) 예정 시각이 있는 약: 시각이 되면, 1시간 지나도 안 먹었으면 한 번 더
  for (const it of items) {
    if (it.cat !== 'med' || !it.plan) continue;
    const ds = C.doseState(it, day, { now, rollover: R });
    if (!['due', 'overdue'].includes(ds.kind) || !ds.due || now < ds.due || now >= ds.due + 3 * HOUR) continue;
    const b = [[btn('💊 먹었어요', `log:${it.id}`), btn('오늘은 건너뛰기', `skip:${it.id}`)]];
    push('dose', `dose:${it.id}`, { text: `💊 ${it.name}${it.cue ? ` · ${it.cue}` : ''}`, buttons: b });
    if (now >= ds.due + HOUR) push('dose', `dose2:${it.id}`, { text: `💊 ${it.name} 아직이에요. 먹었으면 눌러 주세요. 늦게 먹으면 잠이 늦어질 수 있어요.`, buttons: b });
  }

  // 5) 예정 시각이 있는 습관 (예: 소등): 30분 전. 자기 전 약이 남았으면 같이
  for (const it of items) {
    if (it.cat === 'med' || !it.plan?.time || C.itemState(day, it).count) continue;
    const due = at(it.plan.time);
    if (now < due - 30 * MIN || now >= due + 30 * MIN) continue;
    const rows = [[btn(`${it.icon || '✅'} 했어요`, `log:${it.id}`)]];
    const nightMed = items.find(m => m.cat === 'med' && m.block === 'night' && m.type === 'check' && !C.itemState(day, m).count && !C.itemState(day, m).skipped);
    if (nightMed) rows.unshift([btn(`💊 ${nightMed.name} 먹었어요`, `log:${nightMed.id}`)]);
    push('plan', `plan:${it.id}`, { text: `${it.icon || '⏰'} ${it.name} ${fmt(due)}${now < due ? ` · ${Math.ceil((due - now) / MIN)}분 남았어요` : ''}`, buttons: rows });
  }

  // 6) 약 효과가 가장 높은 구간이 시작될 때
  if (profiles?.length && !fx) {
    const doses = PK.dosesOf([prevDay, day], items, profiles).filter(d => d.p.kind === 'curve');
    if (doses.length) {
      const t0 = C.dayStartTs(key, R);
      const sr = PK.series(doses, t0, t0 + 24 * HOUR);
      for (const G of sr.groups) {
        const st = PK.groupStatus(G, sr.ts, now);
        for (const [a, b] of st?.peak || []) {
          if (now >= a && now < a + HOUR && b - now >= 20 * MIN) {
            push('peak', `peak:${G.group}:${a}`, { text: `🎯 지금부터 ${fmt(b)}까지 약 효과가 가장 높은 구간이에요. 제일 어려운 거 하나 50분?`, buttons: [[btn('⏱️ 50분 시작', 'fx:50'), btn('25분', 'fx:25')]] });
          }
        }
      }
    }
  }

  // 7) 매일 모으는 것 (예: 사장님 불편 한 줄, 코테 1문제)
  for (const dly of game?.daily || []) {
    const it = byId(dly.item);
    if (!it || !GM.inDay(dly, key) || C.itemState(day, it).count) continue;
    if (dly.after) {
      const t = at(dly.after);
      if (now < t || now >= t + 4 * HOUR) continue;
    }
    const note = it.type === 'log' && it.ask === 'note';
    push('daily', `daily:${it.id}`, {
      text: `${it.icon || '📝'} ${dly.text || it.name}${dly.sub ? `\n${dly.sub}` : ''}${note ? '\n답장으로 한 줄 보내 주세요.' : ''}`,
      buttons: note ? [] : [[btn(it.type === 'count' ? '+1 했어요' : '✅ 했어요', `log:${it.id}`)]],
      await: note ? { kind: 'note', item: it.id } : undefined,
    });
  }

  // 8) 시간대 규칙 (예: 밤 9시 결정 금지, 걱정 시간)
  for (const h of game?.hints || []) {
    if (!h.text || !GM.inDay(h, key)) continue;
    const it = h.ifItem ? byId(h.ifItem) : null;
    if (h.ifItem && !(it && C.itemState(day, it).count)) continue;
    const a = h.after ? at(h.after) : null;
    const b = h.before ? at(h.before) : null;
    if ((a && (now < a || now >= a + 2 * HOUR)) || (b && now >= b)) continue;
    let text = `${h.icon || '🧭'} ${h.text}${h.sub ? `\n${h.sub}` : ''}`;
    if (it) {
      const notes = evs.filter(e => e.item === it.id && e.note).map(e => `· ${e.note}`);
      if (notes.length) text += `\n\n${notes.slice(-10).join('\n')}`;
    }
    let awaitNext;
    if (h.ask === 'tomorrow') {
      text += '\n\n내일 첫 결과물 하나와 마감을 답장으로 보내 주세요. 예: 코테 2문제 11시';
      awaitNext = { kind: 'tomorrow' };
    }
    push('hint', `hint:${h.id}`, { text, buttons: [], await: awaitNext });
  }

  // 9) 금요일 5줄: 금요일 17시 뒤, 최근 사흘 안에 보낸 보고가 없으면 (recentDays는 최근 7일, 오래된 것부터)
  if (game?.report && C.keyToDate(key).getDay() === 5 && now >= at('17:00') && now < at('23:00') && !GM.reportsOf(recentDays.slice(-3)).length) {
    push('report', 'report5', { text: reportDraft(game.report, recentDays, opts.appUrl), buttons: [] });
  }

  return out.sort(byPri);
}

const byPri = (a, b) => a.pri - b.pri;

// 조용한 시간 (예: 01:00~06:30). 논리적 하루 기준으로 비교한다
function inQuiet(now, key, R, { quietFrom, quietTo }) {
  if (!quietFrom || !quietTo) return false;
  let a = C.tsFor(key, quietFrom, R), b = C.tsFor(key, quietTo, R);
  if (b <= a) b += 24 * HOUR;
  if (now >= a && now < b) return true;
  // 조용한 시간이 하루 시작(새벽) 앞뒤에 걸치는 경우: 전날 기준으로도 본다
  return now >= a - 24 * HOUR && now < b - 24 * HOUR;
}

// 루틴 단계 하나를 알림으로
function stepPing(s, due, { byId, day }) {
  const head = `${s.icon ? `${s.icon} ` : ''}${s.text} (${fmt(due)}까지)${s.hint ? `\n${s.hint}` : ''}`;
  if (s.check === 'item') {
    const it = byId(s.item);
    if (!it) return null;
    const label = it.cat === 'med' ? '💊 먹었어요' : it.type === 'count' ? '+1 했어요' : '✅ 했어요';
    return { text: head, buttons: [[btn(label, `log:${it.id}`)], [btn('오늘 루틴은 그만', 'rtoff')]] };
  }
  if (s.check === 'manual') return { text: head, buttons: [[btn('✅ 했어요', `rt:${s.id}`)], [btn('오늘 루틴은 그만', 'rtoff')]] };
  if (s.check === 'top3') {
    const open = C.top3Of(day).find(t => !t.done);
    if (open) return { text: `${head}\n"${open.text}" 마감 몇 시로 할까요? 답장으로 (예: 21시)`, buttons: [], await: { kind: 'due', id: open.id } };
    return { text: `${head}\n오늘 끝낼 결과물 하나와 마감을 답장으로 보내 주세요. 예: 코테 2문제 21시`, buttons: [], await: { kind: 'top3' } };
  }
  if (s.check === 'focus') return { text: head, buttons: [[btn('⏱️ 25분 시작', 'fx:25')], [btn('오늘 루틴은 그만', 'rtoff')]] };
  return null;
}

// 금요일 5줄 초안: 이번 주 끝낸 일과 결과물, 횟수
export function reportDraft(rc, days, appUrl) {
  const done = days.flatMap(d => C.top3Of(d).filter(t => t.done).map(t => (t.out ? `${t.text} (${t.out})` : t.text)));
  const n = new Map();
  for (const x of done) n.set(x, (n.get(x) || 0) + 1);
  const did = [...n].slice(0, 5).map(([x, k]) => (k > 1 ? `${x} ×${k}` : x)).join(', ') || '(채우기)';
  const nums = (rc.nums || []).map(x => `${x.label} __`).join(' · ') || '(채우기)';
  return `📮 금요일 5줄${rc.to ? ` → ${rc.to}` : ''}\n1. 한 것: ${did}\n2. 숫자: ${nums}\n3. 막힌 것:\n4. 다음 주:\n5. 부탁:${appUrl ? `\n\n앱에서 마저 쓰고 보내기: ${appUrl}?go=report` : ''}`;
}
