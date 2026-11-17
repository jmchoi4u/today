// 아침 브리핑: 날씨·미세먼지·옷차림, 캘린더 일정, 식단, 소식 세 줄, 지금 단계.
// 밖으로 나가는 것: 대략의 위치(소수 첫째 자리)가 Open-Meteo로, 소식 키워드가 Google 뉴스로 간다. 브리핑을 만들 때 기록과 캘린더 내용은 어디에도 보내지 않는다 (두뇌 모드에서는 일정 제목이 오늘 상태에 들어가 AI에게 간다. 장소는 빼고).
// 무엇을 보여 줄지는 비공개 저장소 game.json의 brief { loc, news, meals }와 .env의 CALENDAR_ICS_URL로 정한다.
import * as C from '../../js/core.js';
import * as GM from '../../js/game.js';
import * as WX from '../../js/weather.js';
import { parseICS, eventsBetween } from './ical.mjs';

const { MIN, HOUR } = C;
const DAY = 24 * HOUR;
export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- 미세먼지 (한국 예보 기준: PM2.5 15·35·75, PM10 30·80·150) ----------
const GRADES = ['좋음', '보통', '나쁨', '매우 나쁨'];
const gradeOf = (v, cuts) => (v == null ? -1 : cuts.findIndex(c => v <= c) < 0 ? 3 : cuts.findIndex(c => v <= c));
export function airGrade({ pm25, pm10 }) {
  const g = Math.max(gradeOf(pm25, [15, 35, 75]), gradeOf(pm10, [30, 80, 150]));
  return g < 0 ? null : { level: g, text: GRADES[g], mask: g >= 2 };
}
export async function fetchAir({ lat, lon }, fetchFn = fetch) {
  const q = new URLSearchParams({ latitude: String(WX.round1(lat)), longitude: String(WX.round1(lon)), current: 'pm10,pm2_5', hourly: 'pm10,pm2_5', forecast_days: '1', timezone: 'auto' });
  const r = await fetchFn(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`);
  if (!r.ok) throw new Error(`미세먼지를 받지 못했어요 (${r.status})`);
  const j = await r.json();
  // 지금 값과, 지금부터 밤 9시까지(밖에 있을 시간) 중 가장 높은 값
  const times = j.hourly?.time || [];
  const cur = (j.current?.time || '').slice(0, 13);
  const max = a => {
    const rest = (Array.isArray(a) ? a : []).filter((x, i) => x != null && times[i] >= cur && +String(times[i]).slice(11, 13) <= 21);
    return rest.length ? Math.max(...rest) : null;
  };
  return { pm25: j.current?.pm2_5 ?? null, pm10: j.current?.pm10 ?? null, max25: max(j.hourly?.pm2_5), max10: max(j.hourly?.pm10) };
}

// ---------- 옷차림 (낮 최고 기온 기준, 일교차가 크면 겉옷) ----------
export function clothes({ tmax, tmin, rain, wet }) {
  if (tmax == null) return '';
  const t = Math.round(tmax);
  let wear;
  if (t >= 28) wear = '반팔, 반바지';
  else if (t >= 23) wear = '반팔, 얇은 셔츠, 면바지';
  else if (t >= 20) wear = '긴팔, 얇은 가디건';
  else if (t >= 17) wear = '맨투맨이나 얇은 니트, 가디건';
  else if (t >= 12) wear = '자켓, 니트';
  else if (t >= 9) wear = '트렌치코트나 야상, 니트';
  else if (t >= 5) wear = '코트, 니트, 히트텍';
  else wear = '패딩, 목도리, 장갑';
  const extra = [];
  if (tmin != null && tmax - tmin >= 8 && t >= 9) extra.push(`아침·밤은 ${Math.round(tmin)}°라 겉옷 하나 더`);
  if (wet || (rain != null && rain >= 50)) extra.push('우산');
  return [wear, ...extra].join(' · ');
}

// ---------- 소식 (Google 뉴스 RSS, 키워드마다) ----------
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
export function parseRSS(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = tag => decode(m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]);
    const source = pick('source');
    let title = pick('title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -source.length - 3);
    const t = Date.parse(pick('pubDate'));
    const link = pick('link');
    if (title && /^https?:\/\//.test(link)) out.push({ title, source, link, t: Number.isFinite(t) ? t : 0 });
  }
  return out;
}
export async function fetchNews(keywords, { fetchFn = fetch, now = Date.now(), max = 3, hours = 48 } = {}) {
  const lists = [];
  for (const kw of (keywords || []).slice(0, 5)) {
    try {
      const r = await fetchFn(`https://news.google.com/rss/search?${new URLSearchParams({ q: kw, hl: 'ko', gl: 'KR', ceid: 'KR:ko' })}`, { headers: { 'User-Agent': 'today-bot' } });
      if (!r.ok) continue;
      lists.push(parseRSS(await r.text()).filter(x => x.t && now - x.t <= hours * HOUR && x.t <= now + HOUR).sort((a, b) => b.t - a.t));
    } catch {
      /* 한 키워드가 안 돼도 나머지는 보여 준다 */
    }
  }
  // 키워드를 돌아가며 최신 것부터, 비슷한 제목은 한 번만
  const out = [], seen = new Set();
  const norm = s => s.replace(/[\s"'“”‘’·…,.!?\-\[\]()]/g, '').slice(0, 18);
  for (let i = 0; out.length < max && lists.some(l => l.length > i); i++) {
    for (const l of lists) {
      const x = l[i];
      if (!x || out.length >= max || seen.has(norm(x.title))) continue;
      seen.add(norm(x.title));
      out.push(x);
    }
  }
  return out;
}

// ---------- 일정 ----------
const hm = C.fmtTime;
export const eventLine = e => (e.allDay ? `종일 ${e.summary}` : `${hm(e.start)} ${e.summary}`);

// ---------- 브리핑 문장 (텔레그램 HTML) ----------
export function composeBrief({ key, w, air, events, calendarOn, meals, news, quest, carry }) {
  const L = [`<b>☀️ ${esc(C.fmtDate(key))} 브리핑</b>`];
  const d = w?.days?.find(x => x.date === key) || w?.days?.[0];
  if (w && d) {
    const now = w.temp != null ? `지금 ${Math.round(w.temp)}° · ` : '';
    const desc = WX.describe(w.code);
    L.push(`${desc.icon} ${desc.text ? `${desc.text} · ` : ''}${now}낮 ${Math.round(d.tmax)}° / 아침 ${Math.round(d.tmin)}°${d.rain != null ? ` · 비 ${Math.round(d.rain)}%` : ''}`);
  }
  if (air) {
    // 지금 등급을 말하고, 오늘 남은 시간에 더 나빠지면 그것도 알려 준다
    const cur = airGrade(air), peak = airGrade({ pm25: air.max25, pm10: air.max10 });
    const worse = cur && peak && peak.level > cur.level;
    const g = cur || peak;
    if (g) L.push(`😷 미세먼지 ${cur ? `지금 ${cur.text}` : peak.text}${worse ? `, 오늘 중 ${peak.text}까지` : ''}${air.pm25 != null ? ` (초미세 ${Math.round(air.pm25)})` : ''}${cur?.mask || peak?.mask ? ' · 마스크 챙겨요' : ''}`);
  }
  if (w && d) {
    const c = clothes({ tmax: d.tmax, tmin: d.tmin, rain: d.rain, wet: WX.isWet(w) });
    if (c) L.push(`🧥 ${esc(c)}`);
  }
  if (calendarOn) L.push(`📅 ${events?.length ? events.map(e => esc(eventLine(e))).join(' · ') : '오늘 일정 없음'}`);
  if (meals?.length) L.push(`🍚 ${meals.map(esc).join(' / ')}`);
  if (news?.length) L.push('', '<b>🗞️ 소식</b>', ...news.map(n => `· <a href="${esc(n.link)}">${esc(n.title)}</a>${n.source ? ` <i>${esc(n.source)}</i>` : ''}`));
  const cur = quest?.current;
  if (cur) {
    const next = cur.tasks.find(t => !t.ok && !t.isAuto) || cur.tasks.find(t => !t.ok);
    const left = cur.end ? C.ddayInfo({ label: cur.name, to: cur.end }, key).text : '';
    L.push('', `🎯 ${esc(cur.name)}${left ? ` (${esc(left)})` : ''}${next ? ` · 다음: ${esc(next.text)}` : ''}`);
  }
  if (carry?.length) L.push(`↩️ 어제 못 끝낸 것: ${carry.map(esc).join(', ')}`);
  return L.join('\n');
}

// ---------- 비서에 붙이는 창구 ----------
// calendarUrl: .env의 CALENDAR_ICS_URL (비밀 주소라 기록에 남기지 않는다)
export function createBrief({ store, calendarUrl = '', fetchFn = fetch, now = Date.now, log = () => {} }) {
  let cal = { at: 0, events: null, error: '' };
  const cfg = () => store.game()?.brief || {};
  const get = (url, o = {}) => fetchFn(url, { ...o, signal: AbortSignal.timeout(20_000) });

  // 캘린더는 30분마다 다시 읽는다. 실패하면 지난번 것을 그대로 쓴다
  async function refresh(force = false) {
    if (!calendarUrl || (!force && now() - cal.at < 30 * MIN)) return;
    cal.at = now();
    try {
      const r = await get(calendarUrl);
      if (!r.ok) throw new Error(`캘린더 응답 ${r.status}`);
      cal.events = parseICS(await r.text());
      cal.error = '';
    } catch (e) {
      cal.error = e?.name === 'TimeoutError' ? '캘린더 응답이 늦어요' : e?.message || '캘린더를 읽지 못했어요';
      log('calendar', cal.error);
    }
  }
  const between = (from, to) => (cal.events ? eventsBetween(cal.events, from, to) : []);
  // 그 날짜(달력의 하루)의 일정
  const onDate = key => {
    const from = C.keyToDate(key).getTime();
    return between(from, from + DAY);
  };
  // 비서가 30분 전에 알릴 일정: 새벽 기준 하루 안에서 시간이 있는 것
  function calendarFor(key, rollover) {
    if (!cal.events) return null;
    const from = C.dayStartTs(key, rollover);
    return { upcoming: between(from, from + DAY).filter(e => !e.allDay), tomorrow: onDate(C.addDays(key, 1)) };
  }

  async function build(key) {
    const b = cfg();
    await refresh();
    const [w, air, news] = await Promise.all([
      b.loc ? WX.fetchWeather(b.loc, (u, o) => get(u), now()).catch(e => (log('weather', e?.message), null)) : null,
      b.loc ? fetchAir(b.loc, get).catch(e => (log('air', e?.message), null)) : null,
      b.news?.keywords?.length ? fetchNews(b.news.keywords, { fetchFn: get, now: now(), max: b.news.max || 3, hours: b.news.hours || 48 }).catch(() => []) : [],
    ]);
    const day = store.day(key);
    const prevKey = C.addDays(key, -1);
    const days = C.lastDays(key, 35).filter(k => store.hasDay(k)).map(k => store.day(k));
    const quest = GM.questState(store.game()?.quest, { cfg: store.config(), days, todayKey: key });
    const done = new Set(C.top3Of(day).map(t => t.text));
    const carry = store.hasDay(prevKey) ? C.top3Of(store.day(prevKey)).filter(t => !t.done && !done.has(t.text)).map(t => t.text) : [];
    const meals = b.meals ? b.meals[GM.isWeekend(key) ? 'weekend' : 'weekday'] || b.meals.all : null;
    return composeBrief({ key, w, air, events: onDate(key), calendarOn: !!calendarUrl && !!cal.events, meals, news, quest, carry });
  }

  // 보여 줄 게 하나라도 정해져 있을 때만 자동으로 보낸다
  const enabled = () => !!calendarUrl || !!store.game()?.brief;
  return { refresh, build, calendarFor, onDate, enabled, status: () => ({ on: !!calendarUrl, count: cal.events?.length ?? 0, error: cal.error }) };
}
