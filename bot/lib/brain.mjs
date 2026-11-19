// 비서의 두뇌에 넘길 것들: 최근 대화, 오늘 상태, 약 이름 가리기, 되돌리기.
// AI에게 가는 글은 여기서만 만든다. 약 이름·별명·용량은 "[아침 약]" 같은 이름표로 바꿔서 보낸다.
import * as C from '../../js/core.js';

const { MIN, HOUR } = C;
const fmt = C.fmtTime;
export const HISTORY_KEEP = 40; // 기기에 남기는 대화 수
export const HISTORY_SEND = 20; // AI에게 보내는 대화 수
export const HISTORY_HOURS = 12; // 이보다 오래된 대화는 보내지 않는다

// ----- 최근 대화 (미니 PC의 상태 파일에만 남는다) -----
// who: 'me' | 'bot'
export function remember(state, who, text, now) {
  const s = String(text || '')
    .replace(/<[^>]+>/g, '') // 브리핑 HTML은 글자만
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
  if (!s) return;
  state.history ||= [];
  state.history.push({ t: now, who, text: s.length > 400 ? `${s.slice(0, 400)}…` : s });
  if (state.history.length > HISTORY_KEEP) state.history.splice(0, state.history.length - HISTORY_KEEP);
}

export const recentHistory = (state, now) => (state.history || []).filter(h => now - h.t <= HISTORY_HOURS * HOUR).slice(-HISTORY_SEND);
export const formatHistory = hist => hist.map(h => `[${fmt(h.t)} ${h.who === 'me' ? '나' : '비서'}] ${h.text}`).join('\n');

// ----- 약 이름 가리기 -----
// meds: [{ id, name, words, block }]. 이름표는 먹는 때로 붙이고, 코드(M1…)로 행동을 주고받는다
const LABEL = { am: '아침 약', day: '낮 약', pm: '저녁 약', night: '자기 전 약' };
export function medMasks(meds = []) {
  const used = new Map();
  return meds.map((m, i) => {
    const base = LABEL[m.block] || '약';
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    // 숫자뿐인 말(용량 "10", "27mg")은 가릴 말로 쓰지 않는다 (시각과 날짜까지 가려지지 않게)
    const words = (m.words || []).map(x => String(x || '').trim()).filter(x => x.length >= 2 && !DOSE_ONLY.test(x));
    // 항목 이름은 약 이름·별명이 들어 있을 때만 통째로 가린다 ("아침 약"을 가리면 "아침 약속"까지 깨진다)
    const name = String(m.name || '').trim();
    const terms = words.some(w => name.includes(w)) ? [name, ...words] : words;
    return { id: m.id, code: `M${i + 1}`, label: n > 1 ? `${base} ${n}` : base, terms };
  });
}
const DOSE_ONLY = /^\d+(?:\.\d+)?(?:mg|밀리(?:그램)?)?$/i;

// 예전에 가렸던 말(이름을 바꾸거나 없앤 약)도 계속 가린다. past: { 말: 이름표 }
export function withPast(masks, past = {}) {
  const now = new Set(masks.flatMap(m => m.terms.map(t => t.toLowerCase())));
  const old = Object.entries(past).filter(([t]) => !now.has(t.toLowerCase()));
  const by = new Map();
  for (const [t, label] of old) by.set(label, [...(by.get(label) || []), t]);
  return [...masks, ...[...by].map(([label, terms]) => ({ id: null, code: '', label, terms }))];
}

// AI가 쓴 글 속의 이름표를 사용자가 쓴 말로 되돌린다 (기록에 "[낮 약] 처방전"이 남지 않게)
export function unmask(text, masks = [], message = '') {
  let s = String(text || '');
  const low = String(message).toLowerCase();
  for (const m of masks) {
    if (!s.includes(`[${m.label}]`)) continue;
    const used = [...m.terms].sort((a, b) => b.length - a.length).find(t => low.includes(t.toLowerCase()));
    s = s.split(`[${m.label}]`).join(used || m.label);
  }
  return s;
}

// 약 이름·별명을 이름표로 바꾸고, 이름표 바로 뒤의 용량 숫자도 지운다 ("알파정 18" → "[아침 약]")
const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function redact(text, masks = []) {
  let s = String(text || '');
  const labelOf = new Map();
  for (const m of masks) for (const t of m.terms) if (!labelOf.has(t.toLowerCase())) labelOf.set(t.toLowerCase(), m.label);
  if (labelOf.size) {
    // 한 번에 바꾼다 (바꾼 이름표 안을 다시 바꾸지 않게). 긴 이름부터 ("감마정"을 "감마"보다 먼저). 영문은 대소문자 무시
    const re = new RegExp([...labelOf.keys()].sort((a, b) => b.length - a.length).map(esc).join('|'), 'gi');
    s = s.replace(re, m => `⟦${labelOf.get(m.toLowerCase())}⟧`);
  }
  // 이름표 뒤의 숫자는 용량이라 지운다. 시각(3시, 15:10, 30분)은 남긴다
  s = s.replace(/⟦([^⟧]+)⟧\s*(?:\(\s*\d+(?:\.\d+)?\s*(?:mg|밀리)?\s*\)|\d+(?:\.\d+)?(?![\d.]|\s*(?:시|분|:))(?:\s*(?:mg|밀리))?)/gi, '⟦$1⟧');
  return s.replace(/⟦([^⟧]+)⟧/g, '[$1]');
}

