import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createModelAdapter } from '../bedrock/factory.js';
import { enforceInboundMailPolicy, validateStructuredJsonOutput } from '../security/policy.js';

const candidateDraftInputSchema = z.object({
  transportId: z.string(),
  threadId: z.string(),
  triggerMessageId: z.string(),
  fromAddress: z.string(),
  subject: z.string().optional(),
  body: z.string(),
});

export const candidateDraftOutputSchema = z.object({
  draftBody: z.object({
    textBody: z.string().min(1),
    htmlBody: z.string().min(1),
  }),
  metrics: z.record(z.unknown()),
  traceId: z.string(),
});

export const candidateDraftModelOutputSchema = z.object({
  textBody: z
    .string()
    .min(1)
    .refine((value) => value.includes('[') && value.includes(']')),
  htmlBody: z.string().min(1),
});

export function deriveReplyToAddress(fromAddress: string): string | null {
  const match = fromAddress.match(/<([^>]+)>/);
  const candidate = (match?.[1] ?? fromAddress).trim();
  return z.string().email().safeParse(candidate).success ? candidate : null;
}

export function deriveReplySubject(subject: string | null | undefined): string {
  const trimmed = subject?.trim() || 'Your inquiry';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

const systemPrompt = [
  'Generate a hotel staff candidate reply skeleton.',
  'Do not answer the guest request.',
  'Use this exact structure: Hi {sender name}, then [human writes response here], then Best, {staff name}.',
  'Return JSON only.',
].join('\n');

const generateDraftStep = createStep({
  id: 'generate-candidate-draft',
  inputSchema: candidateDraftInputSchema,
  outputSchema: candidateDraftOutputSchema,
  execute: async ({ inputData, runId }) => {
    enforceInboundMailPolicy({ body: inputData.body });
    const adapter = createModelAdapter();
    const model = await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt,
      userPrompt: `draft reply skeleton for inbound email from ${inputData.fromAddress}: ${inputData.body}`,
    });
    const parsed = candidateDraftModelOutputSchema.parse(
      validateStructuredJsonOutput(model.output),
    );
    return {
      draftBody: {
        textBody: parsed.textBody,
        htmlBody: parsed.htmlBody,
      },
      metrics: {
        modelId: model.modelId,
        usage: model.usage,
      },
      traceId: runId,
    };
  },
});

export const candidateDraftWorkflow = createWorkflow({
  id: 'candidate-draft',
  inputSchema: candidateDraftInputSchema,
  outputSchema: candidateDraftOutputSchema,
})
  .then(generateDraftStep)
  .commit();
