import { z } from 'zod';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { createModelAdapter } from '../bedrock/factory.js';
import { enforceInboundMailPolicy, validateStructuredJsonOutput } from '../security/policy.js';
import {
  applyShadowTriageResult,
  TRIAGE_CATEGORIES,
  validateTriageOutput,
} from '../triage.js';

const triageInputSchema = z.object({
  transportId: z.string(),
  threadId: z.string(),
  triggerMessageId: z.string(),
  subject: z.string().optional(),
  body: z.string(),
});

export const mailTriageWorkflowOutputSchema = z.object({
  output: z.object({
    category: z.enum(TRIAGE_CATEGORIES),
    urgent: z.boolean(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
    policyFlags: z.array(z.string()),
  }),
  shadow: z.object({
    category: z.string(),
    urgent: z.boolean(),
    confidence: z.number(),
    rationale: z.string(),
  }),
  metrics: z.record(z.unknown()),
  traceId: z.string(),
});

const classifyStep = createStep({
  id: 'classify-mail',
  inputSchema: triageInputSchema,
  outputSchema: mailTriageWorkflowOutputSchema,
  execute: async ({ inputData, runId }) => {
    enforceInboundMailPolicy({ body: inputData.body });
    const adapter = createModelAdapter();
    const model = await adapter.invoke({
      modelId: 'amazon.nova-lite-v1:0',
      systemPrompt: 'classify inbound hotel mail',
      userPrompt: `classify this inbound email: ${inputData.body}`,
    });
    const output = validateTriageOutput(validateStructuredJsonOutput(model.output));
    const shadow = applyShadowTriageResult({
      threadId: inputData.threadId,
      transportId: inputData.transportId,
      output,
      metrics: {
        modelId: model.modelId,
        usage: model.usage,
      },
    });
    return {
      output: shadow.output,
      shadow: {
        category: shadow.output.category,
        urgent: shadow.output.urgent,
        confidence: shadow.output.confidence,
        rationale: shadow.output.rationale,
      },
      metrics: shadow.metrics,
      traceId: runId,
    };
  },
});

export const mailTriageWorkflow = createWorkflow({
  id: 'mail-triage',
  inputSchema: triageInputSchema,
  outputSchema: mailTriageWorkflowOutputSchema,
})
  .then(classifyStep)
  .commit();
