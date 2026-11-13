import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/core.js';
import { createStore } from '../js/store.js';
import { createSync, b64enc, b64dec } from '../js/sync.js';
import { MemoryStorage, clock, fakeGitHub } from './helpers.mjs';

const at = (h, m = 0, d = 12) => new Date(2026, 10, d, h, m).getTime();
const KEY = '2026-11-12';
const PATH = 'days/2026/2026-11-12.json';

function device(gh, now, token = 'good') {
  const store = createStore({ storage: new MemoryStorage(), now });
  const sync = createSync({ store, fetchFn: gh.fetchFn, now, todayKey: () => C.dayKey(now()) });
  return { store, sync, connect: () => sync.connect('me/today-data', token) };
}

test('base64: 한글과 이모지가 그대로 돌아온다', () => {
  const s = JSON.stringify({ note: '김치찌개 🍲 든든하게', n: 3 });
  assert.equal(b64dec(b64enc(s)), s);
  assert.equal(b64dec('eyJh\nIjox\nfQ=='), '{"a":1}', 'GitHub이 넣는 줄바꿈을 무시한다');
});

test('처음 연결하면 이 기기의 기록이 올라간다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now);
  a.store.logEvent(KEY, 'med_am', { autoWake: true });
  a.store.saveItem({ name: '비타민', icon: '🟡', cat: 'med', type: 'check', block: 'am' });
  await a.connect();
  assert.equal(a.sync.status().state, 'ok');
  assert.deepEqual([...gh.files.keys()].sort(), ['config.json', PATH]);
  assert.equal(gh.read(PATH).events[0].item, 'med_am');
  assert.deepEqual(a.store.dirtyPaths(), []);
});

test('두 번째 기기는 연결만 해도 같은 기록과 항목을 본다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now), b = device(gh, now);
  a.store.logEvent(KEY, 'med_am', { autoWake: true });
  a.store.saveItem({ name: '비타민', icon: '🟡', cat: 'med', type: 'check', block: 'am' });
  await a.connect();
  await b.connect();
  assert.equal(C.live(b.store.day(KEY)).length, 1);
  assert.equal(C.wakeOf(b.store.day(KEY)), at(8));
  assert.ok(C.activeItems(b.store.config()).some(i => i.name === '비타민'));
  assert.deepEqual(b.store.dirtyPaths(), [], '받기만 했으니 올릴 것이 없다');
});

test('두 기기가 따로 기록해도 충돌 없이 합쳐진다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now), b = device(gh, now);
  await a.connect();
  await b.connect();
  a.store.logEvent(KEY, 'med_am', { autoWake: true });
  now.tick(60000);
  b.store.logEvent(KEY, 'water');
  now.tick(60000);
  b.store.logEvent(KEY, 'coffee');
  await a.sync.syncNow({ pull: false });
  await b.sync.syncNow({ pull: false }); // b는 낡은 상태로 올리려다 충돌 → 받아서 합치고 다시 올린다
  assert.equal(b.sync.status().state, 'ok');
  assert.deepEqual(C.live(b.store.day(KEY)).map(e => e.item), ['med_am', 'water', 'coffee']);
  assert.deepEqual(gh.read(PATH).events.map(e => e.item), ['med_am', 'water', 'coffee']);
  await a.sync.syncNow();
  assert.equal(C.canon(a.store.day(KEY)), C.canon(b.store.day(KEY)), '두 기기가 같은 상태로 수렴한다');
  assert.deepEqual(a.store.dirtyPaths(), []);
});

test('한쪽에서 취소한 기록은 다른 기기에서도 사라진다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now), b = device(gh, now);
  const ev = a.store.logEvent(KEY, 'med_am');
  await a.connect();
  await b.connect();
  now.tick(1000);
  b.store.deleteEvent(KEY, ev.id);
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(C.live(a.store.day(KEY)).length, 0);
});

test('바뀐 것이 없으면 다시 받지 않는다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now);
  a.store.logEvent(KEY, 'med_am');
  await a.connect();
  gh.log.length = 0;
  await a.sync.syncNow();
  assert.deepEqual(gh.log, ['GET /repos/me/today-data/contents/config.json', 'GET /repos/me/today-data/contents/meds.json', 'GET /repos/me/today-data/contents/days/2026'], '목록만 확인하고 파일은 받지 않는다');
  gh.log.length = 0;
  a.store.logEvent(KEY, 'water');
  await a.sync.syncNow({ pull: false });
  assert.deepEqual(gh.log, ['PUT /repos/me/today-data/contents/days/2026/2026-11-12.json'], '변경은 요청 한 번으로 올라간다');
});

