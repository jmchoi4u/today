import test from 'node:test';
import assert from 'node:assert/strict';
import * as PK from '../js/pk.js';
import * as C from '../js/core.js';
import { createStore } from '../js/store.js';
import { MemoryStorage, clock } from './helpers.mjs';

// 이름 없는 시험용 프로필 (실제 약 정보는 비공개 저장소에만 있다)
const LONG = { id: 'long', name: '긴 약', kind: 'curve', group: 'g', halfLife: 3.5, parts: [{ f: 0.22, lag: 0.05, ka: 3 }, { f: 0.78, zo: [1, 7.5], ramp: 0.2 }] };
const TWO = { id: 'two', name: '두 번 오르는 약', kind: 'curve', group: 'g', halfLife: 3.2, parts: [{ f: 0.5, lag: 0.4, ka: 3 }, { f: 0.5, lag: 2.2, ka: 1 }] };
const FAST = { id: 'fast', name: '빠른 약', kind: 'curve', group: 'h', halfLife: 3, parts: [{ f: 1, lag: 0.25, ka: 1.4 }] };
const STEADY = { id: 'steady', name: '쌓이는 약', kind: 'steady' };
const at = (h, m = 0, d = 12) => new Date(2026, 10, d, h, m).getTime();

test('곡선: 한 번에 다 흡수되면 다 빠져나가고, 최고점 시각은 흡수·제거 속도로 정해진다', () => {
  const c = PK.simulate(FAST);
  const s = PK.shape(FAST);
  const ke = Math.LN2 / 3, ka = 1.4;
  const expected = 0.25 + Math.log(ka / ke) / (ka - ke); // 1구획 모델의 이론값
  assert.ok(Math.abs(s.tmax - expected) < 0.1, `tmax ${s.tmax} ≈ ${expected.toFixed(2)}`);
  assert.ok(c[c.length - 1] < 0.01, '30시간 뒤엔 거의 남지 않는다');
  assert.equal(PK.valueAt(FAST, -1), 0, '먹기 전은 0');
});

test('곡선: 서서히 나오는 약은 1시간쯤 첫 상승 뒤 오후까지 올라가고 12시간 남짓 간다', () => {
  const s = PK.shape(LONG);
  assert.ok(s.tmax >= 6 && s.tmax <= 10, `최고점 ${s.tmax}h`);
  assert.ok(s.onset <= 1.2, `효과 시작 ${s.onset}h`);
  assert.ok(s.end >= 11 && s.end <= 14, `효과 끝 ${s.end}h`);
  const early = PK.valueAt(LONG, 1) / s.max;
  assert.ok(early > 0.3 && early < 0.5, '첫 상승은 최고점의 절반쯤');
});

test('곡선: 반반 나뉜 약은 두 번 오르고, 최고점의 75% 이상이 3~4시간 간다', () => {
  const c = PK.simulate(TWO);
  const s = PK.shape(TWO);
  let hi = 0;
  for (const v of c) if (v >= 0.75 * s.max) hi++;
  const hours = hi * PK.DT;
  assert.ok(hours >= 3 && hours <= 4, `75% 이상 ${hours}h`);
  const v = h => PK.valueAt(TWO, h);
  assert.ok(v(1.3) > v(2.2) && v(3.5) > v(2.2), '1.3h 봉우리 → 2.2h 골 → 3.5h 봉우리');
});

test('같은 성분끼리는 용량만큼 더해진다', () => {
  const doses = [{ id: 'x', t: at(8), p: LONG, mg: 20 }, { id: 'y', t: at(14), p: TWO, mg: 10 }, { id: 'z', t: at(8), p: STEADY, mg: 1 }];
  const { ts, groups } = PK.series(doses, at(7), at(23));
  assert.equal(groups.length, 1, '쌓이는 약은 곡선에 넣지 않는다');
  const G = groups[0];
  const i = ts.findIndex(t => t === at(16));
  const expect = PK.valueAt(LONG, 8) * 20 + PK.valueAt(TWO, 2) * 10;
  assert.ok(Math.abs(G.total[i] - expect) < 1e-9);
  assert.equal(G.parts.length, 2);
  const st = PK.groupStatus(G, ts, at(16));
  assert.ok(st.nowRel > 0 && st.nowRel <= 1);
  assert.ok(st.effect.length >= 1 && st.peak.length >= 1);
  // 오후에 더 먹어도 오전 효과 구간은 그대로: 효과 시작은 첫 약 기준 약 1시간 안
  assert.ok(st.effect[0][0] <= at(9, 15), `효과 시작 ${new Date(st.effect[0][0]).toTimeString().slice(0, 5)}`);
});

