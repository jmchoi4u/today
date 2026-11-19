// AI에게 말을 묻는다. AI는 정해진 행동 목록(JSON) 안에서만 답할 수 있고, 답은 여기서 한 번 더 검사한다.
// 두 가지 모드:
//  - full: 모든 말을 AI가 먼저 읽는다. 오늘 상태와 최근 대화를 같이 보낸다 (약 이름은 brain.mjs에서 가린다).
//          데이터를 학습에 쓰지 않는 유료 API(Claude)에서만 켠다.
//  - 기본: 규칙으로 못 알아들은 말만 묻는다. 메시지와 약이 아닌 항목 이름, 오늘 핵심만 보낸다.
import * as C from '../../js/core.js';
import { geminiJSON } from './llm-gemini.mjs';

const { MIN } = C;

export const ACTION_TYPES = ['top3_set', 'top3_due', 'top3_done', 'log', 'med', 'wake', 'out', 'park', 'focus_start', 'focus_stop', 'routine_off', 'routine_on', 'undo', 'cancel', 'status', 'none'];

// 두 회사 모두 받는 단순한 모양: 모든 칸을 문자열로 두고, 안 쓰는 칸은 빈 문자열
const FIELDS = ['type', 'text', 'time', 'item', 'id', 'min', 'day'];
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['actions', 'reply'],
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: FIELDS,
        properties: {
          type: { type: 'string', enum: ACTION_TYPES },
          text: { type: 'string' },
          time: { type: 'string' },
          item: { type: 'string' },
          id: { type: 'string' },
          min: { type: 'string' },
          day: { type: 'string' },
        },
      },
    },
    reply: { type: 'string' },
  },
};

const MED_DOC = '- med: 약을 먹었다. item=약 코드(M1 같은 것), time=먹은 시각 "HH:MM"(지금이면 ""). 안 먹었거나, 먹었는지 모르거나, 다른 날 이야기면 넣지 않는다';
const NO_MED_DOC = '- 약 기록은 여기서 하지 못한다. 약 이야기면 actions를 비우고 "약 먹었어"처럼 보내 달라고 답한다';
const actionsDoc = full => [
  '행동 (type). 쓰지 않는 칸은 빈 문자열 "":',
  '- top3_set: 끝낼 일을 정한다. text=할 일(짧게), time=마감 "HH:MM"(24시간, 없으면 ""), day="today" 또는 "tomorrow"',
  '- top3_due: 이미 있는 핵심(id)의 마감을 정한다. id, time="HH:MM"',
  '- top3_done: 핵심을 끝냈다. id=그 핵심의 id, text=결과물 한 줄(없으면 ""). 어느 일인지 모르면 넣지 말고 되묻는다',
  '- log: 항목 하나를 기록한다 (약 제외). item=항목 id (목록에 있는 것만), text=메모, time=그때 한 일이면 "HH:MM", 지금이면 ""',
  full ? MED_DOC : NO_MED_DOC,
  '- wake: 사용자가 일어났다. time=일어난 시각 "HH:MM"(지금 막 일어났으면 ""). 다른 사람·알람·다시 잠든 이야기면 넣지 않는다. 이미 남긴 기상 시각이 틀렸다고 하면 undo가 아니라 wake에 맞는 시각을 넣고, 시각을 모르면 되묻는다',
  '- out: 집 밖으로 나왔다. time=나온 시각(지금이면 "")',
  '- park: 걱정·비교·새 아이디어를 주차장에 적는다. text=그 내용',
  '- focus_start: 집중 타이머 시작. min=분(숫자 글자, 예 "25"). focus_stop: 타이머를 멈춘다',
  '- routine_off / routine_on: 오늘 아침 루틴 알림을 끄거나 다시 켠다',
  !full ? '' : '- undo: 비서가 바로 앞에서 남긴 기록을 되돌린다. 사용자가 그 기록을 지워 달라고 분명히 말했을 때만 ("방금 기록 지워 줘"). 의견이 다르다는 말("그거 아니야")만으로는 넣지 않는다',
  '- cancel: 비서가 기다리던 질문을 그만 묻는다',
  '- status: 오늘 상태를 보여 준다',
  '- none: 기록할 게 없다 (인사, 잡담, 질문, 고민 이야기)',
].filter(Boolean).join('\n');

