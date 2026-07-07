import { z } from 'zod';

const FORBIDDEN_TOOL_REQUESTS = [
  'send_email',
  'smtp_send',
  'pop3_fetch',
  'delete_mailbox',
] as const;

export const structuredModelOutputSchema = z.record(z.unknown());

export function assertNoPromptInjection(input: string): void {
  const lowered = input.toLowerCase();
  const injectionMarkers = [
    'ignore previous instructions',
    'reveal your system prompt',
    'you are now',
    'override policy',
  ];
  for (const marker of injectionMarkers) {
    if (lowered.includes(marker)) {
      throw new Error(`prompt injection blocked: ${marker}`);
    }
  }
}

export function assertAllowedToolRequest(toolName: string): void {
  if ((FORBIDDEN_TOOL_REQUESTS as readonly string[]).includes(toolName)) {
    throw new Error(`forbidden tool request: ${toolName}`);
  }
}

export function validateStructuredJsonOutput(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('model output must be a JSON object');
  }
  const parsed = structuredModelOutputSchema.parse(raw);
  if (Object.keys(parsed).length === 0) {
    throw new Error('model output must not be empty');
  }
  return parsed;
}

export function enforceInboundMailPolicy(input: {
  body: string;
  requestedTools?: string[];
}): void {
  assertNoPromptInjection(input.body);
  for (const tool of input.requestedTools ?? []) {
    assertAllowedToolRequest(tool);
  }
}
