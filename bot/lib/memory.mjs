// 비서의 기억 3층. 비공개 기록 저장소의 brain/ 폴더에 글(마크다운)로 둔다.
//  - brain/profile.md : 내가 직접 쓰는 "나는 이런 사람, 이렇게 대해 줘". 비서는 읽기만 한다.
//  - brain/memory.md  : 오래 갈 사실 목록. "기억해: …"로 넣거나, 밤 정리 때 AI가 고칠 것을 제안하면 코드가 검사해서 적용한다.
//  - brain/log/날짜.md : 그날 일지 (밤 정리 때 AI가 쓴 요약). 다음 날 대화에 어제 것만 같이 본다.
// 저장소에 남으니 GitHub 기록으로 언제든 되돌릴 수 있다. AI에게 보낼 때는 부르는 쪽에서 약 이름을 가린다.

export const MAX_FACTS = 60;
export const FACT_LEN = 160;
export const NOTE_LEN = 1200;
export const DAYLOG_MAX = 300;
const HEAD = '# 기억\n\n비서가 오래 기억할 사실이에요. 한 줄에 하나. 직접 고쳐도 돼요 (형식: `- [m번호] 날짜 | 내용`).\n';

// ----- memory.md 읽고 쓰기 -----
// 손으로 고친 파일도 잃지 않게 읽는다: 번호 없는 줄("- 내용")과 겹친 번호는 새 번호를 주고,
// 제목·주석 같은 그 밖의 줄은 extra에 그대로 두었다가 다시 쓸 때 맨 아래에 붙인다
export function parseMemory(md) {
  const out = [];
  const extra = [];
  const loose = [];
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[(m\d+)\]\s*(\d{4}-\d{2}-\d{2})?\s*\|?\s*(.+?)\s*$/i);
    if (m) {
      const id = m[1].toLowerCase();
      if (out.some(f => f.id === id)) loose.push({ date: m[2] || '', text: m[3] });
      else out.push({ id, date: m[2] || '', text: m[3] });
      continue;
    }
    const b = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (b) loose.push({ date: '', text: b[1] });
    else if (line.trim() && !HEAD.includes(line.trim())) extra.push(line);
  }
  for (const f of loose) out.push({ id: nextId(out), ...f });
  out.extra = extra;
  return out;
}
export const formatMemory = (facts, extra = facts.extra || []) => `${HEAD}\n${facts.map(f => `- [${f.id}] ${f.date || ''} | ${f.text}`).join('\n')}\n${extra.length ? `\n${extra.join('\n')}\n` : ''}`;
function nextId(facts) {
  return `m${facts.reduce((a, f) => Math.max(a, +f.id.slice(1) || 0), 0) + 1}`;
}
const clean = t => String(t || '').replace(/\s+/g, ' ').replace(/^[-*\s]+/, '').trim().slice(0, FACT_LEN);

// ops: [{ op: 'add'|'update'|'delete', id, text }]. 모르는 id, 빈 글, 같은 내용은 버린다.
// 꽉 찼을 때: evict면 가장 오래된 것을 빼고 넣는다 (내가 "기억해"라고 했을 때). 아니면 넣지 않는다 (밤 정리가 내 기억을 밀어내지 않게)
export function applyOps(facts, ops, date, { evict = true } = {}) {
  let list = facts.map(f => ({ ...f }));
  const applied = [];
  for (const o of (ops || []).slice(0, 8)) {
    const text = clean(o?.text);
    if (o?.op === 'add' && text && !list.some(f => f.text === text)) {
      if (!evict && list.length >= MAX_FACTS) continue;
      const f = { id: nextId(list), date, text };
      list.push(f);
      applied.push({ op: 'add', ...f });
    } else if (o?.op === 'update' && text) {
      const f = list.find(x => x.id === o.id);
      if (f && f.text !== text) {
        applied.push({ op: 'update', id: f.id, was: f.text, text });
        f.text = text;
        f.date = date;
      }
    } else if (o?.op === 'delete') {
      const f = list.find(x => x.id === o.id);
      if (f) {
        applied.push({ op: 'delete', id: f.id, was: f.text });
        list = list.filter(x => x.id !== f.id);
      }
    }
  }
  while (list.length > MAX_FACTS) {
    // 날짜 없는 줄(손으로 쓴 것)은 가장 새것으로 친다
    const old = list.reduce((a, f) => ((f.date || '9') < (a.date || '9') ? f : a), list[0]);
    applied.push({ op: 'delete', id: old.id, was: old.text, full: true });
    list = list.filter(f => f.id !== old.id);
  }
  list.extra = facts.extra || [];
  return { facts: list, applied };
}

