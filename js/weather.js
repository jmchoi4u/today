// 날씨와 해: Open-Meteo (키 없이 쓰는 공개 API).
// 켜야만 동작하고, 위치는 소수 첫째 자리(약 10km 단위)까지만 보낸다. 기록은 보내지 않는다.

const API = 'https://api.open-meteo.com/v1/forecast';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
export const round1 = v => Math.round(v * 10) / 10;

export async function fetchWeather({ lat, lon }, fetchFn = fetch, now = Date.now()) {
  const q = new URLSearchParams({
    latitude: String(round1(lat)),
    longitude: String(round1(lon)),
    current: 'temperature_2m,weather_code,precipitation,is_day',
    daily: 'sunrise,sunset,uv_index_max,precipitation_probability_max,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '2',
  });
  const r = await fetchFn(`${API}?${q}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`날씨를 받지 못했어요 (${r.status})`);
  const j = await r.json();
  const d = j.daily || {};
  return {
    at: now,
    temp: j.current?.temperature_2m,
    code: j.current?.weather_code,
    precip: j.current?.precipitation,
    isDay: j.current?.is_day === 1,
    days: (d.time || []).map((date, i) => ({
      date,
      sunrise: d.sunrise?.[i],
      sunset: d.sunset?.[i],
      uv: d.uv_index_max?.[i],
      rain: d.precipitation_probability_max?.[i],
      tmax: d.temperature_2m_max?.[i],
      tmin: d.temperature_2m_min?.[i],
    })),
  };
}

export async function searchCity(name, fetchFn = fetch) {
  const r = await fetchFn(`${GEO}?${new URLSearchParams({ name, count: '5', language: 'ko', format: 'json' })}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`도시를 찾지 못했어요 (${r.status})`);
  const j = await r.json();
  return (j.results || []).map(x => ({ name: [x.name, x.admin1, x.country].filter(Boolean).join(', '), lat: round1(x.latitude), lon: round1(x.longitude) }));
}

// WMO 날씨 코드
export function describe(code) {
  if (code == null) return { icon: '·', text: '' };
  if (code === 0) return { icon: '☀️', text: '맑음' };
  if (code <= 2) return { icon: '🌤️', text: '구름 조금' };
  if (code === 3) return { icon: '☁️', text: '흐림' };
  if (code === 45 || code === 48) return { icon: '🌫️', text: '안개' };
  if (code >= 51 && code <= 57) return { icon: '🌦️', text: '이슬비' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: '🌧️', text: '비' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: '🌨️', text: '눈' };
  if (code >= 95) return { icon: '⛈️', text: '뇌우' };
  return { icon: '☁️', text: '' };
}
export const isWet = w => !!w && ((w.code >= 51 && w.code <= 99) || w.precip > 0); // 비나 눈

// 그날의 해 뜨고 지는 시각 (타임존 없는 현지 시각 문자열 → 이 기기의 시각으로)
export function sunOf(w, dateKey) {
  const d = w?.days?.find(x => x.date === dateKey);
  if (!d?.sunrise || !d?.sunset) return null;
  return { rise: new Date(d.sunrise).getTime(), set: new Date(d.sunset).getTime(), uv: d.uv, rain: d.rain, tmax: d.tmax, tmin: d.tmin };
}
