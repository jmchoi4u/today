// GitHub 비공개 저장소 동기화.
// 기록은 config.json과 days/연도/날짜.json 파일로 올라간다. 토큰은 이 기기에만 있고, 공개 저장소에는 올리지 않는다.
import { canon, lastDays } from './core.js';
import { CFG_PATH, pathOfDay } from './store.js';

const API = 'https://api.github.com';
export const KEEP_DAYS = 35;
export const MEDS_PATH = 'meds.json'; // 약 정보 (앱은 읽기만 한다)
export const GAME_PATH = 'game.json'; // 스탯 정의 (앱은 읽기만 한다)

export class SyncError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64dec(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

async function pool(list, n, fn) {
  const q = [...list];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

export function createSync({ store, fetchFn, now = Date.now, online = () => true, todayKey, onStatus = () => {} }) {
  let status = { state: store.local().gh ? 'idle' : 'off', msg: '', kind: '', at: 0 };
  let running = null, queued = null, timer = null, repoOk = false;

  const gh = () => store.local().gh;
  const setStatus = (state, msg = '', kind = '') => {
    status = { state, msg, kind, at: now() };
    onStatus(status);
  };
  const contents = p => `/repos/${gh().repo}/contents/${p}`;

  async function req(method, url, { body, etag, keepalive } = {}) {
    const headers = { Authorization: `Bearer ${gh().token}`, Accept: 'application/vnd.github+json' };
    if (etag) headers['If-None-Match'] = etag;
    if (body) headers['Content-Type'] = 'application/json';
    let r;
    try {
      // GitHub API 응답은 브라우저가 60초 캐시하므로 반드시 no-store로 받는다
      r = await fetchFn(API + url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', keepalive: !!keepalive });
    } catch {
      throw new SyncError('network', '네트워크에 연결할 수 없어요');
    }
    if (r.status === 401) throw new SyncError('auth', '토큰이 만료됐거나 올바르지 않아요');
    if (r.status === 403 || r.status === 429) {
      if (r.headers.get('x-ratelimit-remaining') === '0') throw new SyncError('limit', '요청이 많아서 잠시 쉬어가요');
      throw new SyncError('perm', '토큰 권한을 확인해 주세요 (Contents: Read and write)');
    }
    return r;
  }

  async function checkRepo() {
    const r = await req('GET', `/repos/${gh().repo}`);
    if (r.status === 404) throw new SyncError('repo', '토큰이 이 저장소를 볼 수 없어요. 토큰을 만들 때 Repository access에서 "Only select repositories"로 이 저장소를 골랐는지 확인해 주세요');
    if (!r.ok) throw new SyncError('http', `GitHub 응답 오류 (${r.status})`);
    const j = await r.json();
    if (j.private !== true) throw new SyncError('public', '공개 저장소에는 기록을 올리지 않아요. 비공개 저장소를 연결해 주세요');
    repoOk = true;
  }

  function parse(j) {
    try {
      return JSON.parse(b64dec(j.content || ''));
    } catch {
      return null;
    }
  }
  async function getFile(path) {
    const r = await req('GET', contents(path));
    if (r.status === 404) return null;
    if (!r.ok) throw new SyncError('http', `GitHub 응답 오류 (${r.status})`);
    const j = await r.json();
    return { doc: parse(j), sha: j.sha };
  }
  async function putFile(path, doc, sha, keepalive) {
    const body = { message: `sync: ${path}`, content: b64enc(JSON.stringify(doc, null, 1)) };
    if (sha) body.sha = sha;
    const r = await req('PUT', contents(path), { body, keepalive });
    // 409: sha가 낡음, 422: 파일이 이미 있는데 sha 없음, 404+sha: 원격에서 파일이 사라짐 → 다시 받아서 합친다
    if (r.status === 409 || r.status === 422 || (r.status === 404 && sha)) return { conflict: true };
    if (r.status === 404) throw new SyncError('repo', '저장소에 쓸 수 없어요. 토큰의 저장소 접근 권한을 확인해 주세요');
    if (!r.ok) throw new SyncError('http', `GitHub 응답 오류 (${r.status})`);
    const j = await r.json();
    return { sha: j.content?.sha };
  }

  async function pullDoc(path) {
    const f = await getFile(path);
    if (!f) return store.setSha(path, null);
    store.applyRemote(path, f.doc);
    store.setSha(path, f.sha);
  }
  async function pullConfig() {
    const r = await req('GET', contents(CFG_PATH), { etag: store.etag(CFG_PATH) });
    if (r.status === 304) return;
    if (r.status === 404) {
      store.setSha(CFG_PATH, null);
      store.setEtag(CFG_PATH, null);
      return;
    }
    if (!r.ok) throw new SyncError('http', `GitHub 응답 오류 (${r.status})`);
    const j = await r.json();
    store.applyRemote(CFG_PATH, parse(j));
    store.setSha(CFG_PATH, j.sha);
    store.setEtag(CFG_PATH, r.headers.get('etag'));
  }
  // 읽기만 하는 참고 파일 (약 정보, 스탯 정의): 바뀌었을 때만 받는다
  async function pullRef(path, has, set, valid) {
    const r = await req('GET', contents(path), { etag: store.etag(path) });
    if (r.status === 304) return;
    if (r.status === 404) {
      if (has()) set(null);
      store.setEtag(path, null);
      return;
    }
    if (!r.ok) throw new SyncError('http', `GitHub 응답 오류 (${r.status})`);
    const doc = parse(await r.json());
    if (valid(doc)) set(doc);
    store.setEtag(path, r.headers.get('etag'));
  }
  const pullMeds = () => pullRef(MEDS_PATH, () => !!store.medsDoc(), store.setMeds, d => Array.isArray(d?.drugs));
  const pullGame = () => pullRef(GAME_PATH, () => !!store.game(), store.setGame, d => Array.isArray(d?.stats));
  // 연도 폴더 목록 한 번으로 바뀐 날짜만 골라 받는다
  async function pullDays() {
    const keys = lastDays(todayKey(), KEEP_DAYS);
    const want = new Set(keys.map(pathOfDay));
    for (const y of new Set(keys.map(k => k.slice(0, 4)))) {
      const dir = `days/${y}`;
      const r = await req('GET', contents(dir), { etag: store.etag(dir) });
      if (r.status === 304 || r.status === 404) continue;
      if (!r.ok) throw new SyncError('http', `GitHub 응답 오류 (${r.status})`);
      const list = await r.json();
      const changed = (Array.isArray(list) ? list : [])
        .filter(f => f.type === 'file' && want.has(f.path) && store.sha(f.path) !== f.sha)
        .map(f => f.path);
      await pool(changed, 4, pullDoc);
      store.setEtag(dir, r.headers.get('etag')); // 전부 받은 뒤에만 기억한다
    }
  }

  // 올리기는 반드시 하나씩 차례로 (GitHub이 동시 쓰기를 충돌로 처리한다)
  async function pushDoc(path, keepalive) {
    for (let i = 0; i < 4; i++) {
      const doc = store.doc(path);
      if (!doc) return store.clearDirty(path);
      const snap = canon(doc);
      const res = await putFile(path, doc, store.sha(path), keepalive);
      if (!res.conflict) {
        store.setSha(path, res.sha);
        if (canon(store.doc(path)) === snap) store.clearDirty(path);
        return;
      }
      await pullDoc(path);
      if (!store.isDirty(path)) return;
    }
    throw new SyncError('conflict', '동기화가 계속 충돌해요. 잠시 뒤 다시 시도할게요');
  }

  async function run({ pull = true, keepalive = false } = {}) {
    if (!gh()) return setStatus('off');
    if (!online()) return setStatus('offline', '오프라인이에요. 연결되면 자동으로 올릴게요', 'network');
    setStatus('syncing');
    try {
      if (!repoOk) await checkRepo();
      if (pull) {
        await pullConfig();
        await pullMeds();
        await pullGame();
        await pullDays();
      }
      for (const p of store.dirtyPaths()) await pushDoc(p, keepalive);
      store.setLocal({ lastSync: now() }, true);
      setStatus('ok');
    } catch (e) {
      if (e instanceof SyncError) setStatus(e.kind === 'network' ? 'offline' : 'error', e.message, e.kind);
      else setStatus('error', '동기화 중 문제가 생겼어요', 'unknown');
    }
  }

  function syncNow(opts = {}) {
    clearTimeout(timer);
    if (running) {
      queued = { pull: opts.pull !== false || !!queued?.pull };
      return running;
    }
    running = run(opts).finally(() => {
      running = null;
      if (queued) {
        const o = queued;
        queued = null;
        syncNow(o);
      }
    });
    return running;
  }
  function schedule(ms = 4000) {
    if (!gh()) return;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow({ pull: false }), ms);
  }
  // 화면을 떠날 때: 남은 변경을 바로 보낸다 (keepalive로 페이지가 닫혀도 요청은 끝까지 간다)
  function flush() {
    if (gh() && repoOk && !running && online() && store.dirtyPaths().length) syncNow({ pull: false, keepalive: true });
  }

  async function connect(repoInput, tokenInput) {
    const repo = String(repoInput || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const token = String(tokenInput || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new SyncError('input', '저장소는 "계정/저장소" 형식으로 적어 주세요');
    if (!token) throw new SyncError('input', '토큰을 붙여 넣어 주세요');
    const prev = gh();
    store.setLocal({ gh: { repo, token }, shas: {}, etags: {} }, true);
    repoOk = false;
    try {
      await checkRepo();
    } catch (e) {
      store.setLocal({ gh: prev }, true);
      setStatus(prev ? 'idle' : 'off');
      throw e;
    }
    store.markAllDirty();
    await syncNow({ pull: true });
    if (status.state === 'error') throw new SyncError(status.kind, status.msg);
  }
  function disconnect() {
    clearTimeout(timer);
    repoOk = false;
    store.setLocal({ gh: null, shas: {}, etags: {} });
    setStatus('off');
  }
  // 보관 범위(최근 35일) 밖의 날짜를 열 때 그날만 받아온다
  async function fetchDay(key) {
    if (!gh() || !online()) return;
    try {
      await pullDoc(pathOfDay(key));
    } catch {
      /* 다음 동기화에서 다시 시도 */
    }
  }

  return { status: () => status, syncNow, schedule, flush, connect, disconnect, fetchDay };
}
