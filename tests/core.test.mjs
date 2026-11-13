import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/core.js';
import { createStore } from '../js/store.js';
import { MemoryStorage, clock } from './helpers.mjs';

const at = (h, m = 0, d = 12) => new Date(2026, 10, d, h, m).getTime();
const { HOUR, MIN } = C;

function setup(start = at(8)) {
  const now = clock(start);
  const store = createStore({ storage: new MemoryStorage(), now });
  return { now, store, key: C.dayKey(start) };
}
const coachNow = (store, key, now, extra = {}) => C.coach({ now: now(), day: store.day(key), cfg: store.config(), local: store.local(), ...extra });

test('새벽 4시 전은 전날로 친다', () => {
  assert.equal(C.dayKey(at(3, 59)), '2026-11-11');
  assert.equal(C.dayKey(at(4, 0)), '2026-11-12');
  assert.equal(C.dayKey(at(1, 30), 0), '2026-11-12');
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(C.lastDays('2026-11-02', 3), ['2026-10-31', '2026-11-01', '2026-11-02']);
});

test('새벽 시각은 논리적 하루의 다음 달력일로 계산한다', () => {
  assert.equal(C.tsFor('2026-11-12', '08:30'), at(8, 30));
  assert.equal(C.tsFor('2026-11-12', '02:10'), at(2, 10, 13));
  assert.equal(C.dayKey(C.tsFor('2026-11-12', '02:10')), '2026-11-12');
});

test('시간대는 기상 시각 기준으로 흐른다 (늦게 일어나도 같은 순서)', () => {
  const day = { ...C.newDay('2026-11-12'), wake: { t: at(13), m: 1 } };
  assert.equal(C.blockAt(day, at(13, 5)), 'am');
  assert.equal(C.blockAt(day, at(17, 30)), 'day');
  assert.equal(C.blockAt(day, at(22, 30)), 'pm');
  assert.equal(C.blockAt(day, at(2, 30, 13)), 'night');
  assert.equal(C.blockAt(C.newDay('2026-11-12'), at(15)), 'am', '기상 전에는 첫 시간대');
});

test('체크·카운터 상태와 달성률', () => {
  const { store, key, now } = setup();
  const cfg = store.config();
  const water = cfg.items.find(i => i.id === 'water');
  const med = cfg.items.find(i => i.id === 'med_am');
  store.logEvent(key, 'med_am', { autoWake: true });
  for (let i = 0; i < 3; i++) { now.tick(MIN); store.logEvent(key, 'water'); }
  const day = store.day(key);
  assert.equal(C.wakeOf(day), at(8), '첫 기록이 기상 시각이 된다');
  assert.equal(C.itemState(day, med).done, true);
  assert.equal(C.itemState(day, water).count, 3);
  assert.equal(C.itemState(day, water).done, false);
  let p = C.progress(day, cfg);
  assert.deepEqual([p.essDone, p.essTotal, p.essAll], [1, 2, false]);
  store.setSkip(key, 'med_pm', true);
  p = C.progress(store.day(key), cfg);
  assert.deepEqual([p.essDone, p.essTotal, p.essAll], [1, 1, true], '건너뛴 항목은 분모에서 빠진다');
});

test('기록 취소는 삭제 표시로 남고 상태에서 빠진다', () => {
  const { store, key } = setup();
  const ev = store.logEvent(key, 'med_am');
  store.deleteEvent(key, ev.id);
  const med = store.config().items.find(i => i.id === 'med_am');
  assert.equal(C.itemState(store.day(key), med).done, false);
  assert.equal(store.day(key).events.length, 1);
  assert.equal(store.day(key).events[0].del, true);
});

test('병합: 합집합, 최신 수정 우선, 삭제 유지, 순서 무관', () => {
  const a = { ...C.newDay('2026-11-12'), wake: { t: 100, m: 5 }, events: [{ id: 'e1', item: 'water', t: 10, m: 10 }, { id: 'e2', item: 'meal', t: 20, m: 20, note: '김밥' }] };
  const b = { ...C.newDay('2026-11-12'), wake: { t: 200, m: 9 }, events: [{ id: 'e2', item: 'meal', t: 20, m: 30, note: '비빔밥' }, { id: 'e3', item: 'coffee', t: 15, m: 15 }, { id: 'e1', item: 'water', t: 10, m: 40, del: true }] };
  const ab = C.mergeDay(a, b), ba = C.mergeDay(b, a);
  assert.equal(C.canon(ab), C.canon(ba));
  assert.equal(C.canon(C.mergeDay(ab, a)), C.canon(ab), '다시 합쳐도 같다');
  assert.equal(ab.wake.t, 200);
  assert.deepEqual(ab.events.map(e => e.id), ['e1', 'e3', 'e2']);
  assert.equal(ab.events.find(e => e.id === 'e2').note, '비빔밥');
  assert.deepEqual(C.live(ab).map(e => e.id), ['e3', 'e2']);
});

