// 정해진 문구 앞에 붙는 비서의 한마디. 비서 설정(secretary)이 없으면 아무것도 붙이지 않는다.
// {call}은 호칭으로 바꾼다. 호칭 뒤에 조사를 붙이지 않는다 (받침이 있든 없든 어색하지 않게)
const pools = {
  // 아침 기상 확인 (아직 안 일어났을 때)
  wake: ['좋은 아침이에요, {call} ☀️', '아침이에요. 천천히 시작해요', '{call}, 일어날 시간이에요', '오늘도 같이 가요'],
  // 일어났다고 했을 때
  woke: ['잘 주무셨어요, {call}?', '일어나셨네요. 물 한 잔부터 해요', '좋아요, 오늘 시작이에요', '{call}, 오늘도 잘 부탁드려요'],
  // 핵심 하나를 끝냈을 때
  done: ['해내셨네요, {call} 👏', '하나 끝. 수고하셨어요', '역시예요, {call}', '좋아요, 한 걸음 갔어요'],
  // 집중 타이머가 끝났을 때
  focusEnd: ['집중 끝났어요. 물 한 잔 하고 와요', '수고하셨어요, {call}. 5분만 쉬어요', '잘 버텼어요. 어깨 한번 펴요', '{call}, 한 판 끝이에요'],
};
export const KINDS = Object.keys(pools);
export const LINES = pools; // 시험용

// 작은 문자열 해시 (같은 seed면 늘 같은 줄)
function hash(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

// 호칭 넣기. 호칭이 없으면 {call}과 바로 붙은 ", "를 같이 지운다
export function fill(line, call) {
  const c = String(call || '').trim();
  if (c) return line.replaceAll('{call}', c);
  return line.replace(/, \{call\}|\{call\}, |\{call\}/g, '').replace(/\s{2,}/g, ' ').replace(/ ([?.!])/g, '$1').trim();
}

export function lead(kind, persona, seed = '') {
  const pool = pools[kind];
  if (!persona?.name || !pool) return '';
  return fill(pool[hash(seed) % pool.length], persona.call);
}
