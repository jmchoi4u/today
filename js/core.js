// 순수 로직: 시간 계산, 하루 모델, 병합, 통계, 코치.
// DOM과 저장소를 쓰지 않으므로 Node에서 그대로 테스트할 수 있다.

export const MIN = 60000;
export const HOUR = 3600000;
export const AWAKE_HOURS = 16;

// 시간대는 시계가 아니라 "기상 후 몇 시간"으로 정한다. 늦게 일어난 날도 같은 순서로 흐른다.
export const BLOCKS = [
  { id: 'am', name: '기상 후', from: 0, to: 4 },
  { id: 'day', name: '낮', from: 4, to: 9 },
  { id: 'pm', name: '저녁', from: 9, to: 13 },
  { id: 'night', name: '자기 전', from: 13, to: Infinity },
];
export const BLOCK_NAMES = { am: '기상 후', day: '낮', pm: '저녁', night: '자기 전', any: '언제든' };
export const CATS = { med: '약·영양제', habit: '습관', meal: '식사', drink: '음료', move: '운동' };
export const SPECIAL = {
  energy: { name: '에너지', icon: '⚡' },
  mood: { name: '기분', icon: '🙂' },
  focus: { name: '집중', icon: '🎯' },
};

export function defaultConfig(m = 0) {
  const items = [
    { id: 'med_am', name: '아침 약', icon: '💊', cat: 'med', type: 'check', block: 'am', essential: true },
    { id: 'stretch', name: '스트레칭', icon: '🧘', cat: 'habit', type: 'check', block: 'am' },
    { id: 'walk', name: '산책', icon: '🚶', cat: 'habit', type: 'check', block: 'day' },
    { id: 'med_pm', name: '저녁 약', icon: '💊', cat: 'med', type: 'check', block: 'pm', essential: true },
    { id: 'water', name: '물', icon: '💧', cat: 'drink', type: 'count', block: 'any', target: 8, unit: '잔', every: 120 },
    { id: 'coffee', name: '커피', icon: '☕', cat: 'drink', type: 'count', block: 'any', unit: '잔', caffeine: true },
    { id: 'meal', name: '식사', icon: '🍚', cat: 'meal', type: 'log', block: 'any', ask: 'note' },
    { id: 'workout', name: '운동', icon: '🏃', cat: 'move', type: 'log', block: 'any', ask: 'min' },
  ].map((it, i) => ({ ...it, order: i, m }));
  return { v: 1, items, places: [], ddays: [], prefs: { rollover: 4, m } };
}

// 항목 편집 화면에서 한 번에 추가할 수 있는 추천 항목
export const SUGGESTED = [
  { name: '소등', icon: '🌙', cat: 'habit', type: 'check', block: 'night', essential: true },
  { name: '영양제', icon: '🟡', cat: 'med', type: 'check', block: 'am' },
  { name: '코딩 문제', icon: '🧩', cat: 'habit', type: 'count', block: 'any', unit: '개' },
  { name: '지원서', icon: '📨', cat: 'habit', type: 'count', block: 'any', unit: '곳' },
  { name: '체중', icon: '⚖️', cat: 'habit', type: 'log', block: 'am', ask: 'num', unit: 'kg' },
  { name: '독서', icon: '📖', cat: 'habit', type: 'log', block: 'any', ask: 'min' },
  { name: '샤워', icon: '🚿', cat: 'habit', type: 'check', block: 'am' },
  { name: '정리', icon: '🧹', cat: 'habit', type: 'check', block: 'pm' },
];

// ---------- 시간 ----------

const p2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

// 새벽 rollover시 이전은 전날로 친다.
export function dayKey(ts, rollover = 4) {
  return ymd(new Date(ts - rollover * HOUR));
}
export function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export function lastDays(key, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(key, -i));
  return out;
}
// 논리적 하루(key) 안에서 "HH:MM"이 가리키는 실제 시각
export function tsFor(key, hhmm, rollover = 4) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = keyToDate(key);
  if (h < rollover) d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