test('설정 병합: 항목 수정과 삭제가 기기 사이에 전달된다', () => {
  const base = C.defaultConfig(0);
  const a = structuredClone(base), b = structuredClone(base);
  Object.assign(a.items.find(i => i.id === 'med_am'), { name: '오전 약', m: 50 });
  Object.assign(b.items.find(i => i.id === 'walk'), { del: true, m: 60 });
  b.items.push({ id: 'ix', name: '비타민', icon: '🟡', cat: 'med', type: 'check', block: 'am', order: 9, m: 70 });
  const m = C.mergeConfig(a, b);
  assert.equal(C.canon(m), C.canon(C.mergeConfig(b, a)));
  const names = C.activeItems(m).map(i => i.name);
  assert.ok(names.includes('오전 약') && names.includes('비타민') && !names.includes('산책'));
});

test('코치: 시작 전에는 하루 시작만 권한다', () => {
  const { store, key, now } = setup();
  assert.equal(coachNow(store, key, now)[0].key, 'start');
});

test('코치: 필수 약이 먼저, 먹으면 다음 제안으로 넘어간다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  now.tick(10 * MIN);
  let list = coachNow(store, key, now);
  assert.equal(list[0].key, 'do:med_am');
  assert.deepEqual(list[0].action, { label: '방금 먹었어요', act: 'check', arg: 'med_am' });
  assert.equal(list[0].alt.act, 'skip', '일어나자마자는 "아까"를 묻지 않는다');
  store.logEvent(key, 'med_am');
  list = coachNow(store, key, now);
  assert.notEqual(list[0].key, 'do:med_am');
  assert.ok(!list.some(s => s.key === 'do:med_pm'), '저녁 약은 아직 권하지 않는다');
});

test('코치: 못 한 필수 항목은 다음 시간대로 넘어와 맨 앞에 선다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  now.set(at(13, 30));
  const list = coachNow(store, key, now);
  assert.equal(list[0].key, 'do:med_am');
  assert.equal(list[0].title, '아침 약 먹었어요?', '넘어온 항목은 했는지 묻는다');
  assert.match(list[0].sub, /넘어왔어요/);
  assert.equal(list[0].alt.label, '아까 먹었어요');
  store.setSkip(key, 'med_am', true);
  assert.ok(!coachNow(store, key, now).some(s => s.key === 'do:med_am'), '건너뛰면 더 권하지 않는다');
});

test('코치: 물은 간격이 지나면, 식사는 한참 안 먹었을 때 권한다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  store.logEvent(key, 'med_am');
  store.setSkip(key, 'stretch', true);
  now.set(at(9));
  assert.ok(!coachNow(store, key, now).some(s => s.key === 'every:water'));
  now.set(at(10, 5));
  const list = coachNow(store, key, now);
  assert.equal(list[0].key, 'meal:first');
  assert.ok(list.some(s => s.key === 'every:water'));
  store.logEvent(key, 'water');
  assert.ok(!coachNow(store, key, now).some(s => s.key === 'every:water'));
});

test('코치: 나중에를 누르면 그 제안은 잠시 쉰다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  now.tick(5 * MIN);
  store.setLocal({ snooze: { 'do:med_am': now() + 45 * MIN } });
  assert.notEqual(coachNow(store, key, now)[0].key, 'do:med_am');
  now.tick(46 * MIN);
  assert.equal(coachNow(store, key, now)[0].key, 'do:med_am');
});

test('코치: 평소보다 늦게 시작한 날은 가볍게 모드를 권하고, 켜면 필수만 남는다', () => {
  const { store, key, now } = setup(at(13));
  store.setWake(key, at(13));
  store.logEvent(key, 'med_am');
  now.tick(20 * MIN);
  let list = coachNow(store, key, now, { typical: 8 * 60 });
  assert.equal(list[0].key, 'late');
  assert.ok(list.some(s => s.key === 'do:stretch'));
  store.setLite(key, true);
  list = coachNow(store, key, now, { typical: 8 * 60 });
  assert.ok(!list.some(s => s.key === 'late' || s.key === 'do:stretch' || s.key === 't3:set'));
});

