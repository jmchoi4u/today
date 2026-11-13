// 화면. 상태는 store가 갖고, 여기서는 그리기와 입력 처리만 한다.
import * as C from './core.js';
import { createStore } from './store.js';
import { createSync } from './sync.js';
import { stripSvg, flowSvg } from './chart.js';

const VERSION = '1.0';
const { MIN, HOUR } = C;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = createStore({ storage: window.localStorage });
const now = () => Date.now();
const cfg = () => store.config();
const local = () => store.local();
const rollover = () => cfg().prefs?.rollover ?? 4;
const todayKey = () => C.dayKey(now(), rollover());
const ui = { tab: 'today', date: null, just: null };
const viewKey = () => ui.date || todayKey();
const isToday = () => viewKey() === todayKey();
const getDay = k => (store.hasDay(k) ? store.day(k) : null);
const sync = createSync({ store, fetchFn: (u, o) => fetch(u, o), online: () => navigator.onLine, todayKey, onStatus: () => render() });

const IC = {
  check: '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  left: '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  up: '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M5 15l7-7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  x: '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const MOCHI = '<svg viewBox="0 0 32 32" class="mochi-face" aria-hidden="true"><circle cx="16" cy="17.5" r="12.5" class="kn-body"/><path d="M15 5.2c-1-3 1-4.6 3.3-3.9" class="kn-line"/><circle cx="12" cy="16.5" r="3.7" class="kn-gl"/><circle cx="20" cy="16.5" r="3.7" class="kn-gl"/><circle cx="12" cy="16.5" r="1.4" class="kn-eye"/><circle cx="20" cy="16.5" r="1.4" class="kn-eye"/><path d="M14.3 21.5q1.7 1.3 3.4 0" class="kn-line"/></svg>';
const SCORE = ['', '😣', '😕', '😐', '🙂', '😄'];
const PORTION = ['', '가볍게', '보통', '든든하게'];
const EMOJIS = ['💊', '🟡', '💧', '☕', '🍚', '🥗', '🏃', '🏋️', '🧘', '🚶', '🧩', '📨', '📖', '🧹', '🚿', '🌙', '⚖️', '🦷', '☀️', '⭐'];
const WEEKDAY = '일월화수목금토';

const itemById = id => cfg().items.find(i => i.id === id);
const nameOf = id => itemById(id) || C.SPECIAL[id] || { name: '삭제된 항목', icon: '▫️' };
const season = () => C.seasonInfo(todayKey(), cfg().prefs?.seasonStart);
const haptic = p => {
  try {
    navigator.vibrate?.(p ?? 10);
  } catch {
    /* 진동이 없는 기기 */
  }
};

// 누적 목표·주간 통계가 쓰는 전체 기록. 데이터가 바뀔 때만 다시 읽는다.
let ver = 0, memo = { ver: -1, days: [] };
function allDays() {
  if (memo.ver !== ver) memo = { ver, days: store.dayKeys().map(k => store.day(k)) };
  return memo.days;
}

// ---------- 공통 조각 ----------

const win = (title, tag, body, cls = '', right = '') =>
  `<section class="win ${cls}"><div class="win-head"><h2>${title}</h2>${right}<span class="win-tag">${tag}</span></div><div class="win-body">${body}</div></section>`;
const mini = (k, v, unit = '') => `<div class="mini"><div class="mini-k">${k}</div><div class="mini-v"><b>${v}</b>${unit}</div></div>`;

function evDetail(e, it) {
  const b = [];
  if (e.item === 'energy' || e.item === 'mood') b.push(`${e.v}/5`);
  else {
    if (e.min) b.push(C.fmtDur(e.min));
    if (it.ask === 'num' && e.v != null) b.push(`${e.v}${it.unit || ''}`);
    if (it.cat === 'meal' && e.v) b.push(PORTION[e.v]);
    if (e.note) b.push(e.note);
  }
  if (e.place) b.push('📍' + e.place);
  return b.join(' · ');
}

function syncClass() {
  const s = sync.status();
  if (!local().gh) return 'off';
  if (s.state === 'syncing') return 'busy';
  if (s.state === 'error') return 'err';
  if (s.state === 'offline' || !navigator.onLine) return 'offline';
  return local().dirty.length ? 'dirty' : 'ok';
}
function syncLine() {
  const s = sync.status(), l = local();
  if (!l.gh) return '기록은 이 기기에만 있어요';
  if (s.state === 'syncing') return '동기화 중…';
  if (s.state === 'error') return s.msg;
  if (s.state === 'offline' || !navigator.onLine) return '오프라인이에요. 연결되면 자동으로 올려요';
  return (l.dirty.length ? `올릴 변경 ${l.dirty.length}개 · ` : '') + (l.lastSync ? `마지막 동기화 ${C.fmtTime(l.lastSync)}` : '아직 동기화 전이에요');
}

// ---------- 머리와 HUD ----------

function topHtml() {
  const key = viewKey(), day = store.day(key), today = isToday(), w = C.wakeOf(day);
  let sub = '오늘';
  if (today && w && now() > w) sub = `오늘 · 깨어난 지 ${C.fmtDur((now() - w) / MIN)}`;
  if (!today) {
    const n = Math.round((C.keyToDate(todayKey()) - C.keyToDate(key)) / 86400000);
    sub = `${n === 1 ? '어제' : n + '일 전'} · 누르면 오늘로`;
  }
  return `<button class="nav-btn" data-act="day-prev" aria-label="이전 날">${IC.left}</button>
    <button class="date" data-act="day-today"><span class="date-main">${C.fmtDate(key)}</span><span class="date-sub">${sub}</span></button>
    <button class="nav-btn" data-act="day-next" aria-label="다음 날" ${today ? 'disabled' : ''}>${IC.right}</button>
    <button class="sync-btn" data-act="sync-open" aria-label="동기화 상태: ${esc(syncLine())}"><span class="sync-dot ${syncClass()}"></span></button>`;
}

function hudHtml() {
  const tk = todayKey(), e = C.expOf(store.day(tk), cfg()), se = season();
  return `<div class="hud-in"><span class="hud-lv">${e >= C.EXP_GOAL ? 'CLEAR' : 'TODAY'}</span><span class="hud-name">🔥 ${C.streak(getDay, tk)}일 연속</span><span class="hud-max">시즌 ${se.n} · ${se.left ? 'D-' + se.left : '마지막 날'}</span></div>
    <div class="hud-exp"><i style="width:${Math.min(100, e)}%"></i><span>오늘 EXP <b>${e}</b> / ${C.EXP_GOAL}</span></div>`;
}

// ---------- 오늘 탭 ----------

function ddayHtml() {
  const dd = (cfg().ddays || []).filter(d => !d.del);
  if (!dd.length) return '';
  const tk = todayKey();
  return `<div class="ddays">${dd.map(d => `<span class="dday"><b>${esc(C.ddayInfo(d, tk).text || '날짜 없음')}</b>${esc(d.label)}</span>`).join('')}</div>`;
}

function startHtml() {
  return `<section class="win start-card"><div class="say">${MOCHI}<div><b>언제 일어났어요?</b><p>누른 시각부터 오늘이 시작돼요. 늦게 일어난 날도 똑같이 흘러가요.</p></div></div>
    <div class="row-btns"><button class="btn pri" data-act="wake" data-arg="0">방금</button><button class="btn" data-act="wake" data-arg="30">30분 전</button><button class="btn" data-act="wake" data-arg="60">1시간 전</button><button class="btn" data-act="time-wake">시간 선택</button></div></section>`;
}

function stripHtml(day, today) {
  const w = C.wakeOf(day), sl = C.sleepOf(day), p = C.progress(day, cfg());
  const end = sl ? '🌙 ' + C.fmtTime(sl) : w ? '~' + C.fmtTime(w + C.AWAKE_HOURS * HOUR) : '';
  return `<section class="win"><button class="strip-btn" data-act="tab" data-arg="flow" aria-label="오늘 흐름 자세히 보기">${stripSvg(day, cfg(), now(), today)}
    <span class="strip-meta"><span>${w ? '☀️ ' + C.fmtTime(w) : '기상 기록 없음'}</span><span>필수 <b>${p.essDone}/${p.essTotal}</b> · 전체 <b>${p.done}/${p.total}</b></span><span>${end}</span></span></button></section>`;
}

function coachList(day) {
  const tk = todayKey();
  const hist = C.lastDays(C.addDays(tk, -1), 14).map(getDay);
  const list = C.coach({ now: now(), day, cfg: cfg(), local: local(), typical: C.typicalWake(hist) });
  if (list[0].key === 'start' || list[0].key === 'closed') return list;
  const l = local(), sn = k => (l.snooze?.[k] || 0) > now();
  const extra = [];
  const se = season();
  if (se.left === 0 && !sn('season')) extra.push({ pri: 38, key: 'season', icon: '🏁', tone: 'now', title: `시즌 ${se.n} 마지막 날이에요`, sub: '2주 결과를 확인하고 보고해요', action: { label: '결과 보기', act: 'tab', arg: 'week' } });
  if (!l.seen.setup && !sn('setup')) extra.push({ pri: 50, key: 'setup', icon: '🛠️', tone: 'calm', title: '기본 항목을 내 루틴으로 바꿔요', sub: '약 이름, 시간대, 필수 여부를 설정에서 고칠 수 있어요', action: { label: '설정 열기', act: 'tab', arg: 'set' }, alt: { label: '괜찮아요', act: 'seen', arg: 'setup' } });
  if (!l.gh && !l.seen.backup && !sn('backup') && allDays().length >= 2) extra.push({ pri: 52, key: 'backup', icon: '☁️', tone: 'calm', title: '기록을 비공개 저장소에 백업해요', sub: '폰을 바꾸거나 브라우저 데이터를 지워도 남아요', action: { label: '연결하기', act: 'sync-open' }, alt: { label: '괜찮아요', act: 'seen', arg: 'backup' } });
  const out = [...list.filter(s => s.key !== 'clear'), ...extra].sort((a, b) => a.pri - b.pri);
  return out.length ? out : list;
}
function coachHtml(day) {
  const s = coachList(day)[0];
  const btns = [];
  if (s.action) btns.push(`<button class="btn pri" data-act="coach" data-arg="action">${esc(s.action.label)}</button>`);
  if (s.alt) btns.push(`<button class="btn" data-act="coach" data-arg="alt">${esc(s.alt.label)}</button>`);
  if (!['clear', 'closed', 'start'].includes(s.key)) btns.push('<button class="btn ghost" data-act="coach-later">나중에</button>');
  return `<section class="win coach tone-${s.tone}"><div class="say">${MOCHI}<div><b>${esc(s.icon)} ${esc(s.title)}</b><p>${esc(s.sub || '')}</p></div></div>${btns.length ? `<div class="row-btns">${btns.join('')}</div>` : ''}</section>`;
}

function top3Html(day) {
  const map = new Map((day.top3 || []).filter(t => !t.del && t.text).map(t => [t.id, t]));
  // 정한 것만 줄로 보여주고, 빈 칸은 "추가" 한 줄로 접는다 (첫 화면에 타일이 보이도록)
  const set = [...map.values()];
  const rows = set.map(t => `<div class="t3 ${t.done ? 'done' : ''}"><button class="t3-main" data-act="t3-toggle" data-arg="${t.id}" aria-pressed="${!!t.done}"><span class="box">${IC.check}</span><span class="t3-t">${esc(t.text)}</span></button><button class="icon-btn" data-act="t3-edit" data-arg="${t.id}" aria-label="수정">${IC.edit}</button></div>`);
  const free = ['t1', 't2', 't3'].find(id => !map.has(id));
  if (free) rows.push(`<button class="t3 empty" data-act="t3-edit" data-arg="${free}"><span class="t3-n">${set.length + 1}</span><span class="t3-t">${set.length ? '하나 더 추가' : '오늘 꼭 끝낼 일 정하기'}</span><span class="t3-plus">${IC.plus}</span></button>`);
  return win('오늘의 핵심 3가지', 'TOP 3', rows.join(''), '', set.length ? `<span class="win-count">${set.filter(t => t.done).length}/${set.length}</span>` : '');
}

function tileHtml(it, s, { carried, later, today }) {
  const exp = C.itemExp(it);
  let sub;
  if (it.type === 'check') sub = s.done ? `${C.fmtTime(s.last)} 완료` : s.skipped ? '오늘은 건너뜀' : carried ? `${C.BLOCK_NAMES[it.block]}에서 넘어옴` : it.essential ? '필수' : C.BLOCK_NAMES[it.block];
  else if (it.type === 'count') sub = (it.target ? `${s.count}/${it.target}${it.unit || ''}` : `${s.count}${it.unit || '번'}`) + (s.last ? ` · ${today ? C.ago(s.last, now()) : C.fmtTime(s.last)}` : '');
  else if (!s.count) sub = '눌러서 기록';
  else if (it.ask === 'min') sub = `${C.fmtDur(s.sum)} · ${s.count}번`;
  else if (it.ask === 'num') sub = `${s.lastV ?? ''}${it.unit || ''} · ${C.fmtTime(s.last)}`;
  else sub = `${s.count}번 · ${today ? C.ago(s.last, now()) : C.fmtTime(s.last)}`;
  const goal = it.goal?.total ? `<span class="tile-goal">누적 ${C.goalCount(it, allDays())}/${it.goal.total}</span>` : '';
  const bar = it.type === 'count' && it.target ? `<span class="mini-bar"><i style="width:${Math.min(100, Math.round((s.count / it.target) * 100))}%"></i></span>` : '';
  const mark = it.type === 'check' ? `<span class="box">${IC.check}</span>` : `<span class="plus">${IC.plus}</span>`;
  const cls = ['tile', s.done && 'is-done', s.skipped && 'is-skip', later && 'is-later', ui.just === it.id && 'pop'].filter(Boolean).join(' ');
  return `<button class="${cls}" data-act="tile" data-arg="${esc(it.id)}" data-hold="tile-menu" aria-pressed="${!!s.done}">
    <span class="tile-top"><span class="tile-ic" aria-hidden="true">${esc(it.icon || '⭐')}</span>${exp ? `<span class="q-reward">+${exp}</span>` : ''}</span>
    <span class="tile-name">${esc(it.name)}</span><span class="tile-sub">${esc(sub)}</span>${goal}${bar}${mark}</button>`;
}

function tilesHtml(day, items, today) {
  const cur = today ? C.blockAt(day, now()) : 'night', ci = C.blockIdx(cur), lite = C.isLite(day);
  const nowL = [], any = [], done = [], later = new Map();
  for (const it of items) {
    const s = C.itemState(day, it);
    if (lite && it.type === 'check' && !it.essential && !s.done) continue;
    if (it.type === 'check' && (s.done || s.skipped)) done.push([it, s]);
    else if (it.block === 'any') any.push([it, s]);
    else if (C.blockIdx(it.block) <= ci) nowL.push([it, s, C.blockIdx(it.block) < ci]);
    else {
      if (!later.has(it.block)) later.set(it.block, []);
      later.get(it.block).push([it, s]);
    }
  }
  const grid = (list, opt = {}) => `<div class="grid">${list.map(([it, s, carried]) => tileHtml(it, s, { carried, today, ...opt })).join('')}</div>`;
  const liteBtn = today ? `<button class="mini-toggle ${lite ? 'on' : ''}" data-act="lite" data-arg="${lite ? 0 : 1}" aria-pressed="${lite}">가볍게</button>` : '';
  const tip = today && !local().seen.hold ? '<p class="hint">타일을 길게 누르면 시간 수정과 건너뛰기를 할 수 있어요. <button class="link" data-act="seen" data-arg="hold">알겠어요</button></p>' : '';
  let h = win(today ? `지금 · ${C.BLOCK_NAMES[cur]}` : '루틴', today ? 'NOW' : 'DAY', (nowL.length ? grid(nowL) : `<p class="empty">${lite ? '필수 항목은 다 했어요.' : '지금 할 것은 다 했어요.'}</p>`) + tip, '', liteBtn);
  if (any.length) h += win('언제든', 'ANY', grid(any));
  for (const b of C.BLOCKS) if (later.has(b.id)) h += win(`나중에 · ${b.name}`, 'LATER', grid(later.get(b.id), { later: true }), 'later');
  if (done.length) h += win('완료', 'DONE', grid(done), 'done', `<span class="win-count">${done.length}</span>`);
  return h;
}

function condHtml(day) {
  const evs = C.live(day);
  const lastOf = id => evs.filter(e => e.item === id).pop();
  const row = (id, label, icon) => {
    const l = lastOf(id);
    return `<div class="scale"><span class="scale-l">${icon} ${label}</span><div class="scale-dots" role="group" aria-label="${label} 1부터 5">${[1, 2, 3, 4, 5].map(n => `<button class="dot ${l?.v === n ? 'on' : ''}" data-act="cond" data-arg="${id}:${n}" aria-pressed="${l?.v === n}">${n}</button>`).join('')}</div></div>`;
  };
  const last = Math.max(lastOf('energy')?.t || 0, lastOf('mood')?.t || 0);
  return `<section class="win" id="cond"><div class="win-head"><h2>컨디션</h2>${last ? `<span class="win-count">${C.fmtTime(last)}</span>` : ''}<span class="win-tag">STATE</span></div><div class="win-body">${row('energy', '에너지', '⚡')}${row('mood', '기분', '🙂')}</div></section>`;
}

const mmss = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
function focusHtml(day) {
  const f = local().focus;
  const total = C.live(day).filter(e => e.item === 'focus').reduce((a, e) => a + (e.min || 0), 0);
  if (f) {
    const left = f.start + f.dur * MIN - now();
    return win('집중 중', 'FOCUS', `<div class="focus-clock" id="focus-clock">${mmss(left)}</div>${f.label ? `<p class="focus-label">🎯 ${esc(f.label)}</p>` : ''}
      <div class="track"><i class="fill" id="focus-fill" style="width:${Math.min(100, Math.max(0, 100 - (left / (f.dur * MIN)) * 100)).toFixed(1)}%"></i></div>
      <div class="row-btns"><button class="btn pri" data-act="focus-stop">끝내기</button><button class="btn ghost" data-act="focus-cancel">기록 없이 취소</button></div>`);
  }
  return win('집중 타이머', 'FOCUS', `<div class="row-btns"><button class="btn" data-act="focus" data-arg="25">25분</button><button class="btn" data-act="focus" data-arg="50">50분</button><span class="muted grow-r">오늘 ${C.fmtDur(total)}</span></div>`);
}

function reviewHtml(day, today) {
  const r = C.reviewOf(day);
  if (r) {
    return win('하루 마감', 'REVIEW', `<div class="review-done"><span class="score">${SCORE[r.score] || '🌙'}</span><p>${esc(r.note || '한 줄 없이 마감했어요')}</p></div>
      <div class="row-btns"><button class="btn" data-act="review">수정</button><button class="btn pri" data-act="report">보고하기</button></div>`);
  }
  const night = today && C.wakeOf(day) && C.blockAt(day, now()) === 'night';
  return win('하루 마감', 'REVIEW', `<p class="lead">오늘을 한 줄로 정리하고 끝내요. 마감하면 +20 EXP.</p>
    <div class="row-btns"><button class="btn ${night ? 'pri' : ''}" data-act="review">마감하기</button><button class="btn" data-act="report">보고하기</button></div>`);
}

function todayHtml() {
  const key = viewKey(), day = store.day(key), today = isToday();
  let h = '';
  if (!today) h += '<div class="note">지난 날을 보고 있어요. 타일을 누르면 시각을 정해서 기록할 수 있어요.</div>';
  if (today) h += ddayHtml();
  h += today && !C.wakeOf(day) ? startHtml() : stripHtml(day, today);
  if (today && C.wakeOf(day)) h += coachHtml(day);
  h += top3Html(day);
  h += tilesHtml(day, C.activeItems(cfg(), key), today);
  if (today) h += condHtml(day) + focusHtml(day);
  h += reviewHtml(day, today);
  return h;
}

// ---------- 흐름 탭 ----------

function flowHtml() {
  const key = viewKey(), day = store.day(key), today = isToday(), evs = C.live(day);
  const w = C.wakeOf(day), sl = C.sleepOf(day);
  let h = win(`${today ? '오늘' : C.fmtDate(key)} 흐름`, 'FLOW', evs.length || w ? flowSvg(day, cfg(), now(), today) : '<p class="empty">아직 기록이 없어요. 오늘 탭에서 타일을 눌러 시작해요.</p>');
  const rows = [];
  const row = (t, icon, name, detail, act, arg = '') =>
    `<button class="row" data-act="${act}" data-arg="${esc(arg)}"><span class="row-t">${C.fmtTime(t)}</span><span class="row-ic">${esc(icon)}</span><span class="row-b">${esc(name)}${detail ? `<small>${esc(detail)}</small>` : ''}</span><span class="row-go">${IC.right}</span></button>`;
  if (w) rows.push([w, row(w, '☀️', '기상', day.wake.auto ? '첫 기록 시각으로 잡았어요. 눌러서 고칠 수 있어요' : '', 'time-wake')]);
  for (const e of evs) {
    const it = nameOf(e.item);
    rows.push([e.t, row(e.t, it.icon, it.name, evDetail(e, it), 'ev', e.id)]);
  }
  if (sl) rows.push([sl, row(sl, '🌙', '취침', '', 'time-sleep')]);
  rows.sort((a, b) => a[0] - b[0]);
  h += win('기록', 'LOG', rows.length ? `<div class="log">${rows.map(r => r[1]).join('')}</div>` : '<p class="empty">기록이 없어요.</p>', '', `<span class="win-count">${evs.length}</span>`);
  if (w && !sl) h += `<div class="row-btns" style="margin:-4px 0 16px"><button class="btn" data-act="time-sleep">취침 시각 기록</button></div>`;
  return h;
}

// ---------- 주간 탭 ----------

function seasonDays() {
  const se = season(), tk = todayKey(), keys = [];
  for (let k = se.start; k <= tk && k <= se.end; k = C.addDays(k, 1)) keys.push(k);
  return { se, stats: C.seasonStats(keys.map(getDay), cfg()) };
}

function weekHtml() {
  const tk = todayKey(), c = cfg();
  const k7 = C.lastDays(tk, 7), d7 = k7.map(getDay), s = C.summarize(d7, c);
  const { se, stats: ss } = seasonDays();
  let h = win(`시즌 ${se.n}`, 'SEASON', `<div class="goal-h"><span>${C.SEASON_DAYS}일 중 <b>${se.day}일째</b></span><span>${se.left ? `${C.fmtDate(se.end)}까지 · <b>D-${se.left}</b>` : '<b>오늘이 마지막 날</b>'}</span></div>
    <span class="mini-bar"><i class="blue" style="width:${Math.round((se.day / C.SEASON_DAYS) * 100)}%"></i></span>
    <div class="minis" style="margin-top:10px">${mini('기록한 날', ss.recorded, '일')}${mini('필수 달성', ss.essDays, '일')}${mini('CLEAR', ss.clearDays, '일')}</div>
    <div class="row-btns"><button class="btn pri" data-act="report-season">시즌 보고하기</button><span class="muted grow-r">누적 ${ss.exp} EXP</span></div>`);

  const cols = k7.map((k, i) => {
    const d = d7[i], rec = C.recorded(d), e = rec ? C.expOf(d, c) : 0;
    return `<button class="wd ${rec ? '' : 'none'} ${k === tk ? 'today' : ''}" data-act="goto-day" data-arg="${k}" aria-label="${C.fmtDate(k)} ${rec ? 'EXP ' + e : '기록 없음'}"><span class="wd-bar ${e >= C.EXP_GOAL ? 'clear' : ''}"><i style="height:${Math.min(100, e)}%"></i></span><span class="wd-l">${WEEKDAY[C.keyToDate(k).getDay()]}</span><span class="wd-n">${rec ? e : '·'}</span></button>`;
  }).join('');
  h += win('최근 7일', 'WEEK', `<div class="minis" style="margin-bottom:12px">${mini('연속 기록', C.streak(getDay, tk), '일')}${mini('7일 중 기록', s.recorded, '일')}${mini('필수 달성', s.essDays, '일')}</div>
    <div class="week">${cols}</div><p class="hint">막대는 그날의 EXP예요. 노란 막대는 100을 채운 날이에요. 누르면 그날로 가요.</p>`);

  const rows = C.activeItems(c).filter(i => i.type === 'check' || (i.type === 'count' && i.target));
  if (rows.length) {
    let m = '<span></span>' + k7.map(k => `<span class="mx-h">${WEEKDAY[C.keyToDate(k).getDay()]}</span>`).join('');
    for (const it of rows) {
      m += `<span class="mx-n">${esc(it.icon)} ${esc(it.name)}</span>`;
      k7.forEach((k, i) => {
        const d = d7[i];
        if (!C.recorded(d) || (it.since && k < it.since)) return (m += '<span class="mx-c na"></span>');
        const st = C.itemState(d, it);
        m += st.done ? `<span class="mx-c on">${IC.check}</span>` : st.skipped ? '<span class="mx-c skip"></span>' : st.count ? `<span class="mx-c part">${st.count}</span>` : '<span class="mx-c"></span>';
      });
    }
    h += win('항목별', 'ITEMS', `<div class="mx">${m}</div>`);
  }

  const goals = C.activeItems(c).filter(i => i.goal?.total), dd = (c.ddays || []).filter(d => !d.del);
  if (goals.length || dd.length) {
    const g = goals.map(it => {
      const n = C.goalCount(it, allDays());
      return `<div class="goal"><div class="goal-h"><span>${esc(it.icon)} ${esc(it.name)}</span><b>${n} / ${it.goal.total}</b></div><span class="mini-bar"><i style="width:${Math.min(100, Math.round((n / it.goal.total) * 100))}%"></i></span></div>`;
    }).join('');
    const d = dd.map(x => {
      const inf = C.ddayInfo(x, tk);
      return `<div class="goal"><div class="goal-h"><span>📅 ${esc(x.label)}</span><b>${esc(inf.text)}</b></div>${inf.pct != null ? `<span class="mini-bar"><i class="blue" style="width:${inf.pct}%"></i></span>` : ''}</div>`;
    }).join('');
    h += win('누적 목표와 날짜', 'GOAL', g + d);
  }

  const f1 = v => (v == null ? '기록 없음' : v.toFixed(1));
  const kv = [['평균 기상', s.wakeAvg == null ? '기록 없음' : C.fmtMinutesOfDay(s.wakeAvg)], ['평균 수면', s.sleepAvg == null ? '기록 없음' : C.fmtDur(s.sleepAvg * 60)]];
  for (const x of s.counts) kv.push([`${x.item.name} 하루 평균`, `${x.perDay.toFixed(1)}${x.item.unit || '번'}`]);
  kv.push(['집중 합계', C.fmtDur(s.focusMin)], ['운동 합계', C.fmtDur(s.moveMin)], ['에너지 평균', f1(s.energyAvg)], ['기분 평균', f1(s.moodAvg)], ['하루 점수 평균', f1(s.scoreAvg)]);
  for (const x of s.meds) if (x.days) kv.push([x.item.name, `7일 중 ${x.days}일` + (x.afterWake != null ? ` · 기상 후 ${C.fmtDur(x.afterWake)}` : '')]);
  h += win('7일 요약', 'AVG', `<dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`);

  const k28 = C.lastDays(tk, 28);
  h += win('최근 4주', 'HEAT', `<div class="heat">${k28.map(k => {
    const d = getDay(k), e = C.recorded(d) ? C.expOf(d, c) : -1;
    const lv = e < 0 ? '' : e >= C.EXP_GOAL ? 'l3' : e >= 50 ? 'l2' : 'l1';
    return `<button class="hc ${lv} ${k === tk ? 'today' : ''}" data-act="goto-day" data-arg="${k}" aria-label="${C.fmtDate(k)} ${e < 0 ? '기록 없음' : 'EXP ' + e}"></button>`;
  }).join('')}</div><div class="legend"><span><i></i>기록 없음</span><span><i class="l1"></i>기록</span><span><i class="l2"></i>50 이상</span><span><i class="l3"></i>CLEAR</span></div>`);

  const rv = k28.slice().reverse().map(k => [k, C.reviewOf(getDay(k))]).filter(([, r]) => r && (r.note || r.score)).slice(0, 7);
  if (rv.length) h += win('최근 회고', 'REVIEW', rv.map(([k, r]) => `<div class="rv"><span>${SCORE[r.score] || '·'}</span><span>${esc(r.note || '한 줄 없음')}<small>${C.fmtDate(k)}</small></span></div>`).join(''));
  return h;
}

// ---------- 설정 탭 ----------

const typeName = it => (it.type === 'check' ? '한 번 체크' : it.type === 'count' ? '횟수' : it.ask === 'min' ? '시간 기록' : it.ask === 'num' ? '숫자 기록' : '메모 기록');

function setHtml() {
  const c = cfg(), l = local(), items = C.activeItems(c), tk = todayKey();
  const sugg = C.SUGGESTED.filter(sg => !items.some(i => i.name === sg.name));
  let h = win('내 항목', 'ITEMS', items.map((it, i) => `<div class="item-row"><button class="item-main" data-act="item-edit" data-arg="${esc(it.id)}"><span class="row-ic">${esc(it.icon)}</span><span><b>${esc(it.name)}${it.essential ? ' ★' : ''}</b><small>${C.BLOCK_NAMES[it.block]} · ${typeName(it)}${it.goal?.total ? ` · 누적 ${it.goal.total}` : ''}</small></span></button>
      <button class="icon-btn" data-act="item-move" data-arg="${esc(it.id)}:-1" aria-label="위로" ${i ? '' : 'disabled'}>${IC.up}</button><button class="icon-btn" data-act="item-move" data-arg="${esc(it.id)}:1" aria-label="아래로" ${i < items.length - 1 ? '' : 'disabled'}>${IC.down}</button></div>`).join('') +
    `<div class="row-btns"><button class="btn pri" data-act="item-add">항목 추가</button></div>${sugg.length ? `<p class="hint">추천에서 바로 추가</p><div class="sugg">${sugg.map(sg => `<button data-act="item-suggest" data-arg="${esc(sg.name)}">${esc(sg.icon)} ${esc(sg.name)}</button>`).join('')}</div>` : ''}`);

  const dd = (c.ddays || []).filter(d => !d.del);
  h += win('D-day', 'DATE', (dd.length ? dd.map(d => `<button class="set-row" data-act="dday-edit" data-arg="${esc(d.id)}"><span>${esc(d.label)}<small>${[d.from && d.from + ' 시작', d.to && d.to + ' 까지'].filter(Boolean).join(' · ')}</small></span><b>${esc(C.ddayInfo(d, tk).text)}</b></button>`).join('') : '<p class="lead">바꿀 수 없는 날짜를 맨 위에 걸어 둬요. 시작일을 넣으면 몇 주차인지도 세요.</p>') +
    '<div class="row-btns"><button class="btn" data-act="dday-add">날짜 추가</button></div>');

  h += win('하루', 'DAY', `<div class="set-row"><span>하루가 바뀌는 시각<small>이 시각 전의 새벽 기록은 전날로 들어가요</small></span><select data-change="rollover" aria-label="하루가 바뀌는 시각">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}" ${n === rollover() ? 'selected' : ''}>${n}시</option>`).join('')}</select></div>
    <div class="set-row"><span>시즌 시작일<small>2주마다 결과를 끊어서 봐요</small></span><input type="date" data-change="season" aria-label="시즌 시작일" value="${esc(c.prefs?.seasonStart || tk)}" max="${tk}" style="width:auto"></div>`);

  h += win('GitHub 동기화', 'SYNC', `<div class="status ${sync.status().state === 'error' ? 'bad' : ''}"><b>${l.gh ? esc(l.gh.repo) : '연결 안 됨'}</b><br>${esc(syncLine())}</div>
    <div class="row-btns">${l.gh ? '<button class="btn pri" data-act="sync-now">지금 동기화</button><button class="btn" data-act="sync-open">연결 설정</button>' : '<button class="btn pri" data-act="sync-open">비공개 저장소 연결</button>'}</div>`);

  const places = (c.places || []).filter(p => !p.del);
  h += win('위치', 'PLACE', `<div class="set-row"><span>기록할 때 장소 남기기<small>앱을 열고 기록을 누른 순간의 위치만 저장해요</small></span><button class="mini-toggle ${l.loc ? 'on' : ''}" data-act="loc-toggle" aria-pressed="${!!l.loc}">${l.loc ? '켜짐' : '꺼짐'}</button></div>
    ${places.map(p => `<div class="set-row"><span>📍 ${esc(p.name)}</span><button class="btn sm danger" data-act="place-del" data-arg="${esc(p.id)}">삭제</button></div>`).join('')}
    ${l.loc ? '<div class="row-btns"><button class="btn" data-act="place-add">지금 위치를 장소로 저장</button></div>' : ''}`);

  h += win('화면', 'THEME', `<div class="seg">${[['auto', '기기 설정'], ['light', '밝게'], ['dark', '어둡게']].map(([v, t]) => `<button class="${l.theme === v ? 'on' : ''}" data-act="theme" data-arg="${v}">${t}</button>`).join('')}</div>`);

  h += win('데이터', 'DATA', `<p class="lead">기록은 이 기기${l.gh ? '와 연결한 비공개 저장소' : ''}에 있어요. 파일로 따로 보관할 수도 있어요.</p>
    <div class="row-btns"><button class="btn" data-act="export">파일로 내보내기</button><button class="btn" data-act="import-pick">파일에서 가져오기</button></div><input type="file" id="imp" accept="application/json,.json" data-change="import" hidden>`);
  h += `<p class="muted" style="text-align:center">오늘 v${VERSION} · 브라우저 메뉴의 "홈 화면에 추가"로 앱처럼 쓸 수 있어요</p>`;
  return h;
}

// ---------- 그리기 ----------

const VIEWS = { today: todayHtml, flow: flowHtml, week: weekHtml, set: setHtml };
let queued = false, downAt = 0, pending = false;
function render() {
  // 손가락이 눌려 있는 동안 화면을 바꾸면 탭이 씹힌다. 뗀 뒤에 그린다.
  if (downAt && performance.now() - downAt < 1500) {
    pending = true;
    return;
  }
  if (queued) return;
  queued = true;
  Promise.resolve().then(() => {
    queued = false;
    paint();
  });
}
function paint() {
  if (ui.date && ui.date >= todayKey()) ui.date = null;
  $('#top').innerHTML = topHtml();
  const view = $('#view'), a = document.activeElement;
  if (!(a && view.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))) view.innerHTML = VIEWS[ui.tab]();
  $('#hud').innerHTML = hudHtml();
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.arg === ui.tab));
  ensureFocusTick();
}

let toastTimer = 0, toastFn = null;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button data-act="toast-act">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  toastFn = action?.fn || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 5200 : 2600);
}
function burst() {
  const el = $('#burst');
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
  haptic([30, 40, 80]);
}

// ---------- 시트 ----------

let sheetActs = {};
function openSheet(title, tag, body, acts = {}) {
  const el = $('#sheet');
  el.innerHTML = `<div class="sheet-bg" data-act="sheet-close"></div><div class="sheet win" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="win-head"><h2>${esc(title)}</h2><span class="win-tag">${tag}</span><button class="icon-btn" data-act="sheet-close" aria-label="닫기">${IC.x}</button></div><div class="win-body">${body}</div></div>`;
  el.hidden = false;
  sheetActs = acts;
  document.body.classList.add('has-sheet');
  if (!history.state?.sheet) history.pushState({ sheet: 1 }, '');
  const f = el.querySelector('[autofocus]');
  if (f) setTimeout(() => f.focus(), 80);
}
function closeSheet(fromPop) {
  const el = $('#sheet');
  if (el.hidden) return;
  el.hidden = true;
  el.innerHTML = '';
  sheetActs = {};
  document.body.classList.remove('has-sheet');
  if (!fromPop && history.state?.sheet) history.back();
  render();
}
const v = name => $(`#sheet [name="${name}"]`)?.value ?? '';
const segv = name => $(`#sheet .seg[data-name="${name}"]`)?.dataset.value ?? '';
function sheetErr(msg) {
  const el = $('#sheet-err');
  if (el) {
    el.textContent = msg;
    el.hidden = false;
  }
}
const seg = (name, value, opts, cls = '') =>
  `<div class="seg ${cls}" data-name="${name}" data-value="${esc(value ?? '')}">${opts.map(([val, label]) => `<button type="button" class="${String(val) === String(value ?? '') ? 'on' : ''}" data-act="seg" data-arg="${esc(val)}">${label}</button>`).join('')}</div>`;

function ensureSeason() {
  if (!cfg().prefs?.seasonStart) store.setPrefs({ seasonStart: todayKey() });
}

function stampLoc(key, ev) {
  if (!local().loc || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    p => {
      const lat = +p.coords.latitude.toFixed(5), lon = +p.coords.longitude.toFixed(5);
      const place = C.matchPlace(cfg().places, lat, lon);
      store.updateEvent(key, ev.id, { loc: [lat, lon], place: place?.name });
    },
    () => {},
    { maximumAge: 300000, timeout: 10000 },
  );
}

function afterLog(it, key, ev) {
  ui.just = it.id;
  setTimeout(() => {
    if (ui.just === it.id) ui.just = null;
  }, 700);
  haptic(12);
  ensureSeason();
  stampLoc(key, ev);
  const label = `${it.icon} ${it.name} ${C.fmtTime(ev.t)} 기록`;
  if (it.type === 'log' && it.ask !== 'min' && it.ask !== 'num') toast(label, { label: '메모', fn: () => openEventSheet(ev.id, key) });
  else toast(label, { label: '취소', fn: () => store.deleteEvent(key, ev.id) });
}
function addAt(it, key, t) {
  if (it.type === 'log' && (it.ask === 'min' || it.ask === 'num')) return openLogSheet(it, key, t);
  afterLog(it, key, store.logEvent(key, it.id, { t, autoWake: key === todayKey() }));
}

function openLogSheet(it, key, t) {
  const isMin = it.ask === 'min';
  const body = (isMin
    ? `<div class="fld"><span>얼마나 했어요?</span>${seg('min', 30, [10, 20, 30, 45, 60, 90].map(m => [m, m + '분']))}</div><label class="fld"><span>직접 입력 (분)</span><input name="minx" type="number" inputmode="numeric" min="1" max="600" placeholder="비워 두면 위에서 고른 값"></label>`
    : `<label class="fld"><span>값${it.unit ? ` (${esc(it.unit)})` : ''}</span><input name="num" type="number" inputmode="decimal" step="0.1" autofocus></label>`) +
    '<label class="fld"><span>메모 (선택)</span><input name="note" maxlength="60" autocomplete="off"></label><p class="err" id="sheet-err" hidden></p><div class="row-btns"><button class="btn pri" data-act="save">기록</button></div>';
  openSheet(`${it.icon} ${it.name}`, 'LOG', body, {
    save() {
      const note = v('note').trim() || undefined, autoWake = key === todayKey();
      let ev;
      if (isMin) {
        const min = Math.round(parseFloat(v('minx')) || +segv('min'));
        if (!(min > 0)) return sheetErr('시간을 골라 주세요');
        ev = store.logEvent(key, it.id, { t: t ?? now() - min * MIN, min, note, autoWake });
      } else {
        const num = parseFloat(v('num'));
        if (!Number.isFinite(num)) return sheetErr('숫자를 적어 주세요');
        ev = store.logEvent(key, it.id, { t: t ?? now(), v: num, note, autoWake });
      }
      closeSheet();
      afterLog(it, key, ev);
    },
  });
}

function openTileSheet(id) {
  const it = itemById(id);
  if (!it) return;
  const key = viewKey(), today = isToday(), s = C.itemState(store.day(key), it);
  const quick = today ? `<div class="row-btns">${[['지금', 0], ['15분 전', 15], ['30분 전', 30], ['1시간 전', 60]].map(([l, m]) => `<button class="btn" data-act="add-ago" data-arg="${m}">${l}</button>`).join('')}</div>` : '';
  const evRows = s.evs.map(e => `<button class="row no-ic" data-act="ev" data-arg="${e.id}"><span class="row-t">${C.fmtTime(e.t)}</span><span class="row-b">${esc(evDetail(e, it) || '기록')}</span><span class="row-go">${IC.right}</span></button>`).join('');
  const body = `${quick}<div class="fld inline" style="margin-top:12px"><span>시각 지정</span><input type="time" name="time" value="${today ? C.fmtTime(now()) : '12:00'}"><button class="btn" data-act="add-at">기록</button></div>
    ${evRows ? `<h3 class="sub-h">${today ? '오늘' : '이날'} 기록</h3><div class="log">${evRows}</div>` : ''}
    <div class="row-btns">${it.type === 'check' && !s.done ? `<button class="btn" data-act="skip">${s.skipped ? '건너뛰기 취소' : '오늘은 건너뛰기'}</button>` : ''}<button class="btn ghost" data-act="edit-item">항목 편집</button></div>`;
  openSheet(`${it.icon} ${it.name}`, 'QUEST', body, {
    'add-ago'(m) {
      closeSheet();
      addAt(it, key, now() - m * MIN);
    },
    'add-at'() {
      const t = C.tsFor(key, v('time') || '12:00', rollover());
      closeSheet();
      addAt(it, key, t);
    },
    skip() {
      store.setSkip(key, it.id, !s.skipped);
      closeSheet();
    },
    'edit-item'() {
      openItemSheet(it.id);
    },
  });
}

function openEventSheet(id, key = viewKey()) {
  const e = store.day(key).events.find(x => x.id === id);
  if (!e) return;
  const it = nameOf(e.item);
  const isCond = e.item === 'energy' || e.item === 'mood', hasMin = e.item === 'focus' || it.ask === 'min', isNum = it.ask === 'num', isMeal = it.cat === 'meal';
  const t0 = C.fmtTime(e.t);
  let body = `<label class="fld"><span>시각</span><input type="time" name="time" value="${t0}"></label>`;
  if (isCond) body += `<div class="fld"><span>값</span>${seg('v', e.v, [1, 2, 3, 4, 5].map(n => [n, n]))}</div>`;
  if (hasMin) body += `<label class="fld"><span>시간 (분)</span><input name="min" type="number" inputmode="numeric" min="1" max="600" value="${e.min || ''}"></label>`;
  if (isNum) body += `<label class="fld"><span>값${it.unit ? ` (${esc(it.unit)})` : ''}</span><input name="num" type="number" inputmode="decimal" step="0.1" value="${e.v ?? ''}"></label>`;
  if (isMeal) body += `<div class="fld"><span>양</span>${seg('portion', e.v, [1, 2, 3].map(n => [n, PORTION[n]]))}</div>`;
  if (!isCond) body += `<label class="fld"><span>메모</span><input name="note" maxlength="60" value="${esc(e.note || '')}" autocomplete="off" placeholder="${isMeal ? '김치찌개, 밥 한 공기' : ''}"></label>`;
  body += `${e.place ? `<p class="hint">📍 ${esc(e.place)}</p>` : ''}<div class="row-btns"><button class="btn pri" data-act="save">저장</button><button class="btn danger" data-act="del">기록 삭제</button></div>`;
  openSheet(`${it.icon} ${it.name}`, 'EDIT', body, {
    save() {
      const patch = {};
      const hm = v('time');
      if (hm && hm !== t0) patch.t = C.tsFor(key, hm, rollover());
      if (isCond) patch.v = +segv('v') || e.v;
      if (hasMin) patch.min = Math.max(1, Math.round(parseFloat(v('min')) || e.min || 1));
      if (isNum && Number.isFinite(parseFloat(v('num')))) patch.v = parseFloat(v('num'));
      if (isMeal) patch.v = +segv('portion') || undefined;
      if (!isCond) patch.note = v('note').trim() || undefined;
      store.updateEvent(key, id, patch);
      closeSheet();
      toast('고쳤어요');
    },
    del() {
      store.deleteEvent(key, id);
      closeSheet();
      toast('기록을 지웠어요');
    },
  });
}

function openTimeSheet(kind) {
  const key = viewKey(), day = store.day(key);
  const cur = kind === 'wake' ? C.wakeOf(day) : C.sleepOf(day);
  const def = C.fmtTime(cur || now());
  openSheet(kind === 'wake' ? '기상 시각' : '취침 시각', 'TIME', `<label class="fld"><span>시각</span><input type="time" name="time" value="${def}"></label>
    <div class="row-btns"><button class="btn pri" data-act="save">저장</button>${kind === 'sleep' && cur ? '<button class="btn danger" data-act="clear">취침 기록 지우기</button>' : ''}</div>`, {
    save() {
      const t = C.tsFor(key, v('time') || def, rollover());
      if (kind === 'wake') {
        store.setWake(key, t);
        ensureSeason();
      } else store.setSleep(key, t);
      closeSheet();
    },
    clear() {
      store.setSleep(key, 0);
      closeSheet();
    },
  });
}

function openTop3Sheet(id) {
  const key = viewKey(), day = store.day(key);
  const cur = (day.top3 || []).find(t => t.id === id && !t.del);
  const have = new Set(C.top3Of(day).map(t => t.text));
  const carry = C.top3Of(getDay(C.addDays(key, -1))).filter(t => !t.done && !have.has(t.text));
  const clear = () => {
    if (cur?.text) store.setTop3(key, id, { text: '', done: 0 });
    closeSheet();
  };
  openSheet('오늘의 핵심', 'TOP 3', `<label class="fld"><span>오늘 꼭 끝낼 일 하나</span><input name="text" maxlength="40" value="${esc(cur?.text || '')}" placeholder="3장 문제 10개 풀기" autocomplete="off" autofocus></label>
    ${carry.length ? `<div class="fld"><span>어제 못 끝낸 것에서 가져오기</span><div class="sugg">${carry.map(t => `<button data-act="carry" data-arg="${esc(t.text)}">${esc(t.text)}</button>`).join('')}</div></div>` : ''}
    <p class="hint">끝이 보이게 적어요. "공부" 대신 "3장 문제 10개".</p>
    <div class="row-btns"><button class="btn pri" data-act="save">저장</button>${cur?.text ? '<button class="btn danger" data-act="clear">비우기</button>' : ''}</div>`, {
    save() {
      const text = v('text').trim();
      if (!text) return clear();
      store.setTop3(key, id, { text });
      closeSheet();
    },
    clear,
    carry(text) {
      $('#sheet [name="text"]').value = text;
    },
  });
}

function openReviewSheet() {
  const key = viewKey(), day = store.day(key), r = C.reviewOf(day), today = isToday();
  openSheet('하루 마감', 'REVIEW', `<div class="fld"><span>오늘 하루는 어땠어요?</span>${seg('score', r?.score, [1, 2, 3, 4, 5].map(n => [n, SCORE[n]]), 'big')}</div>
    <label class="fld"><span>한 줄 회고</span><textarea name="note" rows="2" maxlength="140" placeholder="오늘 끝낸 것 하나">${esc(r?.note || '')}</textarea></label>
    <label class="fld"><span>내일 가장 중요한 한 가지 (선택)</span><input name="tmr" maxlength="40" autocomplete="off"></label>
    ${today ? `<label class="chk"><input type="checkbox" name="sleep" ${C.sleepOf(day) ? '' : 'checked'}><span>지금을 취침 시각으로 기록</span></label>` : ''}
    <div class="row-btns"><button class="btn pri" data-act="save">마감</button>${r ? '<button class="btn danger" data-act="undo">마감 취소</button>' : ''}</div>`, {
    save() {
      store.setReview(key, { score: +segv('score') || 0, note: v('note').trim() });
      const tm = v('tmr').trim();
      if (tm) {
        const next = C.addDays(key, 1), taken = new Set(C.top3Of(store.day(next)).map(t => t.id));
        const free = ['t1', 't2', 't3'].find(x => !taken.has(x));
        if (free) store.setTop3(next, free, { text: tm, done: 0 });
      }
      if (today && $('#sheet [name="sleep"]')?.checked) store.setSleep(key, now());
      closeSheet();
      toast('오늘 마감 완료. 수고했어요');
    },
    undo() {
      store.setReview(key, null);
      closeSheet();
    },
  });
}

function openItemSheet(id, preset) {
  const cur = id ? itemById(id) : null;
  const it = cur || { name: '', icon: '⭐', cat: 'habit', type: 'check', block: 'am', ...preset };
  const mode = it.type === 'log' ? 'log-' + (it.ask || 'note') : it.type;
  const body = `<label class="fld"><span>이름</span><input name="name" maxlength="20" value="${esc(it.name)}" placeholder="아침 약" autocomplete="off"></label>
    <label class="fld"><span>아이콘</span><input name="icon" maxlength="8" value="${esc(it.icon)}" class="w-ic" autocomplete="off"></label>
    <div class="emojis">${EMOJIS.map(e => `<button type="button" data-act="emoji" data-arg="${e}">${e}</button>`).join('')}</div>
    <div class="fld"><span>종류</span>${seg('cat', it.cat, Object.entries(C.CATS))}</div>
    <div class="fld"><span>기록 방식</span>${seg('mode', mode, [['check', '한 번 체크'], ['count', '횟수'], ['log-note', '메모'], ['log-min', '시간(분)'], ['log-num', '숫자']])}</div>
    <div class="fld"><span>시간대</span>${seg('block', it.block, Object.entries(C.BLOCK_NAMES))}</div>
    <label class="chk"><input type="checkbox" name="essential" ${it.essential ? 'checked' : ''}><span>필수 항목 (가볍게 모드에서도 남아요)</span></label>
    <div class="fld2" data-show="count"><label class="fld"><span>하루 목표</span><input name="target" type="number" inputmode="numeric" min="1" max="99" value="${it.target ?? ''}" placeholder="없음"></label><label class="fld"><span>코치 알림 간격 (분)</span><input name="every" type="number" inputmode="numeric" min="10" max="600" value="${it.every ?? ''}" placeholder="없음"></label></div>
    <label class="fld" data-show="count log-num"><span>단위</span><input name="unit" maxlength="4" value="${esc(it.unit || '')}" placeholder="잔, 개, kg" autocomplete="off"></label>
    <label class="fld" data-show="count log-note log-min log-num"><span>누적 목표 (선택)</span><input name="goal" type="number" inputmode="numeric" min="1" max="9999" value="${it.goal?.total ?? ''}" placeholder="예: 30 → 30개 중 몇 개인지 보여줘요"></label>
    <div data-show-cat="med"><div class="fld2"><label class="fld"><span>효과 시작 (복용 후 분)</span><input name="fxon" type="number" inputmode="numeric" min="0" max="600" value="${it.fx?.on ?? ''}" placeholder="없음"></label><label class="fld"><span>지속 (시간)</span><input name="fxdur" type="number" inputmode="decimal" step="0.5" min="0" max="24" value="${it.fx?.dur ?? ''}" placeholder="없음"></label></div>
    <p class="hint">효과 구간을 직접 입력하면 그래프에 표시하고, 그 시간에는 집중할 일을 먼저 권해요. 비워 두면 쓰지 않아요.</p></div>
    <p class="err" id="sheet-err" hidden></p>
    <div class="row-btns"><button class="btn pri" data-act="save">저장</button>${cur ? '<button class="btn danger" data-act="del">삭제</button>' : ''}</div>`;
  const refresh = () => {
    const m = segv('mode'), c = segv('cat');
    document.querySelectorAll('#sheet [data-show]').forEach(el => (el.hidden = !el.dataset.show.split(' ').includes(m)));
    document.querySelectorAll('#sheet [data-show-cat]').forEach(el => (el.hidden = el.dataset.showCat !== c));
  };
  let armed = false;
  openSheet(cur ? '항목 편집' : '항목 추가', 'ITEM', body, {
    onseg: refresh,
    save() {
      const name = v('name').trim();
      if (!name) return sheetErr('이름을 적어 주세요');
      const num = n => {
        const x = parseFloat(v(n));
        return Number.isFinite(x) && x > 0 ? x : undefined;
      };
      const m = segv('mode'), cat = segv('cat');
      const type = m.startsWith('log') ? 'log' : m, ask = type === 'log' ? m.slice(4) : undefined;
      const goal = type === 'check' ? undefined : num('goal');
      const fxdur = cat === 'med' ? num('fxdur') : undefined;
      const item = {
        ...(cur || {}),
        name,
        icon: v('icon').trim() || '⭐',
        cat,
        type,
        ask,
        block: segv('block'),
        essential: $('#sheet [name="essential"]').checked || undefined,
        target: type === 'count' ? num('target') : undefined,
        every: type === 'count' ? num('every') : undefined,
        unit: type === 'count' || ask === 'num' ? v('unit').trim() || undefined : undefined,
        goal: goal ? { total: Math.round(goal), from: cur?.goal?.from || todayKey() } : undefined,
        fx: fxdur ? { on: Math.round(parseFloat(v('fxon')) || 0), dur: fxdur } : undefined,
      };
      if (!cur) item.since = todayKey();
      store.saveItem(item);
      store.setLocal({ seen: { ...local().seen, setup: 1 } }, true);
      closeSheet();
      toast('저장했어요');
    },
    del(_, el) {
      if (!armed) {
        armed = true;
        el.textContent = '한 번 더 누르면 삭제';
        return;
      }
      store.deleteItem(cur.id);
      closeSheet();
      toast('항목을 지웠어요. 지난 기록은 남아 있어요');
    },
  });
  refresh();
}

function openDdaySheet(id) {
  const cur = id ? (cfg().ddays || []).find(d => d.id === id) : null;
  let armed = false;
  openSheet(cur ? '날짜 편집' : '날짜 추가', 'DATE', `<label class="fld"><span>이름</span><input name="label" maxlength="20" value="${esc(cur?.label || '')}" placeholder="시험, 마감, 발표" autocomplete="off"></label>
    <div class="fld2"><label class="fld"><span>시작일 (선택)</span><input name="from" type="date" value="${esc(cur?.from || '')}"></label><label class="fld"><span>끝나는 날 (선택)</span><input name="to" type="date" value="${esc(cur?.to || '')}"></label></div>
    <p class="hint">끝나는 날을 넣으면 D-day, 시작일을 넣으면 몇 주차인지 보여줘요.</p><p class="err" id="sheet-err" hidden></p>
    <div class="row-btns"><button class="btn pri" data-act="save">저장</button>${cur ? '<button class="btn danger" data-act="del">삭제</button>' : ''}</div>`, {
    save() {
      const label = v('label').trim(), from = v('from') || undefined, to = v('to') || undefined;
      if (!label) return sheetErr('이름을 적어 주세요');
      if (!from && !to) return sheetErr('날짜를 하나 이상 넣어 주세요');
      store.saveDday({ id: cur?.id, label, from, to });
      closeSheet();
    },
    del(_, el) {
      if (!armed) {
        armed = true;
        el.textContent = '한 번 더 누르면 삭제';
        return;
      }
      store.deleteDday(cur.id);
      closeSheet();
    },
  });
}

function defaultRepo() {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/);
  return m ? `${m[1]}/today-data` : '';
}
function openSyncSheet() {
  const l = local(), s = sync.status();
  const tokenUrl = 'https://github.com/settings/personal-access-tokens/new?name=today-sync&description=' + encodeURIComponent('오늘 앱 기록 동기화') + '&expires_in=365&contents=write';
  const body = `${l.gh ? `<div class="status ${s.state === 'error' ? 'bad' : ''}"><b>${esc(l.gh.repo)}</b><br>${esc(syncLine())}</div>` : '<p class="lead">기록을 내 GitHub 비공개 저장소에 올려서, 폰과 컴퓨터가 같은 기록을 보고 백업도 되게 해요.</p>'}
    <label class="fld"><span>저장소 (계정/저장소)</span><input name="repo" value="${esc(l.gh?.repo || defaultRepo())}" placeholder="내계정/today-data" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <label class="fld"><span>토큰${l.gh ? ' (바꿀 때만 입력)' : ''}</span><input name="token" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <p class="err" id="sheet-err" hidden></p>
    <div class="row-btns"><button class="btn pri" data-act="connect">${l.gh ? '다시 연결' : '연결하기'}</button>${l.gh ? '<button class="btn" data-act="sync-now">지금 동기화</button><button class="btn danger" data-act="disconnect">연결 끊기</button>' : ''}</div>
    <details ${l.gh ? '' : 'open'}><summary>토큰 만드는 방법</summary><ol class="steps">
      <li><a href="${tokenUrl}" target="_blank" rel="noopener">GitHub 토큰 만들기 화면 열기</a></li>
      <li>Repository access에서 Only select repositories를 고르고, 기록용 비공개 저장소 하나만 선택해요</li>
      <li>Permissions의 Contents가 Read and write인지 확인해요</li>
      <li>Generate token을 누르고, 나온 값을 복사해서 위 칸에 붙여 넣어요</li></ol></details>
    <p class="hint">토큰은 이 기기에만 저장돼요. 공개 저장소는 연결되지 않아요. 연결을 끊어도 기기의 기록은 남아요.</p>`;
  let armed = false;
  openSheet('GitHub 동기화', 'SYNC', body, {
    async connect(_, el) {
      const label = el.textContent;
      el.disabled = true;
      el.textContent = '연결 중…';
      try {
        await sync.connect(v('repo'), v('token') || local().gh?.token);
        store.setLocal({ seen: { ...local().seen, backup: 1 } }, true);
        closeSheet();
        toast('연결했어요. 이제 자동으로 동기화돼요');
      } catch (e) {
        sheetErr(e?.message || '연결하지 못했어요');
        el.disabled = false;
        el.textContent = label;
      }
    },
    'sync-now'() {
      closeSheet();
      actions['sync-now']();
    },
    disconnect(_, el) {
      if (!armed) {
        armed = true;
        el.textContent = '한 번 더 누르면 끊기';
        return;
      }
      sync.disconnect();
      closeSheet();
      toast('연결을 끊었어요. 토큰을 지웠어요');
    },
  });
}

