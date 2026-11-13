// 실제 GitHub API로 동기화 엔진을 확인하는 선택 테스트.
// 사용: GH_TOKEN=<토큰> GH_REPO=<계정/비공개저장소> node tests/live-sync.mjs
// 2001년 날짜의 시험용 파일만 만들고, 끝나면 지운다.
import assert from 'node:assert/strict';
import * as C from '../js/core.js';
import { createStore } from '../js/store.js';
import { createSync } from '../js/sync.js';
import { MemoryStorage } from './helpers.mjs';

const { GH_TOKEN: token, GH_REPO: repo } = process.env;
if (!token || !repo) {
  console.log('GH_TOKEN, GH_REPO가 없어서 건너뜁니다');
  process.exit(0);
}
const KEY = '2001-01-02', PATH = 'days/2001/2001-01-02.json';
const log = [];
const fetchFn = async (url, opts) => {
  const r = await fetch(url, opts);
  log.push(`${opts.method} ${new URL(url).pathname.replace(`/repos/${repo}`, '')} → ${r.status}`);
  return r;
};
const device = () => {
  const store = createStore({ storage: new MemoryStorage() });
  const sync = createSync({ store, fetchFn, todayKey: () => KEY });
  return { store, sync };
};
const api = (method, path, body) =>
  fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

async function cleanup() {
  const r = await api('GET', 'days/2001');
  if (r.status !== 200) return;
  for (const f of await r.json()) await api('DELETE', f.path, { message: `cleanup: ${f.path}`, sha: f.sha });
}

try {
  await cleanup();
  const a = device(), b = device();
  a.store.logEvent(KEY, 'med_am', { autoWake: true, note: '한글 메모 🍚' });
  await a.sync.connect(repo, token);
  assert.equal(a.sync.status().state, 'ok', a.sync.status().msg);
  console.log('1. 처음 연결과 업로드: 통과');

  await b.sync.connect(repo, token);
  assert.equal(C.live(b.store.day(KEY))[0].note, '한글 메모 🍚');
  console.log('2. 두 번째 기기가 같은 기록을 받음: 통과');

  a.store.logEvent(KEY, 'water');
  b.store.logEvent(KEY, 'coffee');
  await a.sync.syncNow({ pull: false });
  const before = log.length;
  await b.sync.syncNow({ pull: false });
  assert.equal(b.sync.status().state, 'ok', b.sync.status().msg);
  const conflict = log.slice(before).find(l => l.startsWith('PUT') && /→ (409|422)/.test(l));
  assert.ok(conflict, '낡은 상태로 올리면 409/422가 와야 한다: ' + log.slice(before).join(' | '));
  await a.sync.syncNow();
  assert.equal(C.canon(a.store.day(KEY)), C.canon(b.store.day(KEY)));
  assert.equal(C.live(a.store.day(KEY)).length, 3);
  console.log(`3. 동시에 기록해도 합쳐짐 (${conflict.split('→ ')[1]} 충돌 뒤 병합): 통과`);

  const n = log.length;
  await a.sync.syncNow();
  const quiet = log.slice(n);
  assert.ok(quiet.every(l => l.startsWith('GET')) && quiet.some(l => l.endsWith('→ 304')), '바뀐 게 없으면 304: ' + quiet.join(' | '));
  assert.ok(!quiet.some(l => l.includes(PATH)), '파일을 다시 받지 않는다');
  console.log('4. 바뀐 게 없으면 다시 받지 않음 (304): 통과');
} finally {
  await cleanup();
  const left = await api('GET', 'days/2001');
  console.log(left.status === 404 ? '정리 완료: 시험용 파일을 지웠습니다' : `정리 확인 필요 (상태 ${left.status})`);
}
