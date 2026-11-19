import test from 'node:test';
import assert from 'node:assert/strict';
import { promisesOf, kept, dayKept, bond, morningLine, statusLine, reportLine, keptLine } from '../js/bond.js';

// 약속 하나: K = 지킴, x = 못 지킴
const K = () => ({ id: 't1', text: '일', due: 0, done: true, out: '결과', moved: 0, drop: false });
const X = () => ({ id: 't1', text: '일', due: 0, done: false, out: '', moved: 0, drop: false });
// 'KKx' 같은 글자로 날들을 만든다. 마지막 글자가 오늘 (. = 약속 없는 날)
const days = (s, today) => [...s].map((c, i) => ({ key: plus(today, i - s.length + 1), list: c === 'K' ? [K()] : c === 'x' ? [X()] : [] }));
const plus = (key, n) => new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8) + n)).toISOString().slice(0, 10);
const T = '2026-11-19';
const run = s => bond(days(s, T), T);

test('promisesOf: 필요한 칸만, 빈 값은 기본값으로', () => {
  const r = promisesOf([{ id: 't1', text: '코테', due: 5, done: 9, out: '  풀이 ', moved: 1, drop: 3, m: 1 }, { id: 't2' }]);
  assert.deepEqual(r, [
    { id: 't1', text: '코테', due: 5, done: true, out: '풀이', moved: 1, drop: true },
    { id: 't2', text: '', due: 0, done: false, out: '', moved: 0, drop: false },
  ]);
  assert.deepEqual(promisesOf([]), []);
});

test('kept·dayKept: 끝냈고 결과물이 있어야 지킨 것', () => {
  assert.equal(kept(K()), true);
  assert.equal(kept({ ...K(), out: '' }), false);
  assert.equal(kept({ ...K(), done: false }), false);
  assert.equal(dayKept([X(), K()]), true);
  assert.equal(dayKept([X()]), false);
  assert.equal(dayKept([]), false);
  assert.equal(dayKept(undefined), false);
});

test('bond 연속: 사흘 지키면 3', () => assert.equal(run('KKK').streak, 3));
test('bond 연속: 오늘 아직 못 지켰어도 끊지 않는다', () => assert.equal(run('KKx').streak, 2));
test('bond 연속: 빈 날 하루는 봐준다', () => assert.equal(run('KxKK').streak, 3));
test('bond 연속: 7일 안에 두 번 비면 두 번째 빈 날에서 멈춘다', () => assert.equal(run('KxKxK').streak, 2));
test('bond 연속: 다 못 지키면 0, 기록이 없어도 0', () => {
  assert.equal(run('xxx').streak, 0);
  assert.equal(bond([], T).streak, 0);
  assert.equal(bond(undefined, T).streak, 0);
});
test('bond 연속: 약속 없는 날도 빈 날로 친다', () => assert.equal(run('K.KK').streak, 3));
test('bond 연속: 빈 날이 7일 넘게 떨어져 있으면 또 봐주고, 7일 안이면 두 번째 빈 날에서 멈춘다', () => {
  assert.equal(run('KKxKKKKKKxKK').streak, 10);
  assert.equal(run('KKxKKKKKxKK').streak, 7);
});
test('bond 연속: 기록 맨 앞의 빈 날은 세지 않는다', () => assert.equal(run('xKK').streak, 2));
test('bond 연속: 오늘보다 뒤의 날은 보지 않는다', () => {
  const d = [...days('KK', T), { key: plus(T, 1), list: [K()] }];
  assert.equal(bond(d, T).streak, 2);
});
test('bond 연속: 순서가 섞여 있어도 같다', () => assert.equal(bond(days('KxKK', T).reverse(), T).streak, 3));

test('bond 최장: 끊긴 뒤에도 가장 길었던 기록을 남긴다', () => {
  const b = run('KKKKxxK');
  assert.equal(b.streak, 1);
  assert.equal(b.best, 4);
  assert.equal(run('KKK').best, 3);
  assert.equal(bond([], T).best, 0);
});

test('bond 날짜: 달과 해가 바뀌어도 이어 센다', () => {
  assert.equal(bond(days('KKK', '2026-03-01'), '2026-03-01').streak, 3);
  assert.equal(bond(days('KKK', '2027-01-01'), '2027-01-01').streak, 3);
  assert.equal(bond(days('KKKx', '2024-03-02'), '2024-03-02').streak, 3);
  assert.equal(days('KKK', '2027-01-01')[0].key, '2026-12-30');
});

test('bond 이번 주: 오늘까지 딱 7일만 센다', () => {
  // 8일 전부터: 7일 전 날은 빠진다
  const d = days('KKKKKKKK', T);
  d[0].list = [K(), K(), K()];
  d[7].list = [K(), X()];
  const b = bond(d, T);
  assert.deepEqual(b.week, { made: 8, kept: 7 });
  assert.deepEqual(bond([], T).week, { made: 0, kept: 0 });
});

test('bond 어제: 지킴, 미제출, 약속 없음', () => {
  assert.equal(run('Kx').yesterday, 'kept');
  assert.equal(run('xK').yesterday, 'missed');
  assert.equal(run('.K').yesterday, 'none');
  assert.equal(run('K').yesterday, 'none');
});

test('bond 표정: 모든 갈래', () => {
  assert.equal(run('KKK').mood, 'cheer');
  assert.equal(run('xK').mood, 'happy');
  assert.equal(run('Kx').mood, 'calm');
  assert.equal(run('xx').mood, 'worry');
  assert.equal(run('.x').mood, 'calm');
  assert.equal(run('KK').todayKept, true);
  assert.equal(run('Kx').todayKept, false);
});

test('morningLine: 어제 미제출, 약속 없음, 연속, 그 밖', () => {
  assert.equal(morningLine(run('xx')), '어제 약속은 미제출로 남았어요. 뭐가 걸렸어요? 오늘은 하나만, 작게 잡아요.');
  assert.equal(morningLine(run('.x')), '어제는 약속이 없었어요. 오늘 끝낼 한 가지와 마감을 알려 주세요.');
  assert.equal(morningLine(run('KKx')), '🔥 연속 2일째예요. 오늘 약속 하나만 정해 주세요.');
  assert.equal(morningLine(run('xKx')), '어제 약속을 지키셨어요. 오늘도 하나만 정해 주세요.');
});

test('statusLine·reportLine·keptLine: 숫자를 넣는다', () => {
  const b = run('KKKKxxK');
  assert.equal(statusLine(b), '🔥 연속 1일 (최장 4일) · 이번 주 약속 5/7 지킴');
  assert.equal(statusLine(run('KK')), '🔥 연속 2일 · 이번 주 약속 2/2 지킴');
  assert.equal(reportLine(b), '약속: 이번 주 7개 중 5개 지킴 · 연속 1일');
  assert.equal(keptLine(run('KK')), '약속을 지켰어요. 🔥 연속 2일째예요.');
});