function openPlaceSheet() {
  openSheet('장소 저장', 'PLACE', `<label class="fld"><span>이름</span><input name="name" maxlength="12" placeholder="집, 회사, 헬스장" autocomplete="off" autofocus></label><p class="hint">지금 있는 곳을 이 이름으로 기억해요. 반경 150m 안에서 기록하면 장소 이름이 붙어요.</p><p class="err" id="sheet-err" hidden></p>
    <div class="row-btns"><button class="btn pri" data-act="save">지금 위치로 저장</button></div>`, {
    save(_, el) {
      const name = v('name').trim();
      if (!name) return sheetErr('이름을 적어 주세요');
      el.disabled = true;
      navigator.geolocation.getCurrentPosition(
        p => {
          store.savePlace({ name, lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5), r: 150 });
          closeSheet();
          toast(`${name} 저장했어요`);
        },
        () => {
          el.disabled = false;
          sheetErr('위치를 가져오지 못했어요. 브라우저의 위치 권한을 확인해 주세요');
        },
        { timeout: 15000 },
      );
    },
  });
}

async function share(text) {
  try {
    if (navigator.share) return await navigator.share({ text });
  } catch (e) {
    if (e?.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('보고 내용을 복사했어요. 보낼 사람에게 붙여 넣어요');
  } catch {
    openSheet('보고하기', 'REPORT', `<p class="lead">아래 내용을 복사해서 보내요.</p><textarea rows="8" readonly>${esc(text)}</textarea>`);
  }
}

// ---------- 집중 타이머 ----------

let focusTimer = 0, audio = null;
function ensureFocusTick() {
  const on = !!local().focus;
  if (on && !focusTimer) focusTimer = setInterval(tickFocus, 1000);
  if (!on && focusTimer) {
    clearInterval(focusTimer);
    focusTimer = 0;
  }
}
function tickFocus() {
  const f = local().focus;
  if (!f) return ensureFocusTick();
  const left = f.start + f.dur * MIN - now();
  if (left <= 0) return finishFocus(true);
  const c = $('#focus-clock'), b = $('#focus-fill');
  if (c) c.textContent = mmss(left);
  if (b) b.style.width = (100 - (left / (f.dur * MIN)) * 100).toFixed(1) + '%';
}
function beep() {
  try {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.9);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.9);
  } catch {
    /* 소리를 낼 수 없는 상태 */
  }
}
function finishFocus(auto) {
  const f = local().focus;
  if (!f) return;
  const min = Math.min(f.dur, Math.round((now() - f.start) / MIN));
  store.setLocal({ focus: null });
  if (min >= 1) store.logEvent(C.dayKey(f.start, rollover()), 'focus', { t: f.start, min, note: f.label || undefined, autoWake: true });
  if (auto) {
    haptic([200, 100, 200]);
    beep();
    toast(`집중 ${min}분 끝. 잠깐 쉬어요`);
  } else toast(min >= 1 ? `집중 ${min}분 기록했어요` : '1분이 안 돼서 기록하지 않았어요');
}