const STYLE = [
  '답(reply) 쓰는 법:',
  '- 해요체 한두 문장. 기록했다는 확인 문구("기록했어요" 등)는 비서가 따로 붙이니 쓰지 않는다. 덧붙일 말이 없으면 "".',
  '- 맞장구나 칭찬을 늘어놓지 않는다. 칭찬은 한 번, 구체적으로. 사실과 다르면 부드럽게 바로잡는다.',
  '- 죄책감을 주지 않는다. 미룬 일·놓친 일은 "뭐가 걸렸어요?"처럼 묻고, 다음 걸음을 2분짜리로 줄여 준다.',
  '- "하기 싫어" 같은 말에는 마음을 한 줄로 받아 주고 열린 질문 하나만 한다. 조언은 물어본 뒤에, 고를 것은 둘까지.',
  '- "오늘은 안 할래"는 존중한다. 설득하지 않는다.',
  '- 약의 용량·시간을 바꾸라고 하지 않는다. 의학적 판단은 의사에게 묻도록 한다. 약 이름을 짐작해 쓰지 않는다 (코드와 이름표만).',
].join('\n');

// 두뇌 모드의 말하는 법: 기록기가 아니라 말이 통하는 비서
const TALK = [
  '답(reply) 쓰는 법:',
  '- 모든 메시지에 사람처럼 답한다. 한 번에 1~3문장, 이모지는 많아야 하나.',
  '- 기록할 게 있으면 actions에 넣는다. "기록했어요" 같은 확인 문구는 비서 프로그램이 따로 붙이니 쓰지 않는다. reply에는 그다음 한마디를 쓴다: 짧은 반응 하나, 그리고 오늘 상태를 보고 고른 다음 한 걸음이나 질문 하나. 정말 덧붙일 게 없을 때만 "".',
  '- 잡담·고민·질문에는 대화로 답한다. 먼저 그 말을 한 줄로 받아 주고, 도움이 될 것 하나만 건넨다 (2분짜리 첫 동작, 둘 중 고르기, 열린 질문 하나 가운데서).',
  '- "뭐 하지", "막막해", "시작이 안 돼" 같은 말 → 오늘 핵심 중 하나를 골라 (없으면 하나 정하자고 하고) 첫 2분 동작을 말해 주고, 25분 타이머를 켤지 묻는다. 좋다고 하면 focus_start를 넣는다.',
  '- 걱정·비교·새 아이디어가 이어지면 → 한 줄로 받아 주고 주차장에 넣자고 한다 (park). 길게 같이 파고들지 않는다.',
  '- "오늘 상태"와 기억에 있는 사실만 말한다. 없는 일정·기록을 지어내지 않는다. 모르면 모른다고 한다.',
  '- actions에 넣지 않은 것을 "적어 둘게요", "확인했어요", "기억할게요"라고 말하지 않는다. 내일 할 일이나 약속을 말하면 top3_set(day="tomorrow")으로 넣거나, 넣을지 묻는다.',
  '- 최근 대화에서 비서가 방금 한 말을 되풀이하지 않는다. 같은 권유를 두 번 하지 않는다.',
  '- 알림 시각·항목 같은 설정은 이 대화로 바꾸지 못한다. 항목과 예정 시각은 앱 설정 탭에서, 기상 확인 시각과 조용한 시간은 비서 PC의 설정 파일에서 바꾼다고 알려 준다.',
  '- 맞장구나 칭찬을 늘어놓지 않는다. 칭찬은 한 번, 구체적으로. 사실과 다르면 부드럽게 바로잡는다.',
  '- 죄책감을 주지 않는다. 미룬 일·놓친 일은 "뭐가 걸렸어요?"처럼 묻고, 다음 걸음을 2분짜리로 줄여 준다.',
  '- "오늘은 안 할래"는 존중한다. 설득하지 않는다.',
  '- 약의 용량·시간을 바꾸라고 하지 않는다. 의학적 판단은 의사에게 묻도록 한다. 약 이름을 짐작해 쓰지 않는다 (코드와 이름표만).',
].join('\n');

// 비서의 성격. 비공개 설정(game.json의 secretary { name, call, tone })에서 온다. 없으면 이름 없는 기본 성격
const one = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
export function personaText(p) {
  const name = one(p?.name, 20);
  const call = one(p?.call, 20);
  const tone = one(p?.tone, 300) || '밝고 다정한 해요체. 가볍게 농담도 하지만 선을 지키는 프로답다. 짧게 말한다.';
  return [
    `너는 ${name ? `"${name}"라는 이름의 ` : ''}개인 비서다. 사용자의 하루를 옆에서 같이 챙긴다. 기록기가 아니라 말이 통하는 사람처럼 군다.`,
    call ? `사용자를 부를 때의 호칭: "${call}". 호칭은 서너 번에 한 번쯤만 붙인다. 대부분의 답에는 호칭이 없다.` : '',
    `말투: ${tone}`,
  ].filter(Boolean).join('\n');
}

