import {
  createAgentReadTools,
  hmsReadReservationInputSchema,
} from '../src/hms/agent-read-tools.js';
import { describe, expect, it } from 'vitest';

describe('model-facing read tool exclusions', () => {
  it('does not expose permanently excluded property or mail-artifact tools', () => {
    const tools = createAgentReadTools({} as never);
    expect(Object.keys(tools)).toEqual([
      'hms_find_reservation',
      'hms_read_reservation',
      'hms_quote_stay',
      'hms_read_folio',
      'hms_list_documents',
      'hms_sent_email_audit',
      'hms_read_document',
      'hms_company_account_read',
      'hms_group_block_read',
      'hms_event_read',
      'hms_read_notes_traces',
      'mail_parse_channel_payload',
    ]);
    expect(tools).not.toHaveProperty('property_read_knowledge');
    expect(tools).not.toHaveProperty('mail_read_artifact');
  });

  it('keeps trusted admission internal to the model-facing reservation tool', () => {
    const parsed = hmsReadReservationInputSchema.safeParse({
      reservationRef: 'opaque-reservation',
      sections: ['core'],
      admission: {
        releaseId: 'release',
        requestBranchId: 'branch',
        requesterAuthorizationId: 'auth',
        inputDigest: 'a'.repeat(64),
        captureRequired: false,
        captureBindingRef: null,
        reservationRef: null,
        reservationRefIssuedAt: null,
        reservationRefExpiresAt: null,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('returns typed input-missing for quote requests not issued by a producer', async () => {
    const tools = createAgentReadTools({} as never);
    const result = await tools.hms_quote_stay.execute({
      quoteRequestRef: 'body-derived-but-unissued',
      detail: 'summary',
    });
    expect(result).toMatchObject({
      toolId: 'hms_quote_stay',
      status: 'manual_required',
      data: null,
      completeness: 'unknown',
      unavailableSections: [{ section: 'quote', reasonCode: 'INPUT_MISSING' }],
    });
  });
});
