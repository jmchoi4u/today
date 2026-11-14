// Gemini API (REST). 키는 주소가 아니라 헤더로 보내서 기록에 남지 않게 한다.
// 무료 등급에서는 보낸 내용이 Google의 제품 개선에 쓰일 수 있다 (README에 적어 둠).
export async function geminiJSON({ apiKey, model = 'gemini-flash-latest', system, user, schema, fetchFn = globalThis.fetch, timeoutMs = 60000 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || 'gemini-flash-latest')}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: `${system}\n\n답은 다음 JSON 스키마를 따르는 JSON 하나만:\n${JSON.stringify(schema)}` }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 2048 },
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let r;
  try {
    r = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'Gemini 응답이 늦어요' : 'Gemini에 연결할 수 없어요');
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 400 || r.status === 403) throw new Error('Gemini 키나 모델 이름을 확인해 주세요');
  if (r.status === 429) throw new Error('Gemini 무료 한도에 걸렸어요. 잠시 뒤에 다시 해요');
  if (!r.ok) throw new Error(`Gemini 응답 오류 (${r.status})`);
  const j = await r.json();
  const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return parseJSONText(text);
}

// ```json 울타리가 붙어 와도 받는다
export function parseJSONText(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        /* 아래로 */
      }
    }
    throw new Error('AI 답을 읽지 못했어요');
  }
}