test('공개 저장소는 연결을 거부하고 아무것도 올리지 않는다', async () => {
  const gh = fakeGitHub({ isPrivate: false }), now = clock(at(8));
  const a = device(gh, now);
  a.store.logEvent(KEY, 'med_am');
  await assert.rejects(a.connect(), e => e.kind === 'public');
  assert.equal(gh.files.size, 0);
  assert.equal(a.store.local().gh, null);
  assert.equal(a.sync.status().state, 'off');
});

test('토큰이 틀리면 연결되지 않고, 기록은 기기에 그대로 남는다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now, 'bad');
  a.store.logEvent(KEY, 'med_am');
  await assert.rejects(a.connect(), e => e.kind === 'auth');
  assert.equal(C.live(a.store.day(KEY)).length, 1);
  await assert.rejects(a.sync.connect('잘못된 이름', 'good'), e => e.kind === 'input');
});

test('네트워크가 끊기면 대기 상태가 되고, 다시 연결되면 올라간다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  let up = true;
  const store = createStore({ storage: new MemoryStorage(), now });
  const sync = createSync({ store, now, todayKey: () => KEY, fetchFn: (u, o) => (up ? gh.fetchFn(u, o) : Promise.reject(new TypeError('offline'))) });
  await sync.connect('me/today-data', 'good');
  up = false;
  store.logEvent(KEY, 'med_am');
  await sync.syncNow({ pull: false });
  assert.equal(sync.status().state, 'offline');
  assert.deepEqual(store.dirtyPaths(), [PATH]);
  up = true;
  await sync.syncNow();
  assert.equal(sync.status().state, 'ok');
  assert.equal(gh.read(PATH).events.length, 1);
});

test('원격 파일이 사라졌어도 다시 만들어 올린다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now);
  a.store.logEvent(KEY, 'med_am');
  await a.connect();
  gh.files.delete(PATH);
  a.store.logEvent(KEY, 'water');
  await a.sync.syncNow({ pull: false });
  assert.equal(a.sync.status().state, 'ok');
  assert.equal(gh.read(PATH).events.length, 2);
});

test('원격 파일이 깨져 있으면 내 기록으로 덮어쓴다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now);
  a.store.logEvent(KEY, 'med_am');
  await a.connect();
  const b = device(gh, now);
  gh.files.set(PATH, { content: b64enc('{깨진 내용'), sha: 'broken' });
  await a.sync.syncNow();
  assert.equal(a.sync.status().state, 'ok');
  assert.equal(gh.read(PATH).events.length, 1);
  await b.connect();
  assert.equal(C.live(b.store.day(KEY)).length, 1);
});

test('약 정보(meds.json)는 받기만 하고, 바뀌었을 때만 다시 받는다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const meds = { v: 1, drugs: [{ id: 'a', name: '약 A', kind: 'curve', halfLife: 3, parts: [{ f: 1, ka: 2 }] }] };
  gh.files.set('meds.json', { content: b64enc(JSON.stringify(meds)), sha: 'm1' });
  const a = device(gh, now);
  await a.connect();
  assert.deepEqual(a.store.meds().map(d => d.id), ['a']);
  assert.ok(!gh.log.some(l => l.startsWith('PUT') && l.includes('meds.json')), '앱은 약 정보를 올리지 않는다');
  gh.log.length = 0;
  await a.sync.syncNow();
  assert.equal(gh.log.filter(l => l.includes('meds.json')).length, 1, '확인 요청은 한 번 (바뀐 게 없으면 304)');
  meds.drugs.push({ id: 'b', name: '약 B', kind: 'steady' });
  gh.files.set('meds.json', { content: b64enc(JSON.stringify(meds)), sha: 'm2' });
  await a.sync.syncNow();
  assert.deepEqual(a.store.meds().map(d => d.id), ['a', 'b']);
  gh.files.delete('meds.json');
  await a.sync.syncNow();
  assert.deepEqual(a.store.meds(), [], '저장소에서 지우면 기기에서도 사라진다');
});

test('연결을 끊으면 토큰이 지워지고 기록은 남는다', async () => {
  const gh = fakeGitHub(), now = clock(at(8));
  const a = device(gh, now);
  a.store.logEvent(KEY, 'med_am');
  await a.connect();
  a.sync.disconnect();
  assert.equal(a.store.local().gh, null);
  assert.equal(C.live(a.store.day(KEY)).length, 1);
  gh.log.length = 0;
  a.store.logEvent(KEY, 'water');
  await a.sync.syncNow();
  assert.deepEqual(gh.log, []);
});
