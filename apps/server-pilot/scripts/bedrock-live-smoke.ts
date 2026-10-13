/**
 * Live Bedrock smoke: one schema-validated Luna Responses call via instance role.
 * Invoked by deploy/bedrock-live-gate.sh through tsx — never Vitest, never DB.
 */
import { createModelAdapter } from '../src/ai/bedrock/factory.js';
import { classifyMailTriage } from '../src/ai/workflows/mail-triage.js';
import { DEFAULT_TRIAGE_PROMPT_VERSION } from '../src/ai/run-ledger.js';

async function main(): Promise<void> {
  if (process.env.DATABASE_URL) {
    throw new Error('bedrock-live-smoke refuses DATABASE_URL (unset before invoke)');
  }
  if (process.env.VITEST_ALLOW_PILOT_RDS === '1') {
    throw new Error('bedrock-live-smoke refuses VITEST_ALLOW_PILOT_RDS=1');
  }

  const adapter = createModelAdapter();
  const modelId = process.env.AI_MODEL_ID ?? 'global.openai.gpt-6-luna';
  const asOf = '2026-07-29T15:38:03.615Z';
  const classification = await classifyMailTriage(
    {
      transportId: 'transport-centurion',
      threadId: 'bedrock-live-smoke',
      triggerMessageId: 'smoke-1',
      asOf,
      modelId,
      promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
      messages: [
        {
          id: 'smoke-1',
          from: 'guest@example.com',
          subject: 'Room quote',
          body: 'Guest asks for a quotation for one room next week. Not spam. Not urgent.',
          direction: 'inbound',
          createdAt: new Date('2026-07-29T12:00:00.000Z'),
          receivedAt: new Date('2026-07-29T12:00:00.000Z'),
          sentAt: null,
        },
      ],
    },
    adapter,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        modelId: classification.modelId,
        promptHash: classification.promptHash,
        category: classification.output.category,
        urgent: classification.output.urgent,
        usage: {
          inputTokens: classification.usage.inputTokens,
          outputTokens: classification.usage.outputTokens,
          latencyMs: classification.usage.latencyMs,
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
