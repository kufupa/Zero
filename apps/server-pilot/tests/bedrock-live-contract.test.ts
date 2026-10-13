import { describe, expect, it } from 'vitest';
import { createModelAdapter } from '../src/ai/bedrock/factory.js';

const live = process.env.BEDROCK_LIVE_TEST === '1';

describe.skipIf(!live)('bedrock live contract', () => {
  it('Luna Responses returns JSON object via instance credentials', async () => {
    const adapter = createModelAdapter();
    const result = await adapter.invoke({
      modelId: process.env.AI_MODEL_ID ?? 'global.openai.gpt-6-luna',
      systemPrompt: 'Return JSON only.',
      userPrompt: 'Return {"ok":true}',
    });
    expect(result.output).toMatchObject({ ok: true });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    console.log(
      `bedrock-live: latencyMs=${result.usage.latencyMs} in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
    );
  }, 60_000);
});

describe('bedrock live contract (skipped without BEDROCK_LIVE_TEST)', () => {
  it('documents opt-in gate', () => {
    if (!live) {
      expect(live).toBe(false);
    }
  });
});