// ---------- 동작 ----------

function runCoach(a) {
  if (!a) return;
  const key = todayKey();
  if (a.act === 'check' || a.act === 'count') addAt(itemById(a.arg), key);
  else if (a.act === 'log') actions.tile(a.arg);
  else if (a.act === 'skip') {
    store.setSkip(key, a.arg, true);
    toast('오늘은 건너뛰어요', { label: '취소', fn: () => store.setSkip(key, a.arg, false) });
  } else if (a.act === 't3-done') store.setTop3(key, a.arg, { done: now() });
  else if (a.act === 'go-cond') $('#cond')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else actions[a.act]?.(a.arg);
}

const actions = {
  tab(arg) {
    ui.tab = arg;
    paint();
    window.scrollTo(0, 0);
  },
  'day-prev'() {
    ui.date = C.addDays(viewKey(), -1);
    const k = ui.date;
    if (!store.hasDay(k) && local().gh) sync.fetchDay(k).then(render);
    render();
  },
  'day-next'() {
    ui.date = C.addDays(viewKey(), 1);
    render();
  },
  'day-today'() {
    ui.date = null;
    render();
  },
  'goto-day'(k) {
    ui.date = k;
    actions.tab('today');
  },
  wake(arg) {
    store.setWake(todayKey(), now() - arg * MIN);
    ensureSeason();
    haptic(12);
  },
  'time-wake': () => openTimeSheet('wake'),
  'time-sleep': () => openTimeSheet('sleep'),
  tile(id) {
    const it = itemById(id);
    if (!it) return;
    if (!isToday()) return openTileSheet(id);
    const s = C.itemState(store.day(todayKey()), it);
    if (it.type === 'check' && (s.done || s.skipped)) return openTileSheet(id);
    addAt(it, todayKey());
  },
  'tile-menu': id => openTileSheet(id),
  coach(arg) {
    runCoach(coachList(store.day(todayKey()))[0]?.[arg]);
  },
  'coach-later'() {
    const s = coachList(store.day(todayKey()))[0];
    if (s) store.setLocal({ snooze: { ...local().snooze, [s.key]: now() + 45 * MIN } });
  },
  seen(k) {
    store.setLocal({ seen: { ...local().seen, [k]: 1 } });
  },
  lite(arg) {
    store.setLite(todayKey(), arg === '1');
    toast(arg === '1' ? '가볍게 모드. 필수만 챙겨요' : '전체 항목으로 돌아왔어요');
  },
  't3-edit': id => openTop3Sheet(id),
  't3-toggle'(id) {
    const key = viewKey(), t = store.day(key).top3.find(x => x.id === id);
    store.setTop3(key, id, { done: t?.done ? 0 : now() });
    haptic(12);
  },
  cond(arg) {
    const [id, n] = arg.split(':'), key = todayKey();
    const last = C.live(store.day(key)).filter(e => e.item === id).pop();
    if (last && now() - last.t < 10 * MIN) store.updateEvent(key, last.id, { v: +n });
    else store.logEvent(key, id, { v: +n, autoWake: true });
    haptic(10);
  },
  focus(arg) {
    const [m, t3] = String(arg).split(':');
    const label = t3 ? C.top3Of(store.day(todayKey())).find(t => t.id === t3)?.text : '';
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      audio.resume?.();
    } catch {
      audio = null;
    }
    store.setLocal({ focus: { start: now(), dur: +m, label: label || '' } });
    toast(`${m}분 집중 시작`);
  },
  'focus-stop': () => finishFocus(false),
  'focus-cancel'() {
    store.setLocal({ focus: null });
  },
  review: () => openReviewSheet(),
  report: () => share(C.dayReport(store.day(viewKey()), cfg())),
  'report-season'() {
    const { se, stats } = seasonDays();
    const lines = [`[시즌 ${se.n} 보고 · ${C.SEASON_DAYS}일 중 ${se.day}일째]`, `기록 ${stats.recorded}일 · 필수 달성 ${stats.essDays}일 · CLEAR ${stats.clearDays}일 · 누적 ${stats.exp} EXP`, `연속 기록 ${C.streak(getDay, todayKey())}일`];
    for (const it of C.activeItems(cfg())) if (it.goal?.total) lines.push(`${it.name} ${C.goalCount(it, allDays())}/${it.goal.total}`);
    share(lines.join('\n'));
  },
  ev: id => openEventSheet(id),
  'item-edit': id => openItemSheet(id),
  'item-add': () => openItemSheet(null),
  'item-suggest'(name) {
    openItemSheet(null, C.SUGGESTED.find(s => s.name === name));
  },
  'item-move'(arg) {
    const i = arg.lastIndexOf(':');
    store.moveItem(arg.slice(0, i), +arg.slice(i + 1));
  },
  'dday-add': () => openDdaySheet(null),
  'dday-edit': id => openDdaySheet(id),
  'sync-open': () => openSyncSheet(),
  'sync-now'() {
    sync.syncNow().then(() => {
      const s = sync.status();
      toast(s.state === 'ok' ? '동기화했어요' : s.msg || '동기화하지 못했어요');
    });
  },
  'loc-toggle'() {
    if (local().loc) return store.setLocal({ loc: false });
    if (!navigator.geolocation) return toast('이 브라우저는 위치를 쓸 수 없어요');
    navigator.geolocation.getCurrentPosition(
      () => store.setLocal({ loc: true }),
      () => toast('위치 권한이 필요해요. 브라우저 설정에서 허용해 주세요'),
      { timeout: 15000 },
    );
  },
  'place-add': () => openPlaceSheet(),
  'place-del': id => store.deletePlace(id),
  theme(arg) {
    store.setLocal({ theme: arg });
    applyTheme();
  },
  export() {
    const blob = new Blob([JSON.stringify(store.exportAll(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `today-backup-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  },
  'import-pick': () => $('#imp')?.click(),
  'sheet-close': () => closeSheet(),
  'toast-act'() {
    const fn = toastFn;
    toastFn = null;
    $('#toast').hidden = true;
    fn?.();
  },
  seg(arg, el) {
    const g = el.closest('.seg');
    g.dataset.value = arg;
    g.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
    sheetActs.onseg?.();
  },
  emoji(arg) {
    const el = $('#sheet [name="icon"]');
    if (el) el.value = arg;
  },
};

const changes = {
  rollover: el => store.setPrefs({ rollover: +el.value }),
  season: el => el.value && store.setPrefs({ seasonStart: el.value }),
  async import(el) {
    const file = el.files?.[0];
    if (!file) return;
    try {
      const n = store.importAll(JSON.parse(await file.text()));
      toast(`${n}일치 기록을 가져왔어요`);
    } catch (e) {
      toast(e?.message || '파일을 읽지 못했어요');
    }
    el.value = '';
  },
};

function applyTheme() {
  const t = local().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------- 입력 연결 ----------

let holdTimer = 0, held = false, hx = 0, hy = 0;
const flushDown = () => {
  downAt = 0;
  if (pending) {
    pending = false;
    render();
  }
};
document.addEventListener('pointerdown', e => {
  downAt = performance.now();
  setTimeout(() => downAt && performance.now() - downAt >= 1500 && flushDown(), 1600);
  held = false;
  clearTimeout(holdTimer);
  const el = e.target.closest?.('[data-hold]');
  if (!el) return;
  hx = e.clientX;
  hy = e.clientY;
  holdTimer = setTimeout(() => {
    held = true;
    haptic(18);
    actions[el.dataset.hold]?.(el.dataset.arg, el);
  }, 480);
}, true);
document.addEventListener('pointermove', e => {
  if (Math.abs(e.clientX - hx) + Math.abs(e.clientY - hy) > 12) clearTimeout(holdTimer);
}, true);
for (const ev of ['pointerup', 'pointercancel']) {
  document.addEventListener(ev, () => {
    clearTimeout(holdTimer);
    setTimeout(flushDown, 40);
  }, true);
}
window.addEventListener('scroll', () => clearTimeout(holdTimer), { passive: true });
document.addEventListener('contextmenu', e => {
  if (e.target.closest?.('[data-hold]')) e.preventDefault();
});
document.addEventListener('click', e => {
  const el = e.target.closest?.('[data-act]');
  const wasHeld = held;
  held = false;
  if (!el || el.disabled) return;
  // 길게 눌러 메뉴를 연 직후, 같은 타일에 떨어지는 클릭만 무시한다
  if (wasHeld && el.dataset.hold) return e.preventDefault();
  const fn = sheetActs[el.dataset.act] || actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el.dataset.arg, el);
});
document.addEventListener('change', e => {
  const el = e.target.closest?.('[data-change]');
  if (el) changes[el.dataset.change]?.(el);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.closest('#sheet') && sheetActs.save) {
    e.preventDefault();
    sheetActs.save(undefined, $('#sheet [data-act="save"]'));
  }
});
window.addEventListener('popstate', () => closeSheet(true));

let lastExp = { key: '', exp: 0 };
store.subscribe(kind => {
  if (kind !== 'local') ver++;
  if (kind === 'data') sync.schedule();
  const tk = todayKey(), e = C.expOf(store.day(tk), cfg());
  if (kind === 'data' && lastExp.key === tk && lastExp.exp < C.EXP_GOAL && e >= C.EXP_GOAL) burst();
  lastExp = { key: tk, exp: e };
  if (store.failed()) toast('기기 저장 공간이 부족해요. 설정에서 내보내기를 해 주세요');
  render();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return sync.flush();
  if (local().focus) tickFocus();
  if (local().gh) sync.syncNow();
  render();
});
window.addEventListener('online', () => local().gh && sync.syncNow());
window.addEventListener('offline', render);
window.addEventListener('storage', e => {
  if (!e.key?.startsWith('today.')) return;
  store.invalidate(e.key);
  ver++;
  render();
});
setInterval(() => !document.hidden && render(), 30000);
setInterval(() => !document.hidden && local().gh && sync.syncNow(), 180000);

applyTheme();
lastExp = { key: todayKey(), exp: C.expOf(store.day(todayKey()), cfg()) };
paint();
if (local().focus) tickFocus();
if (local().gh) sync.syncNow();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
