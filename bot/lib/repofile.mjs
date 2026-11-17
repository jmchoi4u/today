// 비공개 기록 저장소의 글 파일(brain/*.md)을 읽고 쓴다. GitHub Contents API, 토큰은 헤더로만.
const API = 'https://api.github.com';
const enc = s => Buffer.from(String(s), 'utf8').toString('base64');
const dec = b => Buffer.from(String(b || '').replace(/\n/g, ''), 'base64').toString('utf8');

export function createRepoFiles({ repo, token, fetchFn = globalThis.fetch, timeoutMs = 30_000 }) {
  const url = p => `${API}/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
  const call = (u, o = {}) => fetchFn(u, { ...o, headers, signal: AbortSignal.timeout(timeoutMs) });
  return {
    // 없으면 null
    async get(path) {
      const r = await call(url(path));
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`저장소에서 ${path}를 읽지 못했어요 (${r.status})`);
      const j = await r.json();
      return { text: dec(j.content), sha: j.sha };
    },
    // sha가 있으면 고치기, 없으면 새로 만들기. 그 사이 바뀌었으면 { conflict: true }
    async put(path, text, sha, message) {
      const r = await call(url(path), { method: 'PUT', body: JSON.stringify({ message: message || `비서: ${path}`, content: enc(text), ...(sha ? { sha } : {}) }) });
      if (r.status === 409 || r.status === 422) return { conflict: true };
      if (!r.ok) throw new Error(`저장소에 ${path}를 쓰지 못했어요 (${r.status})`);
      const j = await r.json();
      return { sha: j.content?.sha || null };
    },
  };
}
