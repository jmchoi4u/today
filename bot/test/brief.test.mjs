process.env.TZ = 'Asia/Seoul'; // 날짜 계산을 한국 시각으로 고정 (Date를 쓰기 전에)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../js/core.js';
import { createStore } from '../../js/store.js';
import { MemoryStorage, clock } from '../../tests/helpers.mjs';
import { parseICS, eventsBetween } from '../lib/ical.mjs';
import { airGrade, clothes, parseRSS, fetchNews, composeBrief, createBrief, eventLine } from '../lib/brief.mjs';
import { planPings } from '../lib/planner.mjs';
import { createBot } from '../lib/bot.mjs';

const kst = (mo, d, h = 0, mi = 0) => Date.UTC(2026, mo - 1, d, h - 9, mi); // 한국 시각 → 실제 시각
const dayOf = (mo, d) => [kst(mo, d), kst(mo, d + 1)];
const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'UID:a1', 'SUMMARY:생일 모임', 'DTSTART;VALUE=DATE:20261115', 'DTEND;VALUE=DATE:20261116', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b1', 'SUMMARY:스터디\\, 강', ' 남 모임', 'DTSTART;TZID=Asia/Seoul:20261116T190000', 'DTEND;TZID=Asia/Seoul:20261116T203000', 'LOCATION:강남역',
  'BEGIN:VALARM', 'TRIGGER:-PT30M', 'DESCRIPTION:알림', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c1', 'SUMMARY:주간 회의', 'DTSTART:20261102T010000Z', 'DTEND:20261102T020000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261130T000000Z', 'EXDATE:20261118T010000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c1', 'RECURRENCE-ID:20261116T010000Z', 'SUMMARY:주간 회의 (옮김)', 'DTSTART:20261116T050000Z', 'DTEND:20261116T060000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:d1', 'SUMMARY:사흘만', 'DTSTART;TZID=Asia/Seoul:20261110T080000', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:e1', 'SUMMARY:취소된 것', 'STATUS:CANCELLED', 'DTSTART:20261116T030000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:f1', 'SUMMARY:월말 정산', 'DTSTART;VALUE=DATE:20260930', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:g1', 'SUMMARY:뉴욕 통화', 'DTSTART;TZID=America/New_York:20261116T080000', 'DTEND;TZID=America/New_York:20261116T083000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:h1', 'SUMMARY:둘째 화요일', 'DTSTART;TZID=Asia/Seoul:20261013T120000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('캘린더: 종일·시간·시간대·접힌 줄, 반복과 빠진 날·옮긴 회차·취소', () => {
  const evs = parseICS(ICS);
  const on = (mo, d) => eventsBetween(evs, ...dayOf(mo, d)).map(e => `${e.allDay ? '종일' : C.fmtTime(e.start)} ${e.summary}`);
  assert.deepEqual(on(11, 15), ['종일 생일 모임']);
  assert.deepEqual(on(11, 16), ['14:00 주간 회의 (옮김)', '19:00 스터디, 강남 모임', '22:00 뉴욕 통화'], '옮긴 회차는 새 시각에만, 취소된 건 없음, 뉴욕 08:00은 한국 22:00');
  assert.equal(eventsBetween(evs, ...dayOf(11, 16)).find(e => e.uid === 'b1').location, '강남역');
  assert.deepEqual(on(11, 18), [], '빠진 날(EXDATE)');
  assert.deepEqual(on(11, 23), ['10:00 주간 회의']);
  assert.deepEqual(on(11, 25), ['10:00 주간 회의'], '수요일도');
  assert.deepEqual(on(11, 30), ['종일 월말 정산'], 'UNTIL이 지난 회의는 없고, 매달 마지막 날은 있다');
  assert.deepEqual(on(10, 31), ['종일 월말 정산']);
  assert.deepEqual([on(11, 10), on(11, 12), on(11, 13)], [['08:00 사흘만', '12:00 둘째 화요일'], ['08:00 사흘만'], []], 'COUNT=3이면 세 번만, 11/10은 둘째 화요일');
  assert.deepEqual(parseICS('쓰레기'), []);
  assert.deepEqual(eventsBetween(parseICS('BEGIN:VEVENT\nUID:x\nDTSTART:bad\nEND:VEVENT'), 0, 1e15), []);
});

