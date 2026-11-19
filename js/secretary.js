// 비서 캐릭터: 표정 고르기와 화면에서 하는 말.
// 이름·호칭은 비공개 설정에서 온다.

export const MOODS = ['calm', 'happy', 'cheer', 'worry'];
const LINK = /^https:\/\/t\.me\/[A-Za-z0-9_]{3,40}$/;

// 비서 설정이 없거나 이름이 비면 null (기존 마스코트 그대로). 숨김이면 null
export function persona(game, hidden = false) {
  if (hidden) return null;
  const s = game?.secretary;
  const name = typeof s?.name === 'string' ? s.name.trim() : '';
  if (!name) return null;
  const link = typeof s.link === 'string' ? s.link.trim() : '';
  return { name: name.slice(0, 20), call: String(s.call ?? '').trim().slice(0, 20), link: LINK.test(link) ? link : '' };
}

export const artSrc = mood => `icons/sec-${MOODS.includes(mood) ? mood : 'calm'}.jpg`;
export const moodOf = card => (card?.tone === 'good' ? 'happy' : 'calm');

// 같은 씨앗이면 늘 같은 줄 (Math.random 안 씀)
export function pick(list, seed) {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return list[h % list.length];
}

// {call}을 호칭으로. 호칭이 없으면 옆의 ", "까지 지운다
export function fill(text, p) {
  const call = p?.call || '';
  if (call) return text.replaceAll('{call}', call);
  return text.replace(/, \{call\}|\{call\}, |\{call\}/g, '').trim();
}

const cut = t => (t.length > 24 ? `${t.slice(0, 24)}…` : t);

// 오늘 상황 한마디
export function report(s, p, seed) {
  const top = s.top3 || [];
  const fmt = s.fmt;
  const left = top.filter(t => !t.done);
  let text, mood;
  if (!s.woke) {
    text = '아직 오늘을 시작하지 않으셨어요. 일어난 시각부터 알려 주세요.';
    mood = 'calm';
  } else if (!top.length) {
    text = '아직 오늘 핵심이 없어요. 끝이 보이는 일 하나만 정해 볼까요?';
    mood = 'calm';
  } else if (!left.length) {
    text = `오늘 핵심 ${top.length}개를 다 끝내셨어요. 이제 쉬어도 돼요.`;
    mood = 'cheer';
  } else {
    const late = left.filter(t => t.due && t.due < s.now).sort((a, b) => a.due - b.due)[0];
    if (late) {
      text = `"${cut(late.text)}" 마감(${fmt(late.due)})이 지났어요. 지금 2분만 열어 볼까요?`;
      mood = 'worry';
    } else {
      const next = [...left].sort((a, b) => (a.due || Infinity) - (b.due || Infinity))[0];
      const k = top.length - left.length;
      text = `핵심 ${top.length}개 중 ${k}개 끝났어요. 다음은 "${cut(next.text)}"${next.due ? `, ${fmt(next.due)}까지` : ''}예요.`;
      mood = k >= 1 ? 'happy' : 'calm';
    }
  }
  if (s.focusMin > 0) text += ` 집중은 ${s.focusMin}분 했어요.`;
  if (p?.call && pick([true, false, false], `${seed}:call`)) text = `${p.call}, ${text}`;
  return { text, mood };
}

const CHAT = {
  morning: ['물 한 잔 드셨어요, {call}?', '좋은 아침이에요. 오늘 첫 일 하나만 정해 봐요', '{call}, 햇빛 조금 보고 시작해요 ☀️', '아침은 천천히 해도 괜찮아요'],
  day: ['지금 하는 일 하나만 끝까지 가 봐요', '{call}, 어깨 한 번 펴고 숨 한 번 쉬어요', '점심은 챙겨 드셨어요?', '잘하고 계세요, {call}'],
  evening: ['오늘 한 일 한 줄만 적어 두면 내일이 편해요', '{call}, 오늘도 수고 많으셨어요', '저녁은 가볍게 드셨어요? 🍚', '남은 일은 내일의 나에게 맡겨도 돼요'],
  night: ['{call}, 화면은 여기까지 하고 주무세요', '내일 일은 내일 같이 봐요', '푹 자는 것도 오늘 할 일이에요 🌙', '오늘 하루 잘 버티셨어요, {call}'],
};
export const CHAT_POOLS = CHAT;
const partOf = h => (h >= 5 && h <= 10 ? 'morning' : h >= 11 && h <= 16 ? 'day' : h >= 17 && h <= 21 ? 'evening' : 'night');

// 한 번 더 누르면 하는 잡담
export const chat = (p, seed, hour) => ({ text: fill(pick(CHAT[partOf(hour)], seed), p), mood: 'happy' });

export const CHEERS = ['해내셨네요, {call} 👏', '오늘 목표 달성이에요. 수고하셨어요', '{call}, 정말 잘하셨어요', '한 걸음 더 갔어요. 같이 기뻐요'];
// 목표를 이뤘을 때
export const cheer = (p, seed) => ({ text: fill(pick(CHEERS, seed), p), mood: 'cheer' });
