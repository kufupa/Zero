import { zodToJsonSchema } from 'zod-to-json-schema';
import { describe, expect, it } from 'vitest';
import { EXTRACTION_RULES } from '../src/ai/extraction/extract.js';
import { MAIL_ACTIONS } from '../src/mail/action-labels.js';
import {
  mailExtractionPayloadSchema,
  mailExtractionSchema,
  sanitizeExtraction,
  stableId,
  childAgesForRoom,
  childCountForRoom,
} from '../src/ai/extraction/schema.js';
import { AE1_OUTPUT, AE1_TEXT, AE2_TEXT } from './fixtures/inbound-extraction.js';

const ACTION_OUTPUT = {
  ...AE1_OUTPUT,
  needsAction: true,
  action: 'quote_availability' as const,
  actionEvidence: 'Please advise availability and rates.',
  actionConfidence: 'high' as const,
};

describe('mail extraction contract', () => {
  it('keeps stay-wide child totals unknown per room unless one room covers the stay', () => {
    const shared = {
      id: 'row-multi',
      roomType: 'Twin',
      rooms: 1,
      adultsPerRoom: null,
      childCount: null,
      childAges: [] as number[],
      board: null,
    };
    const multiRoomStay = {
      totalRooms: 2,
      totalChildren: 2,
      rows: [shared, shared],
    };
    expect(childCountForRoom(multiRoomStay, multiRoomStay.rows[0])).toBeNull();
    expect(childAgesForRoom(multiRoomStay, multiRoomStay.rows[0])).toBeNull();

    const oneRoomStay = {
      totalRooms: 1,
      totalChildren: 1,
      rows: [
        {
          id: 'row-single',
          roomType: 'Single',
          rooms: null,
          adultsPerRoom: null,
          childCount: null,
          childAges: [],
          board: null,
        },
      ],
    };
    expect(childCountForRoom(oneRoomStay, oneRoomStay.rows[0])).toBe(1);
    expect(childAgesForRoom(oneRoomStay, oneRoomStay.rows[0])).toBeNull();
  });

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

describe('mail extraction stay guests and action', () => {
  const stayGuestOutput = {
    ...ACTION_OUTPUT,
    confirmationNumbers: ['57291630-1'],
    stays: [
      {
        ...AE1_OUTPUT.stays[0]!,
        action: 'quote_availability' as const,
        guests: [
          { name: 'Guest', confirmationNumber: '57291630-1' },
          { name: 'Other Guest', confirmationNumber: 'ABC-12' },
        ],
      },
      {
        ...AE1_OUTPUT.stays[1]!,
        action: 'new_booking' as const,
        guests: [{ name: 'Guest', confirmationNumber: null }],
      },
    ],
  };

  it('exposes optional stay guests and action in the JSON schema, using MAIL_ACTIONS', () => {
    const jsonSchema = zodToJsonSchema(mailExtractionSchema, { $refStrategy: 'none' }) as {
      properties?: {
        stays?: {
          items?: {
            properties?: { guests?: unknown; action?: { enum?: string[] } };
            required?: string[];
          };
        };
      };
    };
    const staySchema = jsonSchema.properties?.stays?.items;
    expect(staySchema?.properties).toHaveProperty('guests');
    expect(staySchema?.properties).toHaveProperty('action');
    expect(staySchema?.required ?? []).not.toContain('guests');
    expect(staySchema?.required ?? []).not.toContain('action');
    expect(staySchema?.properties?.action?.enum).toEqual([...MAIL_ACTIONS]);
  });

  it('grounds each stay guest confirmation number with the same verbatim check as top-level', () => {
    const parsed = mailExtractionSchema.parse(stayGuestOutput);
    const { payload } = sanitizeExtraction(parsed, {
      messageId: 'msg-stay-guests',
      sourceText: AE2_TEXT,
    });
    expect(payload.confirmationNumbers).toEqual(['57291630-1']);
    expect(payload.stays[0]!.guests).toEqual([
      { name: 'Guest', confirmationNumber: '57291630-1' },
      { name: 'Other Guest', confirmationNumber: null },
    ]);
    expect(payload.stays[1]!.guests).toEqual([{ name: 'Guest', confirmationNumber: null }]);
    expect(payload.stays[0]!.action).toBe('quote_availability');
    expect(payload.stays[1]!.action).toBe('new_booking');
    expect(payload.action).toBe('quote_availability');
    expect(payload.stays[0]!.id).toBe(stableId('s', 'msg-stay-guests', '2027-10-26\0' + '2027-10-28'));
    expect(payload.stays[1]!.id).toBe(stableId('s', 'msg-stay-guests', '2027-11-17\0' + '2027-11-19'));
  });

  it('keeps stay guests and action optional on a stored payload without them', () => {
    const parsed = mailExtractionSchema.parse(ACTION_OUTPUT);
    const legacyPayload: Record<string, unknown> = {
      ...sanitizeExtraction(parsed, { messageId: 'msg-stay-guests-legacy', sourceText: AE1_TEXT }).payload,
    };
    const stays = (legacyPayload.stays as Array<Record<string, unknown>>).map((stay) => {
      const copy = { ...stay };
      delete copy.guests;
      delete copy.action;
      return copy;
    });
    expect(mailExtractionPayloadSchema.safeParse({ ...legacyPayload, stays }).success).toBe(true);
  });

  it('asks the model for per-stay guests and action without rewriting classification rules', () => {
    expect(EXTRACTION_RULES).toContain(
      "For each stay, guests is optional: that stay's named guests, each with name as written and confirmationNumber exactly as written for that guest, or null.",
    );
    expect(EXTRACTION_RULES).toContain(
      'For each stay, action is optional and uses the same enum as top-level action. Top-level kind and action remain a summary of the mail.',
    );
  });
});

describe('mail extraction stay identity', () => {
  const octStay = AE1_OUTPUT.stays[0]!;
  const novStay = AE1_OUTPUT.stays[1]!;

  function staysOf(stays: typeof AE1_OUTPUT.stays, messageId: string) {
    return sanitizeExtraction(
      { ...ACTION_OUTPUT, stays },
      { messageId, sourceText: AE1_TEXT },
    ).payload.stays;
  }

  it('keeps the same stay id when two date sets come back in the other order', () => {
    const forward = staysOf([octStay, novStay], 'msg-stay-reorder');
    const reverse = staysOf([novStay, octStay], 'msg-stay-reorder');
    const octId = forward.find((stay) => stay.requested.arrival === '2027-10-26')!.id;
    const novId = forward.find((stay) => stay.requested.arrival === '2027-11-17')!.id;
    expect(octId).not.toBe(novId);
    expect(reverse.find((stay) => stay.requested.arrival === '2027-10-26')!.id).toBe(octId);
    expect(reverse.find((stay) => stay.requested.arrival === '2027-11-17')!.id).toBe(novId);
    expect(reverse[0]!.requested.arrival).toBe('2027-11-17');
  });

  it('keeps row ids when room types in a stay come back in the other order', () => {
    const [single, twin] = octStay.rows;
    const forward = staysOf([{ ...octStay, rows: [single!, twin!] }], 'msg-row-reorder');
    const reverse = staysOf([{ ...octStay, rows: [twin!, single!] }], 'msg-row-reorder');
    const stayId = forward[0]!.id;
    expect(forward[0]!.rows.map((row) => row.roomType)).toEqual(['Single', 'Double/Twin']);
    expect(reverse[0]!.rows.map((row) => row.roomType)).toEqual(['Double/Twin', 'Single']);
    expect(reverse[0]!.id).toBe(stayId);
    expect(reverse[0]!.rows.find((row) => row.roomType === 'Single')!.id).toBe(
      forward[0]!.rows.find((row) => row.roomType === 'Single')!.id,
    );
    expect(reverse[0]!.rows.find((row) => row.roomType === 'Double/Twin')!.id).toBe(
      forward[0]!.rows.find((row) => row.roomType === 'Double/Twin')!.id,
    );
  });

  it('gives same-date stays distinct ids from guest confirmation, stable across reorder', () => {
    const first = {
      ...octStay,
      guests: [{ name: 'Guest One', confirmationNumber: '57291630-1' }],
    };
    const second = {
      ...octStay,
      guests: [{ name: 'Guest Two', confirmationNumber: '57291630-2' }],
    };
    const sourceText = `${AE1_TEXT}\n57291630-1\n57291630-2`;
    const sanitize = (stays: typeof AE1_OUTPUT.stays) =>
      sanitizeExtraction({ ...ACTION_OUTPUT, stays }, { messageId: 'msg-same-date', sourceText }).payload
        .stays;
    const forward = sanitize([first, second]);
    const reverse = sanitize([second, first]);
    const oneId = forward.find((stay) => stay.guests?.[0]?.confirmationNumber === '57291630-1')!.id;
    const twoId = forward.find((stay) => stay.guests?.[0]?.confirmationNumber === '57291630-2')!.id;
    expect(oneId).not.toBe(twoId);
    expect(reverse.find((stay) => stay.guests?.[0]?.confirmationNumber === '57291630-1')!.id).toBe(oneId);
    expect(reverse.find((stay) => stay.guests?.[0]?.confirmationNumber === '57291630-2')!.id).toBe(twoId);
  });
});
