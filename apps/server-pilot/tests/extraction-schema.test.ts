import { zodToJsonSchema } from 'zod-to-json-schema';
import { describe, expect, it } from 'vitest';
import {
  mailExtractionPayloadSchema,
  mailExtractionSchema,
  sanitizeExtraction,
} from '../src/ai/extraction/schema.js';
import { AE1_OUTPUT, AE1_TEXT } from './fixtures/inbound-extraction.js';

describe('mail extraction origin schema', () => {
  it.each([
    ['person', 'person'],
    ['system_notice', 'system_notice'],
    ['null', null],
  ] as const)('accepts %s at the top level and stores it in the extraction payload', (_, origin) => {
    const parsed = mailExtractionSchema.safeParse({ ...AE1_OUTPUT, origin });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data).toHaveProperty('origin', origin);
    const sanitized = sanitizeExtraction(parsed.data, {
      messageId: 'msg-origin-schema',
      sourceText: AE1_TEXT,
    });
    expect(sanitized.payload).toMatchObject({ origin });
  });

  it('keeps origin optional for older model outputs and stores null when omitted', () => {
    const parsed = mailExtractionSchema.safeParse(AE1_OUTPUT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const sanitized = sanitizeExtraction(parsed.data, {
      messageId: 'msg-origin-missing',
      sourceText: AE1_TEXT,
    });
    expect(sanitized.payload).toHaveProperty('origin', null);
  });

  it('parses an older stored payload without origin', () => {
    const parsed = mailExtractionSchema.safeParse(AE1_OUTPUT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const legacyPayload: Record<string, unknown> = {
      ...sanitizeExtraction(parsed.data, {
        messageId: 'msg-origin-legacy-payload',
        sourceText: AE1_TEXT,
      }).payload,
    };
    delete legacyPayload.origin;

    const storedPayload = mailExtractionPayloadSchema.safeParse(legacyPayload);
    expect(storedPayload.success).toBe(true);
    if (storedPayload.success) expect(storedPayload.data).toEqual(legacyPayload);
    expect(mailExtractionPayloadSchema.safeParse({ ...legacyPayload, origin: null }).success).toBe(true);
  });

  it('rejects values outside the person/system_notice enum', () => {
    expect(mailExtractionSchema.safeParse({ ...AE1_OUTPUT, origin: 'channel' }).success).toBe(false);
  });

  it('exposes optional nullable origin in the JSON schema sent to the model', () => {
    const jsonSchema = zodToJsonSchema(mailExtractionSchema, { $refStrategy: 'none' }) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(jsonSchema.properties).toHaveProperty('origin');
    expect(jsonSchema.required ?? []).not.toContain('origin');
  });
});
