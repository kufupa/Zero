import { describe, expect, it } from 'vitest';
import { createFakeModelAdapter } from '../src/ai/bedrock/fake.js';
import { validateStructuredJsonOutput } from '../src/ai/security/policy.js';

describe('bedrock adapter contract', () => {
  it('fake adapter output validates as structured JSON', async () => {
    const adapter = createFakeModelAdapter();
    const result = await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt: 'draft system',
      userPrompt: 'draft reply for guest booking',
    });
    expect(validateStructuredJsonOutput(result.output)).toMatchObject({
      subject: expect.any(String),
    });
  });
});