// ----- 그날 대화 (밤 정리 재료. 미니 PC의 상태 파일에만 있다가 정리 뒤 지운다) -----
export function logDay(state, key, who, text, now) {
  const s = String(text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return;
  state.dayLog ||= {};
  const list = (state.dayLog[key] ||= []);
  if (list.length < DAYLOG_MAX) list.push({ t: now, who, text: s.length > 300 ? `${s.slice(0, 300)}…` : s });
}
const hhmm = t => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// 내 말은 다 넣고, 비서 말은 앞부분만 (알림 문구가 대부분이라). 전체는 8천 자까지
export function dayLogText(state, key) {
  const lines = (state.dayLog?.[key] || []).map(h => `[${hhmm(h.t)} ${h.who === 'me' ? '나' : '비서'}] ${h.who === 'me' ? h.text : h.text.slice(0, 90)}`);
  let s = lines.join('\n');
  if (s.length > 8000) s = `${s.slice(0, 4000)}\n…(중간 생략)…\n${s.slice(-4000)}`;
  return s;
}

// ----- 대화에 붙일 기억 (약 이름 가리기는 부르는 쪽에서) -----
// redact: 약 이름 가리기. 가린 뒤에 자른다 (자른 자리에 이름이 반쯤 남지 않게)
export function memoryText({ profile, facts, lastNote, lastKey }, redact = s => s) {
  const parts = [];
  const p = redact(String(profile || '').replace(/^#.*$/m, '').trim());
  if (p) parts.push(`## 나에 대해 (내가 직접 쓴 것)\n${p.slice(0, 1500)}`);
  if (facts?.length) parts.push(`## 비서가 기억하는 사실\n${facts.map(f => `- [${f.id}] ${redact(f.text).slice(0, FACT_LEN)}`).join('\n')}`);
  if (lastNote) parts.push(`## 어제 일지${lastKey ? ` (${lastKey})` : ''}\n${redact(String(lastNote).replace(/^#.*$/m, '').trim()).slice(0, NOTE_LEN)}`);
  return parts.join('\n\n');
}

// ----- 밤 정리 (하루 한 번, AI 한 번) -----
export const DREAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['note', 'ops', 'hello'],
  properties: {
    note: { type: 'string' },
    hello: { type: 'string' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'id', 'text'],
        properties: { op: { type: 'string', enum: ['add', 'update', 'delete'] }, id: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
};

// persona: 비서의 성격 글 (있으면 내일 첫마디를 그 말투로)
export function dreamSystem(persona = '') {
  const tone = String(persona || '').replace(/\s+/g, ' ').trim();
  return [
    '너는 사용자의 개인 비서다. 하루가 끝났다. 오늘의 상태와 대화를 읽고 세 가지를 JSON으로 낸다.',
    '1) note: 오늘 일지. 5~8줄, 줄마다 "- "로 시작. 사실만: 무엇을 끝냈나(결과물), 무엇이 밀렸나, 사용자가 말한 이유나 기분(그 사람의 말로), 내일로 넘긴 것. 평가·훈계·칭찬을 쓰지 않는다. 대화가 거의 없었으면 그렇다고 한 줄만 쓴다.',
    '2) ops: "비서가 기억하는 사실" 목록을 고치는 제안. 대부분의 날은 빈 배열이 맞다. 최대 3개.',
    '   - add: 몇 주 뒤에도 쓸모 있는 사실만 (사용자가 직접 말한 선호·사정·약속·반복되는 패턴). 하루짜리 일, 짐작, 성격 해석은 넣지 않는다. text는 한 문장, 80자 안쪽.',
    '   - update: 이미 있는 사실(id)이 바뀌었을 때. delete: 사용자가 틀렸다고 했거나 더는 맞지 않을 때.',
    '   - 사용자가 "기억해"라고 한 것은 이미 들어가 있다. 다시 넣지 않는다.',
    '3) hello: 내일 아침 사용자가 일어났을 때 비서가 건넬 첫마디 한 줄 (80자 안쪽). 오늘 있었던 구체적인 일 하나를 짚고, 내일의 한 걸음을 가볍게 권한다. 훈계하지 않는다. 약 이야기와 이름표("[...]")는 넣지 않는다. 짚을 일이 없으면 빈 문자열.',
    '약은 "[아침 약]" 같은 이름표로만 쓴다. 약 이름·용량을 짐작해 쓰지 않는다. 건강 진단이나 의학적 해석을 쓰지 않는다.',
    '쓰지 않는 칸은 빈 문자열 "".',
    tone ? `hello의 말투: ${tone}` : '',
  ].filter(Boolean).join('\n');
}

export function dreamPrompt({ key, stateText, logText, memory }) {
  return [`# ${key} 하루 정리`, memory || '', `## 하루 끝의 상태\n${stateText || '(없음)'}`, `## 오늘 대화\n${logText || '(대화 없음)'}`].filter(Boolean).join('\n\n');
}

// AI 답 검사: 형식, 길이, 개수. 고칠 대상(id)이 없으면 버린다
export function validateDream(out, facts) {
  if (!out || typeof out !== 'object') return null;
  const ids = new Set(facts.map(f => f.id));
  const note = String(out.note || '').replace(/\r/g, '').trim().slice(0, NOTE_LEN);
  const ops = [];
  for (const o of Array.isArray(out.ops) ? out.ops.slice(0, 10) : []) {
    const text = clean(o?.text);
    if (o?.op === 'add' && text.length >= 4) ops.push({ op: 'add', id: '', text });
    else if (o?.op === 'update' && ids.has(o.id) && text.length >= 4) ops.push({ op: 'update', id: o.id, text });
    else if (o?.op === 'delete' && ids.has(o.id)) ops.push({ op: 'delete', id: o.id, text: '' });
  }
  // hello: 한 줄, 120자까지. 이름표나 약 코드가 새어 나왔으면 버린다
  let hello = typeof out.hello === 'string' ? out.hello.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (/[[\]]/.test(hello) || /\bM\d+\b/.test(hello)) hello = '';
  return { note, ops: ops.slice(0, 3), hello };
}

// ----- 저장소와 묶기 -----
// files: { get(path) → { text, sha } | null, put(path, text, sha, message) → { sha } | { conflict: true } }
export function createMemory({ files, now = Date.now, log = () => {} }) {
  let cache = { profile: '', facts: [], sha: null, lastNote: '', lastKey: '', at: 0, ok: false };

  async function load(yesterdayKey, force = false) {
    if (!force && cache.ok && now() - cache.at < 30 * 60 * 1000 && cache.lastKey === (yesterdayKey || cache.lastKey)) return cache;
    const [p, m, n] = await Promise.all([files.get('brain/profile.md'), files.get('brain/memory.md'), yesterdayKey ? files.get(`brain/log/${yesterdayKey}.md`) : null]);
    cache = { profile: p?.text || '', facts: parseMemory(m?.text), sha: m?.sha || null, lastNote: n?.text || '', lastKey: yesterdayKey || '', at: now(), ok: true };
    return cache;
  }

  // memory.md를 고쳐 쓴다. 그 사이 폰이나 다른 곳에서 바뀌었으면 다시 읽고 한 번 더
  async function change(ops, date, message, opt) {
    for (let i = 0; i < 2; i++) {
      const m = await files.get('brain/memory.md');
      const r = applyOps(parseMemory(m?.text), ops, date, opt);
      if (!r.applied.length) return r;
      const res = await files.put('brain/memory.md', formatMemory(r.facts), m?.sha || null, message);
      if (!res?.conflict) {
        cache = { ...cache, facts: r.facts, sha: res?.sha || null, at: now(), ok: true };
        return r;
      }
    }
    throw new Error('기억 파일이 다른 곳에서 바뀌고 있어요. 잠시 뒤에 다시 해 주세요');
  }

  return {
    load,
    context: redact => (cache.ok ? memoryText(cache, redact) : ''),
    facts: () => cache.facts,
    add: (text, date) => change([{ op: 'add', text }], date, '기억 추가'),
    forget: (id, date) => change([{ op: 'delete', id }], date, '기억 삭제'),
    // 밤 정리: ask(system, user, schema) → AI 답(JSON). 일지를 쓰고, 검사를 통과한 제안만 기억에 반영한다.
    // out: 앞선 시도에서 이미 받은 답 (저장소 쓰기만 실패했을 때 AI를 다시 부르지 않고, 제안을 두 번 반영하지 않게).
    // onOut: 새로 받은 답을 부르는 쪽이 적어 두게 한다
    async dream({ key, stateText, logText, ask, redact = s => s, out = null, onOut = () => {}, persona = '' }) {
      const cur = await load(null, true);
      if (!out) {
        const user = redact(dreamPrompt({ key, stateText, logText, memory: memoryText({ profile: cur.profile, facts: cur.facts }, redact) }));
        out = validateDream(await ask(dreamSystem(persona), user, DREAM_SCHEMA), cur.facts);
        if (!out) throw new Error('밤 정리 답을 읽지 못했어요');
        onOut(out);
      }
      let applied = [];
      // 꽉 찼으면 밤 정리는 새로 넣지 않는다 (내가 넣은 기억을 밀어내지 않게)
      if (out.ops.length) applied = (await change(out.ops, key, `${key} 밤 정리`, { evict: false })).applied;
      if (out.note) {
        const path = `brain/log/${key}.md`;
        const changes = applied.length ? `\n\n기억 변경:\n${applied.map(a => `- ${a.op} ${a.id}: ${a.text || a.was || ''}`).join('\n')}` : '';
        let done = false;
        for (let i = 0; i < 2 && !done; i++) {
          const old = await files.get(path);
          done = !(await files.put(path, `# ${key} 일지\n\n${out.note}${changes}\n`, old?.sha || null, `${key} 일지`))?.conflict;
        }
        if (!done) throw new Error('일지를 저장소에 쓰지 못했어요');
      }
      log(`밤 정리 ${key}: 일지 ${out.note ? '씀' : '없음'}, 기억 변경 ${applied.length}건`);
      return { note: out.note, applied, hello: out.hello || '' }; // 예전 버전이 받아 둔 답에는 hello가 없다
    },
  };
}
