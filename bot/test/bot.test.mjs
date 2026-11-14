import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../../js/core.js';
import { createStore } from '../../js/store.js';
import { createSync } from '../../js/sync.js';
import { MemoryStorage, clock, fakeGitHub } from '../../tests/helpers.mjs';
import { parseMessage, findTime } from '../lib/parse.mjs';
import { planPings, reportDraft } from '../lib/planner.mjs';
import { createBot, newPairCode } from '../lib/bot.mjs';
import { validate, createLLM, SCHEMA } from '../lib/llm.mjs';
import { geminiJSON, parseJSONText } from '../lib/llm-gemini.mjs';
import { parseEnv } from '../lib/env.mjs';
import { FileStorage } from '../lib/filestore.mjs';

// 2026-11-13은 금요일, 11-14는 토요일
const at = (h, m = 0, d = 13) => new Date(2026, 10, d, h, m).getTime();
const KEY = '2026-11-13';

// 이름 없는 시험용 약 곡선 (실제 약 정보는 비공개 저장소에만 있다)
const LONG = { id: 'long', name: '긴 약', kind: 'curve', group: 'g', halfLife: 3.5, parts: [{ f: 0.22, lag: 0.05, ka: 3 }, { f: 0.78, zo: [1, 7.5], ramp: 0.2 }] };

function config() {
  const c = C.defaultConfig(1);
  c.items = c.items.filter(i => i.id !== 'med_pm');
  c.items.find(i => i.id === 'med_am').drugs = [{ id: 'long', mg: 1 }];
  c.items.push(
    { id: 'med_pm', name: '오후 약', icon: '💊', cat: 'med', type: 'check', block: 'day', essential: true, plan: { time: '14:00' }, cue: '점심 먹고 바로', order: 20, m: 1 },
    { id: 'pain_note', name: '불편 한 줄', icon: '📝', cat: 'habit', type: 'log', ask: 'note', noteFirst: true, block: 'any', order: 21, m: 1 },
    { id: 'park', name: '주차장', icon: '🅿️', cat: 'habit', type: 'log', ask: 'note', noteFirst: true, block: 'any', order: 22, m: 1 },
    { id: 'apply', name: '지원', icon: '📨', cat: 'habit', type: 'count', block: 'any', order: 23, m: 1 },
    { id: 'lights_out', name: '23:30 소등', icon: '🌙', cat: 'habit', type: 'check', block: 'night', plan: { time: '23:30' }, order: 24, m: 1 },
    { id: 'med_night', name: '자기 전 약', icon: '💊', cat: 'med', type: 'check', block: 'night', order: 25, m: 1 },
  );
  return c;
}
const GAME = {
  v: 1,
  stats: [],
  routine: [
    { id: 'wake', text: '시각 남기기', check: 'wake' },
    { id: 'med', icon: '💊', text: '약', check: 'item', item: 'med_am', min: 5 },
    { id: 'shower', icon: '🚿', text: '샤워', check: 'manual', min: 20 },
    { id: 'top3', icon: '🎯', text: '결과물 하나 + 마감', check: 'top3', min: 40 },
    { id: 'out', icon: '🚪', text: '집 밖으로', check: 'manual', min: 60 },
  ],
  routineGo: { min: 60, weekday: '08:40', step: 'out' },
  daily: [{ item: 'pain_note', days: 'weekday', after: '18:30', text: '오늘 불편 한 줄' }],
  hints: [
    { id: 'night', after: '21:00', text: '밤 9시 규칙', ask: 'tomorrow' },
    { id: 'worry', after: '18:00', before: '19:30', ifItem: 'park', text: '걱정 시간' },
  ],
  report: { to: '형', nums: [{ id: 'a', label: '문의 수' }] },
};
const OPTS = { wakeWeekday: '07:00', wakeWeekend: '08:00', quietFrom: '01:00', quietTo: '06:30', appUrl: 'https://x/' };

function makeStore(now) {
  const store = createStore({ storage: new MemoryStorage(), now });
  store.applyRemote('config.json', config());
  store.setGame(GAME);
  store.setMeds({ v: 1, drugs: [LONG] });
  return store;
}
const plan = (store, now, state = {}) =>
  planPings({ now: now(), cfg: store.config(), day: store.day(C.dayKey(now(), 4)), recentDays: [], game: store.game(), profiles: store.meds(), state, opts: OPTS });
