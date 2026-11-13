// 화면. 상태는 store가 갖고, 여기서는 그리기와 입력 처리만 한다.
import * as C from './core.js';
import { createStore } from './store.js';
import { createSync } from './sync.js';
import { stripSvg, flowSvg, medSvg, peakSvg, radarSvg } from './chart.js';
import * as PK from './pk.js';
import * as GM from './game.js';
import * as WX from './weather.js';

const VERSION = '1.5';
const { MIN, HOUR } = C;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = createStore({ storage: window.localStorage });
const now = () => Date.now();
const cfg = () => store.config();
const local = () => store.local();
const rollover = () => cfg().prefs?.rollover ?? 4;
const todayKey = () => C.dayKey(now(), rollover());
const ui = { tab: 'today', date: null, just: null, peakMode: 'dose', peakRating: 'attn' };
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
const nameOf = id => {
  const it = itemById(id) || C.SPECIAL[id];
  if (it) return it;
  if (id === 'report5') return { name: '금요일 5줄 보고', icon: '📮' };
  if (id?.startsWith('q:')) {
    const t = store.game()?.quest?.stages?.flatMap(s => s.tasks || []).find(x => x.id === id.slice(2));
    return { name: t ? `퀘스트 · ${t.text}` : '퀘스트', icon: '🗺️' };
  }
  if (id?.startsWith('rt:')) return { name: '아침 루틴', icon: '🌅' };
  return { name: '삭제된 항목', icon: '▫️' };
};
const season = () => C.seasonInfo(todayKey(), cfg().prefs?.seasonStart);
const clampT = (t, [lo, hi]) => Math.min(hi, Math.max(lo, t));
// 그날 기록할 수 있는 시각: 논리적 하루의 시작부터, 오늘이면 지금까지
function timeRange(key) {
  const lo = C.dayStartTs(key, rollover());
  return [lo, Math.max(lo, Math.min(lo + 24 * HOUR - MIN, now()))];
}
// 평소 시각은 체크 항목에만 쓴다 (물 같은 횟수는 의미가 없다)
function usualFor(it, key) {
  if (!it || it.type !== 'check') return null;
  const hist = C.lastDays(C.addDays(key, -1), 21).map(getDay);
  return C.usualTime(it, hist, { wake: C.wakeOf(getDay(key)), key, rollover: rollover() });
}
function typicalWakeTs(key) {
  const m = C.typicalWake(C.lastDays(C.addDays(key, -1), 14).map(getDay));
  return m == null ? null : C.tsFor(key, C.fmtMinutesOfDay(m), rollover());
}
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

// 연속: 하루 빠져도 이어지고 이틀 연속으로 빠지면 끊긴다. 데이터가 바뀔 때만 다시 센다.
let chainMemo = { k: '' };
function chainCtx() {
  const k = ver + '|' + todayKey();
  if (chainMemo.k !== k) chainMemo = { k, first: store.dayKeys()[0] || todayKey(), all: null, items: new Map() };
  return chainMemo;
}
const firstKey = () => chainCtx().first;
function chainNow() {
  const c = chainCtx();
  if (!c.all) c.all = C.chainInfo(k => (k < c.first ? null : C.dayStatus(getDay(k), cfg())), todayKey());
  return c.all;
}
function itemChainN(it) {
  const c = chainCtx();
  if (!c.items.has(it.id)) {
    const from = it.since && it.since > c.first ? it.since : c.first;
    c.items.set(it.id, C.chainInfo(k => (k < from ? null : getDay(k) ? C.itemStatus(getDay(k), it) : 0), todayKey()).n);
  }
  return c.items.get(it.id);
}

// ---------- 약 효과 계산 (약 정보는 비공개 저장소의 meds.json에서) ----------
const profiles = () => store.meds();
const profileById = id => profiles().find(p => p.id === id);
function typicalSleepTs(key) {
  const m = C.typicalSleep(C.lastDays(C.addDays(key, -1), 14).map(getDay), rollover());
  return m == null ? null : C.dayStartTs(key, rollover()) + m * MIN;
}
let medMemo = { k: '' };
function medCtx(key = viewKey()) {
  const k = `${ver}|${key}|${Math.floor(now() / (5 * MIN))}|${profiles().length}`;
  if (medMemo.k === k) return medMemo.v;
  let v = null;
  const P = profiles();
  if (P.length) {
    const items = C.activeItems(cfg(), key);
    const day = getDay(key), isToday_ = key === todayKey(), t = now();
    const doses = PK.dosesOf([getDay(C.addDays(key, -1)), day], items, P);
    const today = doses.filter(d => d.date === key);
    // 예정 시각이 있는데 아직 안 먹은 약: "예정대로 먹으면"의 곡선 (오늘이면 지금보다 이르게 잡지 않는다)
    const planned = [];
    for (const it of items) {
      if (!it.plan || !it.drugs?.length || !day) continue;
      const ds = C.doseState(it, day, { now: t, rollover: rollover() });
      if (!['upcoming', 'due', 'overdue'].includes(ds.kind)) continue;
      const at = isToday_ ? Math.max(ds.due, t) : ds.due;
      for (const l of it.drugs) {
        const p = profileById(l.id);
        if (p?.kind === 'curve') planned.push({ id: `plan:${it.id}:${p.id}`, item: it.id, name: it.name, t: at, due: ds.due, p, mg: +l.mg || +p.mg || 1, date: key, planned: true });
      }
    }
    const wake = C.wakeOf(day), lo = C.dayStartTs(key, rollover());
    const t0 = Math.max(lo, Math.min(wake || lo + 4 * HOUR, today[0]?.t ?? Infinity) - 30 * MIN);
    const sleepAt = typicalSleepTs(key);
    const ends = [...today, ...planned].filter(d => d.p.kind === 'curve').map(d => PK.plan(d.p, d.t).end + 30 * MIN);
    const t1 = Math.min(t0 + 24 * HOUR, Math.max(t0 + 16 * HOUR, ...ends, sleepAt ? sleepAt + 40 * MIN : 0, isToday_ ? t + HOUR : 0));
    const curve = doses.filter(d => d.p.kind === 'curve');
    const sr = PK.series(curve, t0, t1);
    const byG = new Map();
    for (const G of sr.groups) {
      const st = PK.groupStatus(G, sr.ts, t);
      if (st) byG.set(G.group, { ...G, ...st });
    }
    if (planned.length) {
      const sp = PK.series([...curve, ...planned], t0, t1);
      for (const H of sp.groups) {
        const st = PK.groupStatus(H, sp.ts, t);
        if (!st || !H.parts.some(P_ => P_.dose.planned)) continue;
        const G = byG.get(H.group) || { group: H.group, name: H.name, total: new Float64Array(sr.ts.length), parts: [], max: 0, effect: [], peak: [], nowRel: 0, effRel: st.effRel };
        Object.assign(G, { projTotal: H.total, projMax: st.max, projEffect: st.effect, projEffRel: st.effRel });
        byG.set(H.group, G);
      }
    }
    // 그래프 높이 기준: 실제와 예정 중 큰 쪽
    const groups = [...byG.values()].map(G => {
      const scale = Math.max(G.max || 0, G.projMax || 0);
      return { ...G, scale, effRel: G.max ? (G.effRel * G.max) / scale : (G.projEffRel * G.projMax) / scale };
    });
    v = { key, items, doses, today, planned, ts: sr.ts, groups, t0, t1, sleepAt, wake };
  }
  medMemo = { k, v };
  return v;
}
const medBands = key => (medCtx(key)?.groups || []).flatMap(G => G.effect);
const doseOpts = (key, extra = {}) => ({ now: now(), rollover: rollover(), ended: key < todayKey(), ...extra });
const doseOf = (it, day) => C.doseState(it, day, doseOpts(day?.date || todayKey()));

// 예정 있는 약의 결정 카드에 붙는 줄: 먹으면 / 건너뛰면 / 남은 핵심 / 최근 2주
function doseLines(it, day, mc) {
  const t = now(), lines = [], ds = doseOf(it, day);
  const first = C.live(day).find(e => e.item !== it.id && itemById(e.item)?.cat === 'med');
  if (first && ds.due) lines.push(`${nameOf(first.item).name} ${C.fmtTime(first.t)} → 예정 시각은 그 ${C.fmtDur((ds.due - first.t) / MIN)} 뒤`);
  const curves = (it.drugs || []).map(l => profileById(l.id)).filter(p => p?.kind === 'curve');
  if (mc && curves.length) {
    const G = mc.groups.find(g => g.group === (curves[0].group || curves[0].id));
    const takeAt = Math.max(t, ds.due || t);
    const endIf = G?.projEffect?.length ? G.projEffect[G.projEffect.length - 1][1] : Math.max(...curves.map(p => PK.plan(p, takeAt).end));
    const toSleep = end => {
      if (!mc.sleepAt) return '';
      const gap = (mc.sleepAt - end) / MIN;
      return gap >= 60 ? ` · 잠(${C.fmtTime(mc.sleepAt)})까지 ${C.fmtDur(gap)}` : ` · 평소 잠(${C.fmtTime(mc.sleepAt)})과 겹쳐요`;
    };
    lines.push(`먹으면 · 효과 ~${C.fmtTime(endIf)}${toSleep(endIf)}`);
    const endNo = G?.effect?.length ? G.effect[G.effect.length - 1][1] : null;
    lines.push(endNo && endNo > t ? `건너뛰면 · 지금 약 효과 하루 최고의 ${Math.round((G.nowRel || 0) * 100)}% · ~${C.fmtTime(endNo)}에 끝나요` : '건너뛰면 · 지금은 남은 약 효과가 거의 없어요');
  }
  const open = C.top3Of(day).filter(x => !x.done);
  if (open.length) lines.push(`남은 핵심 · ${open.map(x => x.text).join(', ')}`);
  const sm = C.doseSummary(C.lastDays(C.addDays(todayKey(), -1), 14).map(k => C.doseState(it, getDay(k), doseOpts(k, { ended: true }))));
  if (sm.taken + sm.skipped + sm.missed) lines.push(`최근 2주 · 먹음 ${sm.taken} · 건너뜀 ${sm.skipped}${sm.missed ? ` · 못 먹음 ${sm.missed}` : ''}`);
  return lines;
}

