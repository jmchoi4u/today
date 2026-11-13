import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/core.js';
import * as GM from '../js/game.js';
import * as WX from '../js/weather.js';
import { createStore } from '../js/store.js';
import { MemoryStorage, clock } from './helpers.mjs';

const at = (h, m = 0, d = 12) => new Date(2026, 10, d, h, m).getTime();

test('레벨: 필요한 EXP가 조금씩 늘고, 남는 EXP는 다음 레벨로 넘어간다', () => {
  assert.deepEqual(GM.levelOf(0), { lv: 1, into: 0, need: 220, total: 0 });
  assert.deepEqual(GM.levelOf(219).lv, 1);
  assert.deepEqual(GM.levelOf(220), { lv: 2, into: 0, need: 240, total: 220 });
  assert.deepEqual(GM.levelOf(220 + 240 + 10), { lv: 3, into: 10, need: 260, total: 470 });
  assert.equal(GM.tierOf(9).name, '초보자');
  assert.equal(GM.tierOf(10).name, '모험가');
  assert.equal(GM.tierOf(10).next.name, '베테랑');
  assert.equal(GM.tierOf(60).next, null);
});

test('EXP 장부: 하루 100을 넘기면 보너스, 연속 7일에 보너스, 빈 날은 0', () => {
  const now = clock(at(8, 0, 1));
  const store = createStore({ storage: new MemoryStorage(), now });
  const keys = [];
  for (let d = 1; d <= 8; d++) {
    const k = `2026-11-${String(d).padStart(2, '0')}`;
    keys.push(k);
    if (d === 5) continue; // 하루 빠짐 (이틀 규칙이라 연속은 이어진다)
    store.setWake(k, at(8, 0, d));
    store.logEvent(k, 'med_am', { t: at(8, 10, d) });
    store.logEvent(k, 'med_pm', { t: at(20, 0, d) });
    if (d === 3) for (let i = 0; i < 8; i++) store.logEvent(k, 'water', { t: at(10 + i, 0, d) });
  }
  const get = k => (store.hasDay(k) ? store.day(k) : null);
  const L = GM.expLedger('2026-11-01', '2026-11-08', get, store.config());
  assert.equal(L.length, 8);
  assert.deepEqual(L.map(r => r.exp), [70, 70, 102, 70, 0, 70, 70, 70]);
  assert.deepEqual(L[2].why, ['하루 목표 +20']);
  assert.equal(L[7].bonus, 50, '해낸 날 7일째(8일)에 연속 보너스');
  assert.deepEqual(L[7].why, ['7일 연속 +50']);
});

test('스탯: 지표 값으로 등급과 다음 목표까지의 진행을 정한다', () => {
  const now = clock(at(9, 0, 13));
  const store = createStore({ storage: new MemoryStorage(), now });
  store.saveDday({ label: '한 자리', from: '2026-09-28', to: '2026-12-27' });
  store.saveItem({ id: 'apply', name: '지원', icon: '📨', cat: 'habit', type: 'count', block: 'any' });
  for (let i = 0; i < 12; i++) store.logEvent('2026-11-13', 'apply', { t: at(10, i, 13) });
  const def = {
    stats: [
      { id: 'finish', name: '완주', grade: 'D', metric: { type: 'dday_weeks', dday: '한 자리', unit: '주' }, steps: [{ at: 13, grade: 'C' }, { at: 26, grade: 'B-' }] },
      { id: 'money', name: '돈', grade: 'D', metric: { type: 'same', of: 'finish' }, steps: [{ at: 13, grade: 'D+' }] },
      { id: 'work', name: '일', grade: 'C-', metric: { type: 'item_total', item: 'apply' }, steps: [{ at: 10, grade: 'C' }, { at: 20, grade: 'C+' }] },
      { id: 'people', name: '사람', grade: 'C', metric: { type: 'item_total', item: 'one_on_one' }, steps: [{ at: 2, grade: 'C+' }], add: { name: '1:1 만남' } },
      { id: 'brain', name: '머리', grade: 'A', metric: { type: 'keep' } },
    ],
  };
  const S = GM.statsNow(def, { cfg: store.config(), days: [store.day('2026-11-13')], todayKey: '2026-11-13' });
  const by = id => S.find(s => s.id === id);
  assert.deepEqual([by('finish').value, by('finish').grade, by('finish').next.at], [7, 'D', 13]);
  assert.ok(Math.abs(by('finish').pct - 7 / 13) < 1e-9);
  assert.deepEqual([by('money').value, by('money').grade], [7, 'D'], '같은 숫자를 쓴다');
  assert.deepEqual([by('work').value, by('work').grade, by('work').reached, by('work').next.at], [12, 'C', 1, 20]);
  assert.ok(Math.abs(by('work').pct - 0.2) < 1e-9, '10에서 20 사이의 20%');
  assert.equal(by('people').missing, 'one_on_one', '항목이 없으면 만들라고 알려준다');
  assert.equal(by('brain').keep, true);
  assert.equal(GM.statBonus(S), GM.STEP_BONUS, '채운 목표 하나만큼 보너스');
  assert.ok(GM.gradeScore('A') > GM.gradeScore('C') && GM.gradeScore('C') > GM.gradeScore('D'));
});

