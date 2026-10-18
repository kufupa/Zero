import { zodToJsonSchema } from 'zod-to-json-schema';
import { describe, expect, it } from 'vitest';
import { EXTRACTION_RULES } from '../src/ai/extraction/extract.js';
import { MAIL_ACTIONS } from '../src/mail/action-labels.js';
import {
  mailExtractionPayloadSchema,
  mailExtractionSchema,
  sanitizeExtraction,
} from '../src/ai/extraction/schema.js';
import { AE1_OUTPUT, AE1_TEXT } from './fixtures/inbound-extraction.js';

const ACTION_OUTPUT = {
  ...AE1_OUTPUT,
  needsAction: true,
  action: 'quote_availability' as const,
  actionEvidence: 'Please advise availability and rates.',
  actionConfidence: 'high' as const,
};

describe('mail extraction contract', () => {
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

  it('distinguishes voucher booking action from payment and document evidence', () => {
    expect(EXTRACTION_RULES).toContain(
      'A travel agent asking the hotel to log a stay they already booked is booking; an attached voucher or sender-stated paid claim is supporting evidence, not the action.',
    );
    expect(EXTRACTION_RULES).toContain(
      'A POP or proof of payment tied to an existing hotel confirmation number, with no new booking request, remains voucher_pop.',
    );
    expect(EXTRACTION_RULES).toContain(
      'A voucher-only delivery or confirmation with no new booking request remains voucher_pop; a voucher alone is not proof of payment.',
    );
  });
});

describe('mail extraction MAIL_ACTIONS', () => {
  it('imports the shared MAIL_ACTIONS list into the extraction schema', () => {
    expect(MAIL_ACTIONS).toEqual([
      'no_action',
      'quote_availability',
      'new_booking',
      'amend',
      'cancel',
      'payment_proof',
      'billing',
      'group_event',
      'other_actionable',
    ]);
    const jsonSchema = zodToJsonSchema(mailExtractionSchema, { $refStrategy: 'none' }) as {
      properties?: { action?: { enum?: string[] } };
    };
    expect(jsonSchema.properties?.action?.enum).toEqual([...MAIL_ACTIONS]);
  });

  it('persists needsAction, action, evidence and confidence into the payload', () => {
    const parsed = mailExtractionSchema.parse(ACTION_OUTPUT);
    expect(parsed).toMatchObject({
      kind: 'quote',
      needsAction: true,
      action: 'quote_availability',
      actionEvidence: 'Please advise availability and rates.',
      actionConfidence: 'high',
    });
    const { payload } = sanitizeExtraction(parsed, {
      messageId: 'msg-action-schema',
      sourceText: AE1_TEXT,
    });
    expect(payload).toMatchObject({
      needsAction: true,
      action: 'quote_availability',
      actionConfidence: 'high',
    });
  });

  it.each(MAIL_ACTIONS)('accepts action %s', (action) => {
    expect(
      mailExtractionSchema.safeParse({
        ...ACTION_OUTPUT,
        needsAction: action !== 'no_action',
        action,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown action, needsAction mismatch, missing required fields, and evidence over 200 characters', () => {
    expect(mailExtractionSchema.safeParse({ ...ACTION_OUTPUT, action: 'payment' }).success).toBe(false);
    expect(
      mailExtractionSchema.safeParse({ ...ACTION_OUTPUT, needsAction: true, action: 'no_action' }).success,
    ).toBe(false);
    const missing = { ...ACTION_OUTPUT } as Record<string, unknown>;
    delete missing.actionEvidence;
    expect(mailExtractionSchema.safeParse(missing).success).toBe(false);
    expect(mailExtractionSchema.safeParse({ ...ACTION_OUTPUT, actionEvidence: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });

  it('card-masks action evidence before storing it', () => {
    const parsed = mailExtractionSchema.parse({
      ...ACTION_OUTPUT,
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
    const parsed = mailExtractionSchema.parse(ACTION_OUTPUT);
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
