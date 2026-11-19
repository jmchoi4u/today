import test from 'node:test';
import assert from 'node:assert/strict';
import { MOODS, persona, artSrc, moodOf, pick, fill, report, chat, cheer, CHAT_POOLS, CHEERS } from '../js/secretary.js';

const P = { name: '하루', call: '선장님', link: '' };
const NOCALL = { name: '하루', call: '', link: '' };
const H = 3600000;
const NOW = 1_800_000_000_000;
const fmt = ts => `T${(ts - NOW) / H}`;
const base = (o = {}) => ({ woke: true, top3: [], now: NOW, fmt, focusMin: 0, ...o });
const SEEDS = Array.from({ length: 60 }, (_, i) => `2026-11-19:${i}`);
const HOURS = [7, 13, 19, 23];

test('persona: 이름이 없거나 공백이면 null', () => {
  assert.equal(persona(null), null);
  assert.equal(persona({}), null);
  assert.equal(persona({ secretary: {} }), null);
  assert.equal(persona({ secretary: { name: '   ' } }), null);
  assert.equal(persona({ secretary: { name: 7 } }), null);
});

test('persona: 공백을 자르고 길이를 20자로', () => {
  const p = persona({ secretary: { name: `  ${'가'.repeat(30)} `, call: ` ${'나'.repeat(25)} ` } });
  assert.equal(p.name, '가'.repeat(20));
  assert.equal(p.call, '나'.repeat(20));
  assert.equal(p.link, '');
  assert.deepEqual(persona({ secretary: { name: '하루' } }), { name: '하루', call: '', link: '' });
});

test('persona: 텔레그램 링크는 https://t.me/만 남긴다', () => {
  const link = l => persona({ secretary: { name: '하루', link: l } }).link;
  assert.equal(link('https://t.me/haru_bot'), 'https://t.me/haru_bot');
  assert.equal(link('http://t.me/haru_bot'), '');
  assert.equal(link('https://evil.com/haru_bot'), '');
  assert.equal(link('https://t.me.evil.com/haru'), '');
  assert.equal(link('javascript:alert(1)'), '');
  assert.equal(link('https://t.me/ab'), '');
  assert.equal(link('https://t.me/haru"onload'), '');
});

test('artSrc: 표정마다 파일, 모르는 표정은 calm', () => {
  for (const m of MOODS) assert.equal(artSrc(m), `icons/sec-${m}.svg`);
  assert.equal(artSrc('angry'), 'icons/sec-calm.svg');
  assert.equal(artSrc(undefined), 'icons/sec-calm.svg');
});

test('moodOf: good이면 happy, 나머지는 calm', () => {
  assert.equal(moodOf({ tone: 'good' }), 'happy');
  assert.equal(moodOf({ tone: 'now' }), 'calm');
  assert.equal(moodOf({ tone: 'calm' }), 'calm');
  assert.equal(moodOf(undefined), 'calm');
});

test('pick: 같은 씨앗은 같은 결과, 씨앗이 다르면 여러 줄이 나온다', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.equal(pick(list, 'x:1'), pick(list, 'x:1'));
  assert.ok(new Set(SEEDS.map(s => pick(list, s))).size > 1);
});

test('fill: 호칭을 넣고, 없으면 쉼표까지 지운다', () => {
  assert.equal(fill('물 드셨어요, {call}?', P), '물 드셨어요, 선장님?');
  assert.equal(fill('물 드셨어요, {call}?', NOCALL), '물 드셨어요?');
  assert.equal(fill('{call}, 주무세요', NOCALL), '주무세요');
  assert.equal(fill('해내셨네요, {call} 👏', NOCALL), '해내셨네요 👏');
});

const clean = t => {
  assert.ok(!t.includes('{call}'), t);
  assert.ok(!t.startsWith(','), t);
  assert.ok(!/^\s|\s$/.test(t), t);
  assert.ok(!/,\s*[?.!👏]/.test(t), t);
  assert.ok(!/\s[?.!,]/.test(t), t);
};

test('chat·cheer: 호칭이 없어도 모든 줄이 깨끗하다', () => {
  const seen = new Set();
  for (const h of HOURS) for (const s of SEEDS) {
    const r = chat(NOCALL, s, h);
    clean(r.text);
    assert.equal(r.mood, 'happy');
    seen.add(r.text);
    clean(chat(P, s, h).text);
  }
  for (const s of SEEDS) {
    clean(cheer(NOCALL, s).text);
    clean(cheer(P, s).text);
  }
  // 씨앗을 바꿔 다 못 만난 줄도 직접 검사
  for (const line of [...Object.values(CHAT_POOLS).flat(), ...CHEERS]) {
    clean(fill(line, NOCALL));
    assert.ok(!fill(line, P).includes('{call}'));
  }
  assert.ok(seen.size > 4);
});

