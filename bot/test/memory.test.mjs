import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../lib/memory.mjs';
import { createRepoFiles } from '../lib/repofile.mjs';

// 가짜 저장소: 경로 → { text, sha }. put은 sha가 안 맞으면 충돌
function fakeFiles(init = {}) {
  const db = new Map(Object.entries(init).map(([k, v]) => [k, { text: v, sha: 's1' }]));
  let n = 1;
  const puts = [];
  return {
    db,
    puts,
    get: async p => (db.has(p) ? { ...db.get(p) } : null),
    put: async (p, text, sha, message) => {
      const cur = db.get(p);
      if ((cur?.sha || null) !== (sha || null)) return { conflict: true };
      const next = { text, sha: `s${++n}` };
      db.set(p, next);
      puts.push({ p, message });
      return { sha: next.sha };
    },
  };
}

test('기억: 파일 읽고 쓰기, 추가·고치기·지우기. 손으로 고친 줄을 잃지 않고, 꽉 차면 내가 넣을 때만 오래된 것을 뺀다', () => {
  const facts = M.parseMemory('# 기억\n\n- [m1] 2026-11-10 | 아침엔 짧게 말해 주길 원함\n- [m3] 2026-11-12 | 금요일엔 형에게 숫자를 보낸다\n엉뚱한 줄\n- [m3] 2026-11-13 | 중복 id');
  assert.deepEqual(facts.map(f => f.id), ['m1', 'm3', 'm4'], '겹친 번호는 새 번호를 받는다');
  assert.deepEqual(facts.extra, ['엉뚱한 줄']);
  const r = M.applyOps(facts, [{ op: 'add', text: '  - 코테는 밤 9시에 푼다 ' }, { op: 'add', text: '아침엔 짧게 말해 주길 원함' }, { op: 'update', id: 'm1', text: '아침엔 한 줄로' }, { op: 'delete', id: 'm9' }, { op: 'delete', id: 'm3' }], '2026-11-17');
  assert.deepEqual(r.facts.map(f => [f.id, f.text]), [['m1', '아침엔 한 줄로'], ['m4', '중복 id'], ['m5', '코테는 밤 9시에 푼다']]);
  assert.deepEqual(r.applied.map(a => a.op), ['add', 'update', 'delete']);
  const again = M.parseMemory(M.formatMemory(r.facts));
  assert.deepEqual([...again], [...r.facts], '쓴 것을 다시 읽으면 같다');
  assert.deepEqual(again.extra, ['엉뚱한 줄'], '모르는 줄은 그대로 남는다');
  const hand = M.parseMemory('- 커피는 2시 전까지만\n- [M7] 대문자 번호\n## 건강\n<!-- 메모 -->');
  assert.deepEqual(hand.map(f => [f.id, f.text]), [['m7', '대문자 번호'], ['m8', '커피는 2시 전까지만']]);
  assert.deepEqual(hand.extra, ['## 건강', '<!-- 메모 -->']);
  const many = Array.from({ length: M.MAX_FACTS }, (_, i) => ({ id: `m${i + 1}`, date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, text: `사실 ${i}` }));
  const full = M.applyOps(many, [{ op: 'add', text: '새 사실' }], '2026-11-17');
  assert.equal(full.facts.length, M.MAX_FACTS);
  assert.ok(full.facts.some(f => f.text === '새 사실'));
  assert.ok(full.applied.some(a => a.full), '뺀 것을 알려 준다');
  const night = M.applyOps(many, [{ op: 'add', text: '밤 정리가 넣으려는 사실' }], '2026-11-17', { evict: false });
  assert.deepEqual([night.facts.length, night.applied.length], [M.MAX_FACTS, 0], '밤 정리는 꽉 찬 기억을 밀어내지 않는다');
});

test('기억: 일지 쓰기가 실패하면 다음 시도는 받아 둔 답을 다시 쓰고 AI를 또 부르지 않는다', async () => {
  const files = fakeFiles({ 'brain/memory.md': '- [m1] 2026-11-10 | a' });
  const realPut = files.put;
  let fail = true;
  files.put = async (p, ...rest) => {
    if (fail && p.startsWith('brain/log/')) throw new Error('저장소가 잠깐 안 돼요');
    return realPut(p, ...rest);
  };
  const mem = M.createMemory({ files });
  let asked = 0;
  let kept = null;
  const args = { key: '2026-11-17', stateText: 's', logText: 'l', ask: async () => (asked++, { note: '- 한 줄', ops: [{ op: 'add', id: '', text: '새로 알게 된 사실 하나' }] }), onOut: o => (kept = o) };
  await assert.rejects(mem.dream(args), /잠깐 안 돼요/);
  fail = false;
  const r = await mem.dream({ ...args, out: kept });
  assert.equal(asked, 1, 'AI는 한 번만');
  assert.equal(files.db.get('brain/memory.md').text.match(/새로 알게 된 사실 하나/g).length, 1, '제안을 두 번 반영하지 않는다');
  assert.match(files.db.get('brain/log/2026-11-17.md').text, /- 한 줄/);
  assert.equal(r.note, '- 한 줄');
});