const keys = list => list.map(p => p.key);

// ---------------- 말 알아듣기 ----------------
test('해석: 시각이 붙은 할 일, 머리말, 끝, 약·기상·출발', () => {
  const ctx = h => ({ now: at(h, 30), key: KEY, rollover: 4 });
  const top = (s, h = 17) => parseMessage(s, ctx(h)).actions[0];
  assert.deepEqual([top('코테 2문제 21시까지').text, C.fmtTime(top('코테 2문제 21시까지').due)], ['코테 2문제', '21:00']);
  assert.equal(C.fmtTime(top('레포 올리기 9시 반').due), '21:30', '저녁에 9시는 21시');
  assert.equal(C.fmtTime(top('9시 코테', 7).due), '09:00', '아침에 9시는 9시');
  assert.equal(C.fmtTime(top('코테 1시간 뒤').due), '18:30');
  assert.equal(C.fmtTime(top('오후 12시까지 이력서', 9).due), '12:00', '오후 12시는 정오');
  assert.equal(top('밤 12시까지 정리').due, C.tsFor(KEY, '00:00'), '밤 12시는 자정 (다음 날 0시)');
  assert.ok(top('3시에 전화').due < at(17, 30), '오후 5시 반에 "3시"는 지난 오후 3시 (새벽 3시 아님)');
  assert.equal(C.fmtTime(top('새벽 2시까지 마무리').due), '02:00');
  const tm = top('내일 10시 코테');
  assert.deepEqual([tm.key, tm.text, C.fmtTime(tm.due)], ['2026-11-14', '코테', '10:00']);
  assert.equal(parseMessage('에너지 21시에너지', ctx(17)), null, '단어 중간을 시각으로 자르지 않는다');
  assert.equal(parseMessage('코테 2시간 하기', ctx(17)), null, '"2시간"은 시각이 아니다');
  assert.deepEqual(top('걱정: 동기들은 벌써'), { type: 'park', note: '동기들은 벌써' });
  assert.deepEqual(top('불편: 배달 접었어'), { type: 'note', item: 'pain_note', note: '배달 접었어' });
  assert.deepEqual(top('끝냈어요!'), { type: 'top3_done', id: null, out: '' });
  assert.deepEqual(top('끝 풀이 올림'), { type: 'top3_done', id: null, out: '풀이 올림' });
  assert.deepEqual(top('다 했어 데모 링크'), { type: 'top3_done', id: null, out: '데모 링크' });
  assert.equal(top('약 먹었어').type, 'med');
  assert.equal(top('일어났어').type, 'wake');
  assert.equal(top('나왔어요').type, 'out');
  assert.equal(top('오늘').type, 'status');
  assert.equal(parseMessage('안녕', ctx(17)), null, '모르는 말은 AI에게');
});

test('해석: 내가 물어본 것의 답은 그 질문으로, 머리말이 있으면 머리말이 먼저', () => {
  const base = { now: at(17, 30), key: KEY, rollover: 4 };
  assert.deepEqual(parseMessage('풀이 올림', { ...base, awaiting: { kind: 'out', id: 't1' } }).actions[0], { type: 'top3_done', id: 't1', out: '풀이 올림' });
  assert.equal(parseMessage('21시', { ...base, awaiting: { kind: 'due', id: 't2' } }).actions[0].type, 'top3_due');
  assert.equal(parseMessage('배달 수수료', { ...base, awaiting: { kind: 'note', item: 'pain_note' } }).actions[0].note, '배달 수수료');
  assert.equal(parseMessage('코테 2문제 11시', { ...base, awaiting: { kind: 'tomorrow' } }).actions[0].key, '2026-11-14');
  assert.equal(parseMessage('걱정: 돈', { ...base, awaiting: { kind: 'out', id: 't1' } }).actions[0].type, 'park');
  assert.equal(findTime('마감 없음', base), null);
});