// 상태 글자: 타일, 오늘 약 일정, 복용 기록이 같이 쓴다
function doseText(ds, it) {
  const verb = it.cat === 'med' ? '먹음' : '완료';
  switch (ds.kind) {
    case 'taken': return `${C.fmtTime(ds.t)} ${verb}${ds.delay != null ? ' · 제시간' : ''}`;
    case 'late': return `${C.fmtTime(ds.t)} ${verb} · ${C.fmtDur(ds.delay)} 늦게`;
    case 'early': return `${C.fmtTime(ds.t)} ${verb} · ${C.fmtDur(-ds.delay)} 일찍`;
    case 'skipped': return `건너뜀${ds.why ? ` · ${C.SKIP_WHY[ds.why] || ds.why}` : ''}`;
    case 'missed': return `못 ${it.cat === 'med' ? '먹음' : '함'}${ds.why ? ` · ${C.SKIP_WHY[ds.why] || ds.why}` : ''}`;
    case 'upcoming': return `${C.fmtTime(ds.due)} 예정`;
    case 'due': return `${C.fmtTime(ds.due)} 예정 · 지금`;
    case 'overdue': return `${C.fmtTime(ds.due)} 예정 · ${C.fmtDur(ds.delay)} 지남`;
    case 'waiting': return `${nameOf(it.plan.after).name} 먹고 ${it.plan.h || 0}시간 뒤`;
    case 'none': return '기록 없음';
    default: return '';
  }
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

// ---------- 날씨·해 (켜면 1시간마다 새로 받는다) ----------
const wx = () => local().wx || {};
let wxBusy = false;
function wxEnsure(force) {
  const W = wx();
  if (!W.on || !W.loc || wxBusy || !navigator.onLine) return;
  if (!force && W.data && now() - W.data.at < HOUR) return;
  wxBusy = true;
  WX.fetchWeather(W.loc, (u, o) => fetch(u, o), now())
    .then(data => store.setLocal({ wx: { ...wx(), data } }))
    .catch(() => {})
    .finally(() => (wxBusy = false));
}
function wxLine(key) {
  const W = wx();
  if (!W.on || !W.data) return '';
  const sun = WX.sunOf(W.data, key);
  const d = WX.describe(W.data.code);
  const parts = [];
  if (key === todayKey() && W.data.temp != null) parts.push(`${d.icon} ${Math.round(W.data.temp)}°`);
  if (sun) parts.push(now() < sun.set ? `일몰 ${C.fmtTime(sun.set)}` : `일출 ${C.fmtTime(sun.rise + 24 * HOUR)}`);
  return parts.join(' · ');
}

function topHtml() {
  const key = viewKey(), day = store.day(key), today = isToday(), w = C.wakeOf(day);
  let sub = '오늘';
  if (today && w && now() > w) sub = `오늘 · 깨어난 지 ${C.fmtDur((now() - w) / MIN)}`;
  if (today && wxLine(key)) sub += ` · ${wxLine(key)}`;
  if (!today) {
    const n = Math.round((C.keyToDate(todayKey()) - C.keyToDate(key)) / 86400000);
    sub = `${n === 1 ? '어제' : n + '일 전'} · 누르면 오늘로`;
  }
  return `<button class="nav-btn" data-act="day-prev" aria-label="이전 날">${IC.left}</button>
    <button class="date" data-act="day-today"><span class="date-main">${C.fmtDate(key)}</span><span class="date-sub">${sub}</span></button>
    <button class="nav-btn" data-act="day-next" aria-label="다음 날" ${today ? 'disabled' : ''}>${IC.right}</button>
    <button class="sync-btn" data-act="sync-open" aria-label="동기화 상태: ${esc(syncLine())}"><span class="sync-dot ${syncClass()}"></span></button>`;
}

// ---------- 레벨과 스탯 (기록에서 매번 다시 계산) ----------
let gameMemo = { k: '' };
function gameCtx() {
  const tk = todayKey(), k = `${ver}|${tk}`;
  if (gameMemo.k === k) return gameMemo.v;
  const ledger = GM.expLedger(firstKey(), tk, getDay, cfg());
  const def = store.game();
  const stats = def ? GM.statsNow(def, { cfg: cfg(), days: allDays(), todayKey: tk, rollover: rollover() }) : [];
  const quest = def?.quest ? GM.questState(def.quest, { cfg: cfg(), days: allDays(), todayKey: tk, rollover: rollover() }) : null;
  const sBonus = GM.statBonus(stats) + (quest?.bonus || 0);
  const total = ledger.reduce((a, r) => a + r.exp + r.bonus, 0) + sBonus;
  const L = GM.levelOf(total);
  // 레벨 기록: 누적이 문턱을 넘은 날 (스탯 보너스는 오늘에 더한다)
  const ups = [];
  let acc = 0, lv = 1;
  ledger.forEach((r, i) => {
    acc += r.exp + r.bonus + (i === ledger.length - 1 ? sBonus : 0);
    while (acc >= GM.needFor(lv)) {
      acc -= GM.needFor(lv);
      lv++;
      ups.push({ lv, key: r.key });
    }
  });
  const today = ledger.find(r => r.key === tk) || { exp: 0, bonus: 0, why: [] };
  const v = { ledger, def, stats, quest, sBonus, total, L, tier: GM.tierOf(L.lv), ups, today };
  gameMemo = { k, v };
  return v;
}

function hudHtml() {
  const g = gameCtx(), ch = chainNow(), e = g.today.exp, clear = e >= C.EXP_GOAL;
  const fire = ch.atRisk ? `🔥 ${ch.n}일 · 오늘 이어가기` : ch.n ? `🔥 ${ch.n}일 연속` : '🔥 오늘부터';
  return `<div class="hud-in"><span class="hud-lv">Lv.<b>${g.L.lv}</b></span><span class="hud-name">${esc(g.tier.name)}</span><span class="hud-chip ${clear ? 'clear' : ''}">${clear ? `오늘 ${e} · CLEAR +${GM.CLEAR_BONUS}` : `오늘 ${e}/${C.EXP_GOAL}`}</span><span class="hud-max ${ch.atRisk ? 'risk' : ''}">${fire}</span></div>
    <div class="hud-exp"><i style="width:${((g.L.into / g.L.need) * 100).toFixed(1)}%"></i><span>EXP <b>${g.L.into}</b> / ${g.L.need} · 다음 레벨까지 <b>${g.L.need - g.L.into}</b></span></div>`;
}

// ---------- 오늘 탭 ----------

function ddayHtml() {
  const dd = (cfg().ddays || []).filter(d => !d.del);
  if (!dd.length) return '';
  const tk = todayKey();
  return `<div class="ddays">${dd.map(d => `<span class="dday"><b>${esc(C.ddayInfo(d, tk).text || '날짜 없음')}</b>${esc(d.label)}</span>`).join('')}</div>`;
}

function startHtml() {
  const u = typicalWakeTs(todayKey());
  const usual = u && u <= now() - 10 * MIN ? `<button class="btn" data-act="wake-at" data-arg="${u}">평소 ${C.fmtTime(u)}</button>` : '';
  return `<section class="win start-card"><div class="say">${MOCHI}<div><b>언제 일어났어요?</b><p>고른 시각부터 오늘이 시작돼요. 늦게 일어난 날도 똑같이 흘러가요.</p></div></div>
    <div class="row-btns"><button class="btn pri" data-act="wake" data-arg="0">방금</button>${usual}<button class="btn" data-act="wake" data-arg="30">30분 전</button><button class="btn" data-act="wake" data-arg="60">1시간 전</button><button class="btn" data-act="wake" data-arg="120">2시간 전</button><button class="btn" data-act="time-wake">직접 고르기</button></div></section>`;
}

// 어제 체크 안 된 필수: 했는데 기록만 못 한 날을 다음 날 바로잡는다
function retroHtml() {
  const yk = C.addDays(todayKey(), -1);
  if (yk < firstKey() || local().seen['retro:' + yk]) return '';
  const list = C.retroItems(store.day(yk), cfg());
  if (!list.length) return '';
  const rows = list.map(it => `<div class="retro-row"><span class="row-ic">${esc(it.icon)}</span><span class="retro-n">${esc(it.name)}</span><button class="btn sm pri" data-act="retro-yes" data-arg="${esc(it.id)}">${it.cat === 'med' ? '먹었어요' : '했어요'}</button><button class="btn sm" data-act="retro-no" data-arg="${esc(it.id)}">${it.cat === 'med' ? '안 먹었어요' : '못 했어요'}</button></div>`).join('');
  return win('어제 기록 정리', 'YESTERDAY', `<p class="lead">어제 체크 안 된 필수예요. 했는데 기록만 못 했다면 눌러 주세요. 평소 시각으로 들어가고, 바로 고칠 수 있어요.</p>${rows}`, '', `<button class="icon-btn" data-act="retro-close" aria-label="어제 기록 정리 닫기">${IC.x}</button>`);
}

function stripHtml(day, today) {
  const w = C.wakeOf(day), sl = C.sleepOf(day), p = C.progress(day, cfg());
  const end = sl ? '🌙 ' + C.fmtTime(sl) : w ? '~' + C.fmtTime(w + C.AWAKE_HOURS * HOUR) : '';
  return `<section class="win"><button class="strip-btn" data-act="tab" data-arg="flow" aria-label="오늘 흐름 자세히 보기">${stripSvg(day, cfg(), now(), today, medBands(day.date))}
    <span class="strip-meta"><span>${w ? '☀️ ' + C.fmtTime(w) : '기상 기록 없음'}</span><span>필수 <b>${p.essDone}/${p.essTotal}</b> · 전체 <b>${p.done}/${p.total}</b></span><span>${end}</span></span></button>${doseChipsHtml(day)}</section>`;
}

// 오늘 약 일정: 약 항목마다 먹음·예정·건너뜀을 한 줄로 (누르면 시각을 정해 기록하는 창)
function doseChipsHtml(day) {
  const meds = C.activeItems(cfg(), day.date).filter(i => i.cat === 'med' && i.type === 'check');
  if (!meds.length) return '';
  return `<div class="dose-chips">${meds.map(it => {
    const ds = doseOf(it, day);
    const txt = doseText(ds, it) || '아직';
    return `<button class="dose-chip k-${ds.kind}" data-act="tile-menu" data-arg="${esc(it.id)}"><span>${esc(it.icon)} ${esc(it.name)}</span><b>${esc(txt)}</b></button>`;
  }).join('')}</div>`;
}

function coachList(day) {
  const tk = todayKey();
  const hist = C.lastDays(C.addDays(tk, -1), 14).map(getDay);
  const mc = medCtx(tk);
  const windows = (mc?.groups || []).flatMap(G => [...G.effect.map(([a, b]) => ({ start: a, end: b, name: G.name })), ...G.peak.map(([a, b]) => ({ start: a, end: b, name: G.name, peak: true }))]);
  const list = C.coach({ now: now(), day, cfg: cfg(), local: local(), typical: C.typicalWake(hist), chain: chainNow(), windows });
  if (list[0].key === 'start' || list[0].key === 'closed') return list;
  const l = local(), sn = k => (l.snooze?.[k] || 0) > now();
  const extra = [];
  if (mc) {
    const t = now();
    // 약 먹고 1·3·6·9시간쯤(약마다 다름) 집중도를 한 번씩 묻는다 → 내 피크 그래프의 재료
    const lastAttn = C.live(day).filter(e => e.item === 'attn').pop();
    if (!lastAttn || t - lastAttn.t > 60 * MIN) {
      const asked = new Set();
      for (const d of mc.today) {
        if (d.p.kind !== 'curve' || asked.has(d.p.id)) continue;
        asked.add(d.p.id);
        for (const hh of d.p.checks || [1, 3, 6, 9]) {
          const k = `attn:${d.ev}:${hh}`;
          if (Math.abs(t - (d.t + hh * HOUR)) <= 40 * MIN && !sn(k)) {
            extra.push({ pri: 24, key: k, icon: '🧠', tone: 'calm', title: `${d.p.name} 먹은 지 ${hh}시간, 지금 집중 어때요?`, sub: '한 번 누르면 내 피크 그래프가 정확해져요', scale: 'attn' });
          }
        }
      }
    }
    // 효과 구간이 막 끝난 때
    for (const G of mc.groups) {
      const last = G.effect[G.effect.length - 1];
      if (last && t > last[1] && t - last[1] < 60 * MIN && !sn('wear:' + G.group)) {
        extra.push({ pri: 44, key: 'wear:' + G.group, icon: '🌇', tone: 'calm', title: '약 효과가 내려가는 시간이에요', sub: '머리를 덜 쓰는 일로 바꾸거나 잠깐 쉬어요. 이때 피곤하거나 예민해지면 기록해 둬요' });
      }
    }
    // 각성 계열 약을 늦게 먹으려 할 때: 효과가 평소 잠드는 시각까지 가는지 알려준다
    for (const s of list) {
      if (s.key.startsWith('do:') && mc.sleepAt) {
        const stim = (itemById(s.key.slice(3))?.drugs || []).map(x => profileById(x.id)).filter(p => p?.kind === 'curve' && p.stim);
        if (stim.length) {
          const end = Math.max(...stim.map(p => PK.plan(p, t).end));
          if (end > mc.sleepAt - 60 * MIN) s.sub = `지금 먹으면 효과가 ${C.fmtTime(end)}쯤까지 가요. 평소 잠드는 ${C.fmtTime(mc.sleepAt)}에 가까워요`;
        }
      }
      if (s.key.startsWith('meal:') && mc.groups.some(G => G.nowRel >= PK.EFFECT && G.parts.some(P => P.dose.p.appetite))) s.sub += ' · 약 효과 중엔 배고픔을 덜 느낄 수 있어요';
    }
  }
  // 예정 시각이 있는 약: 먹으면/건너뛰면을 같이 보여준다
  for (const s of list) if (s.key.startsWith('dose:')) s.lines = doseLines(itemById(s.key.slice(5)), day, mc);
  const se = season();
  if (se.left === 0 && !sn('season')) extra.push({ pri: 38, key: 'season', icon: '🏁', tone: 'now', title: `시즌 ${se.n} 마지막 날이에요`, sub: '2주 결과를 확인하고 보고해요', action: { label: '결과 보기', act: 'tab', arg: 'week' } });
  if (!l.seen.setup && !sn('setup')) extra.push({ pri: 50, key: 'setup', icon: '🛠️', tone: 'calm', title: '기본 항목을 내 루틴으로 바꿔요', sub: '약 이름, 시간대, 필수 여부를 설정에서 고칠 수 있어요', action: { label: '설정 열기', act: 'tab', arg: 'set' }, alt: { label: '괜찮아요', act: 'seen', arg: 'setup' } });
  // 금요일 5줄: 금요일 저녁(17시 이후)에 이번 주 보고가 없으면
  const nowD = new Date(now());
  if (nowD.getDay() === 5 && nowD.getHours() >= 17 && !GM.reportsOf(C.lastDays(tk, 3).map(getDay)).length && !sn('report5')) {
    const to = reportCfg().to;
    extra.push({ pri: 20, key: 'report5', icon: '📮', title: '금요일 5줄 보내는 날', sub: `${to ? `${to}에게 ` : ''}이번 주 한 것·숫자·막힌 것·다음 주·부탁. 기록은 미리 채워 둘게요`, action: { label: '쓰기', act: 'report5' } });
  }
  // 매일 모으는 한 줄 (예: 사장님 불편): 정한 시각이 지났는데 오늘 아직 없으면
  for (const dly of store.game()?.daily || []) {
    const it = itemById(dly.item);
    if (!it || C.itemState(day, it).count || sn('daily:' + it.id)) continue;
    if (dly.after && C.fmtTime(now()) < dly.after) continue;
    if (dly.days && (dly.days === 'weekend') !== [0, 6].includes(C.keyToDate(day.date).getDay())) continue; // 평일만·주말만
    extra.push({ pri: 31, key: 'daily:' + it.id, icon: it.icon, tone: 'calm', title: dly.text || `${it.name} 남겨요`, sub: dly.sub || '', action: { label: '쓰기', act: 'tile', arg: it.id } });
  }
  // 아침 햇빛: 일어나고 3시간 안, 해가 떠 있고, 비·눈이 아닐 때 (아침 빛은 밤에 졸음이 오는 시각을 앞당긴다)
  const W = wx(), sun = W.on && W.data ? WX.sunOf(W.data, tk) : null, t = now(), wk = C.wakeOf(day);
  if (sun && wk && t - wk < 3 * HOUR && t > sun.rise && t < sun.set - HOUR && !WX.isWet(W.data) && !sn('sun')) {
    const walk = C.activeItems(cfg(), tk).find(i => i.id === 'walk' || i.name.includes('산책'));
    const walked = walk && C.itemState(day, walk).count;
    if (!walked) {
      const d = WX.describe(W.data.code);
      extra.push({ pri: 33, key: 'sun', icon: '☀️', tone: 'calm', title: '아침 햇빛 10분 어때요?', sub: `지금 ${d.text} ${Math.round(W.data.temp)}°, 일몰 ${C.fmtTime(sun.set)}. 아침 빛을 보면 밤에 졸음이 오는 시각이 앞당겨져요`, action: walk ? { label: `${walk.name} 기록`, act: 'tile', arg: walk.id } : null });
    }
  }
  if (W.on && W.data && WX.isWet(W.data)) for (const s of list) if (s.key === 'do:walk') s.sub += ' · 지금 비·눈이 와요. 실내 스트레칭으로 바꿔도 좋아요';
  if (!l.gh && !l.seen.backup && !sn('backup') && allDays().length >= 2) extra.push({ pri: 52, key: 'backup', icon: '☁️', tone: 'calm', title: '기록을 비공개 저장소에 백업해요', sub: '폰을 바꾸거나 브라우저 데이터를 지워도 남아요', action: { label: '연결하기', act: 'sync-open' }, alt: { label: '괜찮아요', act: 'seen', arg: 'backup' } });
  const out = [...list.filter(s => s.key !== 'clear'), ...extra].sort((a, b) => a.pri - b.pri);
  return out.length ? out : list;
}
function coachHtml(day) {
  const s = coachList(day)[0];
  const btns = [];
  if (s.action) btns.push(`<button class="btn pri" data-act="coach" data-arg="action">${esc(s.action.label)}</button>`);
  if (s.alt) btns.push(`<button class="btn" data-act="coach" data-arg="alt">${esc(s.alt.label)}</button>`);
  if (s.alt2) btns.push(`<button class="btn" data-act="coach" data-arg="alt2">${esc(s.alt2.label)}</button>`);
  if (!['clear', 'closed', 'start'].includes(s.key)) btns.push('<button class="btn ghost" data-act="coach-later">나중에</button>');
  const scale = s.scale ? `<div class="scale-dots coach-scale" role="group" aria-label="${esc(C.SPECIAL[s.scale]?.name || '')} 1부터 5">${[1, 2, 3, 4, 5].map(n => `<button class="dot" data-act="cond" data-arg="${s.scale}:${n}">${n}</button>`).join('')}</div>` : '';
  const lines = s.lines?.length ? `<ul class="coach-lines">${s.lines.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  return `<section class="win coach tone-${s.tone}"><div class="say">${MOCHI}<div><b>${esc(s.icon)} ${esc(s.title)}</b><p>${esc(s.sub || '')}</p></div></div>${lines}${scale}${btns.length ? `<div class="row-btns">${btns.join('')}</div>` : ''}</section>`;
}

function top3Html(day) {
  const map = new Map((day.top3 || []).filter(t => !t.del && t.text).map(t => [t.id, t]));
  // 정한 것만 줄로 보여주고, 빈 칸은 "추가" 한 줄로 접는다 (첫 화면에 타일이 보이도록)
  const set = [...map.values()];
  // 마감이 있으면 남은 시간을, 끝냈으면 마감 안에 끝냈는지를 보여준다
  const dueTxt = t => {
    if (!t.due) return '';
    if (t.done) return t.done <= t.due ? `⏰ ${C.fmtTime(t.due)} 마감 안에 끝` : `⏰ ${C.fmtTime(t.due)} 마감 · ${C.fmtDur((t.done - t.due) / MIN)} 넘김`;
    const left = t.due - now();
    return left > 0 ? `⏰ ${C.fmtTime(t.due)}까지 · ${C.fmtDur(left / MIN)} 남음` : `⏰ ${C.fmtTime(t.due)} 마감 지남`;
  };
  const rows = set.map(t => {
    const d = dueTxt(t), late = t.due && !t.done && t.due < now();
    const report = t.done && t.to ? `<button class="icon-btn" data-act="t3-report" data-arg="${t.id}" aria-label="${esc(t.to)}에게 보고">📨</button>` : '';
    return `<div class="t3 ${t.done ? 'done' : ''} ${late ? 'late' : ''}"><button class="t3-main" data-act="t3-toggle" data-arg="${t.id}" aria-pressed="${!!t.done}"><span class="box">${IC.check}</span><span class="t3-t">${esc(t.text)}${d ? `<small>${esc(d)}${t.to ? ` · ${esc(t.to)}에게 보고` : ''}</small>` : ''}</span></button>${report}<button class="icon-btn" data-act="t3-edit" data-arg="${t.id}" aria-label="수정">${IC.edit}</button></div>`;
  });
  const free = ['t1', 't2', 't3'].find(id => !map.has(id));
  if (free) rows.push(`<button class="t3 empty" data-act="t3-edit" data-arg="${free}"><span class="t3-n">${set.length + 1}</span><span class="t3-t">${set.length ? '하나 더 추가' : '오늘 꼭 끝낼 일 정하기'}</span><span class="t3-plus">${IC.plus}</span></button>`);
  return win('오늘의 핵심 3가지', 'TOP 3', rows.join(''), '', set.length ? `<span class="win-count">${set.filter(t => t.done).length}/${set.length}</span>` : '');
}

function tileHtml(it, s, { carried, later, today, day }) {
  const exp = C.itemExp(it);
  let sub;
  const ds = it.type === 'check' && (it.plan || s.skipped || s.missed) && day ? doseOf(it, day) : null;
  if (ds && (it.plan || ds.kind === 'skipped' || ds.kind === 'missed')) sub = doseText(ds, it) || it.cue || '';
  else if (it.type === 'check') sub = s.done ? `${C.fmtTime(s.last)} ${it.cat === 'med' ? '먹음' : '완료'}` : carried ? `${C.BLOCK_NAMES[it.block]}에서 넘어옴` : it.cue || (it.essential ? '필수' : C.BLOCK_NAMES[it.block]);
  else if (it.type === 'count') sub = (it.target ? `${s.count}/${it.target}${it.unit || ''}` : `${s.count}${it.unit || '번'}`) + (s.last ? ` · ${today ? C.ago(s.last, now()) : C.fmtTime(s.last)}` : '');
  else if (!s.count) sub = '눌러서 기록';
  else if (it.ask === 'min') sub = `${C.fmtDur(s.sum)} · ${s.count}번`;
  else if (it.ask === 'num') sub = `${s.lastV ?? ''}${it.unit || ''} · ${C.fmtTime(s.last)}`;
  else sub = `${s.count}번 · ${today ? C.ago(s.last, now()) : C.fmtTime(s.last)}`;
  // 항목별 연속 (오늘 화면에서만)
  let fire = '';
  if (today && !s.skipped && (it.type === 'check' || (it.type === 'count' && it.target))) {
    const ch = itemChainN(it);
    if (ch >= 2) fire = `<span class="fire" aria-label="${ch}일 연속">🔥${ch}</span>`;
  }
  const goal =it.goal?.total ? `<span class="tile-goal">누적 ${C.goalCount(it, allDays())}/${it.goal.total}</span>` : '';
  const bar = it.type === 'count' && it.target ? `<span class="mini-bar"><i style="width:${Math.min(100, Math.round((s.count / it.target) * 100))}%"></i></span>` : '';
  const mark = it.type === 'check' ? `<span class="box">${IC.check}</span>` : `<span class="plus">${IC.plus}</span>`;
  const cls = ['tile', s.done && 'is-done', (s.skipped || (s.missed && !s.done)) && 'is-skip', later && 'is-later', ds?.kind === 'due' || ds?.kind === 'overdue' ? 'is-due' : '', ui.just === it.id && 'pop'].filter(Boolean).join(' ');
  return `<button class="${cls}" data-act="tile" data-arg="${esc(it.id)}" data-hold="tile-menu" aria-pressed="${!!s.done}">
    <span class="tile-top"><span class="tile-ic" aria-hidden="true">${esc(it.icon || '⭐')}</span><span class="tile-badges">${fire}${exp ? `<span class="q-reward">+${exp}</span>` : ''}</span></span>
    <span class="tile-name">${esc(it.name)}</span><span class="tile-sub">${esc(sub)}</span>${goal}${bar}${mark}</button>`;
}

function tilesHtml(day, items, today) {
  const cur = today ? C.blockAt(day, now()) : 'night', ci = C.blockIdx(cur), lite = C.isLite(day);
  const nowL = [], any = [], done = [], later = new Map();
  const toLater = (it, s) => {
    if (!later.has(it.block)) later.set(it.block, []);
    later.get(it.block).push([it, s]);
  };
  for (const it of items) {
    const s = C.itemState(day, it);
    if (lite && it.type === 'check' && !it.essential && !s.done) continue;
    // 예정 시각이 있는 항목은 시간대가 아니라 예정 시각으로 자리를 정한다 (1시간 전부터 "지금")
    const ds = today && it.plan && it.type === 'check' ? doseOf(it, day) : null;
    if (it.type === 'check' && (s.done || s.skipped || s.missed)) done.push([it, s]);
    else if (ds && (ds.kind === 'waiting' || (ds.kind === 'upcoming' && ds.due - now() > HOUR))) toLater(it, s);
    else if (ds) nowL.push([it, s, false]);
    else if (it.block === 'any') any.push([it, s]);
    else if (C.blockIdx(it.block) <= ci) nowL.push([it, s, C.blockIdx(it.block) < ci]);
    else toLater(it, s);
  }
  const grid = (list, opt = {}) => `<div class="grid">${list.map(([it, s, carried]) => tileHtml(it, s, { carried, today, day, ...opt })).join('')}</div>`;
  const liteBtn = today ? `<button class="mini-toggle ${lite ? 'on' : ''}" data-act="lite" data-arg="${lite ? 0 : 1}" aria-pressed="${lite}">가볍게</button>` : '';
  const tip = today && !local().seen.hold ? '<p class="hint">체크한 타일을 누르면 시각을 고칠 수 있어요. 길게 누르면 지난 시각으로 기록하거나 건너뛰어요. <button class="link" data-act="seen" data-arg="hold">알겠어요</button></p>' : '';
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
  const last = Math.max(lastOf('energy')?.t || 0, lastOf('mood')?.t || 0, lastOf('attn')?.t || 0);
  return `<section class="win" id="cond"><div class="win-head"><h2>컨디션</h2>${last ? `<span class="win-count">${C.fmtTime(last)}</span>` : ''}<span class="win-tag">STATE</span></div><div class="win-body">${row('energy', '에너지', '⚡')}${row('mood', '기분', '🙂')}${row('attn', '집중도', '🧠')}</div></section>`;
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
  if (today) h += retroHtml();
  if (today && C.wakeOf(day)) h += routineHtml(day);
  if (today && C.wakeOf(day)) h += coachHtml(day);
  h += top3Html(day);
  h += tilesHtml(day, C.activeItems(cfg(), key), today);
  if (today) h += condHtml(day) + focusHtml(day);
  h += reviewHtml(day, today);
  return h;
}

// ---------- 흐름 탭 ----------

// 흐름·약 탭: 맨 위에서 무엇이든 시각을 정해 추가하고, 아래로 하루 흐름 → 기록 → 약
function flowHtml() {
  const key = viewKey(), day = store.day(key), today = isToday(), evs = C.live(day);
  const w = C.wakeOf(day), sl = C.sleepOf(day);
  let h = `<div class="row-btns add-row"><button class="btn pri" data-act="add-open">＋ 기록 추가</button>${!w ? '<button class="btn" data-act="time-wake">☀️ 기상</button>' : ''}${w && !sl ? '<button class="btn" data-act="time-sleep">🌙 취침</button>' : ''}</div>`;
  h += win(`${today ? '오늘' : C.fmtDate(key)} 흐름`, 'FLOW', evs.length || w ? flowSvg(day, cfg(), now(), today, medBands(key)) : '<p class="empty">아직 기록이 없어요. 위의 "＋ 기록 추가"나 오늘 탭의 타일로 시작해요.</p>');
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
  h += win('기록', 'LOG', rows.length ? `<div class="log">${rows.map(r => r[1]).join('')}</div><p class="hint">눌러서 시각·내용을 고치거나 지워요. 빠진 건 맨 위 "＋ 기록 추가"로.</p>` : '<p class="empty">기록이 없어요.</p>', '', `<span class="win-count">${evs.length}</span>`);
  h += medSectionsHtml(key);
  return h;
}

// ---------- 주간 탭 ----------

function seasonDays() {
  const se = season(), tk = todayKey(), keys = [];
  for (let k = se.start; k <= tk && k <= se.end; k = C.addDays(k, 1)) keys.push(k);
  return { se, stats: C.seasonStats(keys.map(getDay), cfg()) };
}

// ---------- 아침 루틴 (일어나고 4시간 동안, 다 하면 사라진다) ----------
function routineHtml(day) {
  const w = C.wakeOf(day), t = now();
  if (!w || t - w > 4 * HOUR || local().seen['rt:' + day.date]) return '';
  const def = store.game();
  const steps = GM.routineState(GM.routineFor(def?.routine, day.date), day, { focusOn: !!local().focus });
  const n = steps.filter(s => s.done).length;
  if (n === steps.length) return '';
  const next = steps.find(s => !s.done);
  const open = C.top3Of(day).find(x => !x.done);
  // 첫 집중은 각성 계열 약 효과가 올라오는 때에 맞춘다
  const mc = medCtx(day.date);
  const stim = mc?.today.find(d => d.p.kind === 'curve' && d.p.stim);
  const onset = stim ? stim.t + PK.shape(stim.p).onset * HOUR : null;
  const rows = steps.map(s => {
    const pri = s === next ? 'pri' : '';
    let btn = '';
    if (!s.done) {
      if (s.check === 'wake') btn = '<button class="btn sm" data-act="time-wake">기록</button>';
      else if (s.check === 'item') {
        const it = itemById(s.item);
        if (it) btn = `<button class="btn sm ${pri}" data-act="tile" data-arg="${esc(it.id)}">${it.type === 'count' ? '+1' : it.cat === 'med' ? '먹었어요' : '했어요'}</button>`;
      } else if (s.check === 'top3') btn = `<button class="btn sm ${pri}" data-act="t3-edit" data-arg="${esc(open?.id || 't1')}">${open ? '마감 정하기' : '정하기'}</button>`;
      else if (s.check === 'focus') btn = `<button class="btn sm ${pri}" data-act="focus" data-arg="25${open ? ':' + open.id : ''}">시작</button>`;
      else btn = `<button class="btn sm ${pri}" data-act="rt-done" data-arg="${esc(s.id)}">했어요</button>`;
    }
    let hint = s.hint || '';
    if (s.check === 'focus' && !s.done && onset) hint = onset > t ? `약 효과가 ${C.fmtTime(onset)}쯤 올라와요. 그때 시작하면 좋아요` : '약 효과가 올라온 시간이에요. 지금이 좋아요';
    if (s.check === 'top3' && !s.done && open) hint = `"${open.text}" 마감 시각만 정하면 돼요. 정한 시각이 오늘의 외부 마감이에요`;
    return `<div class="rt-row ${s.done ? 'done' : ''} ${s === next ? 'next' : ''}"><span class="box">${IC.check}</span><span class="rt-t">${esc(s.text)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>${btn}</div>`;
  }).join('');
  // 오늘 집중 시간표 (예정된 약까지 넣어서). 평소 잠드는 시각 30분 전에서 끊는다
  const cut = mc?.sleepAt ? mc.sleepAt - 30 * MIN : null;
  let clipped = false;
  const clip = spans => spans.map(([a, b]) => {
    if (cut && b > cut) { clipped = true; return [a, cut]; }
    return [a, b];
  }).filter(([a, b]) => b - a >= 20 * MIN);
  const plan = (mc?.groups || []).map(G => {
    const eff = clip(G.projEffect?.length ? G.projEffect : G.effect).map(span2).join(', ');
    const pk = clip(G.peak).map(span2).join(', ');
    return eff ? `오늘 집중하기 좋은 시간 ${eff}${pk ? ` · 가장 높음 ${pk}` : ''}${G.projEffect?.length ? ' (예정 약 포함)' : ''}` : '';
  }).filter(Boolean).join('<br>') + (clipped ? `<br>평소 잠드는 ${C.fmtTime(mc.sleepAt)} 30분 전까지만 적었어요` : '');
  return win(`아침 루틴 ${n}/${steps.length}`, 'MORNING', `${rows}${plan ? `<p class="rt-plan">${plan}</p>` : ''}`, 'routine', `<button class="icon-btn" data-act="rt-close" aria-label="아침 루틴 닫기">${IC.x}</button>`);
}

// ---------- 금요일 5줄 보고 ----------
const reportCfg = () => store.game()?.report || { to: '', nums: [] };
function weekFacts(endKey) {
  const days = C.lastDays(endKey, 7).map(getDay).filter(Boolean);
  const done = days.flatMap(d => C.top3Of(d).filter(t => t.done).map(t => t.text));
  const count = id => days.reduce((a, d) => a + C.live(d).filter(e => e.item === id).length, 0);
  const focus = days.reduce((a, d) => a + C.live(d).filter(e => e.item === 'focus').reduce((x, e) => x + (e.min || 0), 0), 0);
  const counts = C.activeItems(cfg()).filter(i => i.type === 'count' && !['water', 'coffee'].includes(i.id) || i.goal?.total).map(i => [i, count(i.id)]).filter(([, n]) => n);
  return { done, counts, focus };
}
function openReportSheet(key = todayKey()) {
  const rc = reportCfg(), f = weekFacts(key);
  const prev = GM.reportsOf([getDay(key)]).pop();
  // 같은 일은 한 번만, 여러 날 했으면 ×횟수
  const doneN = new Map();
  for (const x of f.done) doneN.set(x.trim(), (doneN.get(x.trim()) || 0) + 1);
  const did = prev?.did ?? [...doneN].slice(0, 5).map(([x, n]) => (n > 1 ? `${x} ×${n}` : x)).join(', ');
  const auto = [...f.counts.map(([i, n]) => `${i.name} ${n}${i.unit || '번'}`), f.focus ? `집중 ${C.fmtDur(f.focus)}` : ''].filter(Boolean).join(' · ');
  const nums = (rc.nums || []).map(n => `<label class="fld"><span>${esc(n.label)}</span><input name="num-${esc(n.id)}" inputmode="decimal" value="${esc(prev?.nums?.[n.id] ?? '')}" autocomplete="off"></label>`).join('');
  openSheet('금요일 5줄', 'REPORT', `<p class="lead">${rc.to ? `${esc(rc.to)}에게 ` : ''}매주 금요일에 보내요. 매일 보고는 안 해요. 이번 주 기록은 미리 채워 뒀어요.</p>
    <label class="fld"><span>1. 이번 주 한 것</span><textarea name="did" rows="2" maxlength="200">${esc(did)}</textarea></label>
    <div class="fld"><span>2. 숫자${auto ? ` <small>· ${esc(auto)}</small>` : ''}</span></div>${nums ? `<div class="fld2">${nums}</div>` : ''}
    <label class="fld"><span>3. 막힌 것</span><textarea name="stuck" rows="2" maxlength="200">${esc(prev?.stuck || '')}</textarea></label>
    <label class="fld"><span>4. 다음 주</span><textarea name="next" rows="2" maxlength="200">${esc(prev?.next || '')}</textarea></label>
    <label class="fld"><span>5. 부탁</span><textarea name="ask" rows="2" maxlength="200">${esc(prev?.ask || '')}</textarea></label>
    <div class="row-btns"><button class="btn pri" data-act="save">저장하고 보내기</button><button class="btn" data-act="keep">저장만</button></div>`, {
    save() {
      const r = collect();
      closeSheet();
      share(reportText(key, r, auto));
    },
    keep() {
      collect();
      closeSheet();
      toast('저장했어요');
    },
  });
  function collect() {
    const r = { did: v('did').trim(), stuck: v('stuck').trim(), next: v('next').trim(), ask: v('ask').trim(), nums: {} };
    for (const n of rc.nums || []) if (v('num-' + n.id).trim()) r.nums[n.id] = v('num-' + n.id).trim();
    if (prev) store.updateEvent(key, prev.id, r);
    else store.logEvent(key, 'report5', r);
    return r;
  }
}
function reportText(key, r, auto) {
  const rc = reportCfg();
  const nums = [...(rc.nums || []).filter(n => r.nums?.[n.id]).map(n => `${n.label} ${r.nums[n.id]}`), auto].filter(Boolean).join(' · ');
  return [`[금요일 5줄 · ${C.fmtDate(key)}]`, `1. 이번 주 한 것: ${r.did || '-'}`, `2. 숫자: ${nums || '-'}`, `3. 막힌 것: ${r.stuck || '없음'}`, `4. 다음 주: ${r.next || '-'}`, `5. 부탁: ${r.ask || '없음'}`].join('\n');
}

// ---------- 메인 퀘스트 ----------
const md = (k, noYear = false) => {
  const d = C.keyToDate(k);
  return `${!noYear && d.getFullYear() !== new Date().getFullYear() ? `${String(d.getFullYear()).slice(2)}년 ` : ''}${d.getMonth() + 1}/${d.getDate()}`;
};
const stageWhen = s => (s.from && s.to ? `${md(s.from)}~${md(s.to, s.to.slice(0, 4) === s.from.slice(0, 4))}` : s.date ? md(s.date) : s.when || '');
function questHtml(g) {
  const Q = g.quest;
  if (!Q) return '';
  const cur = Q.current, tk = todayKey();
  const tasks = cur ? cur.tasks.map(t => {
    const sub = t.isAuto ? `${fmtNum(t.value ?? 0)} / ${fmtNum(t.auto.at)}${t.auto.unit || ''} · 기록에서 자동으로 세요` : t.ok ? `${C.fmtDate(t.evKey)}에 끝냄` : '';
    return `<button class="qt ${t.ok ? 'ok' : ''}" ${t.isAuto ? 'aria-disabled="true"' : `data-act="q-toggle" data-arg="${esc(t.id)}"`}><span class="box">${IC.check}</span><span class="qt-t">${esc(t.text)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
  }).join('') : '<p class="empty">모든 단계를 끝냈어요</p>';
  const dd = cur?.end ? C.ddayInfo({ label: cur.name, from: cur.start, to: cur.end }, tk).text : '';
  const stages = Q.stages.map(s => `<li class="qs ${s.status} ${s === cur ? 'cur' : ''}"><span class="qs-n">${s.status === 'done' ? '✓' : ''}</span><b>${esc(s.name)}</b><span class="qs-w">${esc(stageWhen(s))}</span><i>${s.ok}/${s.tasks.length}</i></li>`).join('');
  const pains = allDays().flatMap(d => C.live(d).filter(e => e.item === 'pain_note' && e.note).map(e => ({ ...e, key: d.date })));
  const painHtml = itemById('pain_note') ? `<details><summary>틈 노트 · 사장님 불편 ${pains.length}줄</summary>${pains.length ? `<ul class="med-ul">${pains.slice(-8).reverse().map(p => `<li>${esc(p.note)} <small class="muted">${md(p.key)}</small></li>`).join('')}</ul>` : '<p class="muted">아직 없어요. 가게를 나오면서 한 줄씩.</p>'}</details>` : '';
  const reports = GM.reportsOf(allDays());
  return win(`메인 퀘스트 · ${esc(Q.title)}`, 'QUEST', `${Q.goal ? `<p class="lead">${esc(Q.goal)}</p>` : ''}${Q.rule ? `<p class="st-key">${esc(Q.rule)}</p>` : ''}
    ${cur ? `<h3 class="sub-h">지금 단계 · ${esc(cur.name)} <small>${esc(stageWhen(cur))}${dd ? ` · ${esc(dd)}` : ''}</small></h3>${cur.goal ? `<p class="muted">${esc(cur.goal)}</p>` : ''}<div class="q-tasks">${tasks}</div>` : ''}
    <h3 class="sub-h">전체 길 <small>${Q.doneStages}/${Q.stages.length} 단계</small></h3><ol class="q-stages">${stages}</ol>
    ${painHtml}
    <details><summary>금요일 5줄 · ${reports.length}번 보냄</summary>${reports.length ? `<ul class="med-ul">${reports.slice(-4).reverse().map(r => `<li>${md(r.key)} · ${esc(r.did || '')}</li>`).join('')}</ul>` : ''}<div class="row-btns"><button class="btn sm pri" data-act="report5">이번 주 보고 쓰기</button></div></details>
    ${Q.traps?.length ? `<details><summary>미끄러지는 곳</summary><ul class="med-ul">${Q.traps.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    ${Q.signals?.length ? `<details><summary>분기마다 볼 신호</summary><ul class="med-ul">${Q.signals.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    <p class="hint">과제 하나 +${GM.QUEST_BONUS} EXP. 체크는 오늘 기록에 남아서 다른 기기와도 맞춰져요.</p>`);
}

// ---------- 성장 탭: 레벨, 스탯(개선 지도), 시즌, 주간 ----------

const fmtNum = v => (Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toString());

function levelCardHtml(g) {
  const t = g.tier, pct = ((g.L.into / g.L.need) * 100).toFixed(1);
  const why = [`오늘 기록 +${g.today.exp}`, ...g.today.why].join(' · ');
  const ups = g.ups.slice(-5).reverse().map(u => `<li><b>Lv.${u.lv}</b> ${C.fmtDate(u.key)}</li>`).join('');
  return win('레벨', 'LEVEL', `<div class="lv-top"><span class="lv-now">Lv.<b>${g.L.lv}</b></span><span class="lv-meta"><span class="tier-pill">${esc(t.name)}</span><span>${t.next ? `${esc(t.next.name)}까지 Lv.${t.next.min}` : '가장 높은 등급'}</span><span>누적 ${g.total.toLocaleString()} EXP</span></span></div>
    <div class="tiers">${GM.TIERS.map((x, i) => `<span class="${i === t.i ? 'on' : ''}">${esc(x.name)}</span>`).join('')}</div>
    <div class="track lv-track"><i class="fill" style="width:${pct}%"></i></div>
    <p class="muted">다음 레벨까지 ${g.L.need - g.L.into} EXP · ${esc(why)}</p>
    <details><summary>EXP 얻는 법</summary><ul class="med-ul"><li>필수 체크 +30, 다른 체크 +15, 횟수 하나 +4, 기록 하나 +10</li><li>기상 +10, 집중 2.5분마다 +1 (하루 60까지), 컨디션 +3, 핵심 완료 +20, 하루 마감 +20</li><li>하루 100을 넘기면 +${GM.CLEAR_BONUS}, 연속 7·14·30·60·100일에 +50~500</li><li>스탯 목표를 하나 채울 때마다 +${GM.STEP_BONUS}</li><li>레벨마다 필요한 EXP는 조금씩 늘어요 (지금 ${g.L.need})</li></ul></details>
    ${ups ? `<h3 class="sub-h">레벨 기록</h3><ul class="lv-ups">${ups}</ul>` : ''}`);
}

function statCardHtml(s) {
  const up = s.grade !== s.base, unit = s.metric?.unit || '';
  const val = s.value == null ? '' : `${fmtNum(s.value)}${unit}`;
  let body;
  if (s.keep) body = `<p class="st-note">${esc(s.note || '지금 강점이에요. 유지만 해요')}</p>`;
  else if (s.missing) body = `<p class="st-note">이 스탯을 셀 항목이 아직 없어요.</p><div class="row-btns"><button class="btn sm pri" data-act="stat-add" data-arg="${esc(s.id)}">${esc(s.add?.name || '항목')} 항목 만들기</button></div>`;
  else {
    body = `<div class="st-prog"><span class="mini-bar"><i style="width:${Math.round(s.pct * 100)}%"></i></span><span>${s.next ? `${esc(val || '0' + unit)} / ${esc(fmtNum(s.next.at) + unit)} → <b>${esc(s.next.grade)}</b>` : `${esc(val)} · 목표 다 채움`}</span></div>`;
    if (s.note) body += `<p class="st-note">${esc(s.note)}</p>`;
  }
  const steps = !s.keep && s.steps.length ? `<div class="st-steps">${s.steps.map(x => `<span class="${x.done ? 'on' : ''}">${esc(x.label || fmtNum(x.at) + unit)} ${esc(x.grade)}</span>`).join('')}</div>` : '';
  return `<div class="st-card ${s.keep ? 'keep' : ''}"><div class="st-head"><span class="st-ic" aria-hidden="true">${esc(s.icon || '')}</span><b>${esc(s.name)}</b><span class="grade ${up ? 'up' : ''}">${up ? `<s>${esc(s.base)}</s>` : ''}${esc(s.grade)}</span></div>${body}${steps}</div>`;
}

function statsHtml(g) {
  if (!g.def) return win('스탯', 'STAT', '<p class="lead">스탯 정의가 아직 없어요. 비공개 저장소에 game.json이 있으면 동기화할 때 받아와요.</p>');
  const keyStat = g.stats.find(s => s.key) || null;
  return win(esc(g.def.title || '스탯'), 'STAT', `${g.def.lead ? `<p class="lead">${esc(g.def.lead)}</p>` : ''}${radarSvg(g.stats.map(s => ({ name: s.name, now: GM.gradeScore(s.grade), base: GM.gradeScore(s.base) })))}
    <div class="legend"><span><i class="lg-now"></i>지금</span><span><i class="lg-base"></i>처음 평가</span></div>
    ${keyStat ? `<p class="st-key">${esc(keyStat.keyNote || '')}</p>` : ''}${g.stats.map(statCardHtml).join('')}`);
}

function weekHtml() {
  const tk = todayKey(), c = cfg();
  const k7 = C.lastDays(tk, 7), d7 = k7.map(getDay), s = C.summarize(d7, c);
  const { se, stats: ss } = seasonDays();
  const g = gameCtx();
  let h = questHtml(g) + levelCardHtml(g) + statsHtml(g);
  h += win(`시즌 ${se.n}`, 'SEASON', `<div class="goal-h"><span>${C.SEASON_DAYS}일 중 <b>${se.day}일째</b></span><span>${se.left ? `${C.fmtDate(se.end)}까지 · <b>D-${se.left}</b>` : '<b>오늘이 마지막 날</b>'}</span></div>
    <span class="mini-bar"><i class="blue" style="width:${Math.round((se.day / C.SEASON_DAYS) * 100)}%"></i></span>
    <div class="minis" style="margin-top:10px">${mini('기록한 날', ss.recorded, '일')}${mini('필수 달성', ss.essDays, '일')}${mini('CLEAR', ss.clearDays, '일')}</div>
    <div class="row-btns"><button class="btn pri" data-act="report-season">시즌 보고하기</button><span class="muted grow-r">누적 ${ss.exp} EXP</span></div>`);

  const cols = k7.map((k, i) => {
    const d = d7[i], rec = C.recorded(d), e = rec ? C.expOf(d, c) : 0;
    return `<button class="wd ${rec ? '' : 'none'} ${k === tk ? 'today' : ''}" data-act="goto-day" data-arg="${k}" aria-label="${C.fmtDate(k)} ${rec ? 'EXP ' + e : '기록 없음'}"><span class="wd-bar ${e >= C.EXP_GOAL ? 'clear' : ''}"><i style="height:${Math.min(100, e)}%"></i></span><span class="wd-l">${WEEKDAY[C.keyToDate(k).getDay()]}</span><span class="wd-n">${rec ? e : '·'}</span></button>`;
  }).join('');
  h += win('최근 7일', 'WEEK', `<div class="minis" style="margin-bottom:12px">${mini('연속', chainNow().n, '일')}${mini('7일 중 기록', s.recorded, '일')}${mini('필수 달성', s.essDays, '일')}</div>
    <div class="week">${cols}</div><p class="hint">연속은 필수를 다 한 날을 세요. 하루 빠져도 이어지고, 이틀 연속으로 빠지면 끊겨요. 막대는 그날의 EXP이고, 누르면 그날로 가요.</p>`);

  const rows = C.activeItems(c).filter(i => i.type === 'check' || (i.type === 'count' && i.target));
  if (rows.length) {
    let m = '<span></span>' + k7.map(k => `<span class="mx-h">${WEEKDAY[C.keyToDate(k).getDay()]}</span>`).join('');
    for (const it of rows) {
      const ch = itemChainN(it);
      m += `<span class="mx-n">${esc(it.icon)} ${esc(it.name)}${ch >= 2 ? ` <small>🔥${ch}</small>` : ''}</span>`;
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
  const attns = d7.filter(Boolean).flatMap(d => C.live(d).filter(e => e.item === 'attn').map(e => e.v));
  const attnAvg = attns.length ? attns.reduce((a, b) => a + b, 0) / attns.length : null;
  kv.push(['집중 합계', C.fmtDur(s.focusMin)], ['운동 합계', C.fmtDur(s.moveMin)], ['에너지 평균', f1(s.energyAvg)], ['기분 평균', f1(s.moodAvg)], ['집중도 평균', f1(attnAvg)], ['하루 점수 평균', f1(s.scoreAvg)]);
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

// ---------- 약 탭 ----------

const DISCLAIM = '<p class="disclaimer">허가사항 평균값에 맞춘 일반적인 모양이에요. 느끼는 효과는 사람마다 달라서, 아래 "내 데이터로 본 피크"가 진짜 내 피크예요. 복용 시간과 용량은 처방한 의사와 정해요.</p>';
const span2 = ([a, b]) => `${C.fmtTime(a)}~${C.fmtTime(b)}`;

// 약: 흐름 탭 아래쪽 (곡선 → 복용 기록 → 언제 먹으면 → 내 피크 → 약 정보)
function medSectionsHtml(key) {
  const P = profiles();
  const head = '<h2 class="sec-h" id="sec-med">💊 약</h2>';
  if (!P.length) {
    return head + win('약 정보', 'MEDS', `<p class="lead">약 정보 파일(meds.json)이 비공개 저장소에 있으면 동기화할 때 받아와서, 약 곡선과 복용 기록이 여기 나와요.</p>
      <div class="row-btns">${local().gh ? '<button class="btn pri" data-act="sync-now">지금 동기화</button>' : '<button class="btn pri" data-act="sync-open">비공개 저장소 연결</button>'}</div>`);
  }
  const today = key === todayKey(), mc = medCtx(key);
  const linked = new Set(mc.items.flatMap(i => (i.drugs || []).map(l => l.id)));
  const unlinked = P.filter(p => !linked.has(p.id));
  let h = head;
  if (unlinked.length) h += medLinkHtml(unlinked, mc.items);
  h += medGraphHtml(mc, today, P, linked) + DISCLAIM;
  h += medTrackHtml(key);
  const curves = P.filter(p => p.kind === 'curve' && linked.has(p.id));
  if (curves.length) h += medPlanHtml(mc, curves);
  h += medPeakHtml(key);
  h += win('약 정보', 'INFO', P.map(medInfoHtml).join(''));
  return h;
}

function medLinkHtml(unlinked, items) {
  const rows = items.filter(i => i.cat === 'med').map(i => {
    const names = (i.drugs || []).map(l => profileById(l.id)?.name).filter(Boolean).map(esc).join(', ');
    return `<button class="set-row" data-act="item-edit" data-arg="${esc(i.id)}"><span>${esc(i.icon)} ${esc(i.name)}<small>${names || '아직 연결 안 됨'}</small></span><b>연결</b></button>`;
  }).join('');
  return win('약 연결하기', 'LINK', `<p class="lead">어떤 타일이 어떤 약인지 연결하면, 타일을 누를 때마다 곡선이 그려져요. 같이 먹는 약은 한 타일에 여러 개 연결해도 돼요.</p>${rows}
    <p class="hint">아직 연결 안 된 약: ${unlinked.map(p => esc(p.name)).join(', ')}</p>
    <div class="sugg">${unlinked.map(p => `<button data-act="med-new" data-arg="${esc(p.id)}">+ ${esc(p.name)} 타일 만들기</button>`).join('')}</div>`);
}

function medGraphHtml(mc, today, P, linked) {
  const curveDoses = mc.today.filter(d => d.p.kind === 'curve');
  const steady = P.filter(p => p.kind === 'steady' && linked.has(p.id)).map(p => {
    const link = mc.items.flatMap(i => i.drugs || []).find(l => l.id === p.id);
    const took = mc.today.find(d => d.p.id === p.id);
    let state = '하루 안에서는 거의 평평해요';
    if (link?.since && link.since <= mc.key) {
      const n = Math.round((C.keyToDate(mc.key) - C.keyToDate(link.since)) / 86400000) + 1;
      state = `${Math.floor((n - 1) / 7) + 1}주째 · ${n >= 35 ? '일정하게 유지되는 때' : '아직 쌓이는 중'}`;
    }
    return { text: `${p.name} · ${state}${took ? ` · ${C.fmtTime(took.t)} 먹음` : ''}` };
  });
  const ratings = C.live(getDay(mc.key) || C.newDay(mc.key)).filter(e => e.item === 'attn').map(e => ({ t: e.t, v: e.v }));
  const doses = curveDoses.map(d => ({ t: d.t, label: `${C.fmtTime(d.t)} ${d.p.name}` }));
  const seenPlan = new Set();
  const plannedDoses = mc.planned.filter(d => !seenPlan.has(d.item) && seenPlan.add(d.item)).map(d => ({ t: d.t, label: `${C.fmtTime(d.t)} ${d.name} 예정` }));
  const svg = medSvg({ ...mc, doses, plannedDoses, steady, ratings, now: now(), isToday: today });
  const lines = mc.groups.map(G => {
    let line = `<b>${esc(G.name)}</b> 효과 ${G.effect.map(span2).join(', ') || '없음'} · 가장 높음 ${G.peak.map(span2).join(', ') || '없음'}`;
    if (today) {
      let i = mc.ts.findIndex(t => t > now());
      i = i < 0 ? mc.ts.length - 1 : Math.max(0, i - 1);
      const a = G.total[i], b = G.total[Math.min(mc.ts.length - 1, i + 2)];
      const trend = G.nowRel < 0.05 ? '거의 없어요' : b > a * 1.03 ? '오르는 중' : b < a * 0.97 ? '내려가는 중' : '비슷하게 유지';
      line += `<br>지금 하루 최고의 ${Math.round(G.nowRel * 100)}% · ${trend}`;
    }
    const toSleep = end => {
      if (!mc.sleepAt) return '';
      const gap = (mc.sleepAt - end) / MIN;
      return gap >= 60 ? ` → 평소 잠드는 ${C.fmtTime(mc.sleepAt)}까지 ${C.fmtDur(gap)} 여유` : ` → <span class="warn">평소 잠드는 ${C.fmtTime(mc.sleepAt)}에 가까워요. 잠이 늦어질 수 있어요</span>`;
    };
    const end = G.effect.length ? G.effect[G.effect.length - 1][1] : null;
    if (end) line += `<br>${G.projEffect ? '지금까지 먹은 것만: ' : ''}효과 끝 ${C.fmtTime(end)}${toSleep(end)}`;
    if (G.projEffect?.length) {
      const pe = G.projEffect[G.projEffect.length - 1][1];
      line += `<br>예정대로 먹으면: 효과 끝 ${C.fmtTime(pe)}${toSleep(pe)}`;
    }
    return `<p class="med-note">${line}</p>`;
  });
  if (!mc.groups.length) lines.push(`<p class="muted">${today ? '오늘' : '이날'} 기록된 곡선형 약이 없어요. 연결한 약 타일을 누르면 여기 그려져요.</p>`);
  const legend = `<div class="legend med-legend"><span><i class="lg-area"></i>약 농도 (같은 성분은 더함)</span>${mc.planned.length ? '<span><i class="lg-proj"></i>예정대로 먹으면</span>' : ''}<span><i class="lg-eff"></i>효과 구간 (한 번 먹은 최고점의 35%↑)</span><span><i class="lg-peak"></i>하루 중 가장 높음 (80%↑)</span><span><i class="lg-rate"></i>내가 누른 집중도</span></div>`;
  return win(`${today ? '오늘' : C.fmtDate(mc.key)} 약 효과`, 'CURVE', svg + legend + lines.join(''));
}

const planLabel = it => {
  const p = it.plan || {};
  if (p.time) return `${p.time} 예정`;
  if (p.wake != null) return `일어나고 ${p.wake}시간 뒤`;
  if (p.after) return `${nameOf(p.after).name} 먹고 ${p.h || 0}시간 뒤`;
  return '';
};
const relToClock = rel => C.fmtMinutesOfDay(((rel + rollover() * 60) % 1440 + 1440) % 1440);

// 복용 기록: 최근 14일 칸, 제시간·늦음·건너뜀(이유) 요약, 예정 있는 약은 먹은 날·건너뛴 날 비교
function medTrackHtml(key) {
  const items = C.activeItems(cfg(), key).filter(i => i.cat === 'med' && i.type === 'check');
  if (!items.length) return '';
  const keys = C.lastDays(key, 14), tk = todayKey();
  const head = `<div class="tr-grid tr-head">${keys.map(k => `<span>${'일월화수목금토'[C.keyToDate(k).getDay()]}</span>`).join('')}</div>`;
  const SYM = { taken: '✓', late: '✓', early: '✓', skipped: '↷', missed: '✕', none: '·', due: '!', overdue: '!' };
  const rows = items.map(it => {
    const hist = keys.map(k => ({ k, has: !!getDay(k), ...C.doseState(it, getDay(k), doseOpts(k)) }));
    const cells = hist.map(h => {
      const kind = h.has ? h.kind : 'nodoc';
      const label = `${C.fmtDate(h.k)} · ${h.has ? doseText(h, it) || '아직' : '앱을 안 연 날'}`;
      return `<span class="tr-c k-${kind}" title="${esc(label)}" aria-label="${esc(label)}">${h.has ? SYM[h.kind] || '' : ''}</span>`;
    }).join('');
    const sm = C.doseSummary(hist.filter(h => h.k < tk && h.has));
    const whys = Object.entries(sm.why).map(([w, n]) => `${C.SKIP_WHY[w] || w} ${n}`).join(', ');
    const parts = [`제시간 ${sm.onTime}`];
    if (sm.late) parts.push(`늦게 ${sm.late}${sm.lateAvg ? ` (평균 ${C.fmtDur(sm.lateAvg)})` : ''}`);
    if (sm.early) parts.push(`일찍 ${sm.early}`);
    parts.push(`건너뜀 ${sm.skipped}`);
    if (sm.missed) parts.push(`못 먹음 ${sm.missed}`);
    if (sm.none) parts.push(`기록 없음 ${sm.none}`);
    let cmp = '';
    if (it.plan) {
      const o = C.doseOutcomes(it, C.lastDays(key, 28).map(getDay), { rollover: rollover() });
      const f = (v, d = 1) => (v == null ? '–' : v.toFixed(d));
      if (o.taken.n >= 2 && o.skipped.n >= 2) {
        cmp = `<table class="cmp"><tr><th></th><th>먹은 날 ${o.taken.n}</th><th>건너뛴 날 ${o.skipped.n}</th></tr>
          <tr><td>예정 뒤 6시간 집중도</td><td>${f(o.taken.attn)}</td><td>${f(o.skipped.attn)}</td></tr>
          <tr><td>잠든 시각</td><td>${o.taken.sleep == null ? '–' : relToClock(o.taken.sleep)}</td><td>${o.skipped.sleep == null ? '–' : relToClock(o.skipped.sleep)}</td></tr>
          <tr><td>핵심 완료율</td><td>${o.taken.t3 == null ? '–' : Math.round(o.taken.t3 * 100) + '%'}</td><td>${o.skipped.t3 == null ? '–' : Math.round(o.skipped.t3 * 100) + '%'}</td></tr></table>`;
      } else cmp = `<p class="muted">먹은 날과 건너뛴 날이 각각 2일 넘게 모이면, 그날 오후 집중도·잠든 시각·핵심 완료율을 나란히 비교해 보여줘요. (지금 먹은 날 ${o.taken.n}, 건너뛴 날 ${o.skipped.n})</p>`;
    }
    return `<div class="tr-row"><div class="tr-name">${esc(it.icon)} ${esc(it.name)}${it.plan ? ` <small>${esc(planLabel(it))}</small>` : ''}</div><div class="tr-grid">${cells}</div>
      <p class="tr-sum">최근 14일 · ${parts.join(' · ')}${whys ? `<br>이유 · ${esc(whys)}` : ''}</p>${cmp}</div>`;
  }).join('');
  const legend = '<div class="legend tr-legend"><span><i class="k-taken">✓</i>먹음</span><span><i class="k-late">✓</i>늦게</span><span><i class="k-skipped">↷</i>건너뜀</span><span><i class="k-missed">✕</i>못 먹음</span><span><i class="k-none">·</i>기록 없음</span></div>';
  return win('복용 기록', 'DOSE', head + rows + legend);
}

function medPlanHtml(mc, curves) {
  const base = mc.wake || typicalWakeTs(mc.key);
  if (!base) return win('언제 먹으면 언제까지', 'PLAN', '<p class="lead">일어난 시각을 기록하면, 그 시각 기준으로 계산해서 보여줘요.</p>');
  const sleepAt = mc.sleepAt;
  const blocks = curves.map(p => {
    const rows = [0, 1, 2, 3].map(off => {
      const t = base + off * HOUR, pl = PK.plan(p, t);
      const gap = sleepAt ? (sleepAt - pl.end) / MIN : null;
      const tag = gap == null ? '' : gap >= 60 ? `<span class="ok">잠까지 ${C.fmtDur(gap)}</span>` : '<span class="warn">잠드는 시각과 겹쳐요</span>';
      return `<tr><th>${off ? `+${off}시간<br>${C.fmtTime(t)}` : `기상 직후<br>${C.fmtTime(t)}`}</th><td>효과 ${C.fmtTime(pl.start)}~${C.fmtTime(pl.end)}<small>가장 높음 ${span2(pl.peak)}</small></td><td>${tag}</td></tr>`;
    }).join('');
    return `<h3 class="sub-h">💊 ${esc(p.name)}${p.how?.[0] ? ` <small>· ${esc(p.how[0])}</small>` : ''}</h3><table class="plan">${rows}</table>`;
  }).join('');
  return win('언제 먹으면 언제까지', 'PLAN', `<p class="lead">${mc.wake ? '오늘 일어난' : '평소 일어나는'} ${C.fmtTime(base)} 기준이에요. ${sleepAt ? `평소 잠드는 시각은 최근 기록으로 ${C.fmtTime(sleepAt)}예요.` : '취침을 3일 이상 기록하면 잠까지 남는 시간도 보여줘요.'} 처방대로가 기본이고, 시간을 바꾸고 싶으면 이 표를 들고 의사와 이야기해요.</p>${blocks}`);
}

function medPeakHtml(key) {
  const mode = ui.peakMode, rating = ui.peakRating, clock = mode === 'clock';
  const days = C.lastDays(key, 28).map(getDay).filter(Boolean);
  const doses = PK.dosesOf(days, C.activeItems(cfg()), profiles());
  const st = PK.peakStats(days, { mode, doses, rating, bins: clock ? 24 : 15, wakeOf: C.wakeOf });
  const best = PK.bestWindow(st, { width: 2, minN: 2 });
  const what = rating === 'attn' ? '집중도' : '에너지';
  const basis = { dose: '그날 첫 약을 먹고', wake: '일어나고', clock: '' }[mode];
  const text = best
    ? clock ? `${best.from}시~${best.to}시에 ${what}가 가장 높았어요 (평균 ${best.avg.toFixed(1)}, 기록 ${best.n}개)` : `${basis} ${best.from}~${best.to}시간 사이에 ${what}가 가장 높았어요 (평균 ${best.avg.toFixed(1)}, 기록 ${best.n}개)`
    : `기록이 더 필요해요. 지금 ${st.total}개예요. 이웃한 두 칸에 2개씩 모이면 보여줘요.`;
  let fi = -1;
  st.focus.forEach((f, i) => { if (f > (fi < 0 ? 0 : st.focus[fi])) fi = i; });
  const focusLine = fi >= 0 ? `<p class="muted">집중 타이머는 ${clock ? `${fi}시대` : `${basis} ${fi}시간대`}에 가장 많이 썼어요 (${C.fmtDur(st.focus[fi])})</p>` : '';
  const seg = (act, cur, opts) => `<div class="seg sm">${opts.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-act="${act}" data-arg="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
  return win('내 데이터로 본 피크', 'PEAK', `<div class="peak-ctl">${seg('peak-mode', mode, [['dose', '약 먹고'], ['wake', '일어나고'], ['clock', '시각']])}${seg('peak-rating', rating, [['attn', '집중도'], ['energy', '에너지']])}</div>
    ${peakSvg(st, best, { label: i => (clock ? `${i}시` : `${i}h`) })}<p class="peak-t">${text}</p>${focusLine}
    <p class="hint">최근 4주 기록이에요. 막대 위 숫자는 기록 수예요. 집중도는 오늘 탭의 컨디션에서 누르고, 약 먹고 1·3·6·9시간쯤엔 코치가 물어봐요.</p>`);
}

function medInfoHtml(p) {
  const list = xs => (xs?.length ? `<ul class="med-ul">${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const facts = (p.facts || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<details class="med-info"><summary>💊 ${esc(p.name)}${p.sub ? ` <small>${esc(p.sub)}</small>` : ''}</summary>
    ${facts ? `<dl class="med-kv">${facts}</dl>` : ''}
    ${p.how?.length ? `<h4>먹는 법</h4>${list(p.how)}` : ''}
    ${p.brain ? `<h4>뇌에서 하는 일</h4><p>${esc(p.brain)}</p>` : ''}
    ${p.design ? `<h4>왜 이런 모양인지</h4><p>${esc(p.design)}</p>` : ''}
    ${p.watch?.length ? `<h4>알아둘 것</h4>${list(p.watch)}` : ''}
    ${p.source ? `<p class="src">출처: ${esc(p.source)}</p>` : ''}</details>`;
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
  const W = wx();
  h += win('날씨·햇빛', 'SKY', `<div class="set-row"><span>날씨와 해 뜨고 지는 시각<small>아침 햇빛을 권하고, 비 오는 날엔 산책 대신 실내를 권해요. Open-Meteo에 위치(약 10km 단위)만 보내요</small></span><button class="mini-toggle ${W.on ? 'on' : ''}" data-act="wx-toggle" aria-pressed="${!!W.on}">${W.on ? '켜짐' : '꺼짐'}</button></div>
    ${W.on ? `<div class="set-row"><span>${W.loc ? `📍 ${esc(W.loc.name)}` : '위치를 정해 주세요'}${W.data ? `<small>${esc(wxLine(todayKey()))} · ${C.fmtTime(W.data.at)}에 받음</small>` : ''}</span><button class="btn sm" data-act="wx-loc">위치 정하기</button></div>` : ''}`);
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

const VIEWS = { today: todayHtml, flow: flowHtml, med: flowHtml, week: weekHtml, set: setHtml }; // 약은 흐름 탭에 합쳤다
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
  renderLogged();
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
function burst(text = 'CLEAR!') {
  const el = $('#burst');
  el.textContent = text;
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
  haptic([30, 40, 80]);
}

// ---------- 시트 ----------

let sheetActs = {};
function openSheet(title, tag, body, acts = {}) {
  hideLogged();
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
  try {
    sheetActs.beforeClose?.(); // 저장 버튼 없이 닫을 때 쓴 글을 살리거나 빈 기록을 치운다
  } catch {
    /* 닫기는 계속한다 */
  }
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
  // 위치는 지금 막 한 기록에만 (어제 정리나 몇 시간 전 기록에 지금 위치를 붙이면 틀린다)
  if (Math.abs(now() - ev.t) < 10 * MIN) stampLoc(key, ev);
  showLogged(key, ev);
}
function addAt(it, key, t) {
  if (it.type === 'log' && (it.ask === 'min' || it.ask === 'num')) return openLogSheet(it, key, t);
  const ev = store.logEvent(key, it.id, { t, autoWake: key === todayKey() });
  afterLog(it, key, ev);
  if (opensSheet(it)) openEventSheet(ev.id, key, { fresh: true }); // 글이 본체인 기록은 바로 쓰는 칸
}
// 기록하고 나서 창을 하나 더 여는 항목 (앞 창을 닫지 않고 바꿔 끼워야 뒤로 가기와 꼬이지 않는다)
const opensSheet = it => it.type === 'log' && (it.ask === 'min' || it.ask === 'num' || (it.ask === 'note' && !!it.noteFirst));

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
  const key = viewKey(), today = key === todayKey(), day = store.day(key), s = C.itemState(day, it);
  const u = usualFor(it, key), usualOk = u && u <= timeRange(key)[1];
  // 오늘은 지금이 기본, 평소 시각이 한참 전이면 그쪽이 기본 (늦게 기록하는 경우가 많아서)
  let def = today ? now() : u ?? C.guessTime(it, day, { key, rollover: rollover() });
  if (today && usualOk && u < now() - 15 * MIN) def = u;
  const presets = [];
  if (today) presets.push([now(), '지금']);
  if (usualOk) presets.push([u, `평소 ${C.fmtTime(u)}`]);
  const evRows = s.evs.map(e => `<button class="row no-ic" data-act="ev" data-arg="${e.id}"><span class="row-t">${C.fmtTime(e.t)}</span><span class="row-b">${esc(evDetail(e, it) || '기록')}</span><span class="row-go">${IC.right}</span></button>`).join('');
  const body = `${twHtml(key, def, presets)}<div class="row-btns"><button class="btn pri" data-act="add-tw">이 시각으로 기록</button></div>
    ${evRows ? `<h3 class="sub-h">${today ? '오늘' : '이날'} 기록</h3><div class="log">${evRows}</div>` : ''}
    <div class="row-btns">${it.type === 'check' && !s.done ? `<button class="btn" data-act="skip">${s.skipped || s.missed ? '건너뛰기 취소' : today ? '오늘은 건너뛰기' : '이날은 건너뜀'}</button>` : ''}<button class="btn ghost" data-act="edit-item">항목 편집</button></div>`;
  openSheet(`${it.icon} ${it.name} · 언제 했어요?`, 'QUEST', body, {
    'add-tw'() {
      const t = tw.t;
      if (!opensSheet(it)) closeSheet();
      addAt(it, key, t);
    },
    skip() {
      if (s.skipped || s.missed || it.cat !== 'med') {
        store.setSkip(key, it.id, !(s.skipped || s.missed));
        return closeSheet();
      }
      openSkipSheet(it.id, key);
    },
    'edit-item'() {
      openItemSheet(it.id);
    },
  });
}

// ＋ 기록 추가: 무엇이든 고르고 → 시각을 정한다. 지난 일, 다른 날짜도 여기서
function openAddSheet() {
  const key = viewKey(), day = store.day(key), today = key === todayKey();
  const w = C.wakeOf(day), sl = C.sleepOf(day);
  const pick = (act, arg, icon, name, sub) => `<button class="add-pick" data-act="${act}" data-arg="${esc(arg)}"><span class="ap-ic" aria-hidden="true">${esc(icon)}</span><span class="ap-n">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
  const items = C.activeItems(cfg(), key).map(it => {
    const s = C.itemState(day, it);
    const sub = s.skipped ? '건너뜀' : s.count ? (it.type === 'count' ? `${s.count}${it.unit || ''}` : `${C.fmtTime(s.last)}${s.count > 1 ? ` 외 ${s.count - 1}` : ''}`) : '';
    return pick('add-item', it.id, it.icon, it.name, sub);
  });
  const body = `<div class="add-grid">${pick('add-wake', '', '☀️', '기상', w ? C.fmtTime(w) : '')}${pick('add-sleep', '', '🌙', '취침', sl ? C.fmtTime(sl) : '')}${pick('add-focus', '', '🎯', '집중', '타이머 없이 한 것')}${items.join('')}</div><p class="hint">고르면 시각을 정해요. 지난 일도 여기서 넣어요.</p>`;
  openSheet(`${today ? '오늘' : C.fmtDate(key)} 무엇을 남길까요?`, 'ADD', body, {
    'add-wake': () => openTimeSheet('wake'),
    'add-sleep': () => openTimeSheet('sleep'),
    'add-item': id => openTileSheet(id),
    'add-focus': () => openFocusLogSheet(key),
  });
}

// 타이머 없이 한 집중을 나중에 남긴다
function openFocusLogSheet(key) {
  const today = key === todayKey();
  const presets = today ? [[now(), '지금']] : [];
  const def = today ? now() - 25 * MIN : C.dayStartTs(key, rollover()) + 10 * HOUR;
  const body = `<div class="fld"><span>얼마나 했어요?</span>${seg('min', 25, [15, 25, 50, 90].map(m => [m, m + '분']))}</div>
    <label class="fld"><span>직접 입력 (분)</span><input name="minx" type="number" inputmode="numeric" min="1" max="600" placeholder="비워 두면 위에서 고른 값"></label>
    <h3 class="sub-h">언제 시작했어요?</h3>${twHtml(key, def, presets)}
    <label class="fld"><span>무엇을 (선택)</span><input name="note" maxlength="60" autocomplete="off" placeholder="코테 2문제"></label>
    <p class="err" id="sheet-err" hidden></p><div class="row-btns"><button class="btn pri" data-act="save">기록</button></div>`;
  openSheet('🎯 집중 · 지난 기록', 'FOCUS', body, {
    save() {
      const min = Math.round(parseFloat(v('minx')) || +segv('min'));
      if (!(min > 0)) return sheetErr('시간을 골라 주세요');
      // 끝난 집중을 남기는 칸이라, 끝이 지금보다 뒤면 지금 끝난 걸로 맞춘다
      const t = today && tw.t + min * MIN > now() ? now() - min * MIN : tw.t;
      const ev = store.logEvent(key, 'focus', { t, min, note: v('note').trim() || undefined, autoWake: today });
      closeSheet();
      afterLog({ id: 'focus', ...nameOf('focus') }, key, ev);
    },
  });
}

function openEventSheet(id, key = viewKey(), { fresh = false } = {}) {
  const e = store.day(key).events.find(x => x.id === id && !x.del);
  if (!e) return;
  const it = nameOf(e.item);
  // 글이 본체인 기록(예: 사장님 불편 한 줄)은 쓰는 칸이 먼저, 시각 고치기는 접어 둔다
  if (it.noteFirst && it.ask === 'note') return openNoteSheet(e, it, key, fresh);
  const isCond = e.item === 'energy' || e.item === 'mood', hasMin = e.item === 'focus' || it.ask === 'min', isNum = it.ask === 'num', isMeal = it.cat === 'meal';
  const u = usualFor(itemById(e.item), key), presets = [];
  if (key === todayKey()) presets.push([now(), '지금']);
  if (u && u <= timeRange(key)[1]) presets.push([u, `평소 ${C.fmtTime(u)}`]);
  let body = twHtml(key, e.t, presets);
  if (isCond) body += `<div class="fld"><span>값</span>${seg('v', e.v, [1, 2, 3, 4, 5].map(n => [n, n]))}</div>`;
  if (hasMin) body += `<label class="fld"><span>시간 (분)</span><input name="min" type="number" inputmode="numeric" min="1" max="600" value="${e.min || ''}"></label>`;
  if (isNum) body += `<label class="fld"><span>값${it.unit ? ` (${esc(it.unit)})` : ''}</span><input name="num" type="number" inputmode="decimal" step="0.1" value="${e.v ?? ''}"></label>`;
  if (isMeal) body += `<div class="fld"><span>양</span>${seg('portion', e.v, [1, 2, 3].map(n => [n, PORTION[n]]))}</div>`;
  if (!isCond) body += `<label class="fld"><span>메모</span><input name="note" maxlength="60" value="${esc(e.note || '')}" autocomplete="off" placeholder="${isMeal ? '김치찌개, 밥 한 공기' : ''}"></label>`;
  body += `${e.place ? `<p class="hint">📍 ${esc(e.place)}</p>` : ''}<div class="row-btns"><button class="btn pri" data-act="save">저장</button><button class="btn danger" data-act="del">기록 삭제</button></div>`;
  openSheet(`${it.icon} ${it.name}`, 'EDIT', body, {
    save() {
      const patch = {};
      if (Math.round(tw.t / MIN) !== Math.round(e.t / MIN)) patch.t = tw.t;
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

// 글이 본체인 기록: 쓰는 칸이 맨 위에 있고 키보드가 바로 뜬다. 새로 연 기록을 빈 채로 닫으면 남기지 않는다
function openNoteSheet(e, it, key, fresh) {
  const presets = key === todayKey() ? [[now(), '지금']] : [];
  let done = false;
  const body = `<label class="fld"><span>${esc(it.name)}</span><textarea name="note" rows="3" maxlength="200" autofocus autocomplete="off" placeholder="${esc(it.example || '들은 말 그대로 한 줄')}">${esc(e.note || '')}</textarea></label>
    <details class="note-time"><summary>${C.fmtTime(e.t)}에 남김 · 시각 고치기</summary>${twHtml(key, e.t, presets)}</details>
    <div class="row-btns"><button class="btn pri" data-act="save">남기기</button><button class="btn danger" data-act="del">${fresh ? '안 쓸래요' : '기록 삭제'}</button></div>`;
  const finish = note => {
    if (!note) {
      store.deleteEvent(key, e.id);
      return toast(fresh ? '빈 줄은 남기지 않았어요' : '기록을 지웠어요');
    }
    const patch = { note };
    if (Math.round(tw.t / MIN) !== Math.round(e.t / MIN)) patch.t = tw.t;
    store.updateEvent(key, e.id, patch);
    toast(fresh ? '한 줄 남겼어요' : '고쳤어요');
  };
  openSheet(`${it.icon} ${it.name}`, 'NOTE', body, {
    save() {
      done = true;
      finish(v('note').trim());
      closeSheet();
    },
    del() {
      done = true;
      store.deleteEvent(key, e.id);
      closeSheet();
      toast(fresh ? '빈 줄은 남기지 않았어요' : '기록을 지웠어요');
    },
    beforeClose() {
      if (done) return;
      done = true;
      const n = v('note').trim();
      if (fresh) finish(n); // 쓴 글은 살리고, 빈 기록은 치운다
      else if (n && n !== (e.note || '')) finish(n);
    },
  });
}

function openTimeSheet(kind) {
  const key = viewKey(), day = store.day(key), today = key === todayKey();
  const cur = kind === 'wake' ? C.wakeOf(day) : C.sleepOf(day);
  const lo = C.dayStartTs(key, rollover()), usual = kind === 'wake' ? typicalWakeTs(key) : null;
  const def = cur || (today ? now() : kind === 'wake' ? usual || lo + 4 * HOUR : lo + 19 * HOUR);
  const presets = [];
  if (today) presets.push([now(), '지금']);
  if (usual && usual <= timeRange(key)[1]) presets.push([usual, `평소 ${C.fmtTime(usual)}`]);
  openSheet(kind === 'wake' ? '일어난 시각' : '잠든 시각', 'TIME', `${twHtml(key, def, presets)}
    <div class="row-btns"><button class="btn pri" data-act="save">저장</button>${kind === 'sleep' && cur ? '<button class="btn danger" data-act="clear">취침 기록 지우기</button>' : ''}</div>`, {
    save() {
      if (kind === 'wake') {
        store.setWake(key, tw.t);
        ensureSeason();
      } else store.setSleep(key, tw.t);
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
  const dueVal = cur?.due ? C.fmtTime(cur.due) : '';
  const quick = [[60, '1시간 뒤'], [120, '2시간 뒤'], [180, '3시간 뒤']].map(([m, l]) => `<button type="button" data-act="due-in" data-arg="${m}">${l}</button>`).join('');
  openSheet('오늘의 핵심', 'TOP 3', `<label class="fld"><span>오늘 꼭 끝낼 일 하나</span><input name="text" maxlength="40" value="${esc(cur?.text || '')}" placeholder="3장 문제 10개 풀기" autocomplete="off" autofocus></label>
    ${carry.length ? `<div class="fld"><span>어제 못 끝낸 것에서 가져오기</span><div class="sugg">${carry.map(t => `<button data-act="carry" data-arg="${esc(t.text)}">${esc(t.text)}</button>`).join('')}</div></div>` : ''}
    <p class="hint">끝이 보이게 적어요. "공부" 대신 "3장 문제 10개". 크면 반으로 잘라요.</p>
    <div class="fld2"><label class="fld"><span>마감 시각 (외부 마감)</span><input type="time" name="due" value="${dueVal}"></label><label class="fld"><span>누구에게 보고 (선택)</span><input name="to" maxlength="12" value="${esc(cur?.to || '')}" placeholder="형" autocomplete="off"></label></div>
    <div class="sugg" style="margin:-4px 0 12px">${quick}</div>
    <p class="hint">마감 30분 전과 지난 뒤에 코치가 물어봐요. 보고할 사람을 적으면 끝냈을 때 바로 보낼 문장을 만들어 줘요.</p>
    <div class="row-btns"><button class="btn pri" data-act="save">저장</button>${cur?.text ? '<button class="btn danger" data-act="clear">비우기</button>' : ''}</div>`, {
    save() {
      const text = v('text').trim();
      if (!text) return clear();
      const hm = v('due');
      store.setTop3(key, id, { text, due: hm ? C.tsFor(key, hm, rollover()) : 0, to: v('to').trim() || '' });
      closeSheet();
    },
    'due-in'(m) {
      $('#sheet [name="due"]').value = C.fmtTime(now() + m * MIN);
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

// 항목 편집 안의 "어떤 약이에요?": 약마다 체크, 용량(mg), 매일 쌓이는 약은 먹기 시작한 날
function drugLinkHtml(it) {
  const P = profiles();
  if (!P.length) return '';
  const links = new Map((it.drugs || []).map(l => [l.id, l]));
  const rows = P.map(p => {
    const l = links.get(p.id), id = esc(p.id);
    return `<div class="drug-row"><label class="chk"><input type="checkbox" name="drug" value="${id}" ${l ? 'checked' : ''}><span>${esc(p.name)}</span></label>
      <input name="mg-${id}" type="number" inputmode="decimal" step="0.5" min="0" placeholder="mg" value="${l?.mg ?? ''}" aria-label="${esc(p.name)} 용량 mg">
      ${p.kind === 'steady' ? `<label class="since"><span>시작일</span><input name="since-${id}" type="date" value="${esc(l?.since || '')}" aria-label="${esc(p.name)} 먹기 시작한 날"></label>` : ''}</div>`;
  }).join('');
  return `<div class="fld"><span>어떤 약이에요? (같이 먹는 약은 여러 개)</span>${rows}<p class="hint">용량을 넣으면 같은 성분 약이 겹치는 날 곡선이 더 정확해요. 매일 쌓이는 약은 시작일을 넣으면 몇 주째인지 보여줘요.</p></div>`;
}
function readDrugLinks() {
  const out = [...document.querySelectorAll('#sheet [name="drug"]:checked')].map(el => {
    const id = el.value, mg = parseFloat(v('mg-' + id)), since = v('since-' + id);
    const link = { id };
    if (Number.isFinite(mg) && mg > 0) link.mg = mg;
    if (since) link.since = since;
    return link;
  });
  return out.length ? out : undefined;
}

// 약을 건너뛸 때 이유를 받는다. "깜빡했어요"는 건너뛴 게 아니라 못 먹은 날로 남는다.
function openSkipSheet(id, key = todayKey()) {
  const it = itemById(id);
  if (!it) return;
  const today = key === todayKey();
  const chips = Object.entries(C.SKIP_WHY).map(([k, l]) => `<button class="btn" data-act="skip-save" data-arg="${k}">${esc(l)}</button>`).join('');
  openSheet(`${it.icon} ${it.name} · ${today ? '오늘은 건너뛰기' : '그날 안 먹었어요'}`, 'SKIP', `<p class="lead">이유를 누르면 바로 저장돼요. 쌓이면 약 탭의 복용 기록에서 어떤 날 건너뛰는지 보여요. "깜빡했어요"는 건너뛴 날이 아니라 못 먹은 날로 남아요.</p>
    <label class="fld"><span>메모 (선택)</span><input name="note" maxlength="40" autocomplete="off" placeholder="오후에 일정이 없어서"></label>
    <div class="row-btns reasons">${chips}</div>`, {
    'skip-save'(why) {
      const note = v('note').trim() || undefined;
      if (why === 'forgot') store.setMiss(key, id, 'forgot', note);
      else store.setSkip(key, id, true, why, note);
      closeSheet();
      toast(why === 'forgot' ? '못 먹은 날로 남겼어요' : `건너뜀 · ${C.SKIP_WHY[why]}`, { label: '취소', fn: () => store.setSkip(key, id, false) });
    },
  });
}

// 예정 시각 입력: 없음 / 시각 / 기상 후 / 다른 항목 후
function planHtml(it) {
  const p = it.plan || {}, mode = p.time ? 'time' : p.wake != null ? 'wake' : p.after ? 'after' : '';
  const anchors = C.activeItems(cfg()).filter(i => i.type === 'check' && i.id !== it.id);
  return `<div class="fld"><span>예정 시각 (선택)</span>${seg('planmode', mode, [['', '없음'], ['time', '시각'], ['wake', '기상 후'], ['after', '다른 항목 후']])}</div>
    <div data-plan="time"><label class="fld inline"><span>매일</span><input type="time" name="plantime" value="${esc(p.time || '14:00')}"><span>에</span></label></div>
    <div data-plan="wake"><label class="fld inline"><span>일어나고</span><input type="number" name="planwake" inputmode="decimal" step="0.25" min="0" max="20" value="${p.wake ?? 0.5}"><span>시간 뒤</span></label></div>
    <div data-plan="after"><div class="fld2"><label class="fld"><span>기준</span><select name="planafter">${anchors.map(a => `<option value="${esc(a.id)}" ${p.after === a.id ? 'selected' : ''}>${esc(a.icon)} ${esc(a.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>몇 시간 뒤</span><input type="number" name="planh" inputmode="decimal" step="0.25" min="0" max="20" value="${p.h ?? 4.5}"></label></div></div>
    <p class="hint" data-plan="time wake after">예정 30분 전부터 코치가 먹을지·건너뛸지 묻고, 제시간·늦음·건너뜀을 기록해요. 늦게 일어나는 날이 많으면 "다른 항목 후"가 맞을 수 있어요.</p>`;
}
function readPlan() {
  const m = segv('planmode');
  const num = n => parseFloat(v(n));
  if (m === 'time' && v('plantime')) return { time: v('plantime') };
  if (m === 'wake' && Number.isFinite(num('planwake'))) return { wake: num('planwake') };
  if (m === 'after' && v('planafter') && Number.isFinite(num('planh'))) return { after: v('planafter'), h: num('planh') };
  return undefined;
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
    <label class="chk"><input type="checkbox" name="essential" ${it.essential ? 'checked' : ''}><span>필수 항목 (연속에 들어가고, 가볍게 모드에서도 남아요)</span></label>
    <div data-show="check">${planHtml(it)}</div>
    <label class="fld"><span>신호 (선택)</span><input name="cue" maxlength="20" value="${esc(it.cue || '')}" placeholder="양치한 다음에" autocomplete="off"></label>
    <p class="hint" style="margin:-6px 0 12px">이미 매일 하는 일 바로 다음에 붙이면 덜 잊어요. 타일과 코치에 보여요.</p>
    <div class="fld2" data-show="count"><label class="fld"><span>하루 목표</span><input name="target" type="number" inputmode="numeric" min="1" max="99" value="${it.target ?? ''}" placeholder="없음"></label><label class="fld"><span>코치 알림 간격 (분)</span><input name="every" type="number" inputmode="numeric" min="10" max="600" value="${it.every ?? ''}" placeholder="없음"></label></div>
    <label class="fld" data-show="count log-num"><span>단위</span><input name="unit" maxlength="4" value="${esc(it.unit || '')}" placeholder="잔, 개, kg" autocomplete="off"></label>
    <label class="fld" data-show="count log-note log-min log-num"><span>누적 목표 (선택)</span><input name="goal" type="number" inputmode="numeric" min="1" max="9999" value="${it.goal?.total ?? ''}" placeholder="예: 30 → 30개 중 몇 개인지 보여줘요"></label>
    <div data-show-cat="med">${drugLinkHtml(it)}<div class="fld2"><label class="fld"><span>효과 시작 (복용 후 분)</span><input name="fxon" type="number" inputmode="numeric" min="0" max="600" value="${it.fx?.on ?? ''}" placeholder="없음"></label><label class="fld"><span>지속 (시간)</span><input name="fxdur" type="number" inputmode="decimal" step="0.5" min="0" max="24" value="${it.fx?.dur ?? ''}" placeholder="없음"></label></div>
    <p class="hint">약을 연결하면 효과 구간은 자동으로 계산돼요. 연결할 약이 없을 때만 직접 넣어요.</p></div>
    <p class="err" id="sheet-err" hidden></p>
    <div class="row-btns"><button class="btn pri" data-act="save">저장</button>${cur ? '<button class="btn danger" data-act="del">삭제</button>' : ''}</div>`;
  const refresh = () => {
    const m = segv('mode'), c = segv('cat'), pm = segv('planmode');
    document.querySelectorAll('#sheet [data-show]').forEach(el => (el.hidden = !el.dataset.show.split(' ').includes(m)));
    document.querySelectorAll('#sheet [data-show-cat]').forEach(el => (el.hidden = el.dataset.showCat !== c));
    document.querySelectorAll('#sheet [data-plan]').forEach(el => (el.hidden = !el.dataset.plan.split(' ').includes(pm)));
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
        ...(cur || (preset?.id ? { id: preset.id } : {})),
        name,
        icon: v('icon').trim() || '⭐',
        cat,
        type,
        ask,
        block: segv('block'),
        essential: $('#sheet [name="essential"]').checked || undefined,
        cue: v('cue').trim() || undefined,
        target: type === 'count' ? num('target') : undefined,
        every: type === 'count' ? num('every') : undefined,
        unit: type === 'count' || ask === 'num' ? v('unit').trim() || undefined : undefined,
        goal: goal ? { total: Math.round(goal), from: cur?.goal?.from || todayKey() } : undefined,
        fx: fxdur ? { on: Math.round(parseFloat(v('fxon')) || 0), dur: fxdur } : undefined,
        drugs: cat === 'med' ? readDrugLinks() : undefined,
        plan: type === 'check' ? readPlan() : undefined,
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
      <li>Repository access에서 Only select repositories를 고르고, <b>${esc((l.gh?.repo || defaultRepo() || '/기록용 저장소').split('/')[1])}</b> 하나만 골라요 (이름이 비슷한 다른 저장소 말고)</li>
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

// 날씨 위치: 지금 위치(반올림) 또는 도시 이름 검색
function openWxSheet() {
  openSheet('날씨 위치', 'SKY', `<p class="lead">날씨와 해 시각을 받을 곳이에요. 소수 첫째 자리(약 10km)까지만 보내요.</p>
    <div class="row-btns"><button class="btn pri" data-act="wx-gps">지금 위치 쓰기</button></div>
    <label class="fld" style="margin-top:12px"><span>또는 도시 이름</span><input name="city" maxlength="30" placeholder="서울" autocomplete="off"></label>
    <div class="row-btns"><button class="btn" data-act="wx-search">찾기</button></div><div id="wx-results" class="sugg"></div><p class="err" id="sheet-err" hidden></p>`, {
    'wx-gps'(_, el) {
      if (!navigator.geolocation) return sheetErr('이 브라우저는 위치를 쓸 수 없어요');
      el.disabled = true;
      navigator.geolocation.getCurrentPosition(
        p => {
          const loc = { name: '지금 위치 근처', lat: WX.round1(p.coords.latitude), lon: WX.round1(p.coords.longitude) };
          store.setLocal({ wx: { ...wx(), on: true, loc, data: null } });
          closeSheet();
          wxEnsure(true);
        },
        () => {
          el.disabled = false;
          sheetErr('위치를 가져오지 못했어요. 브라우저 위치 권한을 확인하거나 도시 이름으로 찾아 주세요');
        },
        { timeout: 15000, maximumAge: 3600000 },
      );
    },
    async 'wx-search'(_, el) {
      const q = v('city').trim();
      if (!q) return sheetErr('도시 이름을 적어 주세요');
      el.disabled = true;
      try {
        const res = await WX.searchCity(q, (u, o) => fetch(u, o));
        sheetActs._res = res;
        $('#wx-results').innerHTML = res.length ? res.map((r, i) => `<button data-act="wx-pick" data-arg="${i}">${esc(r.name)}</button>`).join('') : '<span class="muted">찾은 곳이 없어요</span>';
      } catch (e) {
        sheetErr(e?.message || '찾지 못했어요');
      }
      el.disabled = false;
    },
    'wx-pick'(i) {
      const r = sheetActs._res?.[+i];
      if (!r) return;
      store.setLocal({ wx: { ...wx(), on: true, loc: r, data: null } });
      closeSheet();
      wxEnsure(true);
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

// ---------- 시각 조절 (시트 안) ----------
// 시계 다이얼 대신 큰 시각 + 앞뒤로 미는 버튼. 늦게 기록한 걸 맞추는 데 두세 번 탭이면 된다.

let tw = null;
const STEPS = [[-60, '−1시간'], [-30, '−30분'], [-10, '−10분'], [-5, '−5분'], [5, '+5분'], [10, '+10분'], [30, '+30분'], [60, '+1시간']];
function twHtml(key, t, presets = []) {
  const range = timeRange(key);
  tw = { key, range, t: clampT(Math.round(t / MIN) * MIN, range) };
  return `<div class="tw"><div class="tw-big"><span id="tw-time">${C.fmtTime(tw.t)}</span><small id="tw-rel">${esc(twRel())}</small></div>
    <div class="tw-steps">${STEPS.map(([d, l]) => `<button type="button" data-act="tw" data-arg="${d}">${l}</button>`).join('')}</div>
    ${presets.length ? `<div class="tw-pre">${presets.map(([ts, l]) => `<button type="button" data-act="tw-set" data-arg="${ts}">${esc(l)}</button>`).join('')}</div>` : ''}
    <label class="fld inline tw-in"><span>직접 입력</span><input type="time" name="time" data-change="tw-input" value="${C.fmtTime(tw.t)}"></label></div>`;
}
function twRel() {
  const parts = [tw.key === todayKey() ? C.ago(tw.t, now()) : C.fmtDate(tw.key)];
  const w = C.wakeOf(getDay(tw.key));
  if (w && tw.t >= w) parts.push(`기상 후 ${C.fmtDur((tw.t - w) / MIN)}`);
  return parts.join(' · ');
}
function twSet(t) {
  if (!tw) return;
  tw.t = clampT(Math.round(t / MIN) * MIN, tw.range);
  const a = $('#tw-time'), b = $('#tw-rel'), inp = $('#sheet [name="time"]');
  if (a) a.textContent = C.fmtTime(tw.t);
  if (b) b.textContent = twRel();
  if (inp) inp.value = C.fmtTime(tw.t);
  haptic(6);
}

// ---------- 방금 기록 바 ----------
// 누른 직후 몇 초 동안 아래에 떠서, 평소 시각이나 몇십 분 전으로 한 번에 옮길 수 있다.

let lg = null, lgTimer = 0;
function showLogged(key, ev) {
  lg = { key, id: ev.id };
  $('#toast').hidden = true;
  bumpLogged();
  renderLogged();
}
function bumpLogged(ms = 7000) {
  clearTimeout(lgTimer);
  lgTimer = setTimeout(hideLogged, ms);
}
function hideLogged() {
  clearTimeout(lgTimer);
  lg = null;
  const el = $('#logged');
  if (el && !el.hidden) {
    el.hidden = true;
    el.innerHTML = '';
  }
}
const lgEvent = () => (lg ? store.day(lg.key).events.find(e => e.id === lg.id && !e.del) || null : null);
function renderLogged() {
  if (!lg) return;
  const ev = lgEvent();
  if (!ev) return hideLogged();
  const key = lg.key, tk = todayKey(), item = itemById(ev.item), it = nameOf(ev.item);
  const range = timeRange(key), u = usualFor(item, key);
  const when = key === tk ? '' : key === C.addDays(tk, -1) ? '어제 ' : C.fmtDate(key) + ' ';
  const extra = item?.type === 'count' ? ` · 오늘 ${C.itemState(store.day(key), item).count}${item.unit || '번'}` : '';
  const chips = [];
  if (u && u <= range[1] && Math.abs(u - ev.t) > 5 * MIN) chips.push(`<button class="usual" data-act="lg-at" data-arg="${u}">평소 ${C.fmtTime(u)}</button>`);
  for (const [d, l] of [[-15, '−15분'], [-30, '−30분'], [-60, '−1시간']]) chips.push(`<button data-act="lg-shift" data-arg="${d}" ${ev.t + d * MIN < range[0] ? 'disabled' : ''}>${l}</button>`);
  chips.push(`<button data-act="lg-pick">${item?.cat === 'meal' ? '메모·시각' : '더 고치기'}</button>`);
  const el = $('#logged');
  el.innerHTML = `<div class="lg-top"><span class="lg-ic" aria-hidden="true">${esc(it.icon)}</span><span class="lg-t">${esc(it.name)} · ${when}<b>${C.fmtTime(ev.t)}</b>${esc(extra)}</span><button class="lg-x" data-act="lg-undo">취소</button><button class="lg-x" data-act="lg-ok" aria-label="확인">${IC.check}</button></div>
    <div class="lg-chips">${chips.join('')}</div>`;
  el.hidden = false;
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
    // 2분 시작이 끝나면 바로 이어 갈 수 있게
    if (f.dur <= 5) toast(`${min}분 했어요. 시작이 제일 어려워요`, { label: '25분 이어서', fn: () => actions.focus('25' + (f.t3 ? ':' + f.t3 : '')) });
    else toast(`집중 ${min}분 끝. 5분 쉬어요`, { label: '한 번 더', fn: () => actions.focus(f.dur + (f.t3 ? ':' + f.t3 : '')) });
  } else toast(min >= 1 ? `집중 ${min}분 기록했어요` : '1분이 안 돼서 기록하지 않았어요');
}

// ---------- 동작 ----------

function runCoach(a) {
  if (!a) return;
  const key = todayKey();
  if (a.act === 'check' || a.act === 'count') addAt(itemById(a.arg), key);
  else if (a.act === 'log') actions.tile(a.arg);
  else if (a.act === 'skip') actions['skip-why'](a.arg);
  else if (a.act === 't3-done') store.setTop3(key, a.arg, { done: now() });
  else if (a.act === 'go-cond') $('#cond')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else actions[a.act]?.(a.arg);
}

const actions = {
  tab(arg) {
    ui.tab = arg === 'med' ? 'flow' : arg;
    hideLogged();
    paint();
    if (arg === 'med') $('#sec-med')?.scrollIntoView();
    else window.scrollTo(0, 0);
  },
  'add-open': () => openAddSheet(),
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
  'wake-at'(ts) {
    store.setWake(todayKey(), +ts);
    ensureSeason();
    haptic(12);
  },
  'wake-ok'() {
    const key = todayKey(), w = C.wakeOf(store.day(key));
    if (w) store.setWake(key, w);
  },
  // 아까 했는데 기록만 못 한 경우: 평소 시각(없으면 시간대 기준)으로 넣고 바로 고칠 수 있게
  ago(id) {
    const it = itemById(id);
    if (!it) return;
    const key = todayKey(), day = store.day(key), [lo, hi] = timeRange(key);
    // 예정 시각이 지났으면 예정 시각, 아니면 평소 시각, 그것도 없으면 시간대 기준
    const due = C.dueOf(it, day, { rollover: rollover() });
    const guess = due && due <= now() ? due : usualFor(it, key) ?? C.guessTime(it, day, { key, rollover: rollover() });
    const t = Math.max(lo, Math.min(hi - MIN, Math.max(C.wakeOf(day) || lo, guess)));
    afterLog(it, key, store.logEvent(key, id, { t, autoWake: true }));
  },
  // 건너뛰기: 약은 이유를 받고, 다른 항목은 바로 건너뛴다
  'skip-why'(id, _el, key = todayKey()) {
    const it = itemById(id);
    if (!it) return;
    if (it.cat === 'med') return openSkipSheet(id, key);
    store.setSkip(key, id, true);
    toast('오늘은 건너뛰어요', { label: '취소', fn: () => store.setSkip(key, id, false) });
  },
  'retro-yes'(id) {
    const it = itemById(id);
    if (!it) return;
    const key = C.addDays(todayKey(), -1), day = store.day(key);
    const due = C.dueOf(it, day, { rollover: rollover() });
    const t = clampT(due ?? usualFor(it, key) ?? C.guessTime(it, day, { key, rollover: rollover() }), timeRange(key));
    afterLog(it, key, store.logEvent(key, id, { t }));
  },
  'retro-no'(id) {
    const key = C.addDays(todayKey(), -1);
    if (itemById(id)?.cat === 'med') return openSkipSheet(id, key);
    store.setMiss(key, id);
  },
  'retro-close'() {
    store.setLocal({ seen: { ...local().seen, ['retro:' + C.addDays(todayKey(), -1)]: 1 } });
  },
  'lg-shift'(d) {
    const ev = lgEvent();
    if (!ev) return;
    store.updateEvent(lg.key, ev.id, { t: clampT(Math.round((ev.t + d * MIN) / MIN) * MIN, timeRange(lg.key)) });
    bumpLogged(9000);
    haptic(8);
  },
  'lg-at'(t) {
    const ev = lgEvent();
    if (!ev) return;
    store.updateEvent(lg.key, ev.id, { t: clampT(+t, timeRange(lg.key)) });
    bumpLogged(9000);
    haptic(8);
  },
  'lg-pick'() {
    if (!lg) return;
    const { key, id } = lg;
    hideLogged();
    openEventSheet(id, key);
  },
  'lg-undo'() {
    if (!lg) return;
    store.deleteEvent(lg.key, lg.id);
    hideLogged();
    toast('기록을 취소했어요');
  },
  'lg-ok': () => hideLogged(),
  'peak-mode'(arg) {
    ui.peakMode = arg;
    render();
  },
  'peak-rating'(arg) {
    ui.peakRating = arg;
    render();
  },
  'rt-done'(id) {
    store.logEvent(todayKey(), 'rt:' + id);
    haptic(10);
  },
  'rt-close'() {
    store.setLocal({ seen: { ...local().seen, ['rt:' + todayKey()]: 1 } });
  },
  'q-toggle'(id) {
    const t = gameCtx().quest?.stages.flatMap(s => s.tasks).find(x => x.id === id);
    if (!t || t.isAuto) return;
    if (t.ok) {
      store.deleteEvent(t.evKey, t.ev);
      toast('체크를 풀었어요');
    } else {
      store.logEvent(todayKey(), 'q:' + id);
      haptic([20, 30, 20]);
      toast(`과제 완료 · +${GM.QUEST_BONUS} EXP`);
    }
  },
  report5: () => openReportSheet(),
  't3-report'(id) {
    const t = C.top3Of(store.day(viewKey())).find(x => x.id === id);
    if (!t) return;
    const when = t.done ? C.fmtTime(t.done) : '';
    share(`${t.to ? `${t.to}, ` : ''}오늘 핵심 끝냈어요: ${t.text}${t.due ? ` (${C.fmtTime(t.due)} 마감, ${when}에 끝)` : when ? ` (${when})` : ''}`);
  },
  'wx-toggle'() {
    const W = wx();
    if (W.on) return store.setLocal({ wx: { ...W, on: false } });
    store.setLocal({ wx: { ...W, on: true } });
    if (!W.loc) openWxSheet();
    else wxEnsure(true);
  },
  'wx-loc': () => openWxSheet(),
  'stat-add'(id) {
    const s = gameCtx().stats.find(x => x.id === id);
    if (s?.add) openItemSheet(null, { ...s.add, id: s.metric.item });
  },
  'med-new'(id) {
    const p = profileById(id);
    if (p) openItemSheet(null, { name: p.name, icon: '💊', cat: 'med', type: 'check', block: p.block || 'am', essential: true, drugs: [{ id: p.id }] });
  },
  tw: d => twSet(tw.t + d * MIN),
  'tw-set': ts => twSet(+ts),
  'time-wake': () => openTimeSheet('wake'),
  'time-sleep': () => openTimeSheet('sleep'),
  tile(id) {
    const it = itemById(id);
    if (!it) return;
    const key = viewKey(), s = C.itemState(store.day(key), it);
    // 체크한 타일을 누르면 바로 시각 고치기 (늦게 기록한 걸 맞추는 게 제일 흔한 일이라)
    if (it.type === 'check' && s.done) return openEventSheet(s.evs[s.evs.length - 1].id, key);
    if (key !== todayKey() || (it.type === 'check' && s.skipped)) return openTileSheet(id);
    // 글이 본체인 기록(예: 사장님 불편 한 줄)은 바로 쓰는 칸을 연다
    if (it.type === 'log' && it.ask === 'note' && it.noteFirst) {
      const ev = store.logEvent(key, it.id, { autoWake: true });
      afterLog(it, key, ev);
      return openEventSheet(ev.id, key, { fresh: true });
    }
    addAt(it, key);
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
    store.setLocal({ focus: { start: now(), dur: +m, label: label || '', t3: t3 || '' } });
    toast(+m <= 5 ? `${m}분만. 파일 열고 첫 줄` : `${m}분 집중 시작`);
  },
  'focus-stop': () => finishFocus(false),
  'focus-cancel'() {
    store.setLocal({ focus: null });
  },
  review: () => openReviewSheet(),
  report: () => share(C.dayReport(store.day(viewKey()), cfg())),
  'report-season'() {
    const { se, stats } = seasonDays();
    const lines = [`[시즌 ${se.n} 보고 · ${C.SEASON_DAYS}일 중 ${se.day}일째]`, `기록 ${stats.recorded}일 · 필수 달성 ${stats.essDays}일 · CLEAR ${stats.clearDays}일 · 누적 ${stats.exp} EXP`, `연속 ${chainNow().n}일`];
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
  'tw-input': el => tw && el.value && twSet(C.tsFor(tw.key, el.value, rollover())),
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

// 하루 목표, 레벨 업, 스탯 등급이 오르는 순간을 알려준다 (내가 기록했을 때만, 동기화로 들어온 건 조용히)
const snap = () => {
  const g = gameCtx();
  return { key: todayKey(), exp: g.today.exp, lv: g.L.lv, tier: g.tier.name, steps: Object.fromEntries(g.stats.map(s => [s.id, [s.reached, s.grade, s.name]])), stages: g.quest?.doneStages || 0, stageName: g.quest?.stages?.[(g.quest?.doneStages || 1) - 1]?.name || '' };
};
let lastSnap = null;
function celebrate(a, b) {
  if (!a) return;
  const msgs = [];
  let big = null;
  if (a.key === b.key && a.exp < C.EXP_GOAL && b.exp >= C.EXP_GOAL) {
    big = 'CLEAR!';
    msgs.push(`하루 목표 달성 · +${GM.CLEAR_BONUS} EXP`);
  }
  for (const [id, [n, grade, name]] of Object.entries(b.steps)) {
    if (n > (a.steps[id]?.[0] ?? n)) {
      big = 'RANK UP!';
      msgs.push(`${name} ${grade} 달성 · +${GM.STEP_BONUS} EXP`);
    }
  }
  if (b.stages > a.stages) {
    big = 'QUEST CLEAR!';
    msgs.push(`메인 퀘스트 '${b.stageName}' 단계 클리어`);
  }
  if (b.lv > a.lv) {
    big = 'LEVEL UP!';
    msgs.push(`Lv.${b.lv}${b.tier !== a.tier ? ` · ${b.tier} 승급` : ''}`);
  }
  if (big) {
    burst(big);
    toast(msgs.join(' · '));
  }
}
store.subscribe(kind => {
  if (kind !== 'local') ver++;
  if (kind === 'data') sync.schedule();
  const s = snap();
  if (kind === 'data') celebrate(lastSnap, s);
  lastSnap = s;
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
lastSnap = snap();
paint();
wxEnsure();
setInterval(() => !document.hidden && wxEnsure(), 10 * MIN);

// 홈 화면 바로가기와 캘린더 알림 링크: ?do=항목 (바로 기록), ?focus=분 (집중 시작), ?go=report (금요일 5줄)
{
  const qs = new URLSearchParams(location.search);
  const doId = qs.get('do'), focusMin = qs.get('focus'), go = qs.get('go');
  if (doId || focusMin || go) {
    history.replaceState(null, '', location.pathname); // 새로고침해도 두 번 기록되지 않게
    const it = doId && itemById(doId);
    if (it) {
      const s = C.itemState(store.day(todayKey()), it);
      if (it.type === 'check' && s.done) openTileSheet(it.id);
      else if (it.type === 'log' && it.ask === 'note' && it.noteFirst) actions.tile(it.id); // 바로 쓰는 칸
      else addAt(it, todayKey());
    } else if (doId) toast('그 항목을 찾지 못했어요');
    if (focusMin && /^\d{1,3}$/.test(focusMin) && !local().focus) actions.focus(focusMin);
    if (go === 'report') actions.report5();
  }
}
if (local().focus) tickFocus();
if (local().gh) sync.syncNow();
// 새 버전이 올라오면 알려준다 (앱을 켜 둔 채로 있어도)
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker
    .register('sw.js')
    .then(reg => document.addEventListener('visibilitychange', () => !document.hidden && reg.update().catch(() => {})))
    .catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('새 버전이 준비됐어요', { label: '적용', fn: () => location.reload() });
  });
}
