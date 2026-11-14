// 짧은 한국어 메시지를 행동으로 바꾼다. 규칙으로 먼저 풀고, 못 풀면 null (AI에게 넘긴다).
import * as C from '../../js/core.js';

const { MIN, HOUR } = C;
const KO_NUM = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const num = s => (/^\d+$/.test(s) ? +s : KO_NUM[s] ?? NaN);
const p2 = n => String(n).padStart(2, '0');
const AM = /^(오전|아침|새벽)$/;
const PM = /^(오후|저녁|밤|낮)$/;

// 시·분 → 그 논리적 하루(key) 안의 실제 시각. 오전/오후가 없으면 지금 이후로 가장 가까운 쪽
function absolute(period, h, mi, { now, key, rollover }) {
  if (!(h >= 0 && h <= 24 && mi >= 0 && mi < 60)) return null;
  const at = hh => C.tsFor(key, `${p2(hh % 24)}:${p2(mi)}`, rollover);
  if (period && AM.test(period)) return at(h % 12);
  // 오후·낮 12시는 정오, 저녁·밤 12시는 자정
  if (period && PM.test(period)) return at(h < 12 ? h + 12 : h === 12 ? (/^(저녁|밤)$/.test(period) ? 24 : 12) : h);
  if (h === 0 || h >= 13) return at(h);
  // 오전/오후가 없으면: 아침(새벽 기준시 이후)과 오후 중 지금 이후로 가장 가까운 쪽.
  // 새벽 1~3시는 "새벽"이라고 말할 때만 (오후 5시에 "3시"는 새벽 3시가 아니라 이미 지난 오후 3시)
  const base = h % 12;
  const cands = [];
  if (base >= rollover || h === 12) cands.push(at(base));
  cands.push(at(base + 12));
  cands.sort((a, b) => a - b);
  return cands.find(t => t > now + MIN) ?? cands[cands.length - 1];
}

// 메시지 안의 시각 표현. { at, match } 또는 null
export function findTime(text, { now, key, rollover = 4 }) {
  const s = String(text);
  const ctx = { now, key, rollover };
  // 시각 뒤 말끝은 같이 지운다. 단어 중간("에너지")을 먹지 않게 뒤가 끊기는 곳에서만
  const tail = '\\s*(?:전까지|까지|전에|에는|에서|엔|에|마감)?(?=$|[\\s,.!?~)])';
  let m = s.match(new RegExp(`(\\d+|한|두|세|네|다섯|여섯)\\s*시간\\s*(?:(반)|(\\d+)\\s*분)?\\s*(?:뒤|후|안에|이내)${tail}`));
  if (m) {
    const h = num(m[1]);
    if (Number.isFinite(h)) return { at: now + h * HOUR + (m[2] ? 30 : m[3] ? +m[3] : 0) * MIN, match: m[0], rel: true };
  }
  m = s.match(new RegExp(`(\\d+)\\s*분\\s*(?:뒤|후|안에|이내)${tail}`));
  if (m) return { at: now + +m[1] * MIN, match: m[0], rel: true };
  m = s.match(new RegExp(`(?:(오전|오후|아침|저녁|밤|낮|새벽)\\s*)?(\\d{1,2}):(\\d{2})${tail}`));
  if (m) {
    const at = absolute(m[1], +m[2], +m[3], ctx);
    if (at) return { at, match: m[0] };
  }
  m = s.match(new RegExp(`(?:(오전|오후|아침|저녁|밤|낮|새벽)\\s*)?(\\d{1,2})\\s*시(?!간)\\s*(?:(반)|(\\d{1,2})\\s*분)?${tail}`));
  if (m) {
    const at = absolute(m[1], +m[2], m[3] ? 30 : m[4] ? +m[4] : 0, ctx);
    if (at) return { at, match: m[0] };
  }
  m = s.match(new RegExp(`자정${tail}`));
  if (m) return { at: C.tsFor(key, '00:00', rollover), match: m[0] };
  return null;
}

