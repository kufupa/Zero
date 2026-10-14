import { zodToJsonSchema } from 'zod-to-json-schema';
import { describe, expect, it } from 'vitest';
import {
  mailExtractionPayloadSchema,
  mailExtractionSchema,
  sanitizeExtraction,
} from '../src/ai/extraction/schema.js';
import { storedAnalysis } from '../src/ai/work-items.js';
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

describe('mail extraction v2 fields', () => {
  it('grounds guest names and sanitizes special requests and meal details', () => {
    const parsed = mailExtractionSchema.safeParse({
      ...AE1_OUTPUT,
      guest: { firstName: 'jamie', lastName: 'Unknown' },
      specialRequests: ['cot', ' cot ', '', 'cot'],
      mealAndPayer: { mealPlan: ' half board ', payer: ' company pays room only ' },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const sanitized = sanitizeExtraction(parsed.data, {
      messageId: 'msg-extraction-v2-guest',
      sourceText: `${AE1_TEXT}\nGuest: Jamie Carter\nPlease add a cot.`,
    });
    expect(sanitized.payload).toMatchObject({
      guest: { firstName: 'jamie', lastName: null },
      specialRequests: ['cot'],
      mealAndPayer: { mealPlan: 'half board', payer: 'company pays room only' },
    });
  });

  it('keeps only external references found in the source', () => {
    const parsed = mailExtractionSchema.safeParse({
      ...AE1_OUTPUT,
      externalRefs: [
        { channel: ' Booking.com ', reference: 'REF-123' },
        { channel: 'Example OTA', reference: 'INVENTED-456' },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const sanitized = sanitizeExtraction(parsed.data, {
      messageId: 'msg-extraction-v2-refs',
      sourceText: `${AE1_TEXT}\nBooking.com reference: REF-123`,
    });
    expect(sanitized.payload).toMatchObject({
      externalRefs: [{ channel: 'Booking.com', reference: 'REF-123' }],
    });
  });

  it('keeps requestedChange for amendments but not bookings', () => {
    const amendment = mailExtractionSchema.safeParse({
      ...AE1_OUTPUT,
      kind: 'amendment',
      requestedChange: ' Late check-out on 18 Nov ',
    });
    const booking = mailExtractionSchema.safeParse({
      ...AE1_OUTPUT,
      kind: 'booking',
      requestedChange: 'Late check-out on 18 Nov',
    });
    expect(amendment.success && booking.success).toBe(true);
    if (!amendment.success || !booking.success) return;

    expect(
      sanitizeExtraction(amendment.data, { messageId: 'msg-v2-amendment', sourceText: AE1_TEXT }).payload,
    ).toMatchObject({ requestedChange: 'Late check-out on 18 Nov' });
    expect(
      sanitizeExtraction(booking.data, { messageId: 'msg-v2-booking', sourceText: AE1_TEXT }).payload,
    ).toMatchObject({ requestedChange: null });
  });

  it('parses an older stored payload without v2 fields', () => {
    const parsed = mailExtractionSchema.safeParse(AE1_OUTPUT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const payload: Record<string, unknown> = {
      ...sanitizeExtraction(parsed.data, { messageId: 'msg-v2-legacy', sourceText: AE1_TEXT }).payload,
    };
    expect(payload).toMatchObject({
      guest: { firstName: null, lastName: null },
      specialRequests: [],
      externalRefs: [],
      requestedChange: null,
      mealAndPayer: { mealPlan: null, payer: null },
    });
    for (const key of ['guest', 'specialRequests', 'externalRefs', 'requestedChange', 'mealAndPayer']) {
      delete payload[key];
    }
    expect(mailExtractionPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('drops a malformed v2 field without failing the whole read', () => {
    const parsed = mailExtractionSchema.safeParse({
      ...AE1_OUTPUT,
      guest: 'Jamie Carter',
      specialRequests: 'cot',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(
      sanitizeExtraction(parsed.data, { messageId: 'msg-v2-malformed', sourceText: AE1_TEXT }).payload,
    ).toMatchObject({ guest: { firstName: null, lastName: null }, specialRequests: [] });
  });

  it('drops special requests the source does not support', () => {
    const parsed = mailExtractionSchema.safeParse({
      ...AE1_OUTPUT,
      specialRequests: ['airport pickup', 'late check-out on 7 November', 'cot'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const sanitized = sanitizeExtraction(parsed.data, {
      messageId: 'msg-v2-requests',
      sourceText: `${AE1_TEXT}\nLate check will be charged on 7 November. Please add a cot.`,
    });
    expect(sanitized.payload.specialRequests).toEqual(['late check-out on 7 November', 'cot']);
  });

  it('feeds the guest surname and requested change into the stored analysis', () => {
    const parsed = mailExtractionSchema.safeParse({
      ...AE1_OUTPUT,
      kind: 'amendment',
      guest: { firstName: 'Jamie', lastName: 'Carter' },
      requestedChange: 'Late check-out on 18 Nov',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { kind, payload } = sanitizeExtraction(parsed.data, {
      messageId: 'msg-v2-analysis',
      sourceText: `${AE1_TEXT}\nGuest: Jamie Carter`,
    });
    const { analysis } = storedAnalysis({ kind, payload, attachments: null }, {});
    expect(analysis.amendment).toMatchObject({
      kind: 'amend',
      guestLastName: 'Carter',
      requestedChange: 'Late check-out on 18 Nov',
    });
  });
});
