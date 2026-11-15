// iCal(.ics) 읽기. 구글 캘린더의 "iCal 형식의 비공개 주소"에서 일정을 뽑는다. 읽기만 하고 아무것도 쓰지 않는다.
// 다루는 것: 종일·시간 일정, 시간대(TZID, UTC), 반복(RRULE: DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY, BYMONTHDAY, UNTIL, COUNT),
// 빠진 날(EXDATE), 한 번만 바꾼 일정(RECURRENCE-ID), 취소된 일정.
const DAY = 86400000;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const unescape = s => String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

// 그 시간대의 벽시계 시각 → 실제 시각(ms). 모르는 시간대면 이 기기의 시간대로 본다
function zonedToEpoch(y, mo, d, h, mi, s, tz) {
  if (!tz) return new Date(y, mo - 1, d, h, mi, s).getTime();
  try {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const p = Object.fromEntries(f.formatToParts(new Date(guess)).map(x => [x.type, +x.value]));
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return guess - (wall - guess);
  } catch {
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }
}

// "20261115", "20261115T190000", "20261115T100000Z" → { t, allDay }
function parseDate(value, params = {}) {
  const m = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h == null) return { t: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)), allDay: false };
  return { t: zonedToEpoch(+y, +mo, +d, +h, +mi, +(s || 0), params.TZID), allDay: false };
}

// "NAME;PARAM=x:VALUE" → { name, params, value } (따옴표 안의 콜론은 건너뛴다)
function parseLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ':' && !q) break;
  }
  if (i >= line.length) return null;
  const [name, ...ps] = line.slice(0, i).split(';');
  const params = {};
  for (const p of ps) {
    const k = p.indexOf('=');
    if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

function parseRRule(v) {
  const r = Object.fromEntries(String(v).split(';').map(x => x.split('=')).filter(x => x.length === 2).map(([k, val]) => [k.toUpperCase(), val]));
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.FREQ)) return null;
  return {
    freq: r.FREQ,
    interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL ? parseDate(r.UNTIL)?.t ?? null : null,
    untilDate: r.UNTIL ? !/T/.test(r.UNTIL) : false,
    byday: r.BYDAY ? r.BYDAY.split(',').map(x => x.trim().toUpperCase().match(/^([+-]?\d+)?([A-Z]{2})$/)).filter(Boolean).map(m => ({ n: m[1] ? +m[1] : 0, wd: WD.indexOf(m[2]) })).filter(x => x.wd >= 0) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number).filter(Number.isFinite) : null,
    wkst: Math.max(0, WD.indexOf(r.WKST || 'MO')),
  };
}

export function parseICS(text) {
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null, skip = 0;
  for (const raw of lines) {
    const up = raw.trim().toUpperCase();
    if (up === 'BEGIN:VEVENT') {
      ev = { uid: '', summary: '', exdates: new Set(), rrule: null, recurId: null, cancelled: false };
      continue;
    }
    if (!ev) continue;
    if (up.startsWith('BEGIN:')) {
      skip++; // VALARM 같은 안쪽 블록은 건너뛴다
      continue;
    }
    if (up.startsWith('END:') && up !== 'END:VEVENT') {
      skip = Math.max(0, skip - 1);
      continue;
    }
    if (up === 'END:VEVENT') {
      if (ev.start != null && !ev.cancelled) {
        if (ev.end == null || ev.end <= ev.start) ev.end = ev.start + (ev.allDay ? DAY : 0);
        out.push(ev);
      } else if (ev.start != null && ev.cancelled && ev.recurId != null) out.push(ev); // 반복 중 한 번 취소: 그 회차를 빼야 한다
      ev = null;
      skip = 0;
      continue;
    }
    if (skip) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'UID') ev.uid = p.value.trim();
    else if (p.name === 'SUMMARY') ev.summary = unescape(p.value);
    else if (p.name === 'LOCATION') ev.location = unescape(p.value);
    else if (p.name === 'STATUS') ev.cancelled = p.value.trim().toUpperCase() === 'CANCELLED';
    else if (p.name === 'DTSTART') {
      const d = parseDate(p.value, p.params);
      if (d) Object.assign(ev, { start: d.t, allDay: d.allDay });
    } else if (p.name === 'DTEND') {
      const d = parseDate(p.value, p.params);
      if (d) ev.end = d.t;
    } else if (p.name === 'RRULE') ev.rrule = parseRRule(p.value);
    else if (p.name === 'EXDATE') {
      for (const v of p.value.split(',')) {
        const d = parseDate(v, p.params);
        if (d) ev.exdates.add(d.t);
      }
    } else if (p.name === 'RECURRENCE-ID') {
      const d = parseDate(p.value, p.params);
      if (d) ev.recurId = d.t;
    }
  }
  return out;
}

