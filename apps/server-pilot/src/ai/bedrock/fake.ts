import type { ModelAdapter, ModelInvokeInput, ModelInvokeResult } from './adapter.js';
import {
  estimateNovaLiteCostUsd,
  NOVA_LITE_RATE_TABLE_VERSION,
} from './bedrock.js';

const FAKE_INPUT_TOKENS = 120;
const FAKE_OUTPUT_TOKENS = 48;

function fakeUsage(): ModelInvokeResult['usage'] {
  return {
    inputTokens: FAKE_INPUT_TOKENS,
    outputTokens: FAKE_OUTPUT_TOKENS,
    totalTokens: FAKE_INPUT_TOKENS + FAKE_OUTPUT_TOKENS,
    latencyMs: 15,
    estimatedCostUsd: estimateNovaLiteCostUsd(FAKE_INPUT_TOKENS, FAKE_OUTPUT_TOKENS),
    rateTableVersion: NOVA_LITE_RATE_TABLE_VERSION,
  };
}

const FIXTURE_OUTPUTS: Record<string, Record<string, unknown>> = {
  triage: {
    category: 'individual',
    urgent: false,
    confidence: 0.91,
    rationale: 'Guest booking inquiry',
    policyFlags: [],
  },
  triageGroup: {
    category: 'group',
    urgent: false,
    confidence: 0.88,
    rationale: 'Group quote language',
    policyFlags: [],
  },
  triageSpam: {
    category: 'spam',
    urgent: false,
    confidence: 0.99,
    rationale: 'Spam offer',
    policyFlags: [],
  },
  draft: {
    subject: 'Re: Booking',
    textBody: 'Hi Guest,\n\n[Write response here]\n\nBest,\nStaff',
    htmlBody: '<p>Hi Guest,</p><p>[Write response here]</p><p>Best,<br>Staff</p>',
  },
};

function fixtureKey(input: ModelInvokeInput): string {
  const prompt = input.userPrompt.toLowerCase();
  if (prompt.includes('triage') || prompt.includes('classify')) {
    if (prompt.includes('spam')) {
      return 'triageSpam';
    }
    if (prompt.includes('group') || prompt.includes('20 rooms')) {
      return 'triageGroup';
    }
    return 'triage';
  }
  return 'draft';
}

export class FakeModelAdapter implements ModelAdapter {
  async invoke(input: ModelInvokeInput): Promise<ModelInvokeResult> {
    const key = fixtureKey(input);
    const base = FIXTURE_OUTPUTS[key] ?? { ok: true };
    if (key === 'draft' && input.userPrompt.toLowerCase().includes('guest')) {
      return {
        modelId: input.modelId,
        output: {
          ...base,
          textBody: 'Hi Guest,\n\n[Write response here]\n\nBest,\nStaff',
          htmlBody: '<p>Hi Guest,</p><p>[Write response here]</p><p>Best,<br>Staff</p>',
        },
        usage: fakeUsage(),
      };
    }
    return {
      modelId: input.modelId,
      output: base,
      usage: fakeUsage(),
    };
  }
}

export function createFakeModelAdapter(): ModelAdapter {
  return new FakeModelAdapter();
}
