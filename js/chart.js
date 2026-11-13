// 오늘 흐름을 그리는 SVG. 가로축은 기상부터 예상 마무리까지의 시간이다.
import { live, wakeOf, sleepOf, HOUR, MIN, AWAKE_HOURS, BLOCKS, SPECIAL } from './core.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = n => +n.toFixed(1);

export function domain(day, now, isToday) {
  const evs = live(day);
  const starts = [wakeOf(day), evs[0]?.t].filter(Boolean);
  const t0 = starts.length ? Math.min(...starts) : now;
  const last = evs.reduce((mx, e) => Math.max(mx, e.t + (e.min || 0) * MIN), t0);
  let t1 = sleepOf(day) || (isToday ? t0 + AWAKE_HOURS * HOUR : Math.max(last + HOUR, t0 + 12 * HOUR));
  t1 = Math.max(t1, last + 20 * MIN, isToday ? now + 20 * MIN : 0);
  return [t0, t1];
}

// 사용자가 항목에 입력한 효과 구간 [시작, 끝]
function bands(day, items) {
  const out = [];
  for (const e of live(day)) {
    const it = items.get(e.item);
    if (it?.fx?.dur) {
      const a = e.t + (it.fx.on || 0) * MIN;
      out.push([a, a + it.fx.dur * HOUR]);
    }
  }
  return out;
}

// 오늘 탭 맨 위의 한 줄짜리 띠 (extra: 약 정보로 계산한 효과 구간 [[시작, 끝]])
export function stripSvg(day, cfg, now, isToday, extra = []) {
  const W = 328, L = 8, R = W - 8, Y = 38, TH = 12;
  const [t0, t1] = domain(day, now, isToday);
  const x = t => r1(L + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (R - L));
  const items = new Map((cfg.items || []).map(i => [i.id, i]));
  const wake = wakeOf(day);
  let s = `<rect x="${L}" y="${Y}" width="${R - L}" height="${TH}" rx="6" class="st-track"/>`;
  const endX = isToday ? x(now) : R;
  if (endX - L > 1) s += `<rect x="${L}" y="${Y}" width="${r1(endX - L)}" height="${TH}" rx="6" class="st-fill"/>`;
  for (const [a, b] of [...bands(day, items), ...extra]) {
    if (b > t0 && a < t1) s += `<rect x="${x(a)}" y="${Y - 6}" width="${Math.max(3, r1(x(b) - x(a)))}" height="3.5" rx="1.75" class="st-fx"/>`;
  }
  if (wake) {
    for (const b of BLOCKS.slice(1)) {
      const tb = wake + b.from * HOUR;
      if (tb > t0 && tb < t1) s += `<line x1="${x(tb)}" x2="${x(tb)}" y1="${Y - 1}" y2="${Y + TH + 1}" class="st-div"/>`;
    }
  }
  const rows = [-99, -99];
  for (const e of live(day)) {
    const it = items.get(e.item) || SPECIAL[e.item];
    if (!it || e.item === 'energy' || e.item === 'mood') continue;
    const px = x(e.t);
    if (it.cat === 'drink') {
      s += `<circle cx="${px}" cy="${Y + TH / 2}" r="2.3" class="st-dot"/>`;
      continue;
    }
    const r = px - rows[0] >= 15 ? 0 : px - rows[1] >= 15 ? 1 : -1;
    if (r < 0) continue;
    rows[r] = px;
    s += `<text x="${Math.min(Math.max(px, L + 8), R - 8)}" y="${r ? 14 : 30}" class="st-em">${esc(it.icon)}</text>`;
  }
  if (isToday) s += `<line x1="${x(now)}" x2="${x(now)}" y1="${Y - 6}" y2="${Y + TH + 6}" class="st-now"/>`;
  return `<svg viewBox="0 0 ${W} 60" class="strip-svg" role="img" aria-label="오늘 흐름 요약">${s}</svg>`;
}