test('스탯: 최근 N일 중 제시간에 한 날 (예정 ±30분)', () => {
  const now = clock(at(9, 0, 13));
  const store = createStore({ storage: new MemoryStorage(), now });
  store.saveItem({ id: 'lights', name: '소등', icon: '🌙', cat: 'habit', type: 'check', block: 'night', plan: { time: '23:30' } });
  const days = [];
  for (const [d, h, m] of [[10, 23, 40], [11, 0, 30], [12, 23, 20]]) {
    const k = `2026-11-${d}`;
    store.logEvent(k, 'lights', { t: C.tsFor(k, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`) });
    days.push(store.day(k));
  }
  const ctx = { cfg: store.config(), days, todayKey: '2026-11-13' };
  assert.equal(GM.metricValue({ type: 'item_days', item: 'lights', days: 14, onTime: true }, ctx), 2, '00:30은 1시간 늦어서 빠진다');
  assert.equal(GM.metricValue({ type: 'item_days', item: 'lights', days: 14 }, ctx), 3);
});

test('메인 퀘스트: 수동 과제는 기록 이벤트로, 자동 과제는 지표로, 단계 상태와 보너스', () => {
  const now = clock(at(9, 0, 20));
  const store = createStore({ storage: new MemoryStorage(), now });
  store.saveItem({ id: 'pain_note', name: '불편 한 줄', icon: '📝', cat: 'habit', type: 'log', ask: 'note', block: 'any' });
  for (let i = 0; i < 3; i++) store.logEvent('2026-11-20', 'pain_note', { t: at(10, i, 20), note: '문의 놓침' });
  store.logEvent('2026-11-20', 'q:a2');
  store.logEvent('2026-11-20', 'report5', { t: at(18, 0, 20), did: '숫자 셋 받음' });
  store.logEvent('2026-11-21', 'report5', { t: at(18, 0, 21), did: '데모 준비' });
  const quest = {
    stages: [
      { id: 's1', name: '재기', from: '2026-11-14', to: '2026-12-27', tasks: [{ id: 'a1', text: '불편 3줄', auto: { type: 'item_total', item: 'pain_note', at: 3 } }, { id: 'a2', text: '숫자 받기' }] },
      { id: 's2', name: '파기', from: '2027-01-04', to: '2027-02-26', tasks: [{ id: 'b1', text: '보고 2번', auto: { type: 'reports', at: 2 } }, { id: 'b2', text: '데모' }] },
    ],
  };
  const days = ['2026-11-20', '2026-11-21'].map(k => store.day(k));
  const Q = GM.questState(quest, { cfg: store.config(), days, todayKey: '2026-11-21' });
  assert.deepEqual(Q.stages.map(s => [s.status, s.ok]), [['done', 2], ['later', 1]]);
  assert.equal(Q.current.id, 's2');
  assert.equal(Q.bonus, 3 * GM.QUEST_BONUS);
  assert.equal(Q.stages[0].tasks[1].evKey, '2026-11-20');
  assert.deepEqual(GM.reportsOf(days).map(r => r.did), ['숫자 셋 받음', '데모 준비'], '시간 순');
  assert.equal(GM.reportsOf(days, '2026-11-21').length, 1, '시작일 전 보고는 세지 않는다');
  assert.equal(GM.questState({ stages: [] }, { days }), null);
});

test('지표: withNote면 글이 있는 기록만 센다 (빈 줄은 30줄에 안 들어간다)', () => {
  const now = clock(at(9, 0, 20));
  const store = createStore({ storage: new MemoryStorage(), now });
  store.saveItem({ id: 'pain_note', name: '불편 한 줄', icon: '📝', cat: 'habit', type: 'log', ask: 'note', block: 'any' });
  store.logEvent('2026-11-20', 'pain_note', { t: at(10, 0, 20), note: '배달 접음' });
  store.logEvent('2026-11-20', 'pain_note', { t: at(11, 0, 20) });
  const ctx = { cfg: store.config(), days: [store.day('2026-11-20')], todayKey: '2026-11-20' };
  assert.equal(GM.metricValue({ type: 'item_total', item: 'pain_note' }, ctx), 2);
  assert.equal(GM.metricValue({ type: 'item_total', item: 'pain_note', withNote: true }, ctx), 1);
});

test('아침 루틴: 기록에서 단계를 확인한다', () => {
  const now = clock(at(9, 0));
  const store = createStore({ storage: new MemoryStorage(), now });
  const key = '2026-11-12';
  let st = GM.routineState(GM.DEFAULT_ROUTINE, store.day(key));
  assert.equal(st.filter(s => s.done).length, 0);
  store.setWake(key, at(8, 30));
  store.logEvent(key, 'water');
  store.logEvent(key, 'rt:light');
  store.setTop3(key, 't1', { text: '코테 1문제' });
  assert.equal(GM.routineState(GM.DEFAULT_ROUTINE, store.day(key)).find(s => s.id === 'top3').done, false, '마감 시각까지 정해야 끝');
  store.setTop3(key, 't1', { text: '코테 1문제', due: at(12) });
  st = GM.routineState(GM.DEFAULT_ROUTINE, store.day(key));
  assert.deepEqual(st.filter(s => s.done).map(s => s.id), ['wake', 'water', 'light', 'top3']);
  assert.equal(GM.routineState(GM.DEFAULT_ROUTINE, store.day(key), { focusOn: true }).find(s => s.id === 'focus').done, true);
  const steps = [{ id: 'a' }, { id: 'w', days: 'weekday' }, { id: 'e', days: 'weekend' }];
  assert.deepEqual(GM.routineFor(steps, '2026-11-13').map(s => s.id), ['a', 'w'], '금요일은 평일');
  assert.deepEqual(GM.routineFor(steps, '2026-11-14').map(s => s.id), ['a', 'e'], '토요일은 주말');
  assert.equal(GM.routineFor(null, '2026-11-14').length, GM.DEFAULT_ROUTINE.length);
});

test('코치: 외부 마감 30분 전과 지난 뒤, 최고 구간엔 50분, 시작이 안 되면 2분', () => {
  const now = clock(at(8));
  const store = createStore({ storage: new MemoryStorage(), now });
  const key = '2026-11-12';
  store.setWake(key, at(8));
  store.logEvent(key, 'med_am');
  store.logEvent(key, 'meal');
  store.setSkip(key, 'stretch', true);
  store.setTop3(key, 't1', { text: '코테 2문제', due: at(12), to: '형' });
  const coach = (extra = {}) => C.coach({ now: now(), day: store.day(key), cfg: store.config(), local: store.local(), ...extra });
  now.set(at(11, 40));
  let s = coach().find(x => x.key === 't3:due:t1');
  assert.match(s.title, /마감 20분 전/);
  assert.match(s.sub, /형에게 보고/);
  now.set(at(12, 10));
  s = coach().find(x => x.key === 't3:late:t1');
  assert.equal(s.alt.act, 't3-edit');
  assert.ok(coach().some(x => x.key === 'start2'), '2시간 넘게 집중을 안 했으면 2분 시작');
  const peak = coach({ windows: [{ start: at(11), end: at(14), name: '약' }, { start: at(12), end: at(13), name: '약', peak: true }] }).find(x => x.key === 't3:go:t1');
  assert.equal(peak.action.arg, '50:t1');
  store.logEvent(key, 'focus', { min: 25 });
  assert.ok(!coach().some(x => x.key === 'start2'));
});

test('날씨: 코드 풀이와 해 시각, 위치는 소수 첫째 자리까지만 보낸다', async () => {
  assert.equal(WX.describe(0).text, '맑음');
  assert.equal(WX.describe(63).icon, '🌧️');
  assert.equal(WX.isWet({ code: 61, precip: 0 }), true);
  assert.equal(WX.isWet({ code: 1, precip: 0 }), false);
  let asked = '';
  const fake = async url => {
    asked = url;
    return { ok: true, json: async () => ({ current: { temperature_2m: 11.6, weather_code: 0, precipitation: 0, is_day: 1 }, daily: { time: ['2026-11-13'], sunrise: ['2026-11-13T07:12'], sunset: ['2026-11-13T17:21'], uv_index_max: [2.5], precipitation_probability_max: [10], temperature_2m_max: [14], temperature_2m_min: [4] } }) };
  };
  const w = await WX.fetchWeather({ lat: 37.56789, lon: 126.97812 }, fake, 1);
  assert.match(asked, /latitude=37\.6&longitude=127/);
  assert.equal(w.temp, 11.6);
  const sun = WX.sunOf(w, '2026-11-13');
  assert.equal(sun.rise, new Date(2026, 10, 13, 7, 12).getTime());
  assert.equal(sun.set, new Date(2026, 10, 13, 17, 21).getTime());
  assert.equal(WX.sunOf(w, '2026-11-14'), null);
});
