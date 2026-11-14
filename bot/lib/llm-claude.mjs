// Claude API (공식 SDK @anthropic-ai/sdk). LLM_PROVIDER=claude일 때만 불러온다.
// 기본 모델은 claude-opus-5-5. 비용을 줄이려면 .env에서 CLAUDE_MODEL=claude-haiku-5-5
// 안전 분류기가 거절하면 서버가 추천 모델로 다시 돌린다 (server-side fallback, fallbacks: "default").
import Anthropic from '@anthropic-ai/sdk';

let client = null;
let clientKey = null;

export async function claudeJSON({ apiKey, model = 'claude-opus-5-5', system, user, schema, sdkClient }) {
  if (!sdkClient && (!client || clientKey !== apiKey)) {
    client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
    clientKey = apiKey;
  }
  const c = sdkClient || client;
  let res;
  try {
    res = await c.beta.messages.create({
      model: model || 'claude-opus-5-5',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // 짧은 분류라서 effort는 low. 형식은 JSON 스키마로 고정
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    });
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
