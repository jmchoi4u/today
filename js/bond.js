// 약속과 연속 기록: 약속을 지킨 날이 며칠 이어졌는지, 그에 따른 비서의 표정과 한마디.
// 앱과 텔레그램 비서가 같이 쓴다.

// 날짜 더하기 (UTC로 계산해서 시간대와 상관없다)
const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

// 핵심 3가지 → 약속 목록
export const promisesOf = (top3 = []) => top3.map(t => ({ id: t.id, text: t.text || '', due: t.due || 0, done: !!t.done, out: String(t.out || '').trim(), moved: t.moved || 0, drop: !!t.drop }));

// 지킨 약속: 끝냈고 결과물 한 줄이 있다
export const kept = p => p.done && !!p.out;
export const dayKept = (list = []) => list.some(kept);

// key 날을 오늘로 보고 센 연속 기록. 그날은 지켰으면 세고, 안 지켰어도 끊지 않는다 (아직 하루가 안 끝났다)
// 그 전 날은 지켰으면 하나 더. 못 지킨 날은 7일에 한 번 봐준다 (세지는 않고 넘어간다).
// 봐준 날에서 7일 안에 또 못 지킨 날이 나오면 거기서 멈춘다
function streakAt(map, key, earliest) {
  let n = dayKept(map.get(key)) ? 1 : 0;
  let gap = null;
  for (let i = 1; ; i++) {
    const k = addDays(key, -i);
    if (k < earliest) break;
    if (dayKept(map.get(k))) n++;
    else if (gap === null || i - gap > 6) gap = i;
    else break;
  }
  return n;
}

// days: [{ key, list: promisesOf(...) }] (순서 상관없음, 없는 날은 약속 없음), todayKey: 오늘
export function bond(days = [], todayKey) {
  const map = new Map(days.filter(d => d.key <= todayKey).map(d => [d.key, d.list || []]));
  const keys = [...map.keys()].sort();
  const earliest = keys[0] || todayKey;
  const todayKept = dayKept(map.get(todayKey));
  const yl = map.get(addDays(todayKey, -1)) || [];
  const yesterday = !yl.length ? 'none' : dayKept(yl) ? 'kept' : 'missed';
  const streak = keys.length ? streakAt(map, todayKey, earliest) : 0;
  let best = streak;
  for (const k of keys) best = Math.max(best, streakAt(map, k, earliest));
  const week = { made: 0, kept: 0 };
  for (let i = 0; i < 7; i++) {
    const list = map.get(addDays(todayKey, -i)) || [];
    week.made += list.length;
    week.kept += list.filter(kept).length;
  }
  const mood = todayKept ? (streak >= 3 ? 'cheer' : 'happy') : yesterday === 'missed' ? 'worry' : 'calm';
  return { todayKept, yesterday, streak, best, week, mood };
}

// 아침 첫마디
export function morningLine(b) {
  if (b.yesterday === 'missed') return '어제 약속은 미제출로 남았어요. 뭐가 걸렸어요? 오늘은 하나만, 작게 잡아요.';
  if (b.yesterday === 'none') return '어제는 약속이 없었어요. 오늘 끝낼 한 가지와 마감을 알려 주세요.';
  if (b.streak >= 2) return `🔥 연속 ${b.streak}일째예요. 오늘 약속 하나만 정해 주세요.`;
  return '어제 약속을 지키셨어요. 오늘도 하나만 정해 주세요.';
}

export const statusLine = b => `🔥 연속 ${b.streak}일${b.best > b.streak ? ` (최장 ${b.best}일)` : ''} · 이번 주 약속 ${b.week.kept}/${b.week.made} 지킴`;
export const reportLine = b => `약속: 이번 주 ${b.week.made}개 중 ${b.week.kept}개 지킴 · 연속 ${b.streak}일`;
export const keptLine = b => `약속을 지켰어요. 🔥 연속 ${b.streak}일째예요.`;
