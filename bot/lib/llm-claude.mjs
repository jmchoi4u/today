// Claude API (공식 SDK @anthropic-ai/sdk). LLM_PROVIDER=claude일 때만 불러온다.
// 모델은 .env의 CLAUDE_MODEL (main.mjs 기본값은 사용자가 고른 claude-haiku-5-5).
// 거절 대비: 서버가 다른 모델로 다시 돌려주는 기능(server-side fallback)은 Fable·Opus 5.5·Sonnet 5.5 등에서만 된다.
// Haiku 5.5에는 없어서 그때는 보통 요청으로 보낸다.
import Anthropic from '@anthropic-ai/sdk';

let client = null;
let clientKey = null;

// 서버 쪽 거절 대비를 받는 모델 (Haiku 계열은 안 받는다)
export const supportsFallback = model => /^claude-(?:fable-5-[12]|mythos-5-[12]|opus-5(?:-5)?|sonnet-5-5)$/.test(String(model || ''));

export async function claudeJSON({ apiKey, model = 'claude-opus-5-5', system, user, schema, sdkClient }) {
  if (!sdkClient && (!client || clientKey !== apiKey)) {
    client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    clientKey = apiKey;
  }
  const c = sdkClient || client;
  const m = model || 'claude-opus-5-5';
  const req = {
    model: m,
    max_tokens: 4096,
    // 매번 같은 설명서는 캐시해서 다시 읽는 값을 줄인다 (짧으면 캐시가 안 걸릴 뿐 문제없다)
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    // 짧은 판단이라 effort는 low. 형식은 JSON 스키마로 고정
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  };
  let res;
  try {
    res = supportsFallback(m)
      ? await c.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await c.messages.create(req);
  } catch (e) {
    // 구체적인 것부터 (TypeScript SDK에서 APIConnectionError는 APIError의 하위 클래스)
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude API 키를 확인해 주세요');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('이 Claude API 키로는 쓸 수 없는 기능이에요');
    if (e instanceof Anthropic.NotFoundError) throw new Error('Claude 모델 이름(CLAUDE_MODEL)을 확인해 주세요');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude 사용 한도에 걸렸어요. 잠시 뒤에 다시 해요');
    if (e instanceof Anthropic.BadRequestError) throw new Error(`Claude 요청 오류: ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Claude에 연결할 수 없어요');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude 응답 오류 (${e.status})`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude가 이 요청을 처리하지 않았어요');
  if (res.stop_reason === 'max_tokens') throw new Error('Claude 답이 너무 길어 잘렸어요');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}