// ----- 오늘 상태 (AI가 볼 한 장) -----
const AWAIT_TEXT = {
  note: a => `한 줄 메모 (${a.item})`,
  out: a => `끝낸 핵심 ${a.id}의 결과물 한 줄`,
  fnote: () => '방금 끝난 집중 시간에 한 일 한 줄',
  due: a => `핵심 ${a.id}의 마감 시각`,
  top3: () => '오늘 끝낼 결과물 하나와 마감',
  tomorrow: () => '내일 첫 결과물 하나와 마감',
  wake_at: () => '실제로 일어난 시각',
  wake_confirm: a => `기상을 ${fmt(a.at)}로 고칠지 (응/아니)`,
  why: a => `핵심 ${a.id} 마감을 미루는 이유 한 줄 (받으면 미룸)`,
};

// o: { now, key, rollover, day, items, masks, steps, routineOff, awaiting, dose, focus, calendar, paused, bond }
export function buildState(o) {
  const L = [];
  const day = o.day || {};
  L.push(`지금: ${C.fmtDate(o.key)} ${fmt(o.now)} (하루는 새벽 ${o.rollover}시에 바뀜)`);
  const w = C.wakeOf(day);
  L.push(`기상: ${w ? `${fmt(w)} (${day.wake?.auto ? '첫 기록으로 짐작한 시각' : '사용자가 남긴 시각'})` : '아직 기록 없음'}`);
  if (o.steps?.length) {
    const st = o.steps.map(s => `${s.text}${s.done ? ' ✓' : w && s.min != null ? ` (${fmt(w + s.min * MIN)}까지)` : ''}`);
    L.push(`아침 루틴${o.routineOff ? ' (오늘 알림 꺼짐)' : ''}: ${st.join(' / ')}`);
  }
  const t3 = C.top3Of(day);
  L.push(`오늘 핵심 (최대 3): ${t3.length ? t3.map(t => `${t.id} "${t.text}"${t.due ? ` ${fmt(t.due)} 마감` : ' 마감 없음'}${t.done ? ` · 끝남${t.out ? ` (결과물: ${t.out})` : ''}` : ''}`).join(' / ') : '없음'}`);
  if (o.bond) L.push(`약속: ${o.bond}`);
  const meds = (o.masks || []).map(m => {
    const it = (o.items || []).find(i => i.id === m.id);
    if (!it) return null;
    const st = C.itemState(day, it);
    const ds = C.doseState(it, day, { now: o.now, rollover: o.rollover });
    return `${m.code} ${m.label}: ${st.count ? `${fmt(st.evs[0].t)}에 먹음` : st.skipped ? '오늘 건너뜀' : ds.due ? `${fmt(ds.due)} 예정, 아직` : '아직'}`;
  });
  L.push(`약: ${meds.filter(Boolean).join(' / ') || '없음'}`);
  const others = (o.items || []).filter(i => i.cat !== 'med');
  if (others.length) L.push(`기록할 수 있는 항목: ${others.map(i => { const n = C.itemState(day, i).count; return `${i.id}(${i.name}${n ? `, 오늘 ${n}번` : ''})`; }).join(', ')}`);
  const fx = C.live(day).filter(e => e.item === 'focus').reduce((a, e) => a + (e.min || 0), 0);
  L.push(`집중: ${o.focus ? `${o.focus.dur}분 타이머 진행 중 (${fmt(o.focus.start + o.focus.dur * MIN)}에 끝)` : '타이머 없음'}${fx ? ` · 오늘 합계 ${fx}분` : ''}`);
  if (o.awaiting && AWAIT_TEXT[o.awaiting.kind]) L.push(`비서가 기다리는 답: ${AWAIT_TEXT[o.awaiting.kind](o.awaiting)}`);
  const dm = o.dose && (o.masks || []).find(m => m.id === o.dose.item);
  if (dm) L.push(`비서가 방금 먹었는지 물어본 약: ${dm.code} ${dm.label}`);
  const cal = o.calendar?.upcoming || [];
  if (cal.length) L.push(`다가오는 일정: ${cal.slice(0, 3).map(e => `${fmt(e.start)} ${e.summary}`).join(' / ')}`);
  if (o.lastUndo && o.now - o.lastUndo.at < 10 * MIN) L.push(`되돌릴 수 있는 마지막 기록: ${o.lastUndo.what} (${Math.max(0, Math.round((o.now - o.lastUndo.at) / MIN))}분 전)`);
  else L.push('되돌릴 수 있는 최근 기록: 없음');
  if (o.paused) L.push('오늘 비서가 먼저 말 걸기: 꺼짐');
  return L.join('\n');
}