// 논리적 하루가 시작되는 시각 (rollover시)
export function dayStartTs(key, rollover = 4) {
  const d = keyToDate(key);
  d.setHours(rollover, 0, 0, 0);
  return d.getTime();
}
// rollover시부터 몇 분 지났는지 (자정을 넘겨도 이어지게)
const relMin = (ts, rollover) => (((minutesOfDay(ts) - rollover * 60) % 1440) + 1440) % 1440;
export function fmtTime(ts) {
  const d = new Date(ts);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function fmtDate(key) {
  const d = keyToDate(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${'일월화수목금토'[d.getDay()]})`;
}
export function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}
export function ago(ts, now) {
  const m = Math.round((now - ts) / MIN);
  return m < 1 ? '방금' : `${fmtDur(m)} 전`;
}
export function minutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}
export function fmtMinutesOfDay(m) {
  m = Math.round(m);
  return `${p2(Math.floor(m / 60) % 24)}:${p2(m % 60)}`;
}
export function uid(now = Date.now()) {
  return now.toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- 하루 모델 ----------

export function newDay(date) {
  return { v: 1, date, events: [], top3: [], skips: [] };
}
const byT = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || byId(a, b);

export const live = day => (day?.events || []).filter(e => !e.del).sort(byT);
export const wakeOf = day => day?.wake?.t || 0;
export const sleepOf = day => day?.sleep?.t || 0;
export const reviewOf = day => (day?.review && !day.review.off ? day.review : null);
export const isLite = day => !!day?.lite?.on;
export const top3Of = day => (day?.top3 || []).filter(t => !t.del && t.text).sort(byId);

export function activeItems(cfg, key) {
  return (cfg?.items || [])
    .filter(i => !i.del && !(key && i.since && key < i.since))
    .sort(byOrder);
}

export function itemState(day, item) {
  const evs = live(day).filter(e => e.item === item.id);
  const count = evs.length;
  const last = count ? evs[count - 1].t : 0;
  const sum = evs.reduce((s, e) => s + (e.min || 0), 0);
  const lastV = count ? evs[count - 1].v : undefined;
  const sk = (day?.skips || []).find(s => s.id === item.id);
  const skipped = !!sk?.on, missed = !!sk?.miss;
  const done = item.type === 'check' ? count > 0 : item.type === 'count' && item.target ? count >= item.target : false;
  return { evs, count, last, sum, lastV, skipped, missed, done };
}
// 항목별 연속에 쓰는 그날 상태: 1 해냄, -1 건너뜀(쉬는 날), 0 못 함
export function itemStatus(day, item) {
  const s = itemState(day, item);
  return s.done ? 1 : s.skipped ? -1 : 0;
}

export const blockIdx = id => BLOCKS.findIndex(b => b.id === id);
export function blockAt(day, now) {
  const w = wakeOf(day);
  if (!w) return 'am';
  const h = (now - w) / HOUR;
  for (const b of BLOCKS) if (h < b.to) return b.id;
  return 'night';
}
export function blockStart(day, id) {
  return wakeOf(day) + BLOCKS[blockIdx(id)].from * HOUR;
}

// 달성률. 기록형(식사·운동)과 목표 없는 카운터, 건너뛴 항목은 분모에서 뺀다.
export function progress(day, cfg) {
  let total = 0, done = 0, essTotal = 0, essDone = 0;
  for (const it of activeItems(cfg, day?.date)) {
    if (it.type === 'log' || (it.type === 'count' && !it.target)) continue;
    const s = itemState(day, it);
    if (s.skipped) continue;
    total++;
    if (s.done) done++;
    if (it.essential) {
      essTotal++;
      if (s.done) essDone++;
    }
  }
  return { total, done, essTotal, essDone, essAll: essTotal > 0 && essDone === essTotal };
}
export const recorded = day => !!day && (live(day).length > 0 || !!wakeOf(day));

// 하루 전체 상태: 필수를 다 했으면 1. 필수를 일부러 다 건너뛴 날은 -1(쉬는 날). 필수가 없으면 기록만 있어도 1.
export function dayStatus(day, cfg) {
  if (!day) return 0;
  const p = progress(day, cfg);
  if (p.essTotal > 0) return p.essAll ? 1 : 0;
  if (activeItems(cfg, day.date).some(it => it.essential && itemState(day, it).skipped)) return -1;
  return recorded(day) ? 1 : 0;
}

// 어제 체크되지 않은 필수 (했는데 기록만 못 한 경우를 다음 날 바로잡는다)
export function retroItems(day, cfg) {
  if (!day) return [];
  return activeItems(cfg, day.date).filter(it => {
    if (!it.essential || it.type !== 'check') return false;
    const s = itemState(day, it);
    return !s.done && !s.skipped && !s.missed;
  });
}

// ---------- 병합 (기기 간 동기화) ----------
// 모든 조각에 수정 시각 m이 있고, 같은 id는 m이 큰 쪽이 이긴다. 삭제는 del 표시로 남겨 되살아나지 않게 한다.

function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = sortKeys(x[k]);
    return o;
  }
  return x;
}
export const canon = x => JSON.stringify(sortKeys(x));

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const am = a.m || 0, bm = b.m || 0;
  if (bm !== am) return bm > am ? b : a;
  return canon(b) > canon(a) ? b : a;
}
function mergeList(a, b) {
  const map = new Map();
  for (const x of Array.isArray(a) ? a : []) if (x && x.id != null) map.set(x.id, x);
  for (const y of Array.isArray(b) ? b : []) if (y && y.id != null) map.set(y.id, newer(map.get(y.id), y));
  return [...map.values()];
}
export function mergeDay(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { v: 1, date: a.date || b.date };
  for (const k of ['wake', 'sleep', 'review', 'lite']) {
    const v = newer(a[k], b[k]);
    if (v) out[k] = v;
  }
  out.events = mergeList(a.events, b.events).sort(byT);
  out.top3 = mergeList(a.top3, b.top3).sort(byId);
  out.skips = mergeList(a.skips, b.skips).sort(byId);
  return out;
}
export function mergeConfig(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    v: 1,
    items: mergeList(a.items, b.items).sort(byOrder),
    places: mergeList(a.places, b.places).sort(byId),
    ddays: mergeList(a.ddays, b.ddays).sort(byId),
    prefs: newer(a.prefs, b.prefs) || { rollover: 4, m: 0 },
  };
}
export const validDay = d => !!d && typeof d === 'object' && Array.isArray(d.events);
export const validConfig = c => !!c && typeof c === 'object' && Array.isArray(c.items);

// ---------- 장소 ----------

export function distM(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}
export function matchPlace(places, lat, lon) {
  let best = null, bd = Infinity;
  for (const p of places || []) {
    if (p.del) continue;
    const d = distM(lat, lon, p.lat, p.lon);
    if (d <= (p.r || 150) && d < bd) {
      best = p;
      bd = d;
    }
  }
  return best;
}

// ---------- 통계 ----------

export function streak(getDay, todayKey) {
  let k = todayKey, n = 0;
  if (!recorded(getDay(k))) k = addDays(k, -1);
  while (n < 3650 && recorded(getDay(k))) {
    n++;
    k = addDays(k, -1);
  }
  return n;
}

// 연속: 하루는 빠져도 이어지고, 이틀 연속으로 빠지면 끊긴다.
// st(key)는 1 해냄, 0 못 함, -1 쉬는 날(끊지도 늘리지도 않음), null 기록을 시작하기 전.
function runBack(st, key, limit = 3650) {
  let n = 0, gap = 0;
  for (let i = 0; i < limit; i++, key = addDays(key, -1)) {
    const s = st(key);
    if (s === null || s === undefined) break;
    if (s === 1) {
      n++;
      gap = 0;
    } else if (s === 0 && ++gap >= 2) break;
  }
  return n;
}
export function chainInfo(st, todayKey) {
  const y = addDays(todayKey, -1);
  const today = st(todayKey) === 1;
  const past = runBack(st, y);
  const out = { n: (today ? 1 : 0) + past, today, atRisk: !today && st(y) === 0 && past > 0, comeback: 0 };
  // 끊긴 뒤 다시 온 날: 지난번 연속이 얼마였는지 알려준다
  if (!today && past === 0) {
    let k = y;
    for (let i = 0; i < 60; i++, k = addDays(k, -1)) {
      const s = st(k);
      if (s === null || s === undefined) break;
      if (s === 1) {
        out.comeback = runBack(st, k);
        break;
      }
    }
  }
  return out;
}

// 평소 이 항목을 한 시각. 기상 기록이 있으면 "기상 후 몇 분"의 중앙값을 그날 기상에 더한다.
export function usualTime(item, days, { wake = 0, key, rollover = 4 } = {}) {
  const offs = [], rels = [];
  for (const d of days) {
    if (!d || d.date === key) continue;
    const ev = live(d).find(e => e.item === item.id);
    if (!ev) continue;
    rels.push(relMin(ev.t, rollover));
    if (wakeOf(d) && ev.t >= wakeOf(d)) offs.push(ev.t - wakeOf(d));
  }
  const med = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  if (wake && offs.length >= 3) return wake + med(offs);
  if (rels.length >= 3) return dayStartTs(key, rollover) + med(rels) * MIN;
  return null;
}

// 기록이 쌓이기 전에 "아까 했어요"가 쓸 시각: 그날 기상 기준, 기상도 없으면 시간대별 보통 시각
const FALLBACK_MIN = { am: 9 * 60, day: 13 * 60, pm: 19 * 60, night: 23 * 60 + 30, any: 12 * 60 };
export function guessTime(item, day, { key, rollover = 4 } = {}) {
  const w = wakeOf(day);
  const i = blockIdx(item.block);
  if (w) return w + (i < 0 ? 1 : BLOCKS[i].from + (i === 0 ? 0.25 : 0.5)) * HOUR;
  const m = FALLBACK_MIN[item.block] ?? 12 * 60;
  return dayStartTs(key, rollover) + ((((m - rollover * 60) % 1440) + 1440) % 1440) * MIN;
}

// 평소 기상 시각(자정부터 분). 표본이 3일 미만이면 null.
export function typicalWake(days) {
  const xs = days.filter(d => wakeOf(d)).map(d => minutesOfDay(wakeOf(d))).sort((a, b) => a - b);
  return xs.length >= 3 ? xs[Math.floor(xs.length / 2)] : null;
}

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// days: 날짜 오름차순 배열(기록 없는 날은 null)
export function summarize(days, cfg) {
  const rec = days.filter(recorded);
  const items = (cfg?.items || []).filter(i => !i.del);
  const catOf = new Map(items.map(i => [i.id, i.cat]));
  const sleeps = [];
  for (let i = 1; i < days.length; i++) {
    const a = days[i - 1], b = days[i];
    if (sleepOf(a) && wakeOf(b)) {
      const h = (wakeOf(b) - sleepOf(a)) / HOUR;
      if (h > 2 && h < 16) sleeps.push(h);
    }
  }
  const all = rec.flatMap(d => live(d));
  const counts = items.filter(i => i.type === 'count').map(i => ({
    item: i,
    perDay: rec.length ? all.filter(e => e.item === i.id).length / rec.length : 0,
  }));
  const meds = items.filter(i => i.cat === 'med' && i.type === 'check').map(i => {
    const offs = [];
    for (const d of rec) {
      const ev = live(d).find(e => e.item === i.id);
      if (ev && wakeOf(d)) offs.push((ev.t - wakeOf(d)) / MIN);
    }
    return { item: i, days: rec.filter(d => live(d).some(e => e.item === i.id)).length, afterWake: avg(offs) };
  });
  return {
    recorded: rec.length,
    essDays: rec.filter(d => progress(d, cfg).essAll).length,
    wakeAvg: avg(rec.filter(d => wakeOf(d)).map(d => minutesOfDay(wakeOf(d)))),
    sleepAvg: avg(sleeps),
    focusMin: all.filter(e => e.item === 'focus').reduce((s, e) => s + (e.min || 0), 0),
    moveMin: all.filter(e => catOf.get(e.item) === 'move').reduce((s, e) => s + (e.min || 0), 0),
    energyAvg: avg(all.filter(e => e.item === 'energy').map(e => e.v)),
    moodAvg: avg(all.filter(e => e.item === 'mood').map(e => e.v)),
    scoreAvg: avg(rec.map(reviewOf).filter(r => r && r.score).map(r => r.score)),
    counts,
    meds,
  };
}

// ---------- EXP · 시즌 · D-day · 누적 목표 ----------
// 끝내기 쉬운 조건을 화면에 만든다: 그날 보이는 결과(EXP), 바꿀 수 없는 날짜(시즌 끝·D-day), 닫힌 범위(누적 목표).

export const EXP_GOAL = 100;
export const SEASON_DAYS = 14;

export function itemExp(it) {
  if (it.type === 'check') return it.essential ? 30 : 15;
  if (it.type === 'count') return it.caffeine ? 0 : 4;
  return 10;
}
export function expOf(day, cfg) {
  if (!day) return 0;
  let total = wakeOf(day) ? 10 : 0;
  for (const it of activeItems(cfg, day.date)) {
    const s = itemState(day, it);
    if (it.type === 'check') total += s.done ? itemExp(it) : 0;
    else if (it.type === 'count') total += itemExp(it) * Math.min(s.count, it.target || 8);
    else total += itemExp(it) * Math.min(s.count, 4);
  }
  const evs = live(day);
  const focusMin = evs.filter(e => e.item === 'focus').reduce((a, e) => a + (e.min || 0), 0);
  total += Math.min(60, Math.round(focusMin / 2.5));
  total += 3 * Math.min(4, evs.filter(e => e.item === 'energy' || e.item === 'mood').length);
  total += 20 * top3Of(day).filter(t => t.done).length;
  if (reviewOf(day)) total += 20;
  return total;
}

const dayDiff = (a, b) => Math.round((keyToDate(b) - keyToDate(a)) / 86400000);

export function seasonInfo(todayKey, startKey) {
  const passed = Math.max(0, dayDiff(startKey || todayKey, todayKey));
  const n = Math.floor(passed / SEASON_DAYS) + 1;
  const start = addDays(startKey || todayKey, (n - 1) * SEASON_DAYS);
  const day = (passed % SEASON_DAYS) + 1;
  return { n, day, start, end: addDays(start, SEASON_DAYS - 1), left: SEASON_DAYS - day };
}
export function seasonStats(days, cfg) {
  const rec = days.filter(recorded);
  return {
    recorded: rec.length,
    essDays: rec.filter(d => progress(d, cfg).essAll).length,
    clearDays: rec.filter(d => expOf(d, cfg) >= EXP_GOAL).length,
    exp: rec.reduce((s, d) => s + expOf(d, cfg), 0),
  };
}

// D-day: to가 있으면 남은 날, from이 있으면 몇 주차인지
export function ddayInfo(d, todayKey) {
  const out = { label: d.label, text: '' };
  const parts = [];
  if (d.from && d.from <= todayKey) {
    out.week = Math.floor(dayDiff(d.from, todayKey) / 7) + 1;
    parts.push(`${out.week}주차`);
  }
  if (d.to) {
    out.left = dayDiff(todayKey, d.to);
    parts.push(out.left > 0 ? `D-${out.left}` : out.left === 0 ? 'D-DAY' : `D+${-out.left}`);
  }
  if (d.from && d.to && d.to > d.from) out.pct = Math.min(100, Math.max(0, Math.round((dayDiff(d.from, todayKey) / dayDiff(d.from, d.to)) * 100)));
  out.text = parts.join(' · ');
  return out;
}

// 누적 목표: 시작일부터 쌓인 횟수 (닫힌 범위 "30개 중 12개")
export function goalCount(item, days) {
  let n = 0;
  for (const d of days) {
    if (!d || (item.goal?.from && d.date < item.goal.from)) continue;
    for (const e of d.events || []) if (!e.del && e.item === item.id) n++;
  }
  return n;
}

// 사람에게 보내는 하루 보고 (기다리는 사람을 만든다)
export function dayReport(day, cfg) {
  const p = progress(day, cfg);
  const lines = [`[${fmtDate(day.date)} 보고]`, `EXP ${expOf(day, cfg)}/${EXP_GOAL} · 필수 ${p.essDone}/${p.essTotal}`];
  const bits = [];
  for (const it of activeItems(cfg, day.date)) {
    const s = itemState(day, it);
    if (!s.count) continue;
    if (it.type === 'check') bits.push(`${it.name} ${fmtTime(s.last)}`);
    else if (it.type === 'count') bits.push(`${it.name} ${s.count}${it.unit || '번'}`);
    else if (it.ask === 'min') bits.push(`${it.name} ${fmtDur(s.sum)}`);
    else if (it.ask === 'num') bits.push(`${it.name} ${s.lastV}${it.unit || ''}`);
    else bits.push(`${it.name} ${s.count}번`);
  }
  const focus = live(day).filter(e => e.item === 'focus').reduce((a, e) => a + (e.min || 0), 0);
  if (focus) bits.push(`집중 ${fmtDur(focus)}`);
  if (bits.length) lines.push(bits.join(', '));
  const t3 = top3Of(day);
  if (t3.length) lines.push(`핵심 ${t3.filter(t => t.done).length}/${t3.length}: ` + t3.map(t => (t.done ? '✓' : '·') + t.text).join(' / '));
  const r = reviewOf(day);
  if (r?.note) lines.push(`한 줄: ${r.note}`);
  return lines.join('\n');
}

// ---------- 코치 ----------
// 지금 상태를 보고 제안을 우선순위 순으로 돌려준다. 맨 앞 하나가 화면에 나온다.

export function coach({ now, day, cfg, local = {}, typical = null, chain = null }) {
  const wake = wakeOf(day);
  if (!wake) {
    return [{ pri: 0, key: 'start', icon: '☀️', tone: 'now', title: '하루를 시작해 볼까요?', sub: '일어난 시간만 알려주면 오늘 흐름을 거기에 맞출게요' }];
  }
  if (reviewOf(day)) {
    return [{ pri: 0, key: 'closed', icon: '🌙', tone: 'good', title: '오늘 하루 마감 완료', sub: '푹 쉬어요. 내일 일어나면 다시 만나요' }];
  }
  const out = [];
  const snoozed = k => (local.snooze?.[k] || 0) > now;
  const push = (pri, s) => {
    if (!snoozed(s.key)) out.push({ pri, tone: 'now', ...s });
  };
  const hrs = (now - wake) / HOUR;
  const cur = blockAt(day, now), ci = blockIdx(cur);
  const items = activeItems(cfg, day.date);
  const st = new Map(items.map(i => [i.id, itemState(day, i)]));
  const lite = isLite(day);
  const evs = live(day);

  // 0) 기상 시각을 첫 기록으로 짐작한 경우: 한 번만 확인
  if (day.wake?.auto && hrs < 10) {
    push(6, {
      key: 'wake-auto',
      icon: '☀️',
      tone: 'calm',
      title: `일어난 시각이 ${fmtTime(wake)} 맞아요?`,
      sub: '첫 기록 시각으로 잡았어요. 고치면 시간대가 그에 맞춰져요',
      action: { label: '고치기', act: 'time-wake' },
      alt: { label: '맞아요', act: 'wake-ok' },
    });
  }

  // 연속이 걸린 날은 필수 제안에 그 이야기를 붙인다
  let chainSub = '';
  if (chain && !chain.today) {
    if (chain.atRisk) chainSub = `어제는 쉬었어요. 오늘 필수를 하면 🔥${chain.n}일이 이어져요`;
    else if (chain.comeback >= 2) chainSub = `다시 시작하는 날이에요. 지난번엔 🔥${chain.comeback}일 이어갔어요`;
  }

  // 1) 지금 시간대이거나 앞 시간대에서 넘어온 체크 항목
  let n = 0;
  for (const it of items) {
    if (it.type !== 'check' || it.block === 'any') continue;
    const s = st.get(it.id);
    if (s.done || s.skipped) continue;
    const bi = blockIdx(it.block);
    if (bi > ci || (lite && !it.essential)) continue;
    const late = bi < ci;
    const verb = it.cat === 'med' ? '먹었어요' : '했어요';
    // 시간대가 시작되고 20분이 지났으면 "아까 했는데 기록만 못 한" 경우를 바로 받아준다
    const ago = now - Math.max(wake, blockStart(day, it.block)) >= 20 * MIN;
    const base = late ? `${BLOCK_NAMES[it.block]} 루틴에서 넘어왔어요. 지금 해도 충분해요` : it.cue || `${BLOCK_NAMES[it.block]} 루틴`;
    push((it.essential ? 10 : 30) + (late ? 0 : 2) + n++ * 0.01, {
      key: 'do:' + it.id,
      icon: it.icon,
      // 지난 시간대에서 넘어왔으면 이미 했을 수도 있으니 묻는다
      title: late ? `${it.name} ${verb.replace('어요', '어요?')}` : it.cat === 'med' ? `${it.name} 챙길 시간이에요` : `${it.name} 할 차례예요`,
      sub: (it.essential && chainSub) || base,
      action: { label: '방금 ' + verb, act: 'check', arg: it.id },
      alt: ago ? { label: '아까 ' + verb, act: 'ago', arg: it.id } : { label: '오늘은 건너뛰기', act: 'skip', arg: it.id },
    });
  }

  // 2) 식사
  const meal = items.find(i => i.cat === 'meal' && i.type === 'log');
  if (meal) {
    const s = st.get(meal.id);
    if (!s.count && hrs >= 1.5) {
      push(20, { key: 'meal:first', icon: meal.icon, title: '첫 끼는 드셨어요?', sub: `일어난 지 ${fmtDur(hrs * 60)} 지났어요`, action: { label: '식사 기록', act: 'log', arg: meal.id } });
    } else if (s.count && now - s.last >= 5 * HOUR && cur !== 'night') {
      push(24, { key: 'meal:gap', icon: meal.icon, title: '식사한 지 꽤 됐어요', sub: `마지막 식사 ${ago(s.last, now)}`, action: { label: '식사 기록', act: 'log', arg: meal.id } });
    }
  }

  // 3) 간격 알림 (물 등)
  for (const it of items) {
    if (it.type !== 'count' || !it.every) continue;
    const s = st.get(it.id);
    if (it.target && s.count >= it.target) continue;
    if (now - (s.last || wake) < it.every * MIN) continue;
    push(26, {
      key: 'every:' + it.id,
      icon: it.icon,
      title: `${it.name} 한 ${it.unit || '번'} 어때요?`,
      sub: (s.last ? `마지막 ${ago(s.last, now)}` : '오늘 아직 기록이 없어요') + (it.target ? ` · ${s.count}/${it.target}${it.unit || ''}` : ''),
      action: { label: '+1', act: 'count', arg: it.id },
    });
  }

  // 4) 효과 구간: 사용자가 항목에 직접 입력한 "복용 후 몇 분부터 몇 시간" 안에 있는지
  let fxItem = null, fxEnd = 0;
  for (const it of items) {
    if (!it.fx || !it.fx.dur) continue;
    const s = st.get(it.id);
    if (!s.count) continue;
    const a = s.last + (it.fx.on || 0) * MIN, b = a + it.fx.dur * HOUR;
    if (now >= a && now < b && b > fxEnd) {
      fxItem = it;
      fxEnd = b;
    }
  }

  // 5) 오늘의 핵심 3가지
  const t3 = top3Of(day), open = t3.filter(t => !t.done);
  if (!t3.length && hrs < 8 && !lite) {
    push(28, { key: 't3:set', icon: '🎯', title: '오늘 가장 중요한 일을 정해요', sub: '3가지만 정해도 하루가 선명해져요', action: { label: '정하기', act: 't3-edit', arg: 't1' } });
  }
  if (open.length && !local.focus && cur !== 'night') {
    const t = open[0];
    push(fxItem ? 22 : 34, {
      key: 't3:go:' + t.id,
      icon: '🎯',
      title: `핵심: ${t.text}`,
      sub: fxItem ? `${fxItem.name} 효과 구간이에요 (${fmtTime(fxEnd)}까지). 25분만 시작해요` : '25분만 먼저 시작해 볼까요?',
      action: { label: '25분 집중', act: 'focus', arg: '25:' + t.id },
      alt: { label: '이미 끝냈어요', act: 't3-done', arg: t.id },
    });
  } else if (fxItem && !local.focus) {
    push(27, { key: 'fx:' + fxItem.id, icon: '⚡', title: '집중하기 좋은 구간이에요', sub: `${fxItem.name} 효과 구간 · ${fmtTime(fxEnd)}까지`, action: { label: '25분 집중', act: 'focus', arg: '25' } });
  }

  // 6) 컨디션
  const conds = evs.filter(e => e.item === 'energy' || e.item === 'mood');
  const lastCond = conds.length ? conds[conds.length - 1].t : 0;
  if (hrs >= 1 && now - (lastCond || wake) >= 4 * HOUR) {
    push(36, { key: 'cond', icon: '🙂', tone: 'calm', title: '지금 컨디션은 어때요?', sub: '에너지와 기분을 한 번씩만 눌러 주세요', action: { label: '기록하기', act: 'go-cond' } });
  }
  const energies = evs.filter(e => e.item === 'energy');
  const le = energies[energies.length - 1];
  if (le && le.v <= 2 && now - le.t < 2 * HOUR) {
    push(18, {
      key: 'low',
      icon: '🫧',
      tone: 'calm',
      title: '에너지가 낮을 땐 작게 가요',
      sub: lite ? '물 한 잔, 5분 걷기부터 해봐요' : '오늘은 필수만 챙겨도 충분해요',
      action: lite ? null : { label: '가볍게 모드', act: 'lite', arg: '1' },
    });
  }

  // 7) 평소보다 2시간 넘게 늦게 시작한 날
  if (typical != null && !lite && hrs < 3 && minutesOfDay(wake) - typical >= 120) {
    push(16, { key: 'late', icon: '🌤️', tone: 'calm', title: '늦게 시작해도 괜찮아요', sub: '오늘은 필수만 챙기는 가볍게 모드 어때요?', action: { label: '가볍게 모드', act: 'lite', arg: '1' } });
  }

  // 8) 늦은 카페인
  const caf = items.find(i => i.caffeine);
  if (caf && st.get(caf.id).count && hrs >= 9 && hrs < 13) {
    push(40, { key: 'caf', icon: '☕', tone: 'calm', title: '지금부터는 카페인을 쉬어가요', sub: '늦은 커피는 잠드는 시간을 미룰 수 있어요' });
  }

  // 9) 하루 마감
  if (cur === 'night') {
    push(14, { key: 'review', icon: '🌙', title: '하루 마감 1분', sub: '오늘을 한 줄로 정리하고 내일을 가볍게 준비해요', action: { label: '마감하기', act: 'review' } });
  }

  out.sort((a, b) => a.pri - b.pri);
  if (!out.length) {
    const next = items.find(i => i.type === 'check' && i.block !== 'any' && blockIdx(i.block) > ci && !st.get(i.id).done && !st.get(i.id).skipped && !(lite && !i.essential));
    out.push({
      pri: 99,
      key: 'clear',
      icon: '👏',
      tone: 'good',
      title: '지금 할 일은 다 했어요',
      sub: next ? `다음은 ${BLOCK_NAMES[next.block]} 루틴이에요 (${fmtTime(blockStart(day, next.block))}쯤부터)` : '남은 시간은 편하게 보내요',
    });
  }
  return out;
}
