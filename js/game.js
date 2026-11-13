// 게임 층: 날마다의 EXP가 쌓여 레벨이 오르고, 스탯은 개선 목표를 채울수록 등급이 오른다.
// 레벨과 보너스는 기록에서 매번 다시 계산한다 (따로 저장하지 않아서 기기끼리 어긋나지 않는다).
// 스탯 정의(이름, 처음 등급, 목표)는 공개 코드에 없고, 비공개 저장소의 game.json에서 온다.

import * as C from './core.js';

export const CLEAR_BONUS = 20; // 하루 EXP 100을 채운 날
export const STREAK_BONUS = { 7: 50, 14: 100, 30: 200, 60: 300, 100: 500 }; // 연속(이틀 규칙)이 이 날수에 닿을 때
export const STEP_BONUS = 100; // 스탯 목표 하나를 채울 때

// 레벨 lv에서 lv+1로 가는 데 필요한 EXP. 처음엔 이틀, 갈수록 조금씩 길어진다.
export const needFor = lv => 200 + 20 * lv;

export function levelOf(total) {
  let lv = 1, rest = Math.max(0, total);
  while (rest >= needFor(lv) && lv < 999) {
    rest -= needFor(lv);
    lv++;
  }
  return { lv, into: rest, need: needFor(lv), total };
}

export const TIERS = [
  { min: 1, name: '초보자' },
  { min: 10, name: '모험가' },
  { min: 20, name: '베테랑' },
  { min: 35, name: '고수' },
  { min: 50, name: '초고수' },
];
export function tierOf(lv) {
  let t = TIERS[0];
  for (const x of TIERS) if (lv >= x.min) t = x;
  const i = TIERS.indexOf(t);
  return { ...t, i, next: TIERS[i + 1] || null };
}

// 처음 기록한 날부터 오늘까지 하루씩: 그날 EXP + 하루 목표 보너스 + 연속 보너스
export function expLedger(firstKey, todayKey, getDay, cfg) {
  const days = [];
  if (!firstKey || firstKey > todayKey) return days;
  let chain = 0, gap = 0;
  for (let k = firstKey; k <= todayKey; k = C.addDays(k, 1)) {
    const d = getDay(k);
    const exp = d ? C.expOf(d, cfg) : 0;
    const row = { key: k, exp, bonus: 0, why: [] };
    if (exp >= C.EXP_GOAL) {
      row.bonus += CLEAR_BONUS;
      row.why.push(`하루 목표 +${CLEAR_BONUS}`);
    }
    const st = C.dayStatus(d, cfg);
    if (st === 1) {
      chain++;
      gap = 0;
      if (STREAK_BONUS[chain]) {
        row.bonus += STREAK_BONUS[chain];
        row.why.push(`${chain}일 연속 +${STREAK_BONUS[chain]}`);
      }
    } else if (st === 0 && k !== todayKey && ++gap >= 2) {
      chain = 0;
      gap = 0;
    }
    days.push(row);
  }
  return days;
}

// ---------- 스탯 ----------
// stat = { id, name, icon, grade, metric: {...}, steps: [{ at, grade, label }], note }
// metric.type:
//   dday_weeks  { dday: '이름' }                 D-day 시작일부터 몇 주째
//   item_total  { item, from?, unit? }            그 항목 기록 누적
//   item_days   { item, days: 14, onTime? }       최근 N일 중 한 날 (onTime이면 예정 ±30분)
//   latest_num  { item }                          숫자 기록의 가장 최근 값
//   same        { of: '다른 스탯 id' }            다른 스탯과 같은 숫자
//   keep                                          손대지 않을 강점