// "코테 2문제 21시까지" → { type: 'top3_set', text: '코테 2문제', due, key }
export function parseTask(raw, { now, key, rollover = 4 }, forceTomorrow = false) {
  let s = String(raw || '');
  let tomorrow = forceTomorrow;
  if (/내일/.test(s)) {
    tomorrow = true;
    s = s.replace(/내일/g, ' ');
  }
  s = s.replace(/오늘/g, ' ');
  const k = tomorrow ? C.addDays(key, 1) : key;
  const t = findTime(s, { now: tomorrow ? C.dayStartTs(k, rollover) : now, key: k, rollover });
  let text = t ? s.replace(t.match, ' ') : s;
  text = text.replace(/\s+/g, ' ').replace(/^[\s,.:~\-·]+|[\s,.:~\-·]+$/g, '').trim();
  if (!text) return null;
  return { type: 'top3_set', text: text.slice(0, 40), due: t ? t.at : 0, key: k };
}

// 메시지 하나 → { actions: [...] } 또는 null(규칙으로 못 풂)
// ctx: { now, key, rollover, awaiting }
export function parseMessage(text, ctx) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let m;
  // 명시적인 머리말은 기다리던 답보다 먼저
  if ((m = raw.match(/^(?:걱정|주차장?|🅿️|🅿)\s*[:：]?\s*([\s\S]+)$/))) return { actions: [{ type: 'park', note: m[1].trim() }] };
  if ((m = raw.match(/^불편\s*[:：]?\s*([\s\S]+)$/))) return { actions: [{ type: 'note', item: 'pain_note', note: m[1].trim() }] };
  if (/^(?:오늘\s*(?:어때|상태)?|상태|뭐\s*남았|남은\s*거)[?？]?$/.test(raw)) return { actions: [{ type: 'status' }] };

  // 내가 방금 물어본 것에 대한 답
  const aw = ctx.awaiting;
  if (aw) {
    if (aw.kind === 'note' && aw.item) return { actions: [{ type: 'note', item: aw.item, note: raw }] };
    if (aw.kind === 'out' && aw.id) return { actions: [{ type: 'top3_done', id: aw.id, out: raw }] };
    if (aw.kind === 'fnote' && aw.ev) return { actions: [{ type: 'focus_note', ev: aw.ev, key: aw.key, note: raw }] };
    if (aw.kind === 'due' && aw.id) {
      const t = findTime(raw, ctx);
      if (t) return { actions: [{ type: 'top3_due', id: aw.id, due: t.at }] };
    }
    if (aw.kind === 'top3' || aw.kind === 'tomorrow') {
      const task = parseTask(raw, ctx, aw.kind === 'tomorrow');
      if (task) return { actions: [task] };
    }
  }

  if (/^(?:일어났|기상|깼어|깼다)/.test(raw)) return { actions: [{ type: 'wake' }] };
  if (/(?:나왔|나갔|출발했|출발함|밖이야|밖임|집\s*밖)/.test(raw)) return { actions: [{ type: 'out' }] };
  if (/약[^\n]{0,8}(?:먹었|먹음|먹엇|먹은|복용)/.test(raw)) return { actions: [{ type: 'med' }] };
  // 긴 말부터 맞춘다 ("끝냈어요"를 "끝" + "냈어요"로 자르지 않게)
  if ((m = raw.match(/^(?:끝냈|끝났|해냈|다\s*했|완료|끝)(?:습니다|어요|어|음|다|함)?[!.~]*\s*[:：,.\-]?\s*([\s\S]*)$/))) return { actions: [{ type: 'top3_done', id: null, out: m[1].trim() }] };

  // 시각이 붙은 할 일만 규칙으로 잡는다. 시각 없는 말은 AI가 판단한다
  const task = parseTask(raw, ctx, false);
  if (task?.due) return { actions: [task] };
  return null;
}