// ---------------- 먼저 말 걸기 ----------------
test('알림: 기상 → 루틴 다음 단계 → 출발 마감', () => {
  const now = clock(at(7, 6));
  const store = makeStore(now);
  assert.deepEqual(keys(plan(store, now)), ['wake1']);
  now.set(at(7, 40));
  assert.deepEqual(keys(plan(store, now)), ['wake1', 'wake2']);
  store.setWake(KEY, at(7, 0));
  now.set(at(7, 6));
  assert.deepEqual(keys(plan(store, now)), ['rt:med'], '일어나고 5분: 약');
  store.logEvent(KEY, 'med_am', { t: at(7, 6) });
  now.set(at(7, 21));
  const p = plan(store, now).find(x => x.key === 'rt:shower');
  assert.match(p.text, /07:20까지/);
  assert.equal(p.buttons[0][0].callback_data, 'rt:shower');
  store.logEvent(KEY, 'rt:shower');
  now.set(at(7, 41));
  const t3 = plan(store, now).find(x => x.key === 'rt:top3');
  assert.deepEqual(t3.await, { kind: 'top3' }, '결과물은 답장으로 받는다');
  now.set(at(7, 52));
  assert.ok(keys(plan(store, now)).includes('go10:' + at(8, 0)), '목표 10분 전');
  now.set(at(8, 1));
  assert.ok(keys(plan(store, now)).includes('go0:' + at(8, 0)));
  store.logEvent(KEY, 'rt:out');
  assert.ok(!keys(plan(store, now)).some(k => k.startsWith('go')), '나가면 출발 알림 끝');
  assert.ok(!keys(plan(store, now, { routineOff: true })).some(k => k.startsWith('rt:')), '루틴 그만이면 단계 알림 없음');
});

test('알림: 핵심 3가지 마감 30분 전, 마감, 1시간 지남. 미루면 새로 센다', () => {
  const now = clock(at(20, 31));
  const store = makeStore(now);
  store.setWake(KEY, at(7, 0));
  store.setTop3(KEY, 't1', { text: '코테 2문제', due: at(21, 0), to: '형' });
  let p = plan(store, now).find(x => x.kind === 'due');
  assert.equal(p.key, `due30:t1:${at(21, 0)}`);
  assert.match(p.text, /29분 남았어요: 코테 2문제 \(21:00 마감 · 형에게 보고\)/);
  now.set(at(21, 5));
  p = plan(store, now).find(x => x.kind === 'due');
  assert.equal(p.key, `due0:t1:${at(21, 0)}`);
  assert.deepEqual(p.await, { kind: 'out', id: 't1' });
  now.set(at(22, 10));
  p = plan(store, now).find(x => x.kind === 'due');
  assert.equal(p.key, `due60:t1:${at(21, 0)}`);
  store.setTop3(KEY, 't1', { due: at(22, 30) });
  p = plan(store, now).find(x => x.kind === 'due');
  assert.equal(p.key, `due30:t1:${at(22, 30)}`, '미룬 마감은 다시 30분 전부터');
  store.setTop3(KEY, 't1', { done: at(22, 15) });
  assert.ok(!plan(store, now).some(x => x.kind === 'due'), '끝낸 건 안 묻는다');
});

test('알림: 예정 약은 시각에, 1시간 지나면 한 번 더. 소등 30분 전엔 자기 전 약 버튼도', () => {
  const now = clock(at(14, 1));
  const store = makeStore(now);
  store.setWake(KEY, at(7, 0));
  store.logEvent(KEY, 'med_am', { t: at(7, 5) });
  assert.ok(keys(plan(store, now)).includes('dose:med_pm'));
  assert.ok(!keys(plan(store, now)).includes('dose2:med_pm'));
  now.set(at(15, 5));
  assert.ok(keys(plan(store, now)).includes('dose2:med_pm'));
  store.setSkip(KEY, 'med_pm', true, 'other');
  assert.ok(!keys(plan(store, now)).some(k => k.startsWith('dose')), '건너뛰면 안 묻는다');
  now.set(at(23, 1));
  const p = plan(store, now).find(x => x.key === 'plan:lights_out');
  assert.match(p.text, /29분 남았어요/);
  assert.equal(p.buttons[0][0].callback_data, 'log:med_night');
  assert.equal(p.buttons[1][0].callback_data, 'log:lights_out');
});