export function systemPrompt(full = false, persona = null) {
  const head = full
    ? [
        personaText(persona),
        '사용자는 텔레그램으로 짧은 한국어를 보낸다.',
        '"오늘 상태"와 "최근 대화"를 보고 새 메시지의 뜻을 알아낸 뒤, 필요한 행동과 답을 JSON으로 낸다.',
        '최근 대화에서 비서가 방금 물어본 것이 있으면 새 메시지는 대개 그 답이다. "(버튼)"은 사용자가 누른 버튼이다.',
        '시각은 "HH:MM" 24시간으로 쓴다. 오전/오후가 없으면 문맥(지금 시각, 지난 일인지 앞으로의 일인지)으로 고른다.',
        '확실할 때만 행동을 넣는다. 애매하면 actions는 비우고 reply로 짧게 되묻는다. 한 메시지에 행동은 셋까지.',
      ]
    : [
        '너는 사용자의 하루 기록 비서다. 사용자가 텔레그램으로 보낸 짧은 한국어 메시지를 아래 행동으로 바꾼다.',
        '확실할 때만 행동을 넣는다. 애매하면 actions는 비우고 reply로 짧게 되묻는다.',
      ];
  return [...head, actionsDoc(full), full ? TALK : STYLE].join('\n\n');
}

// 기본 모드의 질문: 메시지와 최소한의 목록만
export function userPrompt(text, ctx) {
  if (ctx.prompt) return ctx.prompt; // full 모드: brain.mjs가 만든 글 (약 이름은 이미 가려짐)
  const items = (ctx.items || []).map(i => `${i.id}: ${i.name}`).join(', ');
  const top3 = (ctx.top3 || []).map(t => `${t.id}: ${t.text}${t.due ? ` (마감 ${t.due})` : ''}${t.done ? ' (끝남)' : ''}`).join(', ') || '없음';
  return `지금: ${ctx.nowText}\n기록할 수 있는 항목: ${items || '없음'}\n오늘 할 일: ${top3}\n\n메시지: ${String(text).slice(0, 500)}`;
}

// AI 답을 믿지 않고 한 번 더 거른다.
// ctx: { now, key, rollover, items: [{id,name}] (약 제외), top3: [{id,...}], masks: [{code,id}] }
export function validate(out, ctx) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.actions)) return null;
  const items = new Set((ctx.items || []).map(i => i.id));
  const top3 = new Set((ctx.top3 || []).map(t => t.id));
  const medOf = new Map((ctx.masks || []).map(m => [m.code, m.id]));
  const s = v => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  const R = ctx.rollover ?? 4;
  const hhmm = v => (/^\d{1,2}:\d{2}$/.test(s(v)) && +s(v).split(':')[0] < 24 && +s(v).split(':')[1] < 60 ? s(v).padStart(5, '0') : '');
  // 지난 시각: 없으면 0, 오늘(새벽 기준) 안의 지난 시각이면 그 시각, 아직 안 왔거나 오늘 전이면 -1 (그 행동은 버린다)
  const pastTs = v => {
    if (v == null || (typeof v === 'string' && !v.trim())) return 0;
    const h = hhmm(typeof v === 'string' ? v.trim().replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1') : v);
    if (!h) return -1; // 시각을 썼는데 읽을 수 없으면 "지금"으로 바꾸지 않고 버린다
    if (!ctx.key || !ctx.now) return 0;
    const t = C.tsFor(ctx.key, h, R);
    return t <= ctx.now + 5 * MIN && t >= C.dayStartTs(ctx.key, R) ? t : -1;
  };
  const actions = [];
  let dropped = 0;
  const full = !!ctx.prompt; // 오늘 상태와 대화를 본 답인지
  for (const a of out.actions.slice(0, 10)) {
    const n = actions.length;
    if (a?.type !== 'none') dropped++; // 아래에서 받아들이면 다시 뺀다
    if (!a || !ACTION_TYPES.includes(a.type)) continue;
    if (a.type === 'top3_set' && s(a.text)) {
      const k = s(a.day) === 'tomorrow' && ctx.key ? C.addDays(ctx.key, 1) : ctx.key;
      const h = hhmm(a.time);
      // AI의 "HH:MM"은 24시간 표기라 그대로 그날의 시각으로 쓴다 ("02:00"을 오후 2시로 읽지 않게)
      actions.push({ type: 'top3_set', text: s(a.text).slice(0, 40), dueText: h, ...(h && k ? { due: C.tsFor(k, h, R) } : {}), ...(k && k !== ctx.key ? { key: k } : {}) });
    } else if (a.type === 'top3_due' && top3.has(s(a.id)) && hhmm(a.time) && ctx.key) {
      actions.push({ type: 'top3_due', id: s(a.id), due: C.tsFor(ctx.key, hhmm(a.time), R) });
    } else if (a.type === 'top3_done') {
      // 어느 일인지 확실할 때만 끝낸다 (id가 맞거나, 안 끝난 일이 하나뿐일 때). 아니면 버리고 되묻게 둔다
      const open = (ctx.top3 || []).filter(t => !t.done);
      const id = top3.has(s(a.id)) ? s(a.id) : open.length === 1 ? open[0].id : null;
      if (id) actions.push({ type: 'top3_done', id, out: s(a.text) });
    } else if (a.type === 'log' && items.has(s(a.item))) {
      const at = pastTs(a.time);
      if (at >= 0) actions.push({ type: 'note', item: s(a.item), note: s(a.text), at });
    } else if (a.type === 'med' && medOf.has(s(a.item))) {
      const at = pastTs(a.time);
      if (at >= 0) actions.push({ type: 'med', item: medOf.get(s(a.item)), at });
    } else if (a.type === 'wake') {
      const at = pastTs(a.time);
      // AI가 문맥을 보고 사용자 본인의 기상을 고친 것이라 따로 묻지 않는다
      if (at > 0) actions.push({ type: 'wake', at, ...(full ? { fix: true } : {}) });
      else if (at === 0) actions.push({ type: 'wake' });
    } else if (a.type === 'out') {
      const at = pastTs(a.time);
      if (at >= 0) actions.push({ type: 'out', at });
    } else if (a.type === 'park' && s(a.text)) actions.push({ type: 'park', note: s(a.text) });
    else if (a.type === 'focus_start') actions.push({ type: 'focus_start', min: Math.max(1, Math.min(180, parseInt(s(a.min), 10) || 25)) });
    else if (a.type === 'routine_off' || a.type === 'routine_on') actions.push({ type: 'routine', on: a.type === 'routine_on' });
    else if (a.type === 'undo') actions.push({ type: 'undo', recent: true });
    else if (['focus_stop', 'cancel', 'status'].includes(a.type)) actions.push({ type: a.type });
    if (actions.length > n) dropped--;
  }
  // 한 메시지로 하는 일은 셋까지 (검사를 통과한 것 중에서)
  // dropped: AI가 하려던 행동 중 검사에서 버린 수 (부르는 쪽이 규칙으로 다시 풀어 본다)
  return { actions: actions.slice(0, 3), reply: typeof out.reply === 'string' ? out.reply.trim().slice(0, 500) : '', dropped };
}