// AI에게 보낼 글 전체: 오늘 상태 + 최근 대화 + 새 메시지. 마지막에 한 번에 약 이름을 가린다
export function buildPrompt({ stateText, history, message, now, masks, memory = '' }) {
  const parts = [];
  if (memory) parts.push(memory); // 나에 대해, 기억하는 사실, 어제 일지 (거의 안 바뀌는 것부터)
  parts.push(`## 오늘 상태\n${stateText}`);
  if (history?.length) parts.push(`## 최근 대화 (오래된 것부터)\n${formatHistory(history)}`);
  // 새 메시지는 가린 뒤에 자른다 (자른 자리에서 약 이름이 반쯤 남지 않게)
  parts.push(`## 새 메시지\n[${fmt(now)} 나] ${redact(message, masks).slice(0, 500)}`);
  return redact(parts.join('\n\n'), masks);
}

// ----- 되돌리기 -----
// 행동을 반영하기 전의 하루를 복사해 두고, "되돌려"라고 하면 그 모습으로 돌린다.
// 저장소 함수로만 바꿔서 폰과의 동기화(m)가 그대로 따라간다
export const snapshot = day => JSON.parse(JSON.stringify({ wake: day?.wake || null, events: day?.events || [], top3: day?.top3 || [], skips: day?.skips || [] }));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const strip = o => {
  if (!o) return o;
  const { m, ...rest } = o;
  return rest;
};

export function changed(before, day) {
  const now = snapshot(day);
  return !same(strip(before.wake), strip(now.wake)) || !same(before.events.map(strip), now.events.map(strip)) || !same(before.top3.map(strip), now.top3.map(strip)) || !same(before.skips.map(strip), now.skips.map(strip));
}

// 그 행동이 바꾼 것(before → after)만 되돌린다. 그 뒤에 폰에서 남기거나 다시 고친 기록은 건드리지 않는다
export function revert(store, key, before, after) {
  const day = store.day(key);
  let n = 0;
  const bEv = new Map(before.events.map(e => [e.id, e]));
  const aEv = new Map(after.events.map(e => [e.id, e]));
  for (const e of day.events || []) {
    const a = aEv.get(e.id);
    const b = bEv.get(e.id);
    if (!a || same(strip(a), strip(b)) || !same(strip(e), strip(a))) continue;
    if (!b) {
      if (!e.del) {
        store.deleteEvent(key, e.id);
        n++;
      }
      continue;
    }
    const patch = {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(e)])) if (k !== 'm' && k !== 'id' && !same(b[k], e[k])) patch[k] = b[k];
    store.updateEvent(key, e.id, patch);
    n++;
  }
  if (!same(strip(before.wake), strip(after.wake)) && same(strip(day.wake), strip(after.wake))) {
    store.setWake(key, before.wake?.t || 0, !!before.wake?.auto);
    n++;
  }
  const find = (list, id) => (list || []).find(x => x.id === id);
  for (const id of new Set([...before.top3, ...after.top3].map(t => t.id))) {
    const b = find(before.top3, id), a = find(after.top3, id);
    if (same(strip(b), strip(a)) || !same(strip(find(day.top3, id)), strip(a))) continue;
    store.setTop3(key, id, b ? { text: b.text || '', due: b.due || 0, done: b.done || 0, out: b.out || '', ...(b.to ? { to: b.to } : {}) } : { text: '', due: 0, done: 0, out: '' });
    n++;
  }
  for (const id of new Set([...before.skips, ...after.skips].map(s => s.id))) {
    const b = find(before.skips, id), a = find(after.skips, id);
    if (same(strip(b), strip(a)) || !same(strip(find(day.skips, id)), strip(a))) continue;
    store.setSkip(key, id, !!b?.on, b?.why, b?.note);
    n++;
  }
  return n;
}

// ----- 위기 신호: AI 없이 정해진 글로 답한다 -----
const CRISIS = /죽고\s*싶|자살|자해|사라지고\s*싶|없어지고\s*싶|살기\s*싫|살고\s*싶지\s*않|그만\s*살고\s*싶|뒤지고\s*싶|죽어\s*버리|죽어\s*버릴|목숨\s*끊|극단적\s*선택|생을\s*마감/;
export const isCrisis = text => CRISIS.test(String(text || ''));
export const CRISIS_REPLY = [
  '지금 많이 힘들군요. 혼자 견디지 않아도 돼요.',
  '· 자살예방 상담전화 109 (24시간, 전화·문자)',
  '· 지금 위험하면 119',
  '믿을 만한 사람 한 명에게 "지금 얘기 좀 할 수 있어?"라고 보내 보는 것도 좋아요. 오늘 할 일 알림은 잠시 쉴게요. 다시 받으려면 /resume',
].join('\n');
