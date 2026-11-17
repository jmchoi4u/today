// 짧은 한국어 메시지를 행동으로 바꾼다. 규칙으로 먼저 풀고, 못 풀면 null (AI에게 넘긴다).
// 원칙: 약·기상처럼 기록을 바꾸는 규칙은 틀리게 남기느니 안 남기는 쪽을 고른다. 애매하면 null.
import * as C from '../../js/core.js';

const { MIN, HOUR } = C;
const KO_NUM = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const num = s => (/^\d+$/.test(s) ? +s : KO_NUM[s] ?? NaN);
const p2 = n => String(n).padStart(2, '0');
const AM = /^(오전|아침|새벽)$/;
const PM = /^(오후|저녁|밤|낮)$/;

// 시·분 → 그 논리적 하루(key) 안의 실제 시각.
// 오전/오후가 없으면: 앞으로 할 일은 지금 이후로 가장 가까운 쪽, 지난 일(past)은 지금 이전 중에서 고른다.
// early: 지난 시각 중 이른 쪽 (저녁 9시에 "8시 반에 일어났어"는 아침 8시 반)
function absolute(period, h, mi, { now, key, rollover, past, early }) {
  if (!(h >= 0 && h <= 24 && mi >= 0 && mi < 60)) return null;
  const at = hh => C.tsFor(key, `${p2(hh % 24)}:${p2(mi)}`, rollover);
  if (period && AM.test(period)) return at(h % 12);
  // 오후·낮 12시는 정오, 저녁·밤 12시는 자정
  if (period && PM.test(period)) return at(h < 12 ? h + 12 : h === 12 ? (/^(저녁|밤)$/.test(period) ? 24 : 12) : h);
  if (h === 0 || h >= 13) return at(h);
  // 앞으로 할 일에서 새벽 1~3시는 "새벽"이라고 말할 때만 (오후 5시에 "3시"는 이미 지난 오후 3시).
  // 지난 일이면 자정 넘어 "1시에 약 먹었어"처럼 새벽일 수 있어서 후보에 넣는다
  const base = h % 12;
  const cands = [];
  if (base >= rollover || h === 12 || past) cands.push(at(base));
  cands.push(at(base + 12));
  cands.sort((a, b) => a - b);
  if (past) {
    const before = cands.filter(t => t <= now + MIN);
    if (!before.length) return cands[0];
    return early ? before[0] : before[before.length - 1];
  }
  return cands.find(t => t > now + MIN) ?? cands[cands.length - 1];
}

