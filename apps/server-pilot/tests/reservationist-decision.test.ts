import { describe, expect, it } from 'vitest';
import { K2_MAPPING, mapLlmDecision } from '../src/ai/quote-workflow-llm.js';
import { EXTRACTION_RULES } from '../src/ai/extraction/extract.js';
import {
  CENTURION_HOTEL_RULES,
  HOLDING_MOVE_WORKFLOWS,
  lunaAnalysisSchema,
  reservationistDecisionSchema,
} from '../src/ai/reservationist-decision.js';

const fields = {
  stayAsk: null,
  missing: [] as string[],
  replyDraft: 'Noted — staff will handle this.',
  rationale: 'Synthetic fixture.',
};

const CATALOG_MOVES = [
  'forward_to_partner',
  'send_document',
  'payment_ack',
  'amend',
  'cancel',
  'clarify',
  'acknowledge',
  'hms_todo',
] as const;

const EXISTING_WORKFLOWS = ['quote', 'create', 'skip', 'spam', 'other'] as const;

describe('reservationistDecisionSchema', () => {
  it('accepts the move catalog and existing workflow values', () => {
    for (const workflow of [...EXISTING_WORKFLOWS, ...CATALOG_MOVES]) {
      const parsed = reservationistDecisionSchema.parse({ ...fields, workflow });
      expect(parsed.workflow).toBe(workflow);
    }
  });

  it('accepts hms_todo with target op, reason and next step', () => {
    const parsed = reservationistDecisionSchema.parse({
      ...fields,
      workflow: 'hms_todo',
      todoTarget: 'post_payment',
      todoReason: 'POP posting is staff-only.',
      todoNextStep: 'Staff posts payment on the folio.',
    });
    expect(parsed.todoTarget).toBe('post_payment');
    expect(parsed.todoReason).toMatch(/staff-only/);
    expect(parsed.todoNextStep).toMatch(/posts payment/);
  });

  it('rejects renamed FWD names and unknown workflows', () => {
    expect(() => reservationistDecisionSchema.parse({ ...fields, workflow: 'forward' })).toThrow();
    expect(() =>
      reservationistDecisionSchema.parse({ ...fields, workflow: 'invoice_or_folio' }),
    ).toThrow();
    expect(() => reservationistDecisionSchema.parse({ ...fields, workflow: 'partner' })).toThrow();
  });
});

describe('CENTURION_HOTEL_RULES move catalog', () => {
  it('encodes a SOP and required fields for each catalog move', () => {
    expect(CENTURION_HOTEL_RULES).toMatch(/Never claim an HMS action was done/i);
    expect(CENTURION_HOTEL_RULES).toMatch(/unsupported → hms_todo/i);
    expect(CENTURION_HOTEL_RULES).toMatch(/workflow=forward_to_partner/);
    expect(CENTURION_HOTEL_RULES).toMatch(/partnerDestination/);
    expect(CENTURION_HOTEL_RULES).toMatch(/Da Vinci/i);
    expect(CENTURION_HOTEL_RULES).toMatch(/workflow=send_document/);
    expect(CENTURION_HOTEL_RULES).toMatch(/documentKind/);
    expect(CENTURION_HOTEL_RULES).toMatch(/proforma/i);
    expect(CENTURION_HOTEL_RULES).toMatch(/workflow=payment_ack/);
    expect(CENTURION_HOTEL_RULES).toMatch(/Never post payment/i);
    expect(CENTURION_HOTEL_RULES).toMatch(/workflow=amend/);
    expect(CENTURION_HOTEL_RULES).toMatch(/confirmationNumber/);
    expect(CENTURION_HOTEL_RULES).toMatch(/requestedChange/);
    expect(CENTURION_HOTEL_RULES).toMatch(/workflow=cancel/);
    expect(CENTURION_HOTEL_RULES).toMatch(/never accepts penalty/i);
    expect(CENTURION_HOTEL_RULES).toMatch(/workflow=clarify/);
    expect(CENTURION_HOTEL_RULES).toMatch(/workflow=acknowledge/);
    expect(CENTURION_HOTEL_RULES).toMatch(/workflow=hms_todo/);
    expect(CENTURION_HOTEL_RULES).toMatch(/adult-only request with no children mentioned.*childCount=0/i);
    expect(CENTURION_HOTEL_RULES).toMatch(/todoTarget/);
    expect(CENTURION_HOTEL_RULES).toMatch(/todoReason/);
    expect(CENTURION_HOTEL_RULES).toMatch(/todoNextStep/);
    expect(CENTURION_HOTEL_RULES).toMatch(/No tools/);
  });
});

describe('consumers of hotel-rule workflow names', () => {
  it('pane analysis maps holding moves onto other, like skip and spam', () => {
    expect(K2_MAPPING).toMatch(/"skip"/);
    expect(K2_MAPPING).toMatch(/"spam"/);
    for (const move of HOLDING_MOVE_WORKFLOWS) {
      expect(K2_MAPPING).toContain(`"${move}"`);
    }
    expect(K2_MAPPING).toMatch(/are other/);
  });

  it('inbound extraction maps holding moves onto other', () => {
    for (const move of HOLDING_MOVE_WORKFLOWS) {
      expect(EXTRACTION_RULES).toContain(`${move} is other`);
    }
  });

  it('pane mapping treats holding moves like other (no quote groups)', () => {
    for (const workflow of HOLDING_MOVE_WORKFLOWS) {
      const mapped = mapLlmDecision(
        lunaAnalysisSchema.parse({
          workflow,
          flags: [],
          groups: [],
          party: { kind: null, name: null, reference: null },
          rateClaims: [],
          missing: [],
          evidence: [],
          tasks: [],
        }),
      );
      expect(mapped.intent).toBe('other');
      expect(mapped.groups).toEqual([]);
    }
  });
});