test('미세먼지 등급, 옷차림', () => {
  assert.deepEqual([airGrade({ pm25: 10, pm10: 20 }).text, airGrade({ pm25: 30, pm10: 20 }).text, airGrade({ pm25: 10, pm10: 100 }).text, airGrade({ pm25: 80, pm10: 10 }).text], ['좋음', '보통', '나쁨', '매우 나쁨']);
  assert.equal(airGrade({ pm25: 40, pm10: 10 }).mask, true);
  assert.equal(airGrade({ pm25: null, pm10: null }), null);
  assert.equal(clothes({ tmax: 30, tmin: 24 }), '반팔, 반바지');
  assert.equal(clothes({ tmax: 12, tmin: 3, rain: 10 }), '자켓, 니트 · 아침·밤은 3°라 겉옷 하나 더');
  assert.equal(clothes({ tmax: 6, tmin: 0, rain: 70 }), '코트, 니트, 히트텍 · 우산');
  assert.equal(clothes({ tmax: 1, tmin: -8 }), '패딩, 목도리, 장갑');
  assert.equal(clothes({ tmax: 20, tmin: 15, wet: true }), '긴팔, 얇은 가디건 · 우산');
  assert.equal(clothes({}), '');
});

const rss = items => `<rss><channel>${items.map(([title, src, date]) => `<item><title>${title} - ${src}</title><link>https://news.example/${encodeURIComponent(title)}</link><pubDate>${new Date(date).toUTCString()}</pubDate><source url="https://x">${src}</source></item>`).join('')}</channel></rss>`;

test('소식: 키워드를 돌아가며 최신 것, 같은 기사와 오래된 기사는 빼고 세 줄까지', async () => {
  const now = kst(11, 16, 7);
  const feeds = {
    '소상공인 AI': rss([['가게 &amp; AI 도입', '한신문', now - 2 * C.HOUR], ['오래된 기사', '한신문', now - 80 * C.HOUR], ['둘째 기사', '두신문', now - 5 * C.HOUR]]),
    'AI 자동화': rss([['가게 & AI 도입', '세신문', now - 3 * C.HOUR], ['자동화 사례', '세신문', now - 4 * C.HOUR], ['넷째', '세신문', now - 6 * C.HOUR]]),
  };
  const asked = [];
  const fetchFn = async url => {
    const q = new URL(url).searchParams.get('q');
    asked.push(q);
    return feeds[q] ? { ok: true, text: async () => feeds[q] } : { ok: false, status: 500 };
  };
  const news = await fetchNews(['소상공인 AI', 'AI 자동화', '안 되는 키워드'], { fetchFn, now, max: 3 });
  assert.deepEqual(news.map(n => `${n.title}|${n.source}`), ['가게 & AI 도입|한신문', '둘째 기사|두신문', '자동화 사례|세신문']);
  assert.deepEqual(asked, ['소상공인 AI', 'AI 자동화', '안 되는 키워드']);
  assert.deepEqual(parseRSS('<item><title>링크 없음</title></item>'), []);
});

test('브리핑 문장: 있는 것만 넣고, 글자는 HTML로 안전하게', () => {
  const key = '2026-11-16';
  const w = { temp: 5.4, code: 1, precip: 0, days: [{ date: key, tmax: 12.2, tmin: 3.1, rain: 10 }] };
  const text = composeBrief({
    key, w, air: { pm25: 18, pm10: 30, max25: 40, max10: 50 }, calendarOn: true,
    events: [{ summary: '면접 <1차>', start: kst(11, 16, 14), end: kst(11, 16, 15), allDay: false }, { summary: '종일 일정', start: kst(11, 16), end: kst(11, 17), allDay: true }],
    meals: ['아침 계란 3개·밥·김', '점심 국밥'], news: [{ title: 'A & B', source: '신문', link: 'https://n.example/?a=1&b=2' }],
    quest: { current: { name: '서명 주간', start: '2026-11-15', end: '2026-11-22', tasks: [{ text: '자동', isAuto: true, ok: false }, { text: '헌법 서명', ok: false }] } },
    carry: ['코테 2문제'],
  });
  const lines = text.split('\n');
  assert.equal(lines[0], '<b>☀️ 11월 16일 (월) 브리핑</b>');
  assert.equal(lines[1], '🌤️ 구름 조금 · 지금 5° · 낮 12° / 아침 3° · 비 10%');
  assert.equal(lines[2], '😷 미세먼지 지금 보통, 오늘 중 나쁨까지 (초미세 18) · 마스크 챙겨요');
  assert.ok(composeBrief({ key, air: { pm25: 10, pm10: 20, max25: 12, max10: 25 } }).endsWith('😷 미세먼지 지금 좋음 (초미세 10)'));
  assert.equal(lines[3], '🧥 자켓, 니트 · 아침·밤은 3°라 겉옷 하나 더');
  assert.equal(lines[4], '📅 14:00 면접 &lt;1차&gt; · 종일 종일 일정');
  assert.equal(lines[5], '🍚 아침 계란 3개·밥·김 / 점심 국밥');
  assert.ok(text.includes('· <a href="https://n.example/?a=1&amp;b=2">A &amp; B</a> <i>신문</i>'));
  assert.ok(text.includes('🎯 서명 주간 (D-6) · 다음: 헌법 서명'), text);
  assert.ok(text.endsWith('↩️ 어제 못 끝낸 것: 코테 2문제'));
  assert.equal(composeBrief({ key, calendarOn: true, events: [] }), '<b>☀️ 11월 16일 (월) 브리핑</b>\n📅 오늘 일정 없음');
  assert.equal(composeBrief({ key }), '<b>☀️ 11월 16일 (월) 브리핑</b>', '아무것도 없으면 제목만');
  assert.equal(eventLine({ allDay: true, summary: 'x' }), '종일 x');
});

