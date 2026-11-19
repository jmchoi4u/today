// 알림음: 집중이 끝났을 때 울리는 차임. 음량은 0~100
// 화면도 저장소도 모른다. 소리만 낸다

export const DEFAULT_VOL = 60;

export const clampVol = v => {
  if (v == null || v === '') return DEFAULT_VOL;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_VOL;
  return Math.min(100, Math.max(0, Math.round(n)));
};

// 소리 크기는 곱으로 느껴져서, 제곱해야 막대 절반이 절반처럼 들린다
export const gainOf = vol => Math.round(((clampVol(vol) / 100) ** 2) * 0.8 * 10000) / 10000;

// 음 하나 = [Hz, 시작(초), 길이(초)]
export const PATTERNS = { done: [[784, 0, 0.25], [988, 0.22, 0.25], [1175, 0.44, 0.7]] };

export function createSound({ make = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(), volume = () => DEFAULT_VOL } = {}) {
  let ctx = null;
  const running = () => !!ctx && ctx.state === 'running';

  // 누른 뒤에 불러야 한다. 실패해도 false만 돌려준다
  async function unlock() {
    try {
      if (!ctx) ctx = make();
      if (!ctx) return false;
      if (ctx.state !== 'running') await ctx.resume();
      return ctx.state === 'running';
    } catch {
      return false;
    }
  }

  function schedule(name, delaySec = 0) {
    const notes = PATTERNS[name];
    if (!running() || !notes) return null;
    const peak = gainOf(volume());
    if (peak === 0) return null;
    const base = ctx.currentTime + delaySec;
    const oscs = [];
    try {
      for (const [hz, off, len] of notes) {
        const t0 = base + off;
        const osc = ctx.createOscillator(), g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(peak, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
        osc.connect(g).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + len);
        oscs.push(osc);
      }
    } catch {
      /* 소리를 낼 수 없는 상태 */
    }
    const at = base + notes[0][1];
    return {
      at,
      played: () => ctx.currentTime >= at,
      cancel() {
        for (const o of oscs) {
          try {
            o.stop();
          } catch {
            /* 이미 끝난 음 */
          }
          try {
            o.disconnect();
          } catch {
            /* 이미 끊긴 음 */
          }
        }
      },
    };
  }

  function play(name) {
    try {
      if (!ctx || gainOf(volume()) === 0) return false;
      if (running()) return !!schedule(name, 0);
      Promise.resolve(ctx.resume()).then(() => schedule(name, 0), () => {});
      return true;
    } catch {
      return false;
    }
  }

  return { unlock, ready: running, schedule, play };
}