test('코치: 효과 구간 안에서는 핵심 일을 먼저 권한다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  store.saveItem({ ...store.config().items.find(i => i.id === 'med_am'), fx: { on: 60, dur: 6 } });
  store.logEvent(key, 'med_am');
  store.logEvent(key, 'meal'); // 첫 끼 제안이 앞서지 않도록 식사는 기록해 둔다
  store.setSkip(key, 'stretch', true);
  store.setTop3(key, 't1', { text: '보고서 초안' });
  now.set(at(8, 30));
  assert.ok(!/효과 구간/.test(coachNow(store, key, now).find(s => s.key === 't3:go:t1').sub));
  now.set(at(9, 30));
  const s = coachNow(store, key, now)[0];
  assert.equal(s.key, 't3:go:t1');
  assert.match(s.sub, /효과 구간이에요 \(15:00까지\)/);
  assert.equal(s.action.arg, '25:t1');
});

test('코치: 자기 전에는 하루 마감을, 마감하면 인사만', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  for (const id of ['med_am', 'stretch', 'walk', 'med_pm']) store.logEvent(key, id);
  now.set(at(21, 30));
  assert.equal(coachNow(store, key, now)[0].key, 'review');
  store.setReview(key, { score: 4, note: '괜찮은 하루' });
  const list = coachNow(store, key, now);
  assert.deepEqual(list.map(s => s.key), ['closed']);
  store.setReview(key, null);
  assert.equal(C.reviewOf(store.day(key)), null);
});

test('코치: 다 했으면 칭찬과 다음 시간대 안내', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  store.logEvent(key, 'med_am');
  store.logEvent(key, 'stretch');
  store.logEvent(key, 'water');
  store.setTop3(key, 't1', { text: '메일 정리', done: now() });
  store.logEvent(key, 'energy', { v: 4 });
  now.tick(30 * MIN);
  const list = coachNow(store, key, now);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'clear');
  assert.match(list[0].sub, /낮 루틴이에요 \(12:00쯤부터\)/);
});

test('연속 기록과 주간 요약', () => {
  const { store, now } = setup(at(9, 0, 12));
  const days = {};
  for (const d of [8, 9, 10, 12]) {
    const k = `2026-11-${String(d).padStart(2, '0')}`;
    now.set(at(8, 0, d));
    store.setWake(k, at(8, 0, d));
    now.set(at(8, 40, d));
    store.logEvent(k, 'med_am');
    store.logEvent(k, 'water');
    store.logEvent(k, 'water');
    store.logEvent(k, 'focus', { min: 25 });
    store.logEvent(k, 'energy', { v: d === 12 ? 2 : 4 });
    store.setSleep(k, at(23, 30, d));
    days[k] = store.day(k);
  }
  const get = k => days[k] || null;
  assert.equal(C.streak(get, '2026-11-12'), 1, '11일이 비어 있으니 오늘만');
  assert.equal(C.streak(get, '2026-11-11'), 3, '오늘 기록이 없으면 어제부터 센다');
  const s = C.summarize(C.lastDays('2026-11-12', 7).map(get), store.config());
  assert.equal(s.recorded, 4);
  assert.equal(s.wakeAvg, 480);
  assert.equal(s.focusMin, 100);
  assert.equal(s.energyAvg, 3.5);
  assert.equal(s.sleepAvg, 8.5, '취침~다음 날 기상');
  assert.equal(s.counts.find(c => c.item.id === 'water').perDay, 2);
  const med = s.meds.find(m => m.item.id === 'med_am');
  assert.deepEqual([med.days, med.afterWake], [4, 40]);
  assert.equal(C.typicalWake(Object.values(days)), 480);
});

test('EXP: 필수만 해도 거의 채워지고, 커피는 보상이 없다', () => {
  const { store, key, now } = setup();
  const cfg = store.config();
  assert.equal(C.expOf(store.day(key), cfg), 0);
  store.setWake(key, at(8));
  store.logEvent(key, 'med_am');
  store.logEvent(key, 'med_pm');
  assert.equal(C.expOf(store.day(key), cfg), 70, '기상 10 + 필수 30×2');
  for (let i = 0; i < 10; i++) store.logEvent(key, 'water');
  assert.equal(C.expOf(store.day(key), cfg), 102, '물은 목표(8잔)까지만 센다');
  for (let i = 0; i < 3; i++) store.logEvent(key, 'coffee');
  assert.equal(C.expOf(store.day(key), cfg), 102);
  store.logEvent(key, 'focus', { min: 25 });
  store.setTop3(key, 't1', { text: '초안', done: now() });
  store.setReview(key, { score: 4, note: '' });
  assert.equal(C.expOf(store.day(key), cfg), 152, '집중 10 + 핵심 20 + 마감 20');
});

