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

describe('mail action classification schema', () => {
  it('requires the independent action fields and keeps legacy kind intact', () => {
    const parsed = mailExtractionSchema.safeParse({ ...AE1_OUTPUT, kind: 'quote' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data).toMatchObject({
      kind: 'quote',
      needsAction: true,
      action: 'quote_availability',
      actionEvidence: 'Please advise availability and rates.',
      actionConfidence: 'high',
    });
    const { payload } = sanitizeExtraction(parsed.data, {
      messageId: 'msg-action-schema',
      sourceText: AE1_TEXT,
    });
    expect(payload).toMatchObject({
      needsAction: true,
      action: 'quote_availability',
      actionConfidence: 'high',
    });
  });

  it.each([
    'no_action',
    'quote_availability',
    'new_booking',
    'amend',
    'cancel',
    'payment_proof',
    'billing',
    'group_event',
    'other_actionable',
  ])('accepts action %s', (action) => {
    expect(mailExtractionSchema.safeParse({
      ...AE1_OUTPUT,
      needsAction: action !== 'no_action',
      action,
    }).success).toBe(true);
  });

  it('rejects an unknown action, missing required fields, and evidence over 200 characters', () => {
    expect(mailExtractionSchema.safeParse({ ...AE1_OUTPUT, action: 'payment' }).success).toBe(false);
    const missing = { ...AE1_OUTPUT } as Record<string, unknown>;
    delete missing.actionEvidence;
    expect(mailExtractionSchema.safeParse(missing).success).toBe(false);
    expect(mailExtractionSchema.safeParse({ ...AE1_OUTPUT, actionEvidence: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('card-masks action evidence before storing it', () => {
    const parsed = mailExtractionSchema.parse({
      ...AE1_OUTPUT,
      actionEvidence: 'Card charged 4111 1111 1111 1111; receipt attached.',
    });
    const sanitized = sanitizeExtraction(parsed, {
      messageId: 'msg-action-card',
      sourceText: AE1_TEXT,
    });
    expect(sanitized.payload.actionEvidence).not.toMatch(/4111[ -]?1111[ -]?1111[ -]?1111/);
    expect(sanitized.payload.actionEvidence).toContain('[card ••••1111]');
  });

  it('keeps action fields optional when reading an older stored payload', () => {
    const parsed = mailExtractionSchema.parse(AE1_OUTPUT);
    const legacyPayload: Record<string, unknown> = {
      ...sanitizeExtraction(parsed, { messageId: 'msg-action-legacy', sourceText: AE1_TEXT }).payload,
    };
    delete legacyPayload.needsAction;
    delete legacyPayload.action;
    delete legacyPayload.actionEvidence;
    delete legacyPayload.actionConfidence;
    expect(mailExtractionPayloadSchema.safeParse(legacyPayload).success).toBe(true);
  });
});
