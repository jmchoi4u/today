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