test('알림: 매일 한 줄(평일 18:30 뒤), 걱정 시간은 주차장에 적은 날만, 밤 9시엔 내일 결과물을 묻는다', () => {
  const now = clock(at(18, 31));
  const store = makeStore(now);
  store.setWake(KEY, at(7, 0));
  let p = plan(store, now).find(x => x.key === 'daily:pain_note');
  assert.deepEqual(p.await, { kind: 'note', item: 'pain_note' });
  assert.ok(!keys(plan(store, now)).includes('hint:worry'), '주차장이 비면 걱정 시간 없음');
  store.logEvent(KEY, 'park', { note: '동기 비교' });
  p = plan(store, now).find(x => x.key === 'hint:worry');
  assert.match(p.text, /· 동기 비교/);
  const sat = clock(at(18, 31, 14));
  const s2 = makeStore(sat);
  s2.setWake('2026-11-14', at(9, 0, 14));
  assert.ok(!keys(plan(s2, sat)).includes('daily:pain_note'), '주말엔 평일 전용 알림 없음');
  now.set(at(21, 2));
  p = plan(store, now).find(x => x.key === 'hint:night');
  assert.deepEqual(p.await, { kind: 'tomorrow' });
});

test('알림: 조용한 시간엔 말 걸지 않고, 집중 타이머 끝은 예외. 약 효과 최고 구간 시작에 한 번', () => {
  const now = clock(at(2, 0, 14));
  const store = makeStore(now);
  store.setTop3(KEY, 't1', { text: 'x', due: at(1, 30, 14) });
  assert.deepEqual(keys(plan(store, now)), [], '새벽 2시는 조용');
  const focus = { start: at(1, 0, 14), dur: 50, label: 'x', t3: 't1' };
  assert.deepEqual(keys(plan(store, now, { focus })), [`fxend:${at(1, 0, 14)}`]);

  const n2 = clock(at(7, 0));
  const s2 = makeStore(n2);
  s2.setWake(KEY, at(7, 0));
  s2.logEvent(KEY, 'med_am', { t: at(7, 0) });
  s2.logEvent(KEY, 'rt:shower');
  s2.logEvent(KEY, 'rt:out');
  s2.setTop3(KEY, 't1', { text: 'x', due: at(23, 0) });
  let first = null;
  for (let t = at(7, 0); t < at(20, 0); t += 10 * C.MIN) {
    n2.set(t);
    const pk = plan(s2, n2).find(x => x.kind === 'peak');
    if (pk) {
      first = { t, pk };
      break;
    }
  }
  assert.ok(first, '최고 구간 알림이 한 번은 나온다');
  assert.ok(first.t >= at(12, 0) && first.t <= at(17, 0), `최고 구간은 오후 (${C.fmtTime(first.t)})`);
  assert.equal(first.pk.buttons[0][0].callback_data, 'fx:50');
});

test('알림: 금요일 17시 뒤 5줄 초안 (사흘 안에 보낸 게 없을 때)', () => {
  const now = clock(at(17, 30));
  const store = makeStore(now);
  store.setWake(KEY, at(7, 0));
  store.setTop3(KEY, 't1', { text: '코테 2문제', done: at(12, 0), out: '풀이 올림' });
  const week = [store.day(KEY)];
  const ps = planPings({ now: now(), cfg: store.config(), day: store.day(KEY), recentDays: week, game: store.game(), profiles: [], opts: OPTS });
  const r = ps.find(p => p.key === 'report5');
  assert.match(r.text, /→ 형/);
  assert.match(r.text, /코테 2문제 \(풀이 올림\)/);
  assert.match(r.text, /https:\/\/x\/\?go=report/);
  store.logEvent(KEY, 'report5', { did: 'x' });
  const again = planPings({ now: now(), cfg: store.config(), day: store.day(KEY), recentDays: [store.day(KEY)], game: store.game(), profiles: [], opts: OPTS });
  assert.ok(!again.some(p => p.key === 'report5'));
  assert.match(reportDraft({ to: '', nums: [] }, [], ''), /한 것: \(채우기\)/);
});

