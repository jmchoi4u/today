import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VOL, clampVol, gainOf, PATTERNS, createSound } from '../js/sound.js';

// 가짜 AudioContext: 무엇을 만들고 언제 켜고 껐는지 적어 둔다
function fakeCtx(state = 'running') {
  const ctx = {
    state,
    currentTime: 10,
    destination: { name: 'out' },
    resumed: 0,
    oscs: [],
    gains: [],
    resume() {
      ctx.resumed++;
      ctx.state = 'running';
      return Promise.resolve();
    },
    createOscillator() {
      const o = {
        type: '',
        frequency: { value: 0 },
        startAt: null,
        stopAt: null,
        stopped: 0,
        disconnected: 0,
        connect: g => g,
        start(t) { o.startAt = t; },
        stop(t) {
          if (t === undefined) {
            o.stopped++;
            if (o.throwOnStop) throw new Error('이미 끝남');
          } else o.stopAt = t;
        },
        disconnect() { o.disconnected++; },
      };
      ctx.oscs.push(o);
      return o;
    },
    createGain() {
      const calls = [];
      const g = {
        calls,
        gain: {
          setValueAtTime: (v, t) => calls.push(['set', v, t]),
          linearRampToValueAtTime: (v, t) => calls.push(['lin', v, t]),
          exponentialRampToValueAtTime: (v, t) => calls.push(['exp', v, t]),
        },
        connect: d => d,
      };
      ctx.gains.push(g);
      return g;
    },
  };
  return ctx;
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('clampVol: 0~100 정수로 맞추고, 이상한 값은 기본값', () => {
  assert.equal(clampVol(0), 0);
  assert.equal(clampVol(100), 100);
  assert.equal(clampVol(150), 100);
  assert.equal(clampVol(-5), 0);
  assert.equal(clampVol(54.6), 55);
  assert.equal(clampVol('35'), 35);
  for (const v of [null, undefined, '', 'abc', NaN]) assert.equal(clampVol(v), DEFAULT_VOL, String(v));
  assert.equal(DEFAULT_VOL, 60);
});

test('gainOf: 0은 무음, 100은 0.8, 막대를 올릴수록 커진다', () => {
  assert.equal(gainOf(0), 0);
  assert.equal(gainOf(100), 0.8);
  const gs = [0, 25, 50, 75, 100].map(gainOf);
  for (let i = 1; i < gs.length; i++) assert.ok(gs[i] > gs[i - 1], `${gs[i - 1]} < ${gs[i]}`);
});

test('잠금 풀기 전엔 아무 소리도 걸지 않는다', () => {
  const s = createSound({ make: () => fakeCtx() });
  assert.equal(s.ready(), false);
  assert.equal(s.schedule('done'), null);
  assert.equal(s.play('done'), false);
});

test('AudioContext를 못 만들면 unlock은 false, 던지지 않는다', async () => {
  const s = createSound({ make: () => { throw new Error('없음'); } });
  assert.equal(await s.unlock(), false);
  assert.equal(s.ready(), false);
  assert.equal(s.play('done'), false);
});

test('멈춰 있는 컨텍스트는 unlock이 resume해서 true', async () => {
  const ctx = fakeCtx('suspended');
  const s = createSound({ make: () => ctx });
  assert.equal(await s.unlock(), true);
  assert.equal(ctx.resumed, 1);
  assert.equal(s.ready(), true);
});

test('schedule: 세 음을 패턴대로 걸고, 최고 음량은 막대 값을 따른다', async () => {
  const ctx = fakeCtx();
  const s = createSound({ make: () => ctx, volume: () => 40 });
  await s.unlock();
  const h = s.schedule('done', 0);
  assert.ok(h);
  assert.equal(h.at, 10);
  assert.equal(ctx.oscs.length, 3);
  PATTERNS.done.forEach(([hz, off, len], i) => {
    const o = ctx.oscs[i];
    assert.equal(o.type, 'sine');
    assert.equal(o.frequency.value, hz);
    assert.equal(o.startAt, 10 + off);
    assert.equal(o.stopAt, 10 + off + len);
    const [set, lin, exp] = ctx.gains[i].calls;
    assert.deepEqual(set, ['set', 0.0001, 10 + off]);
    assert.equal(lin[1], gainOf(40));
    assert.equal(exp[2], 10 + off + len);
  });
});

test('schedule: 90초 뒤로 걸면 모든 음이 90초 밀리고, 모르는 이름은 null', async () => {
  const ctx = fakeCtx();
  const s = createSound({ make: () => ctx });
  await s.unlock();
  const h = s.schedule('done', 90);
  assert.equal(h.at, 100);
  PATTERNS.done.forEach(([, off], i) => assert.equal(ctx.oscs[i].startAt, 100 + off));
  assert.equal(s.schedule('nope', 0), null);
});

test('음량 0이면 아무것도 만들지 않는다', async () => {
  const ctx = fakeCtx();
  const s = createSound({ make: () => ctx, volume: () => 0 });
  await s.unlock();
  assert.equal(s.schedule('done', 5), null);
  assert.equal(s.play('done'), false);
  assert.equal(ctx.oscs.length, 0);
});

test('손잡이: 시각 전엔 안 울림, 지나면 울림. 취소는 두 번 해도 되고 끝난 음도 괜찮다', async () => {
  const ctx = fakeCtx();
  const s = createSound({ make: () => ctx });
  await s.unlock();
  const h = s.schedule('done', 30);
  assert.equal(h.played(), false);
  ctx.currentTime = 40;
  assert.equal(h.played(), true);
  ctx.oscs[0].throwOnStop = true;
  assert.doesNotThrow(() => h.cancel());
  assert.doesNotThrow(() => h.cancel());
  for (const o of ctx.oscs) {
    assert.ok(o.stopped >= 1);
    assert.ok(o.disconnected >= 1);
  }
});

test('play: 멈춘 컨텍스트면 깨운 다음 울린다', async () => {
  const ctx = fakeCtx();
  const s = createSound({ make: () => ctx });
  await s.unlock();
  ctx.state = 'suspended';
  assert.equal(s.play('done'), true);
  await tick();
  assert.equal(ctx.resumed, 1);
  assert.equal(ctx.oscs.length, 3);
});

test('play: 켜진 컨텍스트면 바로 울린다', async () => {
  const ctx = fakeCtx();
  const s = createSound({ make: () => ctx });
  await s.unlock();
  assert.equal(s.play('done'), true);
  assert.equal(ctx.oscs.length, 3);
  assert.equal(ctx.oscs[0].startAt, 10);
});