test('시즌: 2주 단위로 끊고 마지막 날을 안다', () => {
  assert.deepEqual(C.seasonInfo('2026-11-13', '2026-11-13'), { n: 1, day: 1, start: '2026-11-13', end: '2026-11-26', left: 13 });
  const last = C.seasonInfo('2026-11-26', '2026-11-13');
  assert.deepEqual([last.n, last.day, last.left], [1, 14, 0]);
  const next = C.seasonInfo('2026-11-27', '2026-11-13');
  assert.deepEqual([next.n, next.day, next.start, next.end], [2, 1, '2026-11-27', '2026-12-10']);
  assert.equal(C.seasonInfo('2026-11-13', undefined).n, 1);
});

test('D-day: 남은 날과 몇 주차인지', () => {
  const d = C.ddayInfo({ label: '마감', from: '2026-03-02', to: '2026-06-01' }, '2026-04-17');
  assert.deepEqual([d.week, d.left, d.text], [7, 45, '7주차 · D-45']);
  assert.equal(d.pct, 51);
  assert.equal(C.ddayInfo({ label: '시험', to: '2026-11-13' }, '2026-11-13').text, 'D-DAY');
  assert.equal(C.ddayInfo({ label: '지난 날', to: '2026-11-10' }, '2026-11-13').text, 'D+3');
  assert.equal(C.ddayInfo({ label: '곧 시작', from: '2026-12-01' }, '2026-11-13').text, '');
});

test('누적 목표는 시작일부터 센다', () => {
  const { store, now } = setup(at(9, 0, 10));
  store.logEvent('2026-11-10', 'water');
  now.set(at(9, 0, 12));
  store.logEvent('2026-11-12', 'water');
  const ev = store.logEvent('2026-11-12', 'water');
  store.deleteEvent('2026-11-12', ev.id);
  const days = ['2026-11-10', '2026-11-12'].map(k => store.day(k));
  assert.equal(C.goalCount({ id: 'water', goal: { total: 30 } }, days), 2);
  assert.equal(C.goalCount({ id: 'water', goal: { total: 30, from: '2026-11-11' } }, days), 1);
});

test('하루 보고는 사람이 읽을 수 있는 몇 줄이다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  store.logEvent(key, 'med_am');
  store.logEvent(key, 'water');
  store.logEvent(key, 'workout', { min: 30 });
  store.setTop3(key, 't1', { text: '초안 끝내기', done: now() });
  store.setTop3(key, 't2', { text: '메일 정리' });
  store.setReview(key, { score: 4, note: '끝까지 했다' });
  assert.equal(C.dayReport(store.day(key), store.config()), [
    '[11월 12일 (목) 보고]',
    'EXP 94/100 · 필수 1/2',
    '아침 약 08:00, 물 1잔, 운동 30분',
    '핵심 1/2: ✓초안 끝내기 / ·메일 정리',
    '한 줄: 끝까지 했다',
  ].join('\n'));
});

test('설정 병합: D-day도 기기 사이에 전달된다', () => {
  const a = C.defaultConfig(0), b = C.defaultConfig(0);
  a.ddays.push({ id: 'd1', label: '시험', to: '2026-12-01', m: 10 });
  b.ddays.push({ id: 'd1', label: '시험', to: '2026-12-05', m: 20 }, { id: 'd2', label: '마감', to: '2026-07-31', m: 5 });
  const m = C.mergeConfig(a, b);
  assert.deepEqual(m.ddays.map(d => [d.id, d.to]), [['d1', '2026-12-05'], ['d2', '2026-07-31']]);
  assert.equal(C.mergeConfig({ v: 1, items: [], places: [], prefs: { m: 1 } }, b).ddays.length, 2, '예전 형식에도 안전하다');
});

