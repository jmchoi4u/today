import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA } from '../lib/llm.mjs';

// Claude 쪽은 SDK(@anthropic-ai/sdk)가 깔려 있을 때만 시험한다 (Gemini만 쓰면 안 깔아도 된다)
let mod = null;
try {
  mod = await import('../lib/llm-claude.mjs');
} catch {
  mod = null;
}

test('Claude: 요청 모양 (모델별 거절 대비, 낮은 effort, JSON 스키마, 설명서 캐시)과 답 읽기', { skip: !mod && 'SDK 없음' }, async () => {
  let req = null;
  let path = '';
  const fake = res => ({
    messages: { create: async r => ((req = r), (path = 'messages'), res) },
    beta: { messages: { create: async r => ((req = r), (path = 'beta'), res) } },
  });
  const ok = { stop_reason: 'end_turn', content: [{ type: 'fallback' }, { type: 'text', text: '{"actions":[],"reply":"네"}' }] };
  const out = await mod.claudeJSON({ apiKey: 'k', model: 'claude-opus-5-5', system: 's', user: 'u', schema: SCHEMA, sdkClient: fake(ok) });
  assert.deepEqual(out, { actions: [], reply: '네' });
  assert.equal(path, 'beta', 'Opus 5.5는 서버 쪽 거절 대비를 쓴다');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.effort, 'low');
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: SCHEMA });
  assert.deepEqual(req.system, [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], '설명서는 캐시한다');
  assert.equal(req.temperature, undefined, '샘플링 값은 보내지 않는다');
  await mod.claudeJSON({ apiKey: 'k', model: 'claude-haiku-5-5', system: 's', user: 'u', schema: SCHEMA, sdkClient: fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) });
  assert.equal(req.model, 'claude-haiku-5-5');
  assert.equal(path, 'messages', 'Haiku 5.5는 보통 요청 (서버 쪽 거절 대비가 없다)');
  assert.equal(req.fallbacks, undefined);
  assert.equal(req.betas, undefined);
  assert.equal(mod.supportsFallback('claude-sonnet-5-5'), true);
  assert.equal(mod.supportsFallback('claude-haiku-5-5'), false);
  assert.equal(mod.supportsFallback('claude-opus-4-8'), false);
  await assert.rejects(mod.claudeJSON({ apiKey: 'k', model: 'claude-haiku-5-5', system: 's', user: 'u', schema: SCHEMA, sdkClient: fake({ stop_reason: 'refusal', content: [] }) }), /처리하지 않았어요/);
  await assert.rejects(mod.claudeJSON({ apiKey: 'k', model: 'claude-haiku-5-5', system: 's', user: 'u', schema: SCHEMA, sdkClient: fake({ stop_reason: 'max_tokens', content: [] }) }), /잘렸어요/);
});
