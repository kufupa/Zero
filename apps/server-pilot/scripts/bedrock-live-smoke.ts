/**
 * Live Bedrock smoke: one schema-validated Converse call via instance role.
 * Invoked by deploy/bedrock-live-gate.sh through tsx — never Vitest, never DB.
 */
import { createModelAdapter } from '../src/ai/bedrock/factory.js';
import { triageOutputSchema } from '../src/ai/triage.js';

async function main(): Promise<void> {
  if (process.env.DATABASE_URL) {
    throw new Error('bedrock-live-smoke refuses DATABASE_URL (unset before invoke)');
  }
  if (process.env.VITEST_ALLOW_PILOT_RDS === '1') {
    throw new Error('bedrock-live-smoke refuses VITEST_ALLOW_PILOT_RDS=1');
  }

  const adapter = createModelAdapter();
  const modelId = process.env.AI_MODEL_ID ?? 'amazon.nova-lite-v1:0';
  const result = await adapter.invoke({
    modelId,
    systemPrompt:
      'You classify hotel inbound mail. Return JSON only matching the triage schema.',
    userPrompt:
      'Classify this inbound email as JSON with keys category, urgent, confidence, rationale, policyFlags. ' +
      'Email: Guest asks for a quotation for one room next week. Not spam. Not urgent.',
    responseSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        urgent: { type: 'boolean' },
        confidence: { type: 'number' },
        rationale: { type: 'string' },
        policyFlags: { type: 'array', items: { type: 'string' } },
      },
      required: ['category', 'urgent', 'confidence', 'rationale', 'policyFlags'],
    },
  });

  const parsed = triageOutputSchema.parse(result.output);
  console.log(
    JSON.stringify(
      {
        ok: true,
        modelId: result.modelId,
        category: parsed.category,
        urgent: parsed.urgent,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: result.usage.latencyMs,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
