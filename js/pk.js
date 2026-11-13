// 약 효과 곡선: 단순한 1구획 모델로 "피 속 농도의 모양"을 흉내 낸다.
// 약 정보(프로필)는 공개 코드에 없고, 비공개 저장소의 meds.json에서 온다.
//
// 프로필 예:
//   { id, name, kind: 'curve' | 'steady', group, halfLife,
//     parts: [ { f: 0.5, lag: 0.5, ka: 1.8 },              // 먹고 lag시간 뒤부터 흡수 (속효 부분)
//              { f: 0.5, zo: [1, 8], ramp: 0.5 } ] }      // 1~8시간에 걸쳐 조금씩 나옴 (ramp>0이면 갈수록 많이)
// 결과는 1mg당 상대값이라 같은 성분(group)끼리 더할 수 있다. 절대 농도가 아니다.

import { HOUR, MIN, live, keyToDate } from './core.js';

export const DT = 0.05; // 시간 단위 계산 간격 (3분)
export const SPAN = 30; // 한 번 먹은 약을 30시간까지 본다
export const EFFECT = 0.35; // 자기 최고점의 35% 이상을 "효과 구간"으로 본다
export const PEAK = 0.8; // 80% 이상을 "가장 높은 구간"으로 본다

const cache = new Map();

// 1회 복용(1mg)의 곡선. index i는 먹은 뒤 i*DT시간.
export function simulate(p) {
  const key = JSON.stringify([p.halfLife, p.parts]);
  if (cache.has(key)) return cache.get(key);
  const ke = Math.LN2 / (p.halfLife || 3);
  const n = Math.ceil(SPAN / DT);
  const out = new Float64Array(n + 1);
  const gut = (p.parts || []).map(() => 0);
  const dosed = (p.parts || []).map(() => false);
  let central = 0;
  for (let i = 0; i <= n; i++) {
    const t = i * DT;
    out[i] = central;
    let input = 0;
    (p.parts || []).forEach((q, j) => {
      if (q.ka) {
        if (!dosed[j] && t >= (q.lag || 0)) {
          gut[j] += q.f;
          dosed[j] = true;
        }
        const a = Math.min(gut[j], q.ka * gut[j] * DT);
        gut[j] -= a;
        input += a;
      } else if (q.zo) {
        const [a, b] = q.zo;
        if (t >= a && t < b) {
          const x = (t - a) / (b - a), r = q.ramp || 0;
          input += (q.f / (b - a)) * (1 - r + 2 * r * x) * DT;
        }
      }
    });
    central = Math.max(0, central + input - ke * central * DT);
  }
  cache.set(key, out);
  return out;
}

// 먹은 지 h시간 뒤의 값 (1mg당)
export function valueAt(p, h) {
  if (h < 0 || h > SPAN) return 0;
  const c = simulate(p), x = h / DT, i = Math.floor(x);
  if (i >= c.length - 1) return c[c.length - 1];
  return c[i] + (c[i + 1] - c[i]) * (x - i);
}

// 자기 최고점 기준으로 본 시간 정보 (먹은 뒤 몇 시간)
export function shape(p) {
  const c = simulate(p);
  let max = 0, iMax = 0;
  for (let i = 0; i < c.length; i++) if (c[i] > max) [max, iMax] = [c[i], i];
  const at = th => {
    let a = -1, b = -1;
    for (let i = 0; i < c.length; i++) if (c[i] >= th * max) {
      if (a < 0) a = i;
      b = i;
    }
    return a < 0 ? null : [a * DT, b * DT];
  };
  const eff = at(EFFECT), pk = at(PEAK);
  return { max, tmax: iMax * DT, onset: eff?.[0] ?? 0, end: eff?.[1] ?? 0, peak: pk || [iMax * DT, iMax * DT] };
}

// ---------- 오늘의 복용 기록 → 곡선 ----------