test('기억: 밤 정리 답 검사 (모르는 id·빈 글은 버리고, 제안은 셋까지)', () => {
  const facts = [{ id: 'm1', date: '', text: 'a' }];
  const v = M.validateDream({ note: '- 코테 2문제 끝\n- 운동은 밀림', ops: [{ op: 'add', id: '', text: '저녁 약속이 있는 날은 21시 블록을 건너뛴다' }, { op: 'update', id: 'm7', text: '없는 것' }, { op: 'delete', id: 'm1', text: '' }, { op: 'add', id: '', text: 'x' }, { op: 'hack' }, { op: 'add', id: '', text: '넷째 제안입니다' }, { op: 'add', id: '', text: '다섯째 제안입니다' }] }, facts);
  assert.equal(v.ops.length, 3);
  assert.deepEqual(v.ops.map(o => o.op), ['add', 'delete', 'add']);
  assert.equal(M.validateDream(null, facts), null);
  assert.equal(M.validateDream({ note: 'x'.repeat(5000), ops: 'no' }, facts).note.length, M.NOTE_LEN);
});

test('기억: "기억해"로 넣고, 밤 정리로 일지와 기억을 저장소에 남긴다. AI에게 가는 글은 가린다', async () => {
  const files = fakeFiles({ 'brain/profile.md': '# 나\n반말로, 짧게.', 'brain/memory.md': '- [m1] 2026-11-10 | 아침엔 짧게' });
  const mem = M.createMemory({ files, now: () => 1000 });
  await mem.load('2026-11-16');
  assert.match(mem.context(), /반말로, 짧게/);
  assert.match(mem.context(), /\[m1\] 아침엔 짧게/);
  await mem.add('발표 전날은 알림을 줄여 달라고 함', '2026-11-17');
  assert.match(files.db.get('brain/memory.md').text, /\[m2\] 2026-11-17 \| 발표 전날은/);
  const state = {};
  M.logDay(state, '2026-11-17', 'me', '코테 2문제 21시', 1);
  M.logDay(state, '2026-11-17', 'bot', '<b>🎯</b> "코테 2문제" 21:00 마감으로 잡았어요. 30분 전에 알려 드릴게요.', 2);
  let sent = null;
  const r = await mem.dream({
    key: '2026-11-17',
    stateText: '오늘 핵심: t1 "코테 2문제" 끝남',
    logText: M.dayLogText(state, '2026-11-17'),
    redact: s => s.replace(/짧게/g, '[가림]'),
    ask: async (system, user, schema) => {
      sent = { system, user, schema };
      return { note: '- 코테 2문제를 끝냄', ops: [{ op: 'update', id: 'm1', text: '아침엔 한 줄로' }] };
    },
  });
  assert.ok(!sent.user.includes('짧게'), '보내는 글은 가리는 함수를 거친다');
  assert.match(sent.user, /\[\d\d:\d\d 나\] 코테 2문제 21시/);
  assert.ok(!sent.user.includes('<b>'));
  assert.equal(sent.schema, M.DREAM_SCHEMA);
  assert.deepEqual(r.applied.map(a => a.op), ['update']);
  assert.match(files.db.get('brain/memory.md').text, /\[m1\] 2026-11-17 \| 아침엔 한 줄로/);
  assert.match(files.db.get('brain/log/2026-11-17.md').text, /코테 2문제를 끝냄[\s\S]*기억 변경:\n- update m1/);
  await mem.forget('m2', '2026-11-18');
  assert.ok(!files.db.get('brain/memory.md').text.includes('m2'));
});

test('기억: 그 사이 파일이 바뀌었으면 다시 읽고 한 번 더 쓴다', async () => {
  const files = fakeFiles({ 'brain/memory.md': '- [m1] 2026-11-10 | a' });
  const realGet = files.get;
  let first = true;
  files.get = async p => {
    const r = await realGet(p);
    if (first && p === 'brain/memory.md') {
      first = false;
      files.db.set(p, { text: '- [m1] 2026-11-10 | a\n- [m2] 2026-11-11 | 폰에서 넣음', sha: 'phone' }); // 읽은 직후 다른 곳에서 바뀜
    }
    return r;
  };
  const mem = M.createMemory({ files });
  await mem.add('새 사실', '2026-11-17');
  const text = files.db.get('brain/memory.md').text;
  assert.match(text, /폰에서 넣음/);
  assert.match(text, /\[m3\] 2026-11-17 \| 새 사실/);
});

test('저장소 글 파일: 토큰은 헤더로, 없으면 null, 충돌은 conflict', async () => {
  const calls = [];
  const fetchFn = async (url, o) => {
    calls.push({ url, o });
    if (url.endsWith('none.md')) return { status: 404, ok: false };
    if (o.method === 'PUT') return o.body.includes('"sha":"old"') ? { status: 409, ok: false } : { status: 201, ok: true, json: async () => ({ content: { sha: 'new' } }) };
    return { status: 200, ok: true, json: async () => ({ content: Buffer.from('가나다', 'utf8').toString('base64'), sha: 'abc' }) };
  };
  const f = createRepoFiles({ repo: 'me/data', token: 'SECRET', fetchFn });
  assert.equal(await f.get('brain/none.md'), null);
  assert.deepEqual(await f.get('brain/memory.md'), { text: '가나다', sha: 'abc' });
  assert.deepEqual(await f.put('brain/log/2026-11-17.md', '글', null, '일지'), { sha: 'new' });
  assert.deepEqual(await f.put('brain/memory.md', '글', 'old'), { conflict: true });
  assert.ok(calls.every(c => !c.url.includes('SECRET') && c.o.headers.Authorization === 'Bearer SECRET'));
  assert.equal(JSON.parse(calls[2].o.body).content, Buffer.from('글', 'utf8').toString('base64'));
});