// ---------------- 비서 전체 ----------------
function harness(startTs) {
  const now = clock(startTs);
  const store = makeStore(now);
  const sent = [];
  const tg = {
    send: async (chat, text, buttons) => sent.push({ chat, text, buttons }),
    answer: async () => {},
    clearButtons: async () => {},
  };
  const sync = { syncNow: async () => {} };
  const state = { pairCode: '123456' };
  const bot = createBot({ store, sync, tg, state, now, opts: OPTS });
  const msg = (text, chat = 7, from = 7) => bot.handleUpdate({ message: { chat: { id: chat, type: 'private' }, from: { id: from }, text } });
  const tap = (data, chat = 7, from = 7) => bot.handleUpdate({ callback_query: { id: 'q', data, from: { id: from }, message: { message_id: 1, chat: { id: chat } } } });
  return { now, store, sent, state, bot, msg, tap, last: () => sent.at(-1)?.text };
}

test('비서: 6자리 코드로 주인을 정하고, 주인이 아니면 무시한다', async () => {
  const h = harness(at(17, 0));
  await h.msg('/start 000000');
  assert.match(h.last(), /6자리 코드/);
  assert.equal(h.state.owner, undefined);
  await h.msg('/start 123456');
  assert.equal(h.state.owner, 7);
  assert.equal(h.state.pairCode, null);
  const n = h.sent.length;
  await h.msg('코테 21시', 99, 99);
  await h.tap('wake', 99, 99);
  assert.equal(h.sent.length, n, '다른 사람 말은 무시');
  assert.equal(C.top3Of(h.store.day(KEY)).length, 0);
  assert.match(newPairCode(), /^\d{6}$/);
});

test('비서: 마감 정하기 → 끝 버튼 → 결과물 한 줄 답장', async () => {
  const h = harness(at(17, 0));
  h.state.owner = 7;
  await h.msg('코테 2문제 21시');
  const t = C.top3Of(h.store.day(KEY))[0];
  assert.deepEqual([t.text, C.fmtTime(t.due)], ['코테 2문제', '21:00']);
  assert.match(h.last(), /21:00 마감으로 잡았어요/);
  await h.msg('이력서 3시');
  assert.match(h.last(), /15:00는 이미 지났어요/);
  assert.equal(h.state.awaiting.kind, 'due');
  await h.msg('22시');
  assert.equal(C.fmtTime(C.top3Of(h.store.day(KEY)).find(x => x.text === '이력서').due), '22:00');
  await h.tap(`t3d:${t.id}`);
  assert.ok(C.top3Of(h.store.day(KEY)).find(x => x.id === t.id).done);
  assert.equal(h.state.awaiting.kind, 'out');
  await h.msg('풀이 깃허브에 올림');
  assert.equal(C.top3Of(h.store.day(KEY)).find(x => x.id === t.id).out, '풀이 깃허브에 올림');
  await h.tap('t3s:t2:15');
  assert.match(h.last(), /22:15로 미뤘어요/);
});

test('비서: 버튼으로 약·루틴·출발 기록, 집중 타이머 끝에 기록과 메모', async () => {
  const h = harness(at(7, 0));
  h.state.owner = 7;
  await h.tap('wake');
  assert.equal(C.wakeOf(h.store.day(KEY)), at(7, 0));
  await h.tap('log:med_am');
  assert.equal(C.itemState(h.store.day(KEY), { id: 'med_am', type: 'check' }).count, 1);
  await h.tap('log:med_am');
  assert.match(h.last(), /이미 07:00에 기록/);
  h.now.set(at(7, 48));
  await h.tap('rt:out');
  assert.match(h.last(), /출발 07:48 · 일어나고 48분 \(목표보다 12분 빨라요!\)/);
  await h.tap('fx:25');
  assert.equal(h.state.focus.dur, 25);
  h.now.set(at(8, 12));
  await h.bot.tick();
  assert.ok(!h.sent.some(s => /25분 끝/.test(s.text)), '07:48에 시작한 25분은 08:13에 끝난다');
  h.now.set(at(8, 14));
  await h.bot.tick();
  assert.ok(h.sent.some(s => /25분 끝/.test(s.text)));
  const fx = C.live(h.store.day(KEY)).find(e => e.item === 'focus');
  assert.equal(fx.min, 25);
  assert.equal(h.state.awaiting.kind, 'fnote');
  await h.msg('코테 1문제 풀이');
  assert.equal(C.live(h.store.day(KEY)).find(e => e.item === 'focus').note, '코테 1문제 풀이');
});