test('브리핑 만들기: 자료를 받아 조립하고, 한 군데가 안 돼도 나머지는 보낸다. 캘린더 주소는 받기만', async () => {
  const now = clock(kst(11, 16, 7, 5));
  const store = createStore({ storage: new MemoryStorage(), now });
  store.setGame({ v: 1, stats: [], brief: { loc: { lat: 37.47, lon: 126.95 }, news: { keywords: ['k'] }, meals: { weekday: ['평일 밥'], weekend: ['주말 밥'] } } });
  const urls = [];
  const fetchFn = async url => {
    urls.push(String(url));
    if (url.startsWith('https://cal.example/')) return { ok: true, text: async () => ICS };
    if (url.includes('air-quality')) return { ok: false, status: 503 };
    if (url.includes('api.open-meteo.com')) return { ok: true, json: async () => ({ current: { temperature_2m: 4, weather_code: 0, precipitation: 0, is_day: 1 }, daily: { time: ['2026-11-16'], temperature_2m_max: [11], temperature_2m_min: [2], precipitation_probability_max: [0] } }) };
    return { ok: true, text: async () => rss([['새 소식', '신문', now() - C.HOUR]]) };
  };
  const logs = [];
  const brief = createBrief({ store, calendarUrl: 'https://cal.example/secret.ics', fetchFn, now, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(brief.enabled(), true);
  const text = await brief.build('2026-11-16');
  assert.ok(text.includes('☀️ 맑음 · 지금 4° · 낮 11° / 아침 2°'));
  assert.ok(!text.includes('미세먼지'), '미세먼지가 안 받아지면 그 줄만 뺀다');
  assert.ok(text.includes('📅 14:00 주간 회의 (옮김) · 19:00 스터디, 강남 모임 · 22:00 뉴욕 통화'));
  assert.ok(text.includes('🍚 평일 밥'));
  assert.ok(text.includes('새 소식'));
  assert.ok(urls.some(u => u.includes('latitude=37.5&longitude=127')), '위치는 소수 첫째 자리까지만');
  assert.ok(!logs.join(' ').includes('secret.ics'), '캘린더 주소는 기록에 남기지 않는다');
  const cal = brief.calendarFor('2026-11-16', 4);
  assert.deepEqual(cal.upcoming.map(e => C.fmtTime(e.start)), ['14:00', '19:00', '22:00']);
  assert.deepEqual(cal.tomorrow, []);
  assert.equal(urls.filter(u => u.startsWith('https://cal.example/')).length, 1, '30분 안에는 캘린더를 다시 받지 않는다');
  const off = createBrief({ store: createStore({ storage: new MemoryStorage(), now }), fetchFn, now });
  assert.equal(off.enabled(), false);
  assert.equal(off.calendarFor('2026-11-16', 4), null);
});

test('미세먼지 받기: 지금 값과, 지금부터 밤 9시까지의 최고값', async () => {
  const { fetchAir } = await import('../lib/brief.mjs');
  const time = Array.from({ length: 24 }, (_, h) => `2026-11-16T${String(h).padStart(2, '0')}:00`);
  const pm = time.map((_, h) => (h === 3 ? 90 : h === 15 ? 40 : h === 23 ? 80 : 10)); // 새벽 3시와 밤 11시는 빼야 한다
  let url = '';
  const fetchFn = async u => ((url = u), { ok: true, json: async () => ({ current: { time: '2026-11-16T10:00', pm10: 14, pm2_5: 12 }, hourly: { time, pm10: pm, pm2_5: pm } }) });
  assert.deepEqual(await fetchAir({ lat: 37.47, lon: 126.95 }, fetchFn), { pm25: 12, pm10: 14, max25: 40, max10: 40 });
  assert.ok(url.includes('latitude=37.5&longitude=127'));
  await assert.rejects(fetchAir({ lat: 1, lon: 1 }, async () => ({ ok: false, status: 500 })), /미세먼지/);
});

test('알림: 캘린더 일정 30분 전에 한 번, 밤 10시 뒤 내일 일정', () => {
  const now = clock(kst(11, 16, 13, 29));
  const store = createStore({ storage: new MemoryStorage(), now });
  const calendar = { upcoming: [{ uid: 'u1', summary: '면접', location: '강남', start: kst(11, 16, 14), end: kst(11, 16, 15), allDay: false }], tomorrow: [{ uid: 'u2', summary: '회의', start: kst(11, 17, 10), end: kst(11, 17, 11), allDay: false }, { uid: 'u3', summary: '휴가', start: kst(11, 17), end: kst(11, 18), allDay: true }] };
  const run = () => planPings({ now: now(), cfg: store.config(), day: store.day('2026-11-16'), game: null, profiles: [], opts: {}, calendar }).filter(p => p.kind === 'cal');
  assert.deepEqual(run(), []);
  now.set(kst(11, 16, 13, 31));
  assert.equal(run()[0].text, '📅 29분 뒤: 면접 (14:00)\n📍 강남');
  now.set(kst(11, 16, 14, 1));
  assert.deepEqual(run(), [], '시작한 뒤엔 안 보낸다');
  now.set(kst(11, 16, 22, 1));
  assert.equal(run()[0].text, '📅 내일 일정: 10:00 회의 · 종일 휴가');
});

test('비서: 일어났다고 하면 브리핑을 한 번, "브리핑"이라고 하면 다시', async () => {
  const now = clock(kst(11, 16, 7, 0));
  const store = createStore({ storage: new MemoryStorage(), now });
  const sent = [];
  const tg = { send: async (chat, text, buttons, o) => sent.push({ text, html: !!o?.html }), answer: async () => {}, clearButtons: async () => {} };
  let built = 0, fail = false;
  const brief = { enabled: () => true, refresh: async () => {}, calendarFor: () => null, build: async key => { built++; if (fail) throw new Error('x'); return `<b>브리핑 ${key}</b>`; } };
  const state = { owner: 7 };
  const bot = createBot({ store, sync: { syncNow: async () => {} }, tg, brief, state, now, opts: {} });
  const tap = data => bot.handleUpdate({ callback_query: { id: 'q', data, from: { id: 7 }, message: { message_id: 1, chat: { id: 7 } } } });
  const msg = text => bot.handleUpdate({ message: { chat: { id: 7, type: 'private' }, from: { id: 7 }, text } });
  await bot.tick();
  assert.equal(built, 0, '일어나기 전엔 안 보낸다');
  await tap('wake');
  assert.deepEqual(sent.filter(s => s.html), [{ text: '<b>브리핑 2026-11-16</b>', html: true }]);
  now.tick(60000);
  await bot.tick();
  await bot.tick();
  assert.equal(built, 1, '하루 한 번');
  await msg('브리핑');
  await msg('/brief');
  assert.equal(built, 3);
  // 다음 날: 폰 앱에서 기상을 눌렀고 비서가 그걸 본 경우, 만들기에 실패하면 5분 뒤 다시
  now.set(kst(11, 17, 7, 30));
  store.setWake('2026-11-17', kst(11, 17, 7, 20));
  fail = true;
  await bot.tick();
  await bot.tick();
  assert.equal(built, 4, '실패하면 바로 다시 하지 않는다');
  fail = false;
  now.tick(6 * 60000);
  await bot.tick();
  assert.equal(sent.filter(s => s.html).pop().text, '<b>브리핑 2026-11-17</b>');
  // 일어난 지 4시간이 지났으면 아침 브리핑은 보내지 않는다
  now.set(kst(11, 18, 15, 0));
  store.setWake('2026-11-18', kst(11, 18, 8, 0));
  const n = built;
  await bot.tick();
  assert.equal(built, n);
});