// 반복 일정이 실제로 시작하는 시각들 (to 전까지). 이 기기의 벽시계로 하루·주·달을 넘긴다
function* occurrences(ev, to) {
  const r = ev.rrule;
  const s = new Date(ev.start);
  const hms = [s.getHours(), s.getMinutes(), s.getSeconds()];
  const at = (y, m, d) => new Date(y, m, d, ...hms).getTime();
  const within = t => t >= ev.start && (r.until == null || t <= (r.untilDate ? r.until + DAY - 1 : r.until));
  let n = 0;
  const emit = function* (t) {
    if (!within(t)) return;
    n++;
    if (r.count != null && n > r.count) return;
    yield t;
  };
  const done = t => t >= to || (r.count != null && n >= r.count) || (r.until != null && t > r.until + DAY);
  for (let i = 0; i < 20000; i++) {
    const k = i * r.interval;
    let batch = [];
    if (r.freq === 'DAILY') batch = [at(s.getFullYear(), s.getMonth(), s.getDate() + k)];
    else if (r.freq === 'WEEKLY') {
      const days = r.byday?.length ? r.byday.map(x => x.wd) : [s.getDay()];
      // 그 주의 시작(WKST)에서 요일만큼 더한다
      const back = (s.getDay() - r.wkst + 7) % 7;
      batch = days.map(wd => at(s.getFullYear(), s.getMonth(), s.getDate() - back + k * 7 + ((wd - r.wkst + 7) % 7))).sort((a, b) => a - b);
    } else if (r.freq === 'MONTHLY') {
      const y = s.getFullYear(), m = s.getMonth() + k;
      const last = new Date(y, m + 1, 0).getDate();
      if (r.byday?.length) {
        for (const { n: ord, wd } of r.byday) {
          const all = [];
          for (let d = 1; d <= last; d++) if (new Date(y, m, d).getDay() === wd) all.push(d);
          const pick = ord > 0 ? [all[ord - 1]] : ord < 0 ? [all[all.length + ord]] : all;
          for (const d of pick) if (d) batch.push(at(y, m, d));
        }
      } else for (const d of r.bymonthday?.length ? r.bymonthday : [s.getDate()]) {
        const dd = d < 0 ? last + 1 + d : d;
        if (dd >= 1 && dd <= last) batch.push(at(y, m, dd));
      }
      batch.sort((a, b) => a - b);
    } else if (r.freq === 'YEARLY') {
      const t = new Date(s.getFullYear() + k, s.getMonth(), s.getDate(), ...hms);
      if (t.getMonth() === s.getMonth()) batch = [t.getTime()]; // 2월 29일은 윤년에만
    }
    for (const t of batch) yield* emit(t);
    if (!batch.length ? i > 5000 : done(batch[0])) return;
  }
}

// [from, to) 구간에 걸치는 일정들. 시작 시각 순
export function eventsBetween(events, from, to) {
  const overrides = new Map(); // uid → 바꾸거나 취소한 회차의 원래 시각들
  for (const e of events) {
    if (e.recurId == null) continue;
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Set());
    overrides.get(e.uid).add(e.recurId);
  }
  const out = [];
  const add = (e, start) => {
    const end = start + (e.end - e.start);
    const hit = e.allDay || end > start ? start < to && end > from : start >= from && start < to;
    if (hit) out.push({ uid: e.uid, summary: e.summary || '(제목 없음)', location: e.location || '', start, end, allDay: !!e.allDay });
  };
  for (const e of events) {
    if (e.cancelled) continue;
    if (e.recurId != null || !e.rrule) {
      add(e, e.start);
      continue;
    }
    const skip = overrides.get(e.uid);
    for (const t of occurrences(e, to)) {
      if (e.exdates.has(t) || skip?.has(t)) continue;
      add(e, t);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.summary.localeCompare(b.summary));
}