test('비서: 같은 알림은 하루 한 번, /pause면 그날은 조용히, 주차장·불편 한 줄', async () => {
  const h = harness(at(14, 1));
  h.state.owner = 7;
  h.store.setWake(KEY, at(7, 0));
  h.store.logEvent(KEY, 'med_am', { t: at(7, 5) });
  h.store.logEvent(KEY, 'rt:shower');
  h.store.logEvent(KEY, 'rt:out');
  h.store.setTop3(KEY, 't1', { text: 'x', due: at(23, 0) });
  await h.bot.tick();
  const n = h.sent.filter(s => /오후 약/.test(s.text)).length;
  assert.equal(n, 1);
  await h.bot.tick();
  assert.equal(h.sent.filter(s => /오후 약/.test(s.text)).length, 1, '두 번 보내지 않는다');
  await h.msg('/pause');
  h.now.set(at(15, 5));
  await h.bot.tick();
  assert.ok(!h.sent.some(s => /아직이에요/.test(s.text)), '쉬는 날엔 다시 묻지 않는다');
  await h.msg('걱정: 동기 비교');
  assert.equal(C.live(h.store.day(KEY)).find(e => e.item === 'park').note, '동기 비교');
  await h.msg('불편: 배달 수수료');
  assert.match(h.last(), /불편 한 줄 남겼어요/);
  await h.msg('오늘');
  assert.match(h.last(), /🔕/);
});

test('비서: 모르는 말은 AI에게 묻고, AI 답은 검사한 행동만 쓴다', async () => {
  const h = harness(at(17, 0));
  h.state.owner = 7;
  let asked = null;
  const llm = {
    parse: async (text, ctx) => {
      asked = { text, ctx };
      return validate({ actions: [{ type: 'top3_set', text: '이력서 고치기', due: '22:00', item: '', id: '' }, { type: 'log', text: '', due: '', item: 'rm_rf', id: '' }], reply: '좋아요' }, ctx);
    },
  };
  const bot = createBot({ store: h.store, sync: { syncNow: async () => {} }, tg: { send: async (c, t) => h.sent.push({ text: t }), answer: async () => {}, clearButtons: async () => {} }, llm, state: h.state, now: h.now, opts: OPTS });
  await bot.handleUpdate({ message: { chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '이력서 좀 고쳐야 하는데 열 시까지' } });
  assert.ok(asked.ctx.items.some(i => i.id === 'med_am'));
  assert.ok(!JSON.stringify(asked.ctx).includes('long'), 'AI에게 약 정보(곡선·성분)는 보내지 않는다');
  const t = C.top3Of(h.store.day(KEY))[0];
  assert.deepEqual([t.text, C.fmtTime(t.due)], ['이력서 고치기', '22:00']);
  assert.match(h.sent.at(-1).text, /좋아요/);
});

test('AI 답 검사: 모르는 행동·항목은 버리고, 칸은 잘라 낸다', () => {
  const ctx = { items: [{ id: 'water', name: '물' }], top3: [{ id: 't1', text: 'a' }] };
  const v = validate({ actions: [{ type: 'hack' }, { type: 'log', item: 'water', text: 'x' }, { type: 'log', item: 'nope' }, { type: 'top3_done', id: 't9', text: '결과' }, { type: 'top3_set', text: 'b', due: '25시' }], reply: 'ok' }, ctx);
  assert.deepEqual(v.actions, [{ type: 'note', item: 'water', note: 'x' }, { type: 'top3_done', id: null, out: '결과' }, { type: 'top3_set', text: 'b', dueText: '' }]);
  assert.equal(validate(null, ctx), null);
  assert.equal(createLLM({ provider: 'gemini' }), null, '키가 없으면 AI 없음');
  assert.equal(createLLM({ provider: 'none', geminiKey: 'k' }), null);
  assert.equal(SCHEMA.properties.actions.items.additionalProperties, false);
});