export const GRADES = ['F', 'D-', 'D', 'D+', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+'];
export const gradeScore = g => {
  const i = GRADES.indexOf(g);
  return i < 0 ? 50 : 50 + (i / (GRADES.length - 1)) * 48;
};

export function metricValue(m, { cfg, days, todayKey, rollover = 4 }) {
  if (!m) return null;
  const items = cfg?.items || [];
  if (m.type === 'dday_weeks') {
    const d = (cfg?.ddays || []).find(x => !x.del && (x.id === m.dday || x.label === m.dday));
    if (!d?.from || d.from > todayKey) return d ? 0 : null;
    return Math.floor(Math.round((C.keyToDate(todayKey) - C.keyToDate(d.from)) / 86400000) / 7) + 1;
  }
  const it = m.item ? items.find(i => i.id === m.item && !i.del) : null;
  if (m.item && !it) return null; // 기록할 항목이 아직 없다
  if (m.type === 'item_total') {
    let n = 0;
    for (const d of days) {
      if (!d || (m.from && d.date < m.from)) continue;
      for (const e of C.live(d)) if (e.item === m.item) n++;
    }
    return n;
  }
  if (m.type === 'item_days') {
    const keys = C.lastDays(todayKey, m.days || 14);
    let n = 0;
    for (const k of keys) {
      const d = days.find(x => x?.date === k);
      if (!d) continue;
      const ds = C.doseState(it, d, { rollover, ended: true });
      if (m.onTime ? ds.kind === 'taken' || ds.kind === 'early' : ['taken', 'late', 'early'].includes(ds.kind)) n++;
    }
    return n;
  }
  if (m.type === 'latest_num') {
    for (let i = days.length - 1; i >= 0; i--) {
      const ev = days[i] && C.live(days[i]).filter(e => e.item === m.item && e.v != null).pop();
      if (ev) return ev.v;
    }
    return null;
  }
  return null;
}

// 스탯마다 지금 값, 지금 등급, 다음 목표까지의 진행
export function statsNow(def, ctx) {
  const list = (def?.stats || []).filter(s => !s.del);
  const vals = new Map();
  for (const s of list) if (s.metric?.type !== 'same') vals.set(s.id, metricValue(s.metric, ctx));
  for (const s of list) if (s.metric?.type === 'same') vals.set(s.id, vals.get(s.metric.of) ?? null);
  return list.map(s => {
    const value = vals.get(s.id);
    const steps = (s.steps || []).map(st => ({ ...st, done: value != null && (s.metric?.down ? value <= st.at : value >= st.at) }));
    const reached = steps.filter(x => x.done);
    const next = steps.find(x => !x.done) || null;
    const grade = reached.length ? reached[reached.length - 1].grade : s.grade;
    let pct = 1;
    if (next && value != null) {
      const prevAt = reached.length ? reached[reached.length - 1].at : s.metric?.start ?? 0;
      pct = s.metric?.down ? (prevAt - value) / (prevAt - next.at) : (value - prevAt) / (next.at - prevAt);
      pct = Math.max(0, Math.min(1, pct));
    } else if (next) pct = 0;
    const hasItem = id => (ctx.cfg?.items || []).some(i => i.id === id && !i.del);
    const missing = s.metric?.item && !hasItem(s.metric.item) ? s.metric.item : null; // 기록할 항목이 아직 없다
    return { ...s, value, steps, reached: reached.length, next, grade, base: s.grade, pct, missing, keep: s.metric?.type === 'keep' || !s.metric };
  });
}

export const statBonus = stats => stats.reduce((a, s) => a + s.reached * STEP_BONUS, 0);

// ---------- 메인 퀘스트 ----------
// 과제를 끝내면 그날 기록에 'q:과제id' 이벤트로 남긴다. 기록은 어떤 버전의 앱이든 그대로 동기화한다.
export const QUEST_BONUS = 50;

export function questDone(days) {
  const done = new Map();
  for (const d of days) for (const e of d ? C.live(d) : []) if (e.item.startsWith('q:')) done.set(e.item.slice(2), { t: e.t, key: d.date, ev: e.id });
  return done;
}

// 금요일 5줄 보고 기록 ('report5' 이벤트)
export function reportsOf(days, from) {
  const out = [];
  for (const d of days) for (const e of d ? C.live(d) : []) if (e.item === 'report5' && (!from || d.date >= from)) out.push({ ...e, key: d.date });
  return out.sort((a, b) => a.t - b.t);
}

export function questState(quest, ctx) {
  if (!quest?.stages?.length) return null;
  const done = questDone(ctx.days);
  const today = ctx.todayKey;
  let current = null;
  const stages = quest.stages.map(st => {
    const tasks = (st.tasks || []).map(t => {
      if (t.auto) {
        const value = t.auto.type === 'reports' ? reportsOf(ctx.days, t.auto.from).length : metricValue(t.auto, ctx);
        return { ...t, isAuto: true, value, ok: value != null && value >= t.auto.at };
      }
      const d = done.get(t.id);
      return { ...t, ok: !!d, at: d?.t, ev: d?.ev, evKey: d?.key };
    });
    const ok = tasks.filter(t => t.ok).length;
    const start = st.from || st.date || null, end = st.to || st.date || null;
    const allDone = tasks.length > 0 && ok === tasks.length;
    const status = allDone ? 'done' : start && today < start ? 'later' : 'now';
    return { ...st, tasks, ok, start, end, status };
  });
  current = stages.find(s => s.status !== 'done') || null;
  const bonus = stages.reduce((a, s) => a + s.ok * QUEST_BONUS, 0);
  return { ...quest, stages, current, bonus, doneStages: stages.filter(s => s.status === 'done').length };
}

// ---------- 아침 루틴 ----------
export const DEFAULT_ROUTINE = [
  { id: 'wake', text: '일어난 시각 남기기', check: 'wake' },
  { id: 'water', text: '물 한 잔', check: 'item', item: 'water' },
  { id: 'med', text: '아침 약', check: 'item', item: 'med_am' },
  { id: 'light', text: '햇빛 10분 (창문만 열어도 좋아요)', check: 'manual' },
  { id: 'top3', text: '오늘 꼭 끝낼 일 하나와 마감 시각', check: 'top3' },
  { id: 'phone', text: '폰은 손 닿지 않는 곳에', check: 'manual' },
  { id: 'focus', text: '첫 집중 25분', check: 'focus' },
];
export function routineState(steps, day, { focusOn = false } = {}) {
  const evs = day ? C.live(day) : [];
  const has = id => evs.some(e => e.item === id);
  return (steps || DEFAULT_ROUTINE).map(s => {
    let done = false;
    if (s.check === 'wake') done = !!C.wakeOf(day);
    else if (s.check === 'item') done = has(s.item);
    else if (s.check === 'top3') done = C.top3Of(day).some(t => t.due || t.done); // 마감 시각까지 정해야 끝
    else if (s.check === 'focus') done = focusOn || has('focus');
    else done = has('rt:' + s.id);
    return { ...s, done };
  });
}