// provider: gemini | claude | none
// full: 오늘 상태·최근 대화까지 보내는 모드 (학습에 쓰지 않는 유료 API에서만)
export function createLLM({ provider, geminiKey, geminiModel, claudeKey, claudeModel, fetchFn = globalThis.fetch, maxPerDay = 150, full = false }) {
  const p = String(provider || '').toLowerCase();
  if (p === 'gemini' && !geminiKey) return null;
  if (p === 'claude' && !claudeKey) return null;
  if (!['gemini', 'claude'].includes(p)) return null;
  let claude = null;
  const cm = claudeModel || 'claude-haiku-5-5'; // 이 비서의 사용자가 고른 모델
  const used = new Map(); // 날짜 → 횟수 (하루 한도)
  async function call(key, args) {
    const day = key || 'x';
    if ((used.get(day) || 0) >= maxPerDay) throw new Error('오늘 AI 사용 한도를 다 썼어요');
    used.set(day, (used.get(day) || 0) + 1);
    for (const k of used.keys()) if (k !== day) used.delete(k);
    if (p === 'gemini') return geminiJSON({ apiKey: geminiKey, model: geminiModel, fetchFn, ...args });
    if (!claude) {
      try {
        claude = await import('./llm-claude.mjs');
      } catch {
        throw new Error('Claude 연결 파일이 아직 없어요 (미니 PC에서 install.cmd를 다시 실행하면 깔려요)');
      }
    }
    return claude.claudeJSON({ apiKey: claudeKey, model: cm, ...args });
  }
  return {
    provider: p,
    model: p === 'claude' ? cm : geminiModel || 'gemini-flash-latest',
    full: !!full,
    async parse(text, ctx) {
      return validate(await call(ctx.key, { system: systemPrompt(!!ctx.prompt, ctx.persona), user: userPrompt(text, ctx), schema: SCHEMA }), ctx);
    },
    // 정해진 모양(schema)의 JSON 답을 받는다 (밤 정리 등). 검사는 부르는 쪽에서
    json: (key, system, user, schema) => call(key, { system, user, schema }),
  };
}
