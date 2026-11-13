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

// 오늘 탭 맨 위의 한 줄짜리 띠
export function stripSvg(day, cfg, now, isToday) {
  const W = 328, L = 8, R = W - 8, Y = 38, TH = 12;
  const [t0, t1] = domain(day, now, isToday);
  const x = t => r1(L + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (R - L));
  const items = new Map((cfg.items || []).map(i => [i.id, i]));
  const wake = wakeOf(day);
  let s = `<rect x="${L}" y="${Y}" width="${R - L}" height="${TH}" rx="6" class="st-track"/>`;
  const endX = isToday ? x(now) : R;
  if (endX - L > 1) s += `<rect x="${L}" y="${Y}" width="${r1(endX - L)}" height="${TH}" rx="6" class="st-fill"/>`;
  for (const [a, b] of bands(day, items)) {
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
export function flowSvg(day, cfg, now, isToday) {
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
  s += `<text x="${L}" y="${LN.cond - 5}" class="fl-lb">컨디션 <tspan class="fl-en-t" dx="6">● 에너지</tspan> <tspan class="fl-mo-t" dx="4">● 기분</tspan></text>`;
  for (const v of [1, 3, 5]) s += `<line x1="${L}" x2="${R}" y1="${LN.cond + 46 - ((v - 1) / 4) * 40}" y2="${LN.cond + 46 - ((v - 1) / 4) * 40}" class="fl-base"/>`;

  for (const [a, b] of bands(day, items)) {
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
  for (const [id, cls] of [['energy', 'fl-en'], ['mood', 'fl-mo']]) {
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
