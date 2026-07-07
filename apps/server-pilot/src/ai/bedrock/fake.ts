import type { ModelAdapter, ModelInvokeInput, ModelInvokeResult } from './adapter.js';

const FIXTURE_OUTPUTS: Record<string, Record<string, unknown>> = {
  triage: {
    category: 'individual',
    urgent: false,
    confidence: 0.91,
    rationale: 'Guest booking inquiry',
    policyFlags: [],
  },
  draft: {
    subject: 'Re: Booking',
    textBody: 'Thank you for your inquiry.',
    htmlBody: '<p>Thank you for your inquiry.</p>',
  },
};

function fixtureKey(input: ModelInvokeInput): string {
  if (input.userPrompt.includes('triage') || input.userPrompt.includes('classify')) {
    return 'triage';
  }
  return 'draft';
}

export class FakeModelAdapter implements ModelAdapter {
  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    const key = fixtureKey(input);
    return {
      modelId: input.modelId,
      output: FIXTURE_OUTPUTS[key] ?? { ok: true },
      usage: {
        inputTokens: 120,
        outputTokens: 48,
        latencyMs: 15,
      },
    };
  }
}

export function createFakeModelAdapter(): ModelAdapter {
  return new FakeModelAdapter();
}