test('chat: 시간대마다 다른 묶음', () => {
  assert.ok(CHAT_POOLS.morning.map(l => fill(l, P)).includes(chat(P, 'a', 7).text));
  assert.ok(CHAT_POOLS.night.map(l => fill(l, P)).includes(chat(P, 'a', 2).text));
  assert.ok(CHAT_POOLS.day.map(l => fill(l, P)).includes(chat(P, 'a', 12).text));
  assert.ok(CHAT_POOLS.evening.map(l => fill(l, P)).includes(chat(P, 'a', 20).text));
});

test('cheer: 표정은 cheer', () => {
  assert.equal(cheer(P, 'k:CLEAR!').mood, 'cheer');
  assert.equal(cheer(NOCALL, 'k:LEVEL UP!').mood, 'cheer');
});

test('report 1: 아직 안 일어났으면 기상부터', () => {
  const r = report(base({ woke: false }), NOCALL, 's');
  assert.match(r.text, /일어난 시각부터/);
  assert.equal(r.mood, 'calm');
});

test('report 2: 핵심이 없으면 하나 정하자고', () => {
  const r = report(base(), NOCALL, 's');
  assert.match(r.text, /핵심이 없어요/);
  assert.equal(r.mood, 'calm');
});

test('report 3: 다 끝냈으면 cheer', () => {
  const r = report(base({ top3: [{ text: 'a', done: true, due: 0 }, { text: 'b', done: true, due: NOW - H }] }), NOCALL, 's');
  assert.equal(r.text, '오늘 핵심 2개를 다 끝내셨어요. 이제 쉬어도 돼요.');
  assert.equal(r.mood, 'cheer');
});

test('report 4: 마감 지난 일은 worry, 가장 이른 것', () => {
  const top3 = [{ text: '메일', done: false, due: NOW - H }, { text: '코테', done: false, due: NOW - 2 * H }, { text: '끝난 일', done: true, due: NOW - 3 * H }];
  const r = report(base({ top3 }), NOCALL, 's');
  assert.equal(r.text, '"코테" 마감(T-2)이 지났어요. 지금 2분만 열어 볼까요?');
  assert.equal(r.mood, 'worry');
});

test('report 5: 다음 일은 마감 이른 순, 마감 없는 일은 뒤로', () => {
  const top3 = [{ text: '정리', done: false, due: 0 }, { text: '이력서', done: false, due: NOW + 3 * H }, { text: '코테', done: false, due: NOW + H }];
  const r = report(base({ top3 }), NOCALL, 's');
  assert.equal(r.text, '핵심 3개 중 0개 끝났어요. 다음은 "코테", T1까지예요.');
  assert.equal(r.mood, 'calm');
  const r2 = report(base({ top3: [{ text: '끝', done: true, due: 0 }, { text: '정리', done: false, due: 0 }] }), NOCALL, 's');
  assert.equal(r2.text, '핵심 2개 중 1개 끝났어요. 다음은 "정리"예요.');
  assert.equal(r2.mood, 'happy');
});

test('report: 집중 시간을 뒤에 붙인다', () => {
  const r = report(base({ top3: [{ text: 'a', done: true, due: 0 }], focusMin: 75 }), NOCALL, 's');
  assert.ok(r.text.endsWith(' 집중은 75분 했어요.'));
  assert.ok(!report(base({ focusMin: 0 }), NOCALL, 's').text.includes('집중'));
});

test('report: 긴 할 일은 24자에서 자른다', () => {
  const long = '가'.repeat(40);
  const r = report(base({ top3: [{ text: long, done: false, due: 0 }] }), NOCALL, 's');
  assert.ok(r.text.includes(`"${'가'.repeat(24)}…"`));
  assert.ok(!r.text.includes('가'.repeat(25)));
});

test('report: 호칭은 어떤 씨앗엔 붙고 어떤 씨앗엔 안 붙는다', () => {
  const texts = SEEDS.map(s => report(base(), P, s).text);
  assert.ok(texts.some(t => t.startsWith('선장님, ')));
  assert.ok(texts.some(t => !t.includes('선장님')));
  assert.equal(report(base(), P, 'same').text, report(base(), P, 'same').text);
  assert.ok(SEEDS.every(s => !report(base(), NOCALL, s).text.startsWith(',')));
});