// 항목에 연결된 약: item.drugs = [{ id, mg }]
export function dosesOf(days, items, profiles) {
  const byId = new Map((profiles || []).map(p => [p.id, p]));
  const itemMap = new Map((items || []).map(i => [i.id, i]));
  const out = [];
  for (const d of days) {
    if (!d) continue;
    for (const e of live(d)) {
      const it = itemMap.get(e.item);
      for (const link of it?.drugs || []) {
        const p = byId.get(link.id);
        if (p) out.push({ id: e.id + ':' + p.id, ev: e.id, item: it.id, t: e.t, p, mg: +link.mg || +p.mg || 1, date: d.date });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// 같은 성분끼리 더한 곡선을 t0~t1 구간에서 step 간격으로 샘플링
export function series(doses, t0, t1, step = 10 * MIN) {
  const ts = [];
  for (let t = t0; t <= t1; t += step) ts.push(t);
  const groups = new Map();
  for (const d of doses) {
    if (d.p.kind !== 'curve') continue;
    const g = d.p.group || d.p.id;
    if (!groups.has(g)) groups.set(g, { group: g, name: d.p.groupName || d.p.name, total: new Float64Array(ts.length), parts: [] });
    const G = groups.get(g);
    const ys = new Float64Array(ts.length);
    ts.forEach((t, i) => {
      ys[i] = valueAt(d.p, (t - d.t) / HOUR) * d.mg;
      G.total[i] += ys[i];
    });
    G.parts.push({ dose: d, ys });
  }
  return { ts, groups: [...groups.values()] };
}

// 값이 기준 이상인 구간들 [[시작, 끝], ...]
export function windows(ts, ys, th) {
  const out = [];
  let s = null;
  for (let i = 0; i < ts.length; i++) {
    if (ys[i] >= th && s === null) s = ts[i];
    if ((ys[i] < th || i === ts.length - 1) && s !== null) {
      out.push([s, ys[i] >= th ? ts[i] : ts[i - 1]]);
      s = null;
    }
  }
  return out;
}

// 지금 이 성분이 하루 최고점의 몇 %인지와 효과 구간·가장 높은 구간.
// 효과 구간의 기준은 "한 번 먹었을 때의 최고점"이다. 하루 최고점을 기준으로 하면
// 오후에 한 번 더 먹은 날 오전 효과가 사라진 것처럼 보이기 때문.
export function groupStatus(G, ts, now) {
  let max = 0;
  for (const v of G.total) max = Math.max(max, v);
  if (!max) return null;
  const ref = Math.max(...G.parts.map(P => P.dose.mg * shape(P.dose.p).max));
  let i = ts.findIndex(t => t > now);
  i = i < 0 ? ts.length - 1 : Math.max(0, i - 1);
  return {
    max,
    effRel: (EFFECT * ref) / max,
    nowRel: G.total[i] / max,
    effect: windows(ts, G.total, EFFECT * ref),
    peak: windows(ts, G.total, PEAK * max),
  };
}

// 한 번 먹으면 언제 효과가 있고 언제 끝나는지 (절대 시각)
export function plan(p, t) {
  const s = shape(p);
  return { start: t + s.onset * HOUR, end: t + s.end * HOUR, peak: [t + s.peak[0] * HOUR, t + s.peak[1] * HOUR], tmax: t + s.tmax * HOUR };
}

// 오래 쌓이는 약: 매일 먹기 시작한 지 며칠째인지 (가장 이른 기록 기준)
export function steadyInfo(days, itemIds, todayKey) {
  let first = null;
  for (const d of days) {
    if (!d || !live(d).some(e => itemIds.includes(e.item))) continue;
    if (!first || d.date < first) first = d.date;
  }
  if (!first) return null;
  const days_ = Math.round((keyToDate(todayKey) - keyToDate(first)) / 86400000) + 1;
  return { first, day: days_, week: Math.floor((days_ - 1) / 7) + 1 };
}

// ---------- 내 데이터로 본 피크 ----------
// 기록한 집중도(없으면 에너지)를 "약 먹고 몇 시간째", "일어나고 몇 시간째", "몇 시"로 묶어 평균을 낸다.

export function peakStats(days, { mode = 'dose', doses = [], rating = 'attn', bins = 15, wakeOf } = {}) {
  const sum = new Float64Array(bins), n = new Uint16Array(bins), focus = new Float64Array(bins);
  const add = (h, v, f) => {
    const b = Math.floor(h);
    if (b < 0 || b >= bins) return;
    if (v != null) {
      sum[b] += v;
      n[b]++;
    }
    if (f) focus[b] += f;
  };
  for (const d of days) {
    if (!d) continue;
    const dayDoses = doses.filter(x => x.date === d.date && x.p.kind === 'curve');
    const w = wakeOf ? wakeOf(d) : 0;
    for (const e of live(d)) {
      const isR = e.item === rating && e.v != null, isF = e.item === 'focus' && e.min;
      if (!isR && !isF) continue;
      let h;
      if (mode === 'dose') {
        const before = dayDoses.filter(x => x.t <= e.t);
        if (!before.length) continue;
        h = (e.t - before[0].t) / HOUR; // 그날 첫 복용 기준
      } else if (mode === 'wake') {
        if (!w) continue;
        h = (e.t - w) / HOUR;
      } else h = new Date(e.t).getHours() + new Date(e.t).getMinutes() / 60;
      add(h, isR ? e.v : null, isF ? e.min : 0);
    }
  }
  const avg = [...sum].map((s, i) => (n[i] ? s / n[i] : null));
  return { avg, n: [...n], focus: [...focus], total: [...n].reduce((a, b) => a + b, 0) };
}

// 평균이 가장 높은 연속 구간 (각 칸에 기록이 minN개 이상일 때만)
export function bestWindow(stats, { width = 2, minN = 2 } = {}) {
  let best = null;
  for (let i = 0; i + width <= stats.avg.length; i++) {
    let s = 0, c = 0, ok = true;
    for (let j = i; j < i + width; j++) {
      if (stats.n[j] < minN) {
        ok = false;
        break;
      }
      s += stats.avg[j] * stats.n[j];
      c += stats.n[j];
    }
    if (ok && (!best || s / c > best.avg)) best = { from: i, to: i + width, avg: s / c, n: c };
  }
  return best;
}