// 메시지 안의 시각 표현. { at, match } 또는 null
// past: 지난 일을 말하는 문장 ("3시 10분에 먹었어", "30분 전에 일어났어")
export function findTime(text, { now, key, rollover = 4, past = false, early = false }) {
  const s = String(text);
  const ctx = { now, key, rollover, past, early };
  // 시각 뒤 말끝은 같이 지운다. 단어 중간("에너지")을 먹지 않게 뒤가 끊기는 곳에서만
  const tail = '\\s*(?:쯤|경|정도)?\\s*(?:전까지|까지|전에|에는|에서|엔|에|마감)?\\s*(?:이에요|에요|예요|이요|요|인가|인듯)?(?=$|[\\s,.!?~)ㅋㅎ])';
  let m;
  if (past) {
    m = s.match(new RegExp(`(\\d+|한|두|세|네|다섯|여섯)\\s*시간\\s*(?:(반)|(\\d+)\\s*분)?\\s*전${tail}`));
    if (m) {
      const h = num(m[1]);
      if (Number.isFinite(h)) return { at: now - h * HOUR - (m[2] ? 30 : m[3] ? +m[3] : 0) * MIN, match: m[0], rel: true };
    }
    // "2시 30분 전에"의 "30분 전"은 상대 시각이 아니다
    m = s.match(new RegExp(`(?<!\\d)(?<!\\d\\s*시\\s*)(\\d+)\\s*분\\s*전${tail}`));
    if (m) return { at: now - +m[1] * MIN, match: m[0], rel: true };
  } else {
    m = s.match(new RegExp(`(\\d+|한|두|세|네|다섯|여섯)\\s*시간\\s*(?:(반)|(\\d+)\\s*분)?\\s*(?:뒤|후|안에|이내)${tail}`));
    if (m) {
      const h = num(m[1]);
      if (Number.isFinite(h)) return { at: now + h * HOUR + (m[2] ? 30 : m[3] ? +m[3] : 0) * MIN, match: m[0], rel: true };
    }
    m = s.match(new RegExp(`(\\d+)\\s*분\\s*(?:뒤|후|안에|이내)${tail}`));
    if (m) return { at: now + +m[1] * MIN, match: m[0], rel: true };
  }
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

// 지난 일을 말하는 문장인지: "먹었어", "끝냈다고", "운동함", "일어남".
// 이런 말에 붙은 시각은 마감이 아니라 그때 한 일이다.
// 받침이 ㅆ인 글자 뒤에 말끝(어·음·다·고·지·네·는데…)이 오면 과거로 본다. 있다·겠다는 빼고.
// 함·감·옴·봄·씀·잠은 앞으로의 계획에도 쓴다 ("3시에 병원 감"). 시각이 아직 안 왔거나 까지·마감이 있으면 과거로 안 본다.
// "마감"의 감, "해야 함"의 함은 과거가 아니다
const PAST_NOUN = /(?:먹음|했음|끝냄|마침|일어남|깸|다녀옴|갔다옴|복용함|완료함|도착함)(?=$|[\s,.!?~ㅋㅎ)])/;
const WEAK_NOUN = /(?:(?<!야\s?)함|(?<!마)감|옴|봄|씀|잠)(?=$|[\s,.!?~ㅋㅎ)])/;
const PAST_END = /^(?:어|음|다|고|지|네|습|던|는데|잖|거든|으니|$|[\s,.!?~ㅋㅎ)])/;
export function isPastStatement(text, ctx = null) {
  const s = String(text || '');
  if (PAST_NOUN.test(s)) return true;
  if (WEAK_NOUN.test(s) && !/까지|마감/.test(s)) {
    const t = ctx ? findTime(s, { ...ctx, past: false }) : null;
    if (!t || t.at <= ctx.now) return true;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 0xac00;
    if (c < 0 || c >= 11172 || c % 28 !== 20 || s[i] === '있' || s[i] === '겠') continue;
    if (PAST_END.test(s.slice(i + 1))) return true;
  }
  return false;
}

// 낱말로 들어 있는지: 앞에 다른 글자가 붙지 않고, 뒤에는 조사만 ("감마를"은 맞고 "코감마", "감마큐브"는 아니다)
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PARTICLE = '(?:을|를|은|는|이|가|도|만|랑|이랑|하고|좀|부터|까지|도요)';
const wordIn = (s, w) => new RegExp(`(?<![가-힣A-Za-z])${esc(w)}(?=$|[^가-힣A-Za-z]|${PARTICLE}(?![가-힣]))`).test(s);

// 메시지에 이름이 나온 약 항목 id들. 항목 이름 통째로 맞은 것이 먼저. meds: [{ id, name, words, taken }]
export function matchMeds(text, meds = []) {
  const s = String(text || '');
  const out = [];
  for (const m of meds) {
    // 항목 이름 통째로 (띄어쓰기는 달라도 된다). 뒤에 다른 글자가 붙으면 아니다 ("아침 약속")
    const n = String(m.name || '').replace(/\s+/g, '');
    if (n.length >= 3 && new RegExp(`${[...n].map(esc).join('\\s*')}(?=$|[^가-힣A-Za-z]|${PARTICLE}(?![가-힣]))`).test(s)) out.push(m.id);
  }
  for (const m of meds) if (!out.includes(m.id) && (m.words || []).some(w => w && w.length >= 2 && wordIn(s, w))) out.push(m.id);
  return out;
}
export const matchMed = (text, meds) => matchMeds(text, meds)[0] ?? null;