test('Gemini: 키는 헤더로, 답은 JSON으로 읽는다', async () => {
  let seen = null;
  const fetchFn = async (url, o) => {
    seen = { url, headers: o.headers, body: JSON.parse(o.body) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '```json\n{"actions":[],"reply":"네"}\n```' }] } }] }) };
  };
  const out = await geminiJSON({ apiKey: 'KEY123', system: 's', user: 'u', schema: SCHEMA, fetchFn });
  assert.deepEqual(out, { actions: [], reply: '네' });
  assert.ok(!seen.url.includes('KEY123'), '키를 주소에 넣지 않는다');
  assert.equal(seen.headers['x-goog-api-key'], 'KEY123');
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
  await assert.rejects(geminiJSON({ apiKey: 'k', system: '', user: '', schema: {}, fetchFn: async () => ({ ok: false, status: 429 }) }), /한도/);
  assert.throws(() => parseJSONText('없음'), /읽지 못했어요/);
  assert.deepEqual(parseJSONText('앞말 {"a":1} 뒷말'), { a: 1 });
});

test('동기화: 비서가 남긴 기록이 비공개 저장소를 거쳐 폰에 그대로 합쳐진다', async () => {
  const gh = fakeGitHub();
  const now = clock(at(9, 0));
  const repo = { gh: { repo: 'me/data', token: 'good' } };
  // 폰: 설정을 먼저 올려 둔다
  const phone = createStore({ storage: new MemoryStorage(), now });
  phone.applyRemote('config.json', config());
  phone.setLocal(repo);
  phone.markAllDirty();
  phone.logEvent(KEY, 'med_am', { t: at(8, 0) });
  const phoneSync = createSync({ store: phone, fetchFn: gh.fetchFn, now, todayKey: () => KEY });
  await phoneSync.syncNow();
  // 비서: 빈 기기에서 받기만 하고 시작 (기본 설정으로 원격을 덮지 않는다)
  const botStore = createStore({ storage: new MemoryStorage(), now });
  botStore.setLocal(repo, true);
  const botSync = createSync({ store: botStore, fetchFn: gh.fetchFn, now, todayKey: () => KEY });
  await botSync.syncNow({ pull: true });
  assert.equal(gh.log.filter(l => l.startsWith('PUT /repos/me/data/contents/config.json')).length, 1, '설정은 폰이 올린 한 번뿐');
  assert.ok(botStore.config().items.some(i => i.id === 'pain_note'));
  const bot = createBot({ store: botStore, sync: botSync, tg: { send: async () => {}, answer: async () => {}, clearButtons: async () => {} }, state: { owner: 7 }, now, opts: OPTS });
  await bot.apply([{ type: 'note', item: 'pain_note', note: '문의 놓침' }]);
  await botSync.syncNow({ pull: false });
  await phoneSync.syncNow();
  const evs = C.live(phone.day(KEY)).map(e => e.item);
  assert.deepEqual(evs, ['med_am', 'pain_note'], '폰에 비서 기록이 들어오고, 폰 기록도 그대로');
});

test('설정 파일과 파일 저장소', () => {
  assert.deepEqual(parseEnv('﻿# 주석\nA=1\nB="두 단어"\n C = \'x\' \nbad\n'), { A: '1', B: '두 단어', C: 'x' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'today-bot-'));
  const file = path.join(dir, 'store.json');
  const s = new FileStorage(file);
  s.setItem('a', 'x');
  s.setItem('b', 'y');
  s.removeItem('a');
  const again = new FileStorage(file);
  assert.equal(again.getItem('b'), 'y');
  assert.equal(again.getItem('a'), null);
  assert.equal(again.length, 1);
  fs.writeFileSync(file, '{깨짐');
  assert.equal(new FileStorage(file).length, 0, '깨진 파일이면 빈 저장소로 시작');
  fs.rmSync(dir, { recursive: true, force: true });
});
