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

test('Claude: 요청 모양 (모델, 거절 대비, 낮은 effort, JSON 스키마)과 답 읽기', { skip: !mod && 'SDK 없음' }, async () => {
  let req = null;
  const fake = res => ({ beta: { messages: { create: async r => ((req = r), res) } } });
  const out = await mod.claudeJSON({ apiKey: 'k', system: 's', user: 'u', schema: SCHEMA, sdkClient: fake({ stop_reason: 'end_turn', content: [{ type: 'fallback' }, { type: 'text', text: '{"actions":[],"reply":"네"}' }] }) });
  assert.deepEqual(out, { actions: [], reply: '네' });
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.effort, 'low');
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: SCHEMA });
  assert.equal(req.temperature, undefined, '샘플링 값은 보내지 않는다');
  await mod.claudeJSON({ apiKey: 'k', model: 'claude-haiku-5-5', system: 's', user: 'u', schema: SCHEMA, sdkClient: fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }) });
  assert.equal(req.model, 'claude-haiku-5-5', '.env의 CLAUDE_MODEL로 바꿀 수 있다');
  await assert.rejects(mod.claudeJSON({ apiKey: 'k', system: 's', user: 'u', schema: SCHEMA, sdkClient: fake({ stop_reason: 'refusal', content: [] }) }), /처리하지 않았어요/);
  await assert.rejects(mod.claudeJSON({ apiKey: 'k', system: 's', user: 'u', schema: SCHEMA, sdkClient: fake({ stop_reason: 'max_tokens', content: [] }) }), /잘렸어요/);
});
