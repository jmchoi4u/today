// 규칙으로 못 알아들은 말만 AI에게 묻는다. AI는 정해진 행동 목록(JSON) 안에서만 답할 수 있고,
// 답은 여기서 한 번 더 검사한다. 약 이름·건강 메모 같은 건 보내지 않는다 (항목 이름과 오늘 할 일만).
import { geminiJSON } from './llm-gemini.mjs';

export const ACTION_TYPES = ['top3_set', 'top3_done', 'log', 'park', 'wake', 'out', 'status', 'none'];

// 두 회사 모두 받는 단순한 모양: 모든 칸을 문자열로 두고, 안 쓰는 칸은 빈 문자열
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
        required: ['type', 'text', 'due', 'item', 'id'],
        properties: {
          type: { type: 'string', enum: ACTION_TYPES },
          text: { type: 'string' },
          due: { type: 'string' },
          item: { type: 'string' },
          id: { type: 'string' },
        },
      },
    },
    reply: { type: 'string' },
  },
};

export function systemPrompt() {
  return [
    '너는 사용자의 하루 기록 비서다. 사용자가 텔레그램으로 보낸 짧은 한국어 메시지를 아래 행동으로 바꾼다.',
    '행동 (type):',
    '- top3_set: 오늘 꼭 끝낼 일을 정한다. text=할 일(짧게), due=마감 "HH:MM"(24시간, 없으면 "")',
    '- top3_done: 할 일을 끝냈다. id=끝낸 할 일의 id (어느 일인지 모르면 이 행동을 넣지 말고 reply로 되묻는다), text=결과물 한 줄(없으면 "")',
    '- log: 항목 하나를 기록한다. item=항목 id (목록에 있는 것만), text=메모(없으면 "")',
    '- park: 걱정·비교·새 아이디어를 주차장에 적는다. text=그 내용',
    '- wake: 지금 일어났다. out: 지금 집 밖으로 나왔다. status: 오늘 상태를 묻는다.',
    '- none: 기록할 게 없다 (인사, 잡담, 질문)',
    '규칙: 확실할 때만 행동을 넣는다. 애매하면 actions는 비우고 reply로 짧게 되묻는다.',
    'reply는 해요체 한두 문장. 칭찬은 짧게, 다음 할 일 하나를 말한다. 의학적 판단(약 용량·시간 바꾸기)은 하지 않는다.',
    '쓰지 않는 칸은 빈 문자열 "".',
  ].join('\n');
}

export function userPrompt(text, ctx) {
  const items = (ctx.items || []).map(i => `${i.id}: ${i.name}`).join(', ');
  const top3 = (ctx.top3 || []).map(t => `${t.id}: ${t.text}${t.due ? ` (마감 ${t.due})` : ''}${t.done ? ' (끝남)' : ''}`).join(', ') || '없음';
  return `지금: ${ctx.nowText}\n기록할 수 있는 항목: ${items || '없음'}\n오늘 할 일: ${top3}\n\n메시지: ${String(text).slice(0, 500)}`;
}

// AI 답을 믿지 않고 한 번 더 거른다
export function validate(out, ctx) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.actions)) return null;
  const items = new Set((ctx.items || []).map(i => i.id));
  const top3 = new Set((ctx.top3 || []).map(t => t.id));
  const s = v => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
  const actions = [];
  for (const a of out.actions.slice(0, 10)) {
    if (!a || !ACTION_TYPES.includes(a.type)) continue;
    if (a.type === 'top3_set' && s(a.text)) actions.push({ type: 'top3_set', text: s(a.text).slice(0, 40), dueText: /^\d{1,2}:\d{2}$/.test(s(a.due)) ? s(a.due) : '' });
    else if (a.type === 'top3_done') {
      // 어느 일인지 확실할 때만 끝낸다 (id가 맞거나, 안 끝난 일이 하나뿐일 때). 아니면 버리고 되묻게 둔다
      const open = (ctx.top3 || []).filter(t => !t.done);
      const id = top3.has(s(a.id)) ? s(a.id) : open.length === 1 ? open[0].id : null;
      if (id) actions.push({ type: 'top3_done', id, out: s(a.text) });
    }
    else if (a.type === 'log' && items.has(s(a.item))) actions.push({ type: 'note', item: s(a.item), note: s(a.text) });
    else if (a.type === 'park' && s(a.text)) actions.push({ type: 'park', note: s(a.text) });
    else if (['wake', 'out', 'status'].includes(a.type)) actions.push({ type: a.type });
  }
  // 한 메시지로 하는 일은 셋까지 (검사를 통과한 것 중에서)
  return { actions: actions.slice(0, 3), reply: s(out.reply) };
}

// provider: gemini | claude | none
export function createLLM({ provider, geminiKey, geminiModel, claudeKey, claudeModel, fetchFn = globalThis.fetch, maxPerDay = 150 }) {
  const p = String(provider || '').toLowerCase();
  if (p === 'gemini' && !geminiKey) return null;
  if (p === 'claude' && !claudeKey) return null;
  if (!['gemini', 'claude'].includes(p)) return null;
  let claude = null;
  const used = new Map(); // 날짜 → 횟수 (하루 한도)
  return {
    provider: p,
    async parse(text, ctx) {
      const day = ctx.key || 'x';
      if ((used.get(day) || 0) >= maxPerDay) throw new Error('오늘 AI 사용 한도를 다 썼어요');
      used.set(day, (used.get(day) || 0) + 1);
      for (const k of used.keys()) if (k !== day) used.delete(k);
      const args = { system: systemPrompt(), user: userPrompt(text, ctx), schema: SCHEMA };
      let raw;
      if (p === 'gemini') raw = await geminiJSON({ apiKey: geminiKey, model: geminiModel, fetchFn, ...args });
      else {
        claude ||= await import('./llm-claude.mjs');
        raw = await claude.claudeJSON({ apiKey: claudeKey, model: claudeModel, ...args });
      }
      return validate(raw, ctx);
    },
  };
}
