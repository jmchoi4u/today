// 조용한 점검: 답이 없는 알림은 줄인다. 더 세게 다시 보내지 않는다.
//  - 같은 종류의 알림을 사흘 연속 아무 반응 없이 넘기면 그 종류는 3일 쉰다 (낮에 한 번 알리고 "다시 받기" 버튼을 준다).
//    "반응"은 그날 그 알림이 처음 온 뒤의 텔레그램 말·버튼, 또는 폰 앱에서 남긴 기록이다.
//  - 36시간 동안 아무 반응이 없고 그동안 알림을 셋 넘게 보냈으면, 꼭 필요한 것만 남기고 가볍게 한 번만 묻는다. 반응하면 바로 돌아온다
// 줄이지 않는 것: 약(예정 약 알림과 아침 루틴의 약 단계), 사용자가 직접 정한 마감, 캘린더, 집중 타이머 끝.
// q = state.q: { seen, quiet, unanswered, notice: [kind], stat: { kind: { day, first, hit, streak } }, mute: { kind: until } }
const MIN = 60 * 1000, HOUR = 60 * MIN;
export const EXEMPT = new Set(['dose', 'due', 'cal', 'focus']);
export const KEEP = new Set(['wake', 'report']); // 쉬게 하지 않고 세지도 않는 종류 (기상 확인은 아침의 문, 주간 리뷰는 앱에서 답한다)
export const QUIET_KEEP = new Set(['go', 'report']); // 조용한 동안에도 보내는 종류 (출발 마감, 주간 리뷰). 기상 확인은 첫 번째만
export const IGNORE_DAYS = 3;
export const MUTE_MS = 72 * HOUR;
export const SILENCE_MS = 36 * HOUR;
export const SILENCE_PINGS = 3;
export const HIT_MS = 2 * HOUR; // 그 종류의 마지막 알림 뒤 이 안에 반응해야 그 알림에 답한 걸로 친다 (답을 기다리는 시간과 같다)
export const KIND_NAME = { routine: '아침 루틴', go: '출발 마감', peak: '약 효과 구간', daily: '매일 한 줄', hint: '시간대 규칙', plan: '예정 습관' };

// 약을 묻는 알림은 종류가 routine이어도 줄이지 않는다
export const isExempt = p => EXEMPT.has(p.kind) || p.await?.kind === 'dose';
const daytime = now => {
  const h = new Date(now).getHours();
  return h >= 9 && h < 22;
};
const init = q => {
  q.stat ||= {};
  q.mute ||= {};
  q.notice ||= [];
  return q;
};
// 날이 바뀌면 어제 결과를 센다: 알림이 갔는데 반응이 없었으면 연속 +1, 반응했으면 0. 알림이 없던 날은 그대로
function roll(st, key) {
  if (st.day === key) return;
  if (st.day && st.first) st.streak = st.hit ? 0 : (st.streak || 0) + 1;
  st.day = key;
  st.first = 0;
  st.last = 0;
  st.hit = false;
}

// 반응이 있었다. at: 그 반응의 시각 (텔레그램이면 지금, 앱 기록이면 그 기록을 남긴 시각)
export function onSeen(q, now, at = now) {
  init(q);
  if (at > (q.seen || 0)) q.seen = at;
  q.quiet = false;
  q.unanswered = 0;
  for (const st of Object.values(q.stat)) {
    if (st.first && at >= st.first && at - (st.last || st.first) <= HIT_MS) {
      st.hit = true;
      st.streak = 0;
    }
  }
}

// 알림을 보냈다. 답을 바라는 알림(버튼이나 답장)만 센다
export function onSent(q, ping, key, now) {
  init(q);
  if (isExempt(ping) || KEEP.has(ping.kind)) return;
  if (!(ping.buttons?.length || ping.await)) return;
  const st = (q.stat[ping.kind] ||= { streak: 0 });
  roll(st, key);
  if (!st.first) st.first = now;
  st.last = now;
  q.unanswered = (q.unanswered || 0) + 1;
}

// 30초마다. → { notice: [쉬게 된 종류, 낮에만], reentry: 조용해져서 한 번 물을 때 }
export function review(q, key, now) {
  init(q);
  if (!q.seen) q.seen = now; // 처음 켠 때부터 센다
  const day = daytime(now);
  for (const [kind, st] of Object.entries(q.stat)) {
    roll(st, key);
    // 쉬기는 낮에 정한다: 쉰다고 알리는 그때부터 쉬게 (새벽에 정해 두고 아침 알림을 말없이 빼지 않는다)
    if (day && (st.streak || 0) >= IGNORE_DAYS && !(q.mute[kind] > now)) {
      q.mute[kind] = now + MUTE_MS;
      st.streak = 0;
      if (!q.notice.includes(kind)) q.notice.push(kind);
    }
  }
  for (const [kind, until] of Object.entries(q.mute)) if (until <= now) delete q.mute[kind];
  q.notice = q.notice.filter(k => q.mute[k] > now);
  let reentry = false;
  // 다시 말 거는 한마디와 쉰다는 알림은 낮에만 (자는 시간에 보내지 않는다)
  if (day && !q.quiet && now - q.seen >= SILENCE_MS && (q.unanswered || 0) >= SILENCE_PINGS) {
    q.quiet = true;
    reentry = true;
  }
  return { notice: day ? [...q.notice] : [], reentry };
}
// 쉰다는 알림을 보내는 데 성공했다
export function noticeSent(q) {
  init(q).notice = [];
}

// 이 알림을 지금 보내도 되는지
export function allow(q, ping, now) {
  init(q);
  if (isExempt(ping)) return true;
  if (q.mute[ping.kind] > now) return false;
  if (q.quiet) return (ping.kind === 'wake' && ping.key === 'wake1') || QUIET_KEEP.has(ping.kind);
  return true;
}

export function unmute(q, kind) {
  init(q);
  if (kind) {
    delete q.mute[kind];
    q.notice = q.notice.filter(k => k !== kind);
    if (q.stat[kind]) q.stat[kind].streak = 0;
  } else {
    q.mute = {};
    q.notice = [];
    q.quiet = false;
    q.unanswered = 0;
    for (const st of Object.values(q.stat)) st.streak = 0;
  }
}