test('구간 찾기와 복용 계획', () => {
  const ts = [0, 1, 2, 3, 4, 5].map(h => h * C.HOUR), ys = [0, 5, 9, 4, 8, 1];
  assert.deepEqual(PK.windows(ts, ys, 4), [[ts[1], ts[4]]]);
  assert.deepEqual(PK.windows(ts, ys, 6), [[ts[2], ts[2]], [ts[4], ts[4]]]);
  const p = PK.plan(LONG, at(9));
  const s = PK.shape(LONG);
  assert.equal(p.end, at(9) + s.end * C.HOUR);
  assert.ok(p.peak[0] < p.tmax && p.tmax <= p.peak[1]);
});

test('항목에 연결한 약만 복용 기록이 된다', () => {
  const now = clock(at(8));
  const store = createStore({ storage: new MemoryStorage(), now });
  const key = '2026-11-12';
  const it = store.saveItem({ name: '아침에 먹는 것', icon: '💊', cat: 'med', type: 'check', block: 'am', drugs: [{ id: 'long', mg: 36 }, { id: 'steady' }] });
  store.logEvent(key, it.id, { t: at(8, 10) });
  store.logEvent(key, 'water', { t: at(8, 20) });
  const doses = PK.dosesOf([store.day(key)], C.activeItems(store.config()), [LONG, STEADY]);
  assert.deepEqual(doses.map(d => [d.p.id, d.mg, d.t]), [['long', 36, at(8, 10)], ['steady', 1, at(8, 10)]]);
  assert.deepEqual(PK.steadyInfo([store.day(key)], [it.id], '2026-11-26'), { first: key, day: 15, week: 3 });
});

test('내 피크: 첫 복용 뒤 몇 시간째에 기록한 집중도를 모아 가장 높은 구간을 찾는다', () => {
  const now = clock(at(8));
  const store = createStore({ storage: new MemoryStorage(), now });
  const it = store.saveItem({ name: '약', icon: '💊', cat: 'med', type: 'check', block: 'am', drugs: [{ id: 'long' }] });
  const days = [];
  for (const d of [9, 10, 11]) {
    const k = `2026-11-${String(d).padStart(2, '0')}`;
    store.setWake(k, at(7, 30, d));
    store.logEvent(k, it.id, { t: at(8, 0, d) });
    store.logEvent(k, 'attn', { t: at(9, 30, d), v: 2 }); // 1시간대
    store.logEvent(k, 'attn', { t: at(11, 10, d), v: 4 }); // 3시간대
    store.logEvent(k, 'attn', { t: at(12, 20, d), v: 5 }); // 4시간대
    store.logEvent(k, 'attn', { t: at(18, 0, d), v: 2 }); // 10시간대
    store.logEvent(k, 'focus', { t: at(11, 0, d), min: 25 });
    days.push(store.day(k));
  }
  const doses = PK.dosesOf(days, C.activeItems(store.config()), [LONG]);
  const st = PK.peakStats(days, { mode: 'dose', doses });
  assert.deepEqual([st.n[1], st.n[3], st.n[4], st.n[10]], [3, 3, 3, 3]);
  assert.equal(st.avg[4], 5);
  assert.equal(st.focus[3], 75);
  assert.deepEqual(PK.bestWindow(st, { width: 2, minN: 2 }), { from: 3, to: 5, avg: 4.5, n: 6 });
  const byWake = PK.peakStats(days, { mode: 'wake', wakeOf: C.wakeOf });
  assert.equal(byWake.avg[3], 4, '기상 기준으로는 3시간대');
  const byClock = PK.peakStats(days, { mode: 'clock', bins: 24 });
  assert.equal(byClock.avg[12], 5, '시계 기준으로는 12시');
});

test('평소 잠드는 시각은 자정을 넘겨도 이어서 센다', () => {
  const mk = (d, h, m) => ({ ...C.newDay(`2026-11-${d}`), sleep: { t: C.tsFor(`2026-11-${d}`, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`), m: 1 } });
  const days = [mk('09', 23, 40), mk('10', 0, 30), mk('11', 1, 0)];
  assert.equal(C.typicalSleep(days), 20 * 60 + 30, '04시 기준 20시간 30분 뒤 = 00:30');
  assert.equal(C.typicalSleep(days.slice(0, 2)), null);
});