// 먹었다는 말. 그 말이 메시지의 마지막 서술어일 때만 (뒤엔 방금·아까 같은 말, ㅋㅋ, 이모지, 마침표만).
// "먹었는데 효과 없었어", "먹었던 것 같은데", "먹었을걸"은 기록하지 않는다. "챙겼어"(가방에 챙김), "복용 시간"(명사)도 아니다
const MED_END = '(?=(?:\\s|방금|아까|이미|벌써|진작|지금|오늘|[ㅋㅎㅠㅜ]|[^\\p{L}\\p{N}?？])*$)';
const MED_VERB = new RegExp(`(?:먹었|먹엇|복용했|챙겨\\s*먹었)(?:어요|어|다|습니다|음|지|다고|다니까|거든|는데요)?${MED_END}|(?:먹음|복용함|복용\\s*완료|먹고\\s*왔(?:어요|어|다|음)?)${MED_END}`, 'u');
// 안 먹었거나, 먹었는지 모르거나, 지난 일·다른 날·가정·질문이면 기록하지 않는다
const NOT_TAKEN = /(?:안|못)\s*(?:먹|챙|복용)|복용\s*(?:안|못)|않았|까먹|깜빡|아직|먹을|먹어야|먹으려|었어야|었으면|는지|던가|었나|[?？]|먹은\s*(?:지|다음|후|뒤|날|줄)|어제|어젯밤|그저께|지난|매일|맨날/;
// 남의 말을 옮기는 말 ("먹었냐고", "먹었대")
const HEARSAY = /냐고|냐며|냐는|냐\s*[?？]|[대래](?:요)?[\s.!~ㅋㅎ]*$/;
// 약 알림 뒤의 "먹었어"는 그 약. 시각·"이미" 같은 말과 동사만 있을 때만 ("아침 먹었어", "1시에 떡볶이 먹었어"는 약이 아니다)
function bareDoseReply(raw, pctx) {
  const t = findTime(raw, pctx);
  const r = (t ? raw.replace(t.match, ' ') : raw)
    .replace(/먹었\S*|먹음|먹엇\S*|먹고\s*왔\S*|복용했\S*|복용함|챙겨\s*먹었\S*/g, ' ')
    .replace(/아니(?:야|요)?|이미|벌써|아까|방금|진작|그거|약|한|쯤|응|ㅇㅇ|넵|네|예|다|어|요|ㅋ+|ㅎ+|[\s,.!~]/g, '');
  return !r;
}
// 아직 못 끝냈다는 말
const NOT_DONE = /아직|(?:못|안)\s*(?:했|함|끝|냈|해)|덜\s*(?:했|됐|끝)/;
const WAKE_VERB = /(?:일어났|일어남|깼|깸|기상(?!청|특보|예보|정보))/;
// 기상 기록으로 보면 안 되는 말: 못 일어남·실패·알람·바람·어제·질문·남의 말·다른 사람(아기가, 동생이)·다시 잠
const WAKE_NOT = /(?:못|안)\s*(?:일어|깼|깸)|실패|목표|바꿔|알람|일어났어야|일어났으면|어제|[?？]\s*$|[대래](?:요)?[\s.!~ㅋㅎ]*$|[가-힣](?:가|이)\s|다시\s*(?:잤|잠|자|누웠)|또\s*잤|(?:사고|사건|문제|난리|싸움|에러|오류|일)\s*(?:가|이)?\s*일어/;
// "지금 일어난 건 아니고", "아까 일어났어": 기상 시각을 다시 물어야 하는 말
const WAKE_EARLIER = /(?:(?:일어난|깬|기상한)[^\n]{0,8}(?:아니|아냐|아님|아닌)|(?:아까|좀\s*전에|진작|일찍)\s*(?:일어났|깼))/;
// "몇 시에 일어났어요?"의 답에서 시각 말고 빼도 되는 말
const WAKE_FILLER = /아마|대충|한|좀|조금|넘어서|넘어|쯤|인가|인듯|정도|경|에|이었어|이었음|였어|였음|이요|에요|예요|요|음|아|일어났\S*|깼\S*|기상|ㅋ+|ㅎ+|[\s,.!?~]/g;
// "아니", "취소"로 시작하면 방금 물어본 값(마감·결과물)에 대한 답이 아닐 수 있다
const NEG = /^(?:아니요|아니야|아니|아냐|아뇨|취소|됐어|됐고|그게\s*아니라)(?:[\s,.!~]+|$)/;