test('연속: 하루 빠져도 이어지고, 이틀 연속으로 빠지면 끊긴다', () => {
  const S = map => k => (k in map ? map[k] : null);
  const T = '2026-11-12';
  // 9일 하루 빠짐 → 그대로 이어짐 (해낸 날만 센다)
  let c = C.chainInfo(S({ '2026-11-08': 1, '2026-11-09': 0, '2026-11-10': 1, '2026-11-11': 1, [T]: 0 }), T);
  assert.deepEqual(c, { n: 3, today: false, atRisk: false, comeback: 0 });
  // 어제 빠짐 → 오늘 하면 이어진다
  c = C.chainInfo(S({ '2026-11-09': 1, '2026-11-10': 1, '2026-11-11': 0, [T]: 0 }), T);
  assert.deepEqual(c, { n: 2, today: false, atRisk: true, comeback: 0 });
  c = C.chainInfo(S({ '2026-11-09': 1, '2026-11-10': 1, '2026-11-11': 0, [T]: 1 }), T);
  assert.deepEqual([c.n, c.atRisk], [3, false]);
  // 이틀 연속 빠짐 → 끊김. 돌아온 날은 지난번 길이를 알려준다
  c = C.chainInfo(S({ '2026-11-07': 1, '2026-11-08': 1, '2026-11-09': 1, '2026-11-10': 0, '2026-11-11': 0, [T]: 0 }), T);
  assert.deepEqual(c, { n: 0, today: false, atRisk: false, comeback: 3 });
  c = C.chainInfo(S({ '2026-11-07': 1, '2026-11-08': 1, '2026-11-09': 1, '2026-11-10': 0, '2026-11-11': 0, [T]: 1 }), T);
  assert.deepEqual([c.n, c.comeback], [1, 0], '오늘 하면 1부터 다시');
  // 쉬는 날(-1)은 끊지도 늘리지도 않는다
  c = C.chainInfo(S({ '2026-11-09': 1, '2026-11-10': -1, '2026-11-11': -1, [T]: 1 }), T);
  assert.equal(c.n, 2);
  // 기록을 시작하기 전(null)에서 멈춘다
  assert.equal(C.chainInfo(S({ [T]: 1 }), T).n, 1);
});

test('하루 상태: 필수를 다 해야 1, 필수를 일부러 다 건너뛰면 쉬는 날', () => {
  const { store, key } = setup();
  const cfg = store.config();
  assert.equal(C.dayStatus(null, cfg), 0);
  store.logEvent(key, 'med_am', { autoWake: true });
  assert.equal(C.dayStatus(store.day(key), cfg), 0, '저녁 약이 남았다');
  store.logEvent(key, 'med_pm');
  assert.equal(C.dayStatus(store.day(key), cfg), 1);
  const k2 = '2026-11-13';
  store.setSkip(k2, 'med_am', true);
  store.setSkip(k2, 'med_pm', true);
  assert.equal(C.dayStatus(store.day(k2), cfg), -1);
});

test('평소 시각: 기상 후 몇 분인지의 중앙값을 오늘 기상에 더한다', () => {
  const { store } = setup(at(8, 0, 9));
  for (const [d, m] of [[9, 20], [10, 30], [11, 40]]) {
    const k = `2026-11-${String(d).padStart(2, '0')}`;
    store.setWake(k, at(8, 0, d));
    store.logEvent(k, 'med_am', { t: at(8, m, d) });
  }
  const med = store.config().items.find(i => i.id === 'med_am');
  const hist = ['2026-11-09', '2026-11-10', '2026-11-11'].map(k => store.day(k));
  assert.equal(C.usualTime(med, hist, { wake: at(10, 0), key: '2026-11-12' }), at(10, 30), '늦게 일어난 날은 그만큼 늦게');
  assert.equal(C.usualTime(med, hist, { key: '2026-11-12' }), at(8, 30), '오늘 기상이 없으면 평소 시계 시각');
  assert.equal(C.usualTime(med, hist.slice(0, 2), { key: '2026-11-12' }), null, '표본이 3일 미만이면 모른다');
});

