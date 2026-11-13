// 기기 안 저장소. 모든 변경은 먼저 여기(localStorage)에 쓰고, 동기화는 그 뒤에 따라온다.
import { defaultConfig, newDay, mergeDay, mergeConfig, canon, uid, validDay, validConfig } from './core.js';

export const CFG_PATH = 'config.json';
export const pathOfDay = key => `days/${key.slice(0, 4)}/${key}.json`;
export const keyOfPath = path => (path.startsWith('days/') ? path.slice(-15, -5) : null);

const K_CFG = 'today.cfg';
const K_DAY = 'today.day.';
const K_LOCAL = 'today.local';
const K_MEDS = 'today.meds'; // 약 정보: 비공개 저장소의 meds.json을 받아 둔 것 (앱에서는 읽기만)
const K_GAME = 'today.game'; // 스탯 정의: 비공개 저장소의 game.json (앱에서는 읽기만)

const LOCAL_DEFAULTS = {
  gh: null, // { repo, token } 이 기기에만 저장. 동기화 대상 아님
  shas: {},
  etags: {},
  dirty: [],
  lastSync: 0,
  theme: 'auto',
  loc: false,
  snooze: {},
  focus: null,
  seen: {},
};

export function createStore({ storage, now = Date.now } = {}) {
  const subs = new Set();
  let failed = false;
  const read = k => {
    try {
      const s = storage.getItem(k);
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };
  const write = (k, v) => {
    try {
      storage.setItem(k, JSON.stringify(v));
      failed = false;
    } catch {
      failed = true;
    }
  };

  let cfgSaved = read(K_CFG);
  if (!validConfig(cfgSaved)) cfgSaved = null;
  let cfg = cfgSaved || defaultConfig(0);
  let hasCfg = !!cfgSaved;
  const days = new Map();
  let local = { ...LOCAL_DEFAULTS, ...(read(K_LOCAL) || {}) };
  const validMeds = m => !!m && typeof m === 'object' && Array.isArray(m.drugs);
  let meds = read(K_MEDS);
  if (!validMeds(meds)) meds = null;
  const validGame = g => !!g && typeof g === 'object' && Array.isArray(g.stats);
  let game = read(K_GAME);
  if (!validGame(game)) game = null;

  const emit = kind => subs.forEach(fn => fn(kind));
  const saveLocal = () => write(K_LOCAL, local);

  function markDirty(path) {
    if (!local.dirty.includes(path)) {
      local.dirty = [...local.dirty, path];
      saveLocal();
    }
  }
  function clearDirty(path) {
    if (local.dirty.includes(path)) {
      local.dirty = local.dirty.filter(p => p !== path);
      saveLocal();
    }
  }

  // ----- 하루 -----
  const hasDay = key => storage.getItem(K_DAY + key) != null;
  function day(key) {
    let d = days.get(key);
    if (!d) {
      d = read(K_DAY + key);
      if (!validDay(d)) d = newDay(key);
      d.top3 ||= [];
      d.skips ||= [];
      days.set(key, d);
    }
    return d;
  }
  function mutDay(key, fn) {
    const d = day(key);
    const out = fn(d, now());
    write(K_DAY + key, d);
    markDirty(pathOfDay(key));
    emit('data');
    return out;
  }
  const clean = o => {
    for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
    return o;
  };
  function upsert(list, id, patch, m, base = {}) {
    let x = list.find(e => e.id === id);
    if (!x) {
      x = { id, ...base };
      list.push(x);
    }
    Object.assign(x, patch, { m });
    return x;
  }

  function logEvent(key, item, { t, autoWake, ...extra } = {}) {
    return mutDay(key, (d, m) => {
      const ev = clean({ id: uid(m), item, t: t ?? m, m, ...extra });
      d.events.push(ev);
      if (autoWake && !d.wake?.t) d.wake = { t: ev.t, auto: true, m };
      return ev;
    });
  }
  function updateEvent(key, id, patch) {
    return mutDay(key, (d, m) => {
      const ev = d.events.find(e => e.id === id);
      if (!ev) return null;
      Object.assign(ev, patch, { m });
      // 기상을 첫 기록으로 짐작했는데 그 기록을 더 이른 시각으로 옮기면 기상도 따라간다
      if (patch.t != null && d.wake?.auto && patch.t < d.wake.t) d.wake = { t: patch.t, auto: true, m };
      return clean(ev);
    });
  }
  function deleteEvent(key, id) {
    return mutDay(key, (d, m) => {
      const ev = d.events.find(e => e.id === id);
      if (ev) {
        ev.del = true;
        ev.m = m;
      }
    });
  }
  const setWake = (key, t, auto) => mutDay(key, (d, m) => { d.wake = auto ? { t, auto: true, m } : { t, m }; });
  const setSleep = (key, t) => mutDay(key, (d, m) => { d.sleep = { t: t || 0, m }; });
  const setReview = (key, r) => mutDay(key, (d, m) => { d.review = r ? { ...r, m } : { off: true, m }; });
  const setLite = (key, on) => mutDay(key, (d, m) => { d.lite = { on: !!on, m }; });
  const setTop3 = (key, id, patch) => mutDay(key, (d, m) => upsert(d.top3, id, patch, m, { text: '', done: 0 }));
  // 건너뛰기: 이유(why)와 메모를 함께 남긴다. 취소하면 이유도 지운다.
  const setSkip = (key, itemId, on, why, note) =>
    mutDay(key, (d, m) => upsert(d.skips, itemId, { on: !!on, miss: false, why: on ? why : undefined, note: on ? note : undefined }, m));
  // "못 했어요": 다시 묻지 않게 표시한다 (건너뛴 날이 아니라 못 한 날로 남는다)
  const setMiss = (key, itemId, why, note) => mutDay(key, (d, m) => upsert(d.skips, itemId, { on: false, miss: true, why, note }, m));

  // ----- 설정(항목·장소) -----
  function mutCfg(fn) {
    const out = fn(cfg, now());
    hasCfg = true;
    write(K_CFG, cfg);
    markDirty(CFG_PATH);
    emit('data');
    return out;
  }
  function saveItem(item) {
    return mutCfg((c, m) => {
      if (item.id) {
        const cur = c.items.find(i => i.id === item.id);
        if (cur) return clean(Object.assign(cur, item, { m }));
      }
      const order = c.items.reduce((mx, i) => Math.max(mx, i.order ?? 0), -1) + 1;
      const it = clean({ ...item, id: item.id || 'i' + uid(m), order, m });
      c.items.push(it);
      return it;
    });
  }
  function deleteItem(id) {
    mutCfg((c, m) => {
      const it = c.items.find(i => i.id === id);
      if (it) Object.assign(it, { del: true, m });
    });
  }
  function moveItem(id, dir) {
    mutCfg((c, m) => {
      const list = c.items.filter(i => !i.del).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const i = list.findIndex(x => x.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      list.forEach((x, n) => {
        if (x.order !== n) Object.assign(x, { order: n, m });
      });
    });
  }
  const setPrefs = patch => mutCfg((c, m) => { c.prefs = { ...c.prefs, ...patch, m }; });
  const savePlace = p => mutCfg((c, m) => upsert(c.places, p.id || 'p' + uid(m), p, m));
  const deletePlace = id => mutCfg((c, m) => {
    const p = c.places.find(x => x.id === id);
    if (p) Object.assign(p, { del: true, m });
  });
  const saveDday = d => mutCfg((c, m) => clean(upsert((c.ddays ||= []), d.id || 'd' + uid(m), d, m)));
  const deleteDday = id => mutCfg((c, m) => {
    const d = (c.ddays || []).find(x => x.id === id);
    if (d) Object.assign(d, { del: true, m });
  });

  // ----- 약 정보 (동기화로만 들어온다) -----
  function setMeds(doc) {
    const next = validMeds(doc) ? doc : null;
    if (canon(next) === canon(meds)) return;
    meds = next;
    if (meds) write(K_MEDS, meds);
    else {
      try {
        storage.removeItem(K_MEDS);
      } catch {
        /* 지울 수 없는 저장소 */
      }
    }
    emit('remote');
  }

  function setGame(doc) {
    const next = validGame(doc) ? doc : null;
    if (canon(next) === canon(game)) return;
    game = next;
    if (game) write(K_GAME, game);
    else {
      try {
        storage.removeItem(K_GAME);
      } catch {
        /* 지울 수 없는 저장소 */
      }
    }
    emit('remote');
  }

  // ----- 기기 전용 값 -----
  function setLocal(patch, silent) {
    local = { ...local, ...patch };
    saveLocal();
    if (!silent) emit('local');
  }

  // ----- 동기화가 쓰는 창구 -----
  function doc(path) {
    if (path === CFG_PATH) return hasCfg ? cfg : null;
    const key = keyOfPath(path);
    return key && hasDay(key) ? day(key) : null;
  }
  // 원격 문서를 받아 내 것과 합친다. 합친 결과가 원격과 다르면 올릴 것이 남았다는 뜻이다.
  function applyRemote(path, remote) {
    if (path === CFG_PATH) {
      if (!validConfig(remote)) return markDirty(path);
      const before = hasCfg ? cfg : null;
      const merged = mergeConfig(before, remote);
      const changed = !before || canon(merged) !== canon(before);
      if (changed) {
        cfg = merged;
        hasCfg = true;
        write(K_CFG, cfg);
      }
      canon(merged) !== canon(remote) ? markDirty(path) : clearDirty(path);
      if (changed) emit('remote');
      return;
    }
    const key = keyOfPath(path);
    if (!key) return;
    if (!validDay(remote)) return hasDay(key) ? markDirty(path) : undefined;
    const before = hasDay(key) ? day(key) : null;
    const merged = mergeDay(before, remote);
    const changed = !before || canon(merged) !== canon(before);
    if (changed) {
      days.set(key, merged);
      write(K_DAY + key, merged);
    }
    canon(merged) !== canon(remote) ? markDirty(path) : clearDirty(path);
    if (changed) emit('remote');
  }
  function setSha(path, sha) {
    const shas = { ...local.shas };
    if (sha) shas[path] = sha;
    else delete shas[path];
    local = { ...local, shas };
    saveLocal();
  }
  function setEtag(k, v) {
    const etags = { ...local.etags };
    if (v) etags[k] = v;
    else delete etags[k];
    local = { ...local, etags };
    saveLocal();
  }
  function dayKeys() {
    const out = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(K_DAY)) out.push(k.slice(K_DAY.length));
    }
    return out.sort();
  }
  // 처음 연결할 때: 이 기기에 있는 것을 전부 올릴 대상으로 표시
  function markAllDirty() {
    const paths = dayKeys().map(pathOfDay);
    if (hasCfg) paths.push(CFG_PATH);
    local = { ...local, dirty: [...new Set([...local.dirty, ...paths])] };
    saveLocal();
  }

  // ----- 내보내기/가져오기 -----
  function exportAll() {
    const out = { app: 'today', v: 1, exportedAt: now(), config: cfg, meds, game, days: {} };
    for (const k of dayKeys()) out.days[k] = day(k);
    return out;
  }
  function importAll(data) {
    if (!data || data.app !== 'today' || typeof data.days !== 'object') throw new Error('오늘 앱의 백업 파일이 아니에요');
    let n = 0;
    if (validMeds(data.meds)) setMeds(data.meds);
    if (validGame(data.game)) setGame(data.game);
    if (validConfig(data.config)) {
      applyRemote(CFG_PATH, data.config);
      markDirty(CFG_PATH);
    }
    for (const [k, d] of Object.entries(data.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !validDay(d)) continue;
      applyRemote(pathOfDay(k), d);
      markDirty(pathOfDay(k));
      n++;
    }
    emit('data');
    return n;
  }

  // 다른 탭에서 바뀐 값을 다시 읽는다
  function invalidate(storageKey) {
    if (!storageKey) return;
    if (storageKey === K_CFG) {
      const c = read(K_CFG);
      if (validConfig(c)) {
        cfg = c;
        hasCfg = true;
      }
    } else if (storageKey === K_LOCAL) {
      local = { ...LOCAL_DEFAULTS, ...(read(K_LOCAL) || {}) };
    } else if (storageKey === K_MEDS) {
      const m = read(K_MEDS);
      meds = validMeds(m) ? m : null;
    } else if (storageKey === K_GAME) {
      const g = read(K_GAME);
      game = validGame(g) ? g : null;
    } else if (storageKey.startsWith(K_DAY)) {
      days.delete(storageKey.slice(K_DAY.length));
    }
  }

  return {
    subscribe: fn => (subs.add(fn), () => subs.delete(fn)),
    config: () => cfg,
    hasConfig: () => hasCfg,
    day,
    hasDay,
    dayKeys,
    local: () => local,
    setLocal,
    meds: () => meds?.drugs || [],
    medsDoc: () => meds,
    setMeds,
    game: () => game,
    setGame,
    failed: () => failed,
    logEvent, updateEvent, deleteEvent,
    setWake, setSleep, setReview, setLite, setTop3, setSkip, setMiss,
    saveItem, deleteItem, moveItem, setPrefs, savePlace, deletePlace, saveDday, deleteDday,
    doc, applyRemote, markDirty, clearDirty, markAllDirty,
    isDirty: p => local.dirty.includes(p),
    dirtyPaths: () => [...local.dirty],
    sha: p => local.shas[p],
    setSha,
    etag: k => local.etags[k],
    setEtag,
    exportAll, importAll, invalidate,
  };
}