// 메시지 하나 → { actions: [...] } 또는 null(규칙으로 못 풂)
// ctx: { now, key, rollover, awaiting, dose, meds }
export function parseMessage(text, ctx) {
  const raw0 = String(text || '').trim();
  if (!raw0) return null;
  let m;
  // 명시적인 머리말은 기다리던 답보다 먼저
  if ((m = raw0.match(/^(?:걱정|주차장?|🅿️|🅿)\s*[:：]?\s*([\s\S]+)$/))) return { actions: [{ type: 'park', note: m[1].trim() }] };
  if ((m = raw0.match(/^불편\s*[:：]?\s*([\s\S]+)$/))) return { actions: [{ type: 'note', item: 'pain_note', note: m[1].trim() }] };
  if (/^(?:오늘\s*(?:어때|상태)?|상태|뭐\s*남았|남은\s*거)[?？]?$/.test(raw0)) return { actions: [{ type: 'status' }] };

  const neg = raw0.match(NEG);
  const raw = neg ? raw0.slice(neg[0].length).trim() : raw0;
  let aw = ctx.awaiting || null;
  // "아니 밤 9시"처럼 고쳐 주는 답이면 질문은 살려 둔다. 그 밖의 "아니 …"는 값 질문의 답이 아니다
  if (neg && aw && ['due', 'top3', 'tomorrow', 'out'].includes(aw.kind) && !(['due', 'tomorrow'].includes(aw.kind) && findTime(raw, ctx))) aw = null;
  if (neg && !raw) return ctx.awaiting || ctx.dose ? { actions: [{ type: 'cancel' }] } : null;
  const past = isPastStatement(raw, ctx);
  const pctx = { ...ctx, past: true };
  // 지난 시각: 없으면 0. 찾았는데 아직 안 온 시각이거나 오늘(새벽 기준) 전이면 -1 (그 말로는 기록하지 않는다)
  const pastAt = (early = false) => {
    const t = findTime(raw, { ...pctx, early });
    if (!t) return 0;
    if (t.at > ctx.now + 5 * MIN || t.at < C.dayStartTs(ctx.key, ctx.rollover ?? 4)) return -1;
    return t.at;
  };
  // 한 줄 메모·결과물·집중 메모를 기다리는 중이면 그 답이 먼저 (메모 안의 "일어났어"를 기상으로 잡지 않게)
  const freeAns = aw && ['note', 'out', 'fnote'].includes(aw.kind);

  // onlyAnswers: 비서가 물어본 질문의 답만 규칙으로 받는다 (두뇌 모드에서 나머지 말은 AI가 읽는다)
  const general = !ctx.onlyAnswers;

  // 일어난 시각: "10시 반에 일어났어"는 그 시각으로, "지금 일어난 건 아니고"는 몇 시였는지 묻는다
  // (답만 받는 모드에서도 기상 시각을 묻던 중이면 기상 말은 받는다)
  if ((general || ['wake_at', 'wake_confirm'].includes(aw?.kind)) && !freeAns && !/내일/.test(raw)) {
    if (WAKE_EARLIER.test(raw0) && !WAKE_NOT.test(raw) && !findTime(raw, pctx)) return { actions: [{ type: 'wake_ask' }] };
    if (WAKE_VERB.test(raw) && !WAKE_NOT.test(raw)) {
      const t = pastAt(true);
      if (t > 0) return { actions: [{ type: 'wake', at: t }] };
      if (t < 0) return null;
    }
  }
  // "몇 시에 일어났어요?"의 답: 시각과 군말만 있을 때 ("9시 회의"는 기상이 아니라 할 일)
  if (aw?.kind === 'wake_at') {
    const tt = findTime(raw, { ...pctx, early: true });
    const rest = tt ? raw.replace(tt.match, ' ').replace(WAKE_FILLER, '') : 'x';
    if (tt && !rest && tt.at <= ctx.now + 5 * MIN) return { actions: [{ type: 'wake', at: tt.at, fix: true }] };
  }
  // "기상을 HH:MM로 고칠까요?"의 답
  if (aw?.kind === 'wake_confirm' && aw.at && /^(?:(?:응|어|네|넵|예|맞아|ㅇㅇ|ㅇ|고쳐\s*줘?|그래|좋아|ok|오케이)[\s,.!~요]*)+$/i.test(raw)) return { actions: [{ type: 'wake', at: aw.at, fix: true }] };

  // 약: 약 이름(또는 "약")과 "먹었어"가 같이 있으면. 방금 약을 물어봤으면 "먹었어"만으로도.
  // 안/못 먹었거나, 먹었는지 모르거나, 남의 말이면 기록하지 않는다.
  // 한 줄 메모를 기다리는 중이면 약 이름이 분명할 때만 (메모 안의 "약"을 약으로 잡지 않게)
  if (MED_VERB.test(raw) && !NOT_TAKEN.test(raw) && !HEARSAY.test(raw)) {
    const doseItem = ctx.dose?.item || (aw?.kind === 'dose' ? aw.item : null) || null;
    // 이름이 여러 약에 걸리면: 방금 물어본 약 → 아직 안 먹은 약 → 하나뿐일 때만 그 약
    const hits = matchMeds(raw, ctx.meds);
    const taken = id => !!(ctx.meds || []).find(x => x.id === id)?.taken;
    const which = hits.includes(doseItem) ? doseItem : hits.find(id => !taken(id)) || (hits.length === 1 ? hits[0] : null);
    const generic = !freeAns && /(?<![가-힣])약(?![간속])[^\n]{0,8}(?:먹었|먹음|먹엇|복용했|복용함)/.test(raw);
    const dose = (ctx.dose || aw?.kind === 'dose') && bareDoseReply(raw, pctx);
    // 답만 받는 모드에선 방금 물어본 약에 대한 답일 때만
    const ok = general ? which || generic || dose : dose || (doseItem && (which === doseItem || (generic && !hits.length)));
    if (ok) {
      const at = pastAt();
      if (at < 0) return null;
      return { actions: [{ type: 'med', item: which || (dose ? doseItem : null), at }] };
    }
  }

  // 내가 방금 물어본 것에 대한 답
  if (aw) {
    if (aw.kind === 'note' && aw.item) return { actions: [{ type: 'note', item: aw.item, note: raw }] };
    // "결과물 한 줄"을 물었는데 "아직 못 했어"면 끝낸 게 아니다
    if (aw.kind === 'out' && aw.id && !NOT_DONE.test(raw)) return { actions: [{ type: 'top3_done', id: aw.id, out: raw }] };
    if (aw.kind === 'fnote' && aw.ev) return { actions: [{ type: 'focus_note', ev: aw.ev, key: aw.key, note: raw }] };
    // 지난 일을 말하는 문장의 시각은 마감 답이 아니다 ("3시 10분에 이미 먹었다고")
    if (aw.kind === 'due' && aw.id && !past) {
      const t = findTime(raw, ctx);
      if (t) return { actions: [{ type: 'top3_due', id: aw.id, due: t.at, n: aw.n || 0 }] };
    }
    // 오늘 결과물은 시각이 붙은 답만 규칙으로 ("배고파"가 할 일이 되지 않게). 시각 없는 답은 AI가 판단한다.
    // 밤에 묻는 "내일 첫 결과물"은 늦은 시각의 답이 대개 할 일이라 시각이 없어도 받는다
    if ((aw.kind === 'top3' || aw.kind === 'tomorrow') && !past && !/[?？]\s*$/.test(raw)) {
      const task = parseTask(raw, ctx, aw.kind === 'tomorrow');
      if (task && (task.due || aw.kind === 'tomorrow')) return { actions: [task] };
    }
  }

  if (!general) return null;
  if (/^(?:방금\s*|지금\s*)?(?:일어났|기상(?!청|특보|예보|정보)|깼어|깼다|깸|일어남)/.test(raw) && !WAKE_NOT.test(raw)) return { actions: [{ type: 'wake' }] };
  if (/(?:나왔|나갔|출발했|출발함|밖이야|밖임|집\s*밖)/.test(raw) && !/(?:안|못)\s*(?:나왔|나갔|나감|출발)|아직|나가야|나갈/.test(raw)) {
    const at = pastAt();
    if (at < 0) return null;
    return { actions: [{ type: 'out', at }] };
  }
  // 긴 말부터 맞춘다 ("끝냈어요"를 "끝" + "냈어요"로 자르지 않게). "끝이 안 보여", "다 했어?"는 끝이 아니다
  if (!/[?？]\s*$/.test(raw) && !NOT_DONE.test(raw) && (m = raw.match(/^(?:끝냈|끝났|해냈|다\s*했|완료|끝)(?:습니다|어요|어|음|다|함)?(?![이은을가의])[!.~]*\s*[:：,.\-]?\s*([\s\S]*)$/))) return { actions: [{ type: 'top3_done', id: null, out: m[1].trim() }] };

  // 시각이 붙은 할 일만 규칙으로 잡는다. 시각 없는 말과 지난 일은 AI가 판단한다
  if (past) return null;
  const task = parseTask(raw, ctx, false);
  if (task?.due) return { actions: [task] };
  return null;
}