test('평소 시각: 자정을 넘기는 기록도 이어서 계산한다', () => {
  const { store } = setup(at(9, 0, 9));
  const lights = { id: 'lights', type: 'check' };
  for (const [d, h, m] of [[9, 23, 50], [10, 0, 10], [11, 0, 30]]) {
    const k = `2026-11-${String(d).padStart(2, '0')}`;
    store.logEvent(k, 'lights', { t: C.tsFor(k, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`) });
  }
  const hist = ['2026-11-09', '2026-11-10', '2026-11-11'].map(k => store.day(k));
  assert.equal(C.usualTime(lights, hist, { key: '2026-11-12' }), at(0, 10, 13));
});

test('기록이 쌓이기 전 짐작 시각: 기상 기준, 기상도 없으면 시간대 기준', () => {
  const am = { block: 'am' }, pm = { block: 'pm' }, night = { block: 'night' };
  const day = { ...C.newDay('2026-11-12'), wake: { t: at(10), m: 1 } };
  assert.equal(C.guessTime(am, day, { key: '2026-11-12' }), at(10, 15));
  assert.equal(C.guessTime(pm, day, { key: '2026-11-12' }), at(19, 30));
  assert.equal(C.guessTime(am, C.newDay('2026-11-12'), { key: '2026-11-12' }), at(9));
  assert.equal(C.guessTime(night, C.newDay('2026-11-12'), { key: '2026-11-12' }), at(23, 30));
});

test('어제 정리: 체크 안 된 필수만 묻고, 했다·못 했다·건너뜀이면 빠진다', () => {
  const { store } = setup(at(9, 0, 11));
  const k = '2026-11-11', cfg = store.config();
  store.logEvent(k, 'med_am', { autoWake: true });
  assert.deepEqual(C.retroItems(store.day(k), cfg).map(i => i.id), ['med_pm']);
  store.setMiss(k, 'med_pm');
  assert.deepEqual(C.retroItems(store.day(k), cfg), []);
  assert.equal(C.dayStatus(store.day(k), cfg), 0, '못 했다고 하면 못 한 날로 남는다');
  store.setSkip(k, 'med_pm', false);
  assert.deepEqual(C.retroItems(store.day(k), cfg).map(i => i.id), ['med_pm']);
  store.logEvent(k, 'med_pm', { t: at(20, 0, 11) });
  assert.deepEqual(C.retroItems(store.day(k), cfg), []);
  assert.equal(C.dayStatus(store.day(k), cfg), 1, '했다고 하면 그날은 해낸 날');
});

test('늦게 고친 시각: 기상을 첫 기록으로 짐작했으면 더 이른 시각으로 따라간다', () => {
  const { store, key } = setup(at(10, 2));
  const ev = store.logEvent(key, 'med_am', { autoWake: true });
  assert.deepEqual([C.wakeOf(store.day(key)), store.day(key).wake.auto], [at(10, 2), true]);
  store.updateEvent(key, ev.id, { t: at(8, 30) });
  assert.deepEqual([C.wakeOf(store.day(key)), store.day(key).wake.auto], [at(8, 30), true]);
  store.setWake(key, at(9));
  store.updateEvent(key, ev.id, { t: at(8) });
  assert.equal(C.wakeOf(store.day(key)), at(9), '직접 정한 기상은 건드리지 않는다');
});

test('코치: 시간대가 한참 지났으면 "아까 먹었어요"를 함께 준다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  now.set(at(8, 40));
  const s = coachNow(store, key, now).find(x => x.key === 'do:med_am');
  assert.deepEqual(s.alt, { label: '아까 먹었어요', act: 'ago', arg: 'med_am' });
});

test('코치: 기상을 첫 기록으로 짐작했으면 맞는지 먼저 묻는다', () => {
  const { store, key, now } = setup(at(10, 2));
  store.logEvent(key, 'med_am', { autoWake: true });
  const s = coachNow(store, key, now)[0];
  assert.equal(s.key, 'wake-auto');
  assert.deepEqual([s.action.act, s.alt.act], ['time-wake', 'wake-ok']);
  store.setWake(key, at(8));
  assert.notEqual(coachNow(store, key, now)[0].key, 'wake-auto');
});

test('코치: 어제 빠진 날은 필수 제안에 연속 이야기를 붙인다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  now.tick(5 * MIN);
  const atRisk = { n: 4, today: false, atRisk: true, comeback: 0 };
  assert.match(coachNow(store, key, now, { chain: atRisk })[0].sub, /오늘 필수를 하면 🔥4일이 이어져요/);
  const back = { n: 0, today: false, atRisk: false, comeback: 6 };
  assert.match(coachNow(store, key, now, { chain: back })[0].sub, /지난번엔 🔥6일/);
  store.saveItem({ ...store.config().items.find(i => i.id === 'stretch'), cue: '양치한 다음에' });
  store.logEvent(key, 'med_am');
  assert.equal(coachNow(store, key, now).find(x => x.key === 'do:stretch').sub, '양치한 다음에', '신호가 있으면 신호를 보여준다');
});

test('예정 시각: 시각 고정, 기상 후, 다른 항목 뒤', () => {
  const { store, key } = setup(at(9));
  const day = () => store.day(key);
  assert.equal(C.dueOf({ plan: { time: '14:00' } }, day()), at(14));
  assert.equal(C.dueOf({ plan: { time: '01:30' } }, day()), at(1, 30, 13), '새벽이면 다음 달력일');
  assert.equal(C.dueOf({ plan: { wake: 0.5 } }, day()), null, '기상 전에는 모른다');
  store.setWake(key, at(9, 30));
  assert.equal(C.dueOf({ plan: { wake: 0.5 } }, day()), at(10));
  assert.equal(C.dueOf({ plan: { after: 'med_am', h: 4.5 } }, day()), null);
  store.logEvent(key, 'med_am', { t: at(10, 15) });
  assert.equal(C.dueOf({ plan: { after: 'med_am', h: 4.5 } }, day()), at(14, 45));
});

test('복용 상태: 예정 전후, 제시간·늦음·일찍, 건너뜀(이유)·못 먹음', () => {
  const { store, key } = setup(at(9));
  const it = { id: 'med_pm', plan: { time: '14:00' }, type: 'check' };
  const st = (h, m = 0, extra) => C.doseState(it, store.day(key), { now: at(h, m), ...extra });
  assert.deepEqual([st(13, 0).kind, st(13, 40).kind, st(14, 20).kind, st(15, 10).kind], ['upcoming', 'due', 'due', 'overdue']);
  assert.equal(st(15, 10).delay, 70);
  const ev = store.logEvent(key, 'med_pm', { t: at(14, 10) });
  assert.deepEqual([st(15).kind, st(15).delay], ['taken', 10]);
  store.updateEvent(key, ev.id, { t: at(15, 5) });
  assert.deepEqual([st(16).kind, st(16).delay], ['late', 65]);
  store.updateEvent(key, ev.id, { t: at(13, 0) });
  assert.equal(st(16).kind, 'early');
  store.deleteEvent(key, ev.id);
  store.setSkip(key, 'med_pm', true, 'sleep', '늦게 일어남');
  assert.deepEqual([st(16).kind, st(16).why, st(16).note], ['skipped', 'sleep', '늦게 일어남']);
  store.setSkip(key, 'med_pm', false);
  assert.equal(st(16).kind, 'overdue', '건너뛰기를 취소하면 이유도 사라진다');
  store.setMiss(key, 'med_pm', 'forgot');
  assert.deepEqual([st(16).kind, st(16).why], ['missed', 'forgot']);
  assert.equal(C.doseState(it, C.newDay('2026-11-10'), { ended: true }).kind, 'none', '지난 날인데 기록이 없으면');
});

test('복용 요약과 먹은 날·건너뛴 날 비교', () => {
  const { store } = setup(at(9, 0, 1));
  const it = { id: 'med_pm', plan: { time: '14:00' }, type: 'check' };
  const days = [];
  // 1~4일: 먹음(제시간 2, 늦게 2), 5~7일: 건너뜀(잠 2, 일 가벼움 1), 8일: 못 먹음
  const plan = [[1, 14, 5], [2, 13, 50], [3, 15, 0], [4, 15, 30]];
  for (const [d, h, m] of plan) {
    const k = `2026-11-0${d}`;
    store.logEvent(k, 'med_pm', { t: at(h, m, d) });
    store.logEvent(k, 'attn', { t: at(16, 0, d), v: 4 });
    store.setSleep(k, at(23, 30, d));
    store.setTop3(k, 't1', { text: '할 일', done: at(18, 0, d) });
    days.push(store.day(k));
  }
  for (const [d, why] of [[5, 'sleep'], [6, 'sleep'], [7, 'light']]) {
    const k = `2026-11-0${d}`;
    store.setSkip(k, 'med_pm', true, why);
    store.logEvent(k, 'attn', { t: at(16, 0, d), v: 2 });
    store.setTop3(k, 't1', { text: '할 일' });
    days.push(store.day(k));
  }
  store.setMiss('2026-11-08', 'med_pm', 'forgot');
  days.push(store.day('2026-11-08'));
  const hist = days.map(d => C.doseState(it, d, { ended: true }));
  const s = C.doseSummary(hist);
  assert.deepEqual([s.taken, s.onTime, s.late, s.skipped, s.missed], [4, 2, 2, 3, 1]);
  assert.equal(s.lateAvg, 75, '늦은 날만 평균 (60분, 90분)');
  assert.deepEqual(s.why, { sleep: 2, light: 1, forgot: 1 });
  const o = C.doseOutcomes(it, days);
  assert.deepEqual([o.taken.n, o.taken.attn, o.skipped.n, o.skipped.attn], [4, 4, 3, 2]);
  assert.equal(o.taken.t3, 1);
  assert.equal(o.skipped.t3, 0);
  assert.equal(o.taken.sleep, 19 * 60 + 30, '04시 기준 19시간 30분 = 23:30');
});

test('코치: 예정 시각 30분 전부터 먹을지·건너뛸지 묻는다', () => {
  const { store, key, now } = setup();
  store.setWake(key, at(8));
  store.logEvent(key, 'med_am', { t: at(8, 10) });
  store.saveItem({ ...store.config().items.find(i => i.id === 'med_pm'), block: 'day', plan: { time: '14:00' } });
  now.set(at(13, 0));
  assert.ok(!coachNow(store, key, now).some(s => s.key === 'dose:med_pm'), '아직 이르다');
  assert.ok(!coachNow(store, key, now).some(s => s.key === 'do:med_pm'), '예정 있는 항목은 시간대 제안을 따로 하지 않는다');
  now.set(at(13, 45));
  let s = coachNow(store, key, now)[0];
  assert.equal(s.key, 'dose:med_pm');
  assert.equal(s.alt2.act, 'skip-why');
  assert.equal(s.alt, null, '예정 전후에는 "아까"가 없다');
  now.set(at(15, 0));
  s = coachNow(store, key, now)[0];
  assert.match(s.title, /14:00 예정 · 1시간 지났어요/);
  assert.equal(s.alt.act, 'ago');
  store.setSkip(key, 'med_pm', true, 'light');
  assert.ok(!coachNow(store, key, now).some(x => x.key === 'dose:med_pm'));
  assert.equal(C.progress(store.day(key), store.config()).essTotal, 1, '건너뛴 필수는 분모에서 빠진다');
});

test('하루 보고에 건너뛴 이유가 들어간다', () => {
  const { store, key } = setup();
  store.setWake(key, at(8));
  store.logEvent(key, 'med_am');
  store.setSkip(key, 'med_pm', true, 'sleep');
  assert.match(C.dayReport(store.day(key), store.config()), /저녁 약 건너뜀\(잠 때문에\)/);
});

test('장소: 반경 안의 가장 가까운 곳을 고른다', () => {
  const places = [{ id: 'a', name: '집', lat: 37.5, lon: 127.0 }, { id: 'b', name: '헬스장', lat: 37.5009, lon: 127.0 }];
  assert.equal(C.matchPlace(places, 37.50001, 127.00001).name, '집');
  assert.equal(C.matchPlace(places, 37.5008, 127.0).name, '헬스장');
  assert.equal(C.matchPlace(places, 37.6, 127.0), null);
});

test('저장소: 다시 열어도 기록이 남고, 항목 순서를 바꿀 수 있다', () => {
  const storage = new MemoryStorage();
  const now = clock(at(8));
  const s1 = createStore({ storage, now });
  const key = C.dayKey(now());
  s1.logEvent(key, 'med_am', { autoWake: true });
  s1.setTop3(key, 't1', { text: '운동 가기' });
  s1.moveItem('walk', -1);
  const s2 = createStore({ storage, now });
  assert.equal(C.live(s2.day(key)).length, 1);
  assert.equal(C.top3Of(s2.day(key))[0].text, '운동 가기');
  assert.deepEqual(C.activeItems(s2.config()).slice(0, 3).map(i => i.id), ['med_am', 'walk', 'stretch']);
  assert.deepEqual(s2.dirtyPaths().sort(), ['config.json', 'days/2026/2026-11-12.json']);
});

test('저장소: 내보낸 파일을 다른 기기에서 가져오면 같은 기록이 된다', () => {
  const a = setup(at(8)), b = setup(at(9));
  a.store.logEvent(a.key, 'med_am', { autoWake: true });
  a.store.setReview(a.key, { score: 5, note: '좋았다' });
  a.store.saveItem({ name: '영양제', icon: '🟡', cat: 'med', type: 'check', block: 'am' });
  b.store.logEvent(b.key, 'water');
  const file = JSON.parse(JSON.stringify(a.store.exportAll()));
  assert.equal(b.store.importAll(file), 1);
  assert.deepEqual(C.live(b.store.day(b.key)).map(e => e.item), ['med_am', 'water'], '원래 있던 기록과 합쳐진다');
  assert.equal(C.reviewOf(b.store.day(b.key)).note, '좋았다');
  assert.ok(C.activeItems(b.store.config()).some(i => i.name === '영양제'));
  assert.throws(() => b.store.importAll({ hello: 1 }), /백업 파일이 아니에요/);
});

test('저장소: 나중에 추가한 항목은 과거 날짜의 달성률에 끼지 않는다', () => {
  const { store } = setup(at(8));
  store.saveItem({ name: '영양제', icon: '🟡', cat: 'med', type: 'check', block: 'am', essential: true, since: '2026-11-12' });
  const cfg = store.config();
  assert.equal(C.progress(C.newDay('2026-11-10'), cfg).essTotal, 2);
  assert.equal(C.progress(C.newDay('2026-11-12'), cfg).essTotal, 3);
});