// 흐름 탭의 큰 그래프: 약·루틴 / 식사 / 음료 / 집중·운동 / 컨디션
export function flowSvg(day, cfg, now, isToday, extra = []) {
  const W = 340, L = 10, R = W - 10, H = 296;
  const LN = { rt: 34, meal: 80, drink: 126, act: 172, cond: 218 };
  const [t0, t1] = domain(day, now, isToday);
  const x = t => r1(L + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (R - L));
  const items = new Map((cfg.items || []).map(i => [i.id, i]));
  const evs = live(day), wake = wakeOf(day), sleep = sleepOf(day);
  let s = '';

  const span = (t1 - t0) / HOUR, step = span > 15 ? 3 : span > 8 ? 2 : 1;
  const h0 = new Date(t0);
  h0.setMinutes(0, 0, 0);
  for (let t = h0.getTime(); t <= t1; t += HOUR) {
    const hr = new Date(t).getHours();
    if (t < t0 || hr % step) continue;
    s += `<line x1="${x(t)}" x2="${x(t)}" y1="22" y2="${H - 22}" class="fl-grid"/><text x="${x(t)}" y="${H - 7}" class="fl-ax">${hr}시</text>`;
  }
  if (wake) {
    BLOCKS.forEach((b, i) => {
      const a = Math.max(t0, wake + b.from * HOUR), e = Math.min(t1, wake + Math.min(b.to, 99) * HOUR);
      if (e <= a) return;
      if (i && a > t0) s += `<line x1="${x(a)}" x2="${x(a)}" y1="4" y2="${H - 22}" class="fl-div"/>`;
      if (x(e) - x(a) >= 36) s += `<text x="${r1((x(a) + x(e)) / 2)}" y="13" class="fl-blk">${b.name}</text>`;
    });
  }

  const lane = (y, label) => `<text x="${L}" y="${y - 5}" class="fl-lb">${label}</text><line x1="${L}" x2="${R}" y1="${y + 28}" y2="${y + 28}" class="fl-base"/>`;
  s += lane(LN.rt, '약·루틴') + lane(LN.meal, '식사') + lane(LN.drink, '물·음료') + lane(LN.act, '집중·운동');
  s += `<text x="${L}" y="${LN.cond - 5}" class="fl-lb">컨디션 <tspan class="fl-en-t" dx="6">● 에너지</tspan> <tspan class="fl-mo-t" dx="4">● 기분</tspan> <tspan class="fl-at-t" dx="4">● 집중도</tspan></text>`;
  for (const v of [1, 3, 5]) s += `<line x1="${L}" x2="${R}" y1="${LN.cond + 46 - ((v - 1) / 4) * 40}" y2="${LN.cond + 46 - ((v - 1) / 4) * 40}" class="fl-base"/>`;

  for (const [a, b] of [...bands(day, items), ...extra]) {
    if (b > t0 && a < t1) s += `<rect x="${x(a)}" y="${LN.rt + 2}" width="${Math.max(3, r1(x(b) - x(a)))}" height="24" rx="6" class="fl-fx"/>`;
  }

  const lastX = { rt: -99, meal: -99, drink: -99 };
  const mark = (ln, t, icon, size) => {
    let px = x(t);
    if (px - lastX[ln] < size) px = lastX[ln] + size;
    lastX[ln] = px;
    return `<text x="${Math.min(px, R - 6)}" y="${LN[ln] + 21}" class="fl-em" style="font-size:${size}px">${esc(icon)}</text>`;
  };
  const bar = (t, min, cls) => {
    const a = x(t), w = Math.max(4, r1(x(t + Math.max(min, 1) * MIN) - a));
    return `<rect x="${a}" y="${LN.act + 4}" width="${w}" height="20" rx="6" class="${cls}"/>` + (w >= 32 ? `<text x="${r1(a + w / 2)}" y="${LN.act + 18}" class="fl-bt">${min}분</text>` : '');
  };

  if (wake) s += mark('rt', wake, '☀️', 15);
  for (const e of evs) {
    const it = items.get(e.item);
    if (e.item === 'focus') s += bar(e.t, e.min || 1, 'fl-focus');
    else if (!it) continue;
    else if (it.cat === 'move') s += bar(e.t, e.min || 1, 'fl-move');
    else if (it.cat === 'meal') s += mark('meal', e.t, it.icon, 15);
    else if (it.cat === 'drink') s += mark('drink', e.t, it.icon, 12);
    else s += mark('rt', e.t, it.icon, 15);
  }
  if (sleep) s += mark('rt', sleep, '🌙', 15);

  const cy = v => r1(LN.cond + 46 - ((v - 1) / 4) * 40);
  for (const [id, cls] of [['energy', 'fl-en'], ['mood', 'fl-mo'], ['attn', 'fl-at']]) {
    const pts = evs.filter(e => e.item === id && e.v);
    if (pts.length > 1) s += `<polyline points="${pts.map(e => `${x(e.t)},${cy(e.v)}`).join(' ')}" class="${cls}"/>`;
    for (const e of pts) s += `<circle cx="${x(e.t)}" cy="${cy(e.v)}" r="3.6" class="${cls} pt"/>`;
  }

  if (isToday) {
    const nx = x(now);
    s += `<line x1="${nx}" x2="${nx}" y1="20" y2="${H - 22}" class="fl-now"/><path d="M${nx - 4.5} 15h9l-4.5 6z" class="fl-nowm"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="flow-svg" role="img" aria-label="시간대별 약, 식사, 음료, 집중과 운동, 컨디션 기록">${s}</svg>`;
}

// ---------- 약 탭 ----------

const hourTicks = (t0, t1, x, y0, y1, yLabel) => {
  let s = '';
  const span = (t1 - t0) / HOUR, step = span > 15 ? 3 : span > 8 ? 2 : 1;
  const h0 = new Date(t0);
  h0.setMinutes(0, 0, 0);
  for (let t = h0.getTime(); t <= t1; t += HOUR) {
    const hr = new Date(t).getHours();
    if (t < t0 || hr % step) continue;
    s += `<line x1="${x(t)}" x2="${x(t)}" y1="${y0}" y2="${y1}" class="fl-grid"/><text x="${x(t)}" y="${yLabel}" class="fl-ax">${hr}시</text>`;
  }
  return s;
};

// 오늘 약 효과: 같은 성분끼리 더한 곡선(굵게), 복용마다의 곡선(점선), 효과·최고 구간 띠, 복용 시각, 집중도 기록, 지금, 평소 잠드는 시각
export function medSvg(m) {
  const W = 340, L = 12, R = W - 12, TOP = 34, BOT = 172;
  const H = BOT + 40 + m.steady.length * 24;
  const { t0, t1 } = m;
  const x = t => r1(L + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (R - L));
  const y = rel => r1(BOT - Math.max(0, Math.min(1.05, rel)) * (BOT - TOP));
  let s = hourTicks(t0, t1, x, TOP - 6, BOT + 18, BOT + 30);
  const G0 = m.groups[0];
  if (G0) {
    for (const [v, t] of [[G0.effRel, '효과 기준'], [0.8, '최고 80%']]) s += `<line x1="${L}" x2="${R}" y1="${y(v)}" y2="${y(v)}" class="med-th"/><text x="${R}" y="${y(v) - 3}" class="med-th-t">${t}</text>`;
  }
  m.groups.forEach((G, gi) => {
    const sc = G.scale || G.max || 1;
    // 예정대로 먹으면: 점선 (실제 곡선 아래에 먼저 그린다)
    if (G.projTotal) s += `<polyline points="${m.ts.map((t, i) => `${x(t)},${y(G.projTotal[i] / sc)}`).join(' ')}" class="med-proj g${gi}"/>`;
    const pts = m.ts.map((t, i) => `${x(t)},${y(G.total[i] / sc)}`);
    s += `<path d="M${x(m.ts[0])},${BOT} L${pts.join(' L')} L${x(m.ts[m.ts.length - 1])},${BOT} Z" class="med-area g${gi}"/>`;
    if (G.parts.length > 1) for (const P of G.parts) s += `<polyline points="${m.ts.map((t, i) => `${x(t)},${y(P.ys[i] / sc)}`).join(' ')}" class="med-part g${gi}"/>`;
    s += `<polyline points="${pts.join(' ')}" class="med-line g${gi}"/>`;
    for (const [a, b] of G.effect) s += `<rect x="${x(a)}" y="${BOT + 5}" width="${Math.max(2, r1(x(b) - x(a)))}" height="5" rx="2.5" class="med-eff g${gi}"/>`;
    for (const [a, b] of G.peak) s += `<rect x="${x(a)}" y="${BOT + 4}" width="${Math.max(2, r1(x(b) - x(a)))}" height="7" rx="3.5" class="med-peak g${gi}"/>`;
  });
  // 복용 시각과 예정 시각 (겹치면 아래 줄로)
  let lastX = -99, row = 0;
  const marks = [...m.doses.map(d => ({ ...d, plan: false })), ...(m.plannedDoses || []).map(d => ({ ...d, plan: true }))].sort((a, b) => a.t - b.t);
  for (const d of marks) {
    const dx = x(d.t);
    row = dx - lastX < 58 ? 1 - row : 0;
    lastX = dx;
    s += `<line x1="${dx}" x2="${dx}" y1="${TOP - 6 + row * 12}" y2="${BOT}" class="med-dose${d.plan ? ' plan' : ''}"/><text x="${Math.min(Math.max(dx, L + 24), R - 24)}" y="${TOP - 10 + row * 12}" class="med-dose-t${d.plan ? ' plan' : ''}">${esc(d.label)}</text>`;
  }
  // 기록한 집중도 (1~5를 같은 높이 축에)
  const rp = (m.ratings || []).filter(r => r.t >= t0 && r.t <= t1);
  if (rp.length > 1) s += `<polyline points="${rp.map(r => `${x(r.t)},${y((r.v - 1) / 4)}`).join(' ')}" class="med-rate-l"/>`;
  for (const r of rp) s += `<circle cx="${x(r.t)}" cy="${y((r.v - 1) / 4)}" r="4" class="med-rate"/>`;
  if (m.sleepAt && m.sleepAt > t0 && m.sleepAt < t1) {
    const sx = x(m.sleepAt);
    s += `<line x1="${sx}" x2="${sx}" y1="${TOP - 4}" y2="${BOT + 12}" class="med-sleep"/><text x="${Math.min(sx, R - 30)}" y="${BOT + 22}" class="med-sleep-t">🌙 평소 잠</text>`;
  }
  if (m.isToday && m.now > t0 && m.now < t1) {
    const nx = x(m.now);
    s += `<line x1="${nx}" x2="${nx}" y1="${TOP - 2}" y2="${BOT + 12}" class="fl-now"/><path d="M${nx - 4.5} ${TOP - 7}h9l-4.5 6z" class="fl-nowm"/>`;
  }
  // 오래 쌓이는 약: 하루 안에서는 거의 평평한 띠
  m.steady.forEach((st, i) => {
    const yy = BOT + 38 + i * 24;
    s += `<rect x="${L}" y="${yy}" width="${R - L}" height="18" rx="9" class="med-steady"/><text x="${L + 10}" y="${yy + 13}" class="med-steady-t">${esc(st.text)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="flow-svg" role="img" aria-label="오늘 약 효과 곡선">${s}</svg>`;
}

// 스탯 레이더: 처음 평가(점선)와 지금(채움). now/base는 50~98점
export function radarSvg(stats) {
  const n = stats.length;
  if (n < 3) return '';
  const W = 340, H = 260, cx = 170, cy = 128, R = 92;
  const ang = i => ((-90 + (i * 360) / n) * Math.PI) / 180;
  const pt = (i, v) => [r1(cx + Math.cos(ang(i)) * R * v), r1(cy + Math.sin(ang(i)) * R * v)];
  const norm = sc => Math.max(0.08, Math.min(1, (sc - 50) / 48));
  let s = '';
  for (const k of [0.25, 0.5, 0.75, 1]) s += `<polygon points="${stats.map((_, i) => pt(i, k).join(',')).join(' ')}" class="rd-grid"/>`;
  for (let i = 0; i < n; i++) s += `<line x1="${cx}" y1="${cy}" x2="${pt(i, 1)[0]}" y2="${pt(i, 1)[1]}" class="rd-grid"/>`;
  s += `<polygon points="${stats.map((x, i) => pt(i, norm(x.base)).join(',')).join(' ')}" class="rd-base"/>`;
  s += `<polygon points="${stats.map((x, i) => pt(i, norm(x.now)).join(',')).join(' ')}" class="rd-now"/>`;
  stats.forEach((x, i) => {
    const [px, py] = pt(i, norm(x.now));
    s += `<circle cx="${px}" cy="${py}" r="3.5" class="rd-dot"/>`;
    const [lx, ly] = pt(i, 1.2);
    s += `<text x="${lx}" y="${ly + 4}" class="rd-lab">${esc(x.name)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="flow-svg" role="img" aria-label="스탯 레이더">${s}</svg>`;
}

// 내 데이터로 본 피크: 칸마다 평균 집중도(1~5) 막대, 기록 수, 가장 높은 구간 강조
export function peakSvg(st, best, { unit = 'h', label = i => `${i}${unit}` } = {}) {
  const n = st.avg.length, W = 340, L = 10, R = W - 10, TOP = 22, BOT = 118, H = 140;
  const bw = (R - L) / n;
  let s = '';
  for (const v of [1, 3, 5]) {
    const yy = r1(BOT - (v / 5) * (BOT - TOP));
    s += `<line x1="${L}" x2="${R}" y1="${yy}" y2="${yy}" class="fl-base"/>`;
  }
  for (let i = 0; i < n; i++) {
    const bx = r1(L + i * bw + 1.5), w = r1(bw - 3);
    const inBest = best && i >= best.from && i < best.to;
    if (st.avg[i] == null) s += `<rect x="${bx}" y="${BOT - 6}" width="${w}" height="6" rx="2" class="pk-empty"/>`;
    else {
      const hgt = r1((st.avg[i] / 5) * (BOT - TOP));
      s += `<rect x="${bx}" y="${r1(BOT - hgt)}" width="${w}" height="${hgt}" rx="3" class="${inBest ? 'pk-best' : 'pk-bar'}"/>`;
      s += `<text x="${r1(bx + w / 2)}" y="${r1(BOT - hgt - 4)}" class="pk-n">${st.n[i]}</text>`;
    }
    if (i % (n > 16 ? 3 : 2) === 0) s += `<text x="${r1(bx + w / 2)}" y="${BOT + 16}" class="fl-ax">${label(i)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="flow-svg" role="img" aria-label="시간대별 평균 집중도">${s}</svg>`;
}
