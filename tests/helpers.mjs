// 테스트용 가짜 저장소와 가짜 GitHub
import { b64dec } from '../js/sync.js';

export class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

export function clock(start) {
  let t = start;
  const now = () => t;
  now.tick = ms => (t += ms);
  now.set = v => (t = v);
  return now;
}

export function fakeGitHub({ isPrivate = true } = {}) {
  const files = new Map(); // path → { content, sha }
  const log = [];
  let n = 0;
  const res = (status, body, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  });
  async function fetchFn(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    log.push(`${method} ${u.pathname}`);
    if (opts.cache !== 'no-store') throw new Error('cache: no-store 누락');
    if (opts.headers.Authorization !== 'Bearer good') return res(401, {});
    const m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+(?:\/contents\/(.*))?$/);
    if (!m) return res(404, {});
    if (m[1] === undefined) return res(200, { private: isPrivate, permissions: { push: true } });
    const path = decodeURIComponent(m[1]);
    const inm = opts.headers['If-None-Match'];
    if (method === 'GET') {
      const f = files.get(path);
      if (f) {
        const etag = `"${f.sha}"`;
        return inm === etag ? res(304, null) : res(200, { type: 'file', path, sha: f.sha, content: f.content }, { etag });
      }
      const kids = [...files.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/'));
      if (!kids.length) return res(404, {});
      const etag = `"dir-${kids.map(k => files.get(k).sha).join('.')}"`;
      return inm === etag ? res(304, null) : res(200, kids.map(p => ({ type: 'file', path: p, sha: files.get(p).sha })), { etag });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      const cur = files.get(path);
      if (cur && !body.sha) return res(422, {});
      if (cur && body.sha !== cur.sha) return res(409, {});
      if (!cur && body.sha) return res(404, {});
      const sha = 'sha' + ++n;
      files.set(path, { content: body.content, sha });
      return res(cur ? 200 : 201, { content: { sha } });
    }
    return res(405, {});
  }
  return { fetchFn, files, log, read: p => JSON.parse(b64dec(files.get(p).content)) };
}
