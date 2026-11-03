import { describe, expect, it } from 'vitest';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { approveHmsWrite, formDigest, publicHmsWriteForm, resolveHmsNeedsCheck } from '../src/ai/hms-approval.js';
import type { DB } from '../src/db/client.js';
import {
  bindCloudAmendInput,
  bindCloudAmendForm,
  cloudAmendFirstPilotScopeSupported,
  cloudAmendPreimage,
  cloudAmendSourceBinding,
  selectedAmendSourceMatches,
  type CloudAmendSource,
} from '../src/ai/pane-cloud-amend.js';
import type { HmsCloudFindResult } from '../src/ai/hms-cloud-saved-stay-find.js';

const mail = { id: 'message-1', transportId: 'transport', threadId: 'thread', direction: 'inbound' as const,
  historyOnly: false, sourceProvenance: null,
  subject: 'Change', textBody: 'Please change the dates', htmlBody: null };
const source: CloudAmendSource = { messageId: mail.id, threadId: mail.threadId,
  extractionId: '00000000-0000-4000-8000-000000000001', sourceHash: staffQuoteSourceHash(mail) };
const item = { id: '00000000-0000-4000-8000-000000000002', transportId: 'transport', threadId: 'thread',
  sourceMessageId: mail.id, extractionId: source.extractionId, status: 'needs_you', kind: 'amendment', state: {} };
const extraction = { id: source.extractionId, messageId: mail.id, kind: 'amendment', status: 'succeeded' };
const thread = { id: 'thread', transportId: 'transport', historyOnly: false, trashedAt: null };
const native = { source: 'record_view_ext_model' as const, propertyCode: 'HRCEN', confirmation: '12345678-1',
  reservationStayId: '10', reservationId: '11', recordId: '12', guestId: '13', status: 'Reserved',
  firstName: 'Proof', lastName: 'Labtest', arrival: '2027-05-02', departure: '2027-05-04', roomType: 'STQN',
  ratePlan: 'BAR', adults: 2, children: 1, childAges: [8] };
const stay = { confirmation: native.confirmation, status: native.status, firstName: native.firstName, lastName: native.lastName,
  arrival: native.arrival, departure: native.departure, nights: 2, adults: 2, children: 1, roomType: native.roomType,
  ratePlan: native.ratePlan, mealPlan: null, averageRate: '100', grandTotal: '200', balance: '0', sourceOfBusiness: null,
  guaranteeType: 'Non-Guaranteed Individual', depositReceived: '0', bookingAgency: null, organization: null };
const found: HmsCloudFindResult = { source: 'hms_cloud_saved_stay', outcome: 'found', reason: null,
  stay, nativePreimage: native, arrivalMismatch: false, requestedArrival: native.arrival, hmsArrival: native.arrival,
  screenshots: [], runId: null, guestName: 'Proof Labtest', observedAt: '2026-11-03T00:00:00.000Z' };

describe('source-bound saved-stay amendment', () => {
  it('refuses another message from the same thread, changed text, stale extraction and closed items', () => {
    expect(selectedAmendSourceMatches(source, item, mail, extraction, 'transport', thread)).toBe(true);
    expect(selectedAmendSourceMatches(source, { ...item, sourceMessageId: 'message-2' }, mail, extraction, 'transport', thread)).toBe(false);
    expect(selectedAmendSourceMatches(source, item, { ...mail, textBody: 'Changed later' }, extraction, 'transport', thread)).toBe(false);
    expect(selectedAmendSourceMatches(source, item, mail, { ...extraction, messageId: 'message-2' }, 'transport', thread)).toBe(false);
    expect(selectedAmendSourceMatches(source, { ...item, status: 'dismissed' }, mail, extraction, 'transport', thread)).toBe(false);
    expect(selectedAmendSourceMatches(source, item, { ...mail, historyOnly: true }, extraction, 'transport', thread)).toBe(false);
    expect(selectedAmendSourceMatches(source, item, { ...mail, sourceProvenance: { attention: 'ambiguous' } }, extraction, 'transport', thread)).toBe(false);
    expect(selectedAmendSourceMatches(source, item, mail, extraction, 'other-transport', thread)).toBe(false);
    for (const invalid of [undefined, { ...thread, historyOnly: true }, { ...thread, trashedAt: new Date() },
      { ...thread, id: 'other-thread' }, { ...thread, transportId: 'other-transport' }]) {
      expect(selectedAmendSourceMatches(source, item, mail, extraction, 'transport', invalid)).toBe(false);
    }
  });

  it('binds the source body, extraction contents, attachment metadata and edit cursor', () => {
    const fullMail = { ...mail, fromAddress: 'guest@example.test', toAddresses: [], ccAddresses: [], bccAddresses: [],
      ownerHeaderValue: null, messageIdHeader: null, inReplyTo: null, references: null, originalMsgS3Key: null,
      rawMimeS3Key: null, receivedAt: null, sentAt: null, createdAt: new Date('2026-11-03T00:00:00Z') };
    const fullExtraction = { ...extraction, extractorVersion: 'v1', language: 'en',
      payload: { kind: 'amendment' }, translation: null, attachments: [] };
    const fullItem = { ...item, revision: 1, revisionHead: 1, revisionSeq: 2 };
    const document = { id: 'attachment-1', messageId: mail.id, filename: 'request.pdf', mimeType: 'application/pdf',
      sizeBytes: 5, sha256: 'a'.repeat(64), sourceAttachmentId: null, s3Key: 'attachments/test', contentId: null,
      isInline: false };
    type Rows = Parameters<typeof cloudAmendSourceBinding>[0];
    const rows = { item: fullItem, thread, mail: fullMail, extraction: fullExtraction, attachments: [document] } as unknown as Rows;
    const bound = cloudAmendSourceBinding(rows, source, 'transport');
    expect(bound).not.toBeNull();
    for (const changed of [
      { ...rows, mail: { ...rows.mail!, fromAddress: 'other@example.test' } },
      { ...rows, extraction: { ...rows.extraction!, translation: { status: 'succeeded', text: 'changed' } } },
      { ...rows, attachments: [{ ...rows.attachments[0]!, sha256: 'b'.repeat(64) }] },
      { ...rows, item: { ...rows.item!, revisionSeq: 3 } },
      { ...rows, thread: { ...thread, trashedAt: new Date() } },
    ]) expect(cloudAmendSourceBinding(changed, source, 'transport')).not.toEqual(bound);
  });

  it('does not expose the private source or native preimage to the approval card', () => {
    const state = { action: 'amend', confirmation: '12345678-1', fields: { adults: 3, ratePlan: 'BAR', retainRates: 'yes' },
      cloudAmend: { binding: { digest: 'a'.repeat(64) }, preimage: { native: { guestId: 'private-native-id' } } },
      hmsSnapshot: { digest: 'b'.repeat(64), readAt: '2026-11-03T00:00:00Z' } };
    const publicForm = publicHmsWriteForm(state);
    expect(publicForm.cloudAmend).toEqual({ bound: true });
    expect(JSON.stringify(publicForm)).not.toContain('private-native-id');
    expect(formDigest(state)).not.toEqual(formDigest({ ...state, cloudAmend: { binding: { digest: 'c'.repeat(64) } } }));
  });

  it('exposes only the retained nightly rate and total to the staff card', () => {
    const field = (cents: string) => ({ data: { state: 'amount', cents }, visible: { state: 'amount', cents },
      dataCurrency: { state: 'currency', code: 'ZAR' }, visibleCurrency: { state: 'currency', code: 'ZAR' } });
    const names = ['averagenightly', 'averagerate', 'grandtotal', 'totalrate', 'totalratewithtax', 'guesttotal', 'tax', 'guesttax'];
    const prices = { version: 1, currency: 'ZAR', fields: Object.fromEntries(names.map((name) => [name, field('123450')])) };
    const state = { action: 'amend', fields: { adults: 3, ratePlan: 'BAR', retainRates: 'yes' },
      cloudAmend: { binding: { digest: 'a'.repeat(64) }, preimage: { native: { guestId: 'private-native-id' } },
        nativeDigest: 'b'.repeat(64), approvedPrices: prices } };
    const form = publicHmsWriteForm(state);
    expect(Object.keys((form.cloudAmend as { approvedPrices: { fields: object } }).approvedPrices.fields).sort())
      .toEqual(['averagenightly', 'grandtotal']);
    expect(JSON.stringify(form)).not.toContain('private-native-id');
    for (const damaged of [
      { ...prices, fields: { ...prices.fields, guesttax: undefined } },
      { ...prices, fields: { ...prices.fields, grandtotal: { ...field('123450'), visible: { state: 'amount', cents: '1' } } } },
      { ...prices, fields: { ...prices.fields, averagenightly: field('1234567890123') } },
    ]) {
      const invalid = publicHmsWriteForm({ ...state, cloudAmend: { ...state.cloudAmend, approvedPrices: damaged } });
      expect(invalid.cloudAmend).toEqual({ bound: true });
    }
  });

  it('refuses Cloud Go before writing a grant when its worker is off', async () => {
    let inserts = 0;
    const row = { ...item, state: { action: 'amend', cloudAmend: { bound: true } } };
    const tx = { select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [row] }) }) }) }),
      insert: () => { inserts += 1; throw new Error('unexpected_insert'); } };
    const db = { transaction: async (fn: (value: unknown) => Promise<unknown>) => fn(tx) } as unknown as DB;
    await expect(approveHmsWrite({ db, transportId: 'transport', actorUserId: 'staff', workItemId: item.id,
      sessionId: 'session', sessionProfile: 'remote', env: { PANE_HMS_LAB_AMEND_WORKER: 'off', PANE_WRITE_AMEND: 'lab' },
    })).rejects.toMatchObject({ refusal: 'amend_save_unavailable' });
    expect(inserts).toBe(0);
  });

  it('refuses preparation before any DB or HMS read while the worker is off', async () => {
    const db = { select: () => { throw new Error('unexpected_db_read'); } } as unknown as DB;
    await expect(bindCloudAmendForm({ db, transportId: 'transport', workItemId: item.id,
      source: { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash },
      confirmation: native.confirmation, arrival: native.arrival,
      changes: { adults: 3, ratePlan: 'BAR', retainRates: 'yes' } })).resolves.toEqual({
        status: 'refused', reason: 'amend_save_unavailable',
      });
  });

  it('does not clear an uncertain Cloud amend from a staff note', async () => {
    let writes = 0;
    const row = { ...item, state: { action: 'amend', cloudAmend: { bound: true } } };
    const tx = { select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [row] }) }) }) }),
      insert: () => { writes += 1; }, update: () => { writes += 1; } };
    const db = { transaction: async (fn: (value: unknown) => Promise<unknown>) => fn(tx) } as unknown as DB;
    await expect(resolveHmsNeedsCheck({ db, transportId: 'transport', actorUserId: 'staff', workItemId: item.id,
      note: 'Checked the booking' })).rejects.toMatchObject({ refusal: 'amend_reconciliation_required' });
    expect(writes).toBe(0);
  });

  it('accepts only an exact unpaid HRCEN Labtest preimage', () => {
    expect(cloudAmendPreimage(found)?.native).toEqual(native);
    for (const bad of [
      { ...found, arrivalMismatch: true },
      { ...found, nativePreimage: { ...native, lastName: 'Guest' } },
      { ...found, nativePreimage: { ...native, propertyCode: 'HRDAV' } },
      { ...found, nativePreimage: { ...native, arrival: '2026-12-31' } },
      { ...found, stay: { ...stay, depositReceived: '20' } },
      { ...found, stay: { ...stay, guaranteeType: 'Credit Card' } },
    ]) expect(cloudAmendPreimage(bad)).toBeNull();
  });

  it('validates date, child and retain-rate input before checking supported save scope', () => {
    const selection = { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash };
    const base = { workItemId: item.id, source: selection, confirmation: native.confirmation, arrival: native.arrival };
    expect(bindCloudAmendInput.safeParse({ ...base, changes: { adults: 3, ratePlan: 'BAR', retainRates: 'yes' } }).success).toBe(true);
    expect(bindCloudAmendInput.safeParse({ ...base, source, changes: { adults: 3, ratePlan: 'BAR', retainRates: 'yes' } }).success).toBe(false);
    for (const changes of [
      { adults: 3, ratePlan: 'BAR' }, { adults: 3, ratePlan: 'BAR', retainRates: 'maybe' },
      { children: 2, childAges: [8], ratePlan: 'BAR', retainRates: 'yes' },
      { departure: '2027-02-30', ratePlan: 'BAR', retainRates: 'yes' },
    ]) expect(bindCloudAmendInput.safeParse({ ...base, changes }).success).toBe(false);
    for (const changes of [{ adults:3, ratePlan:'BAR', retainRates:'no' },
      { arrival:'2027-05-03', departure:'2027-05-04', ratePlan:'BAR', retainRates:'yes' },
      { children:1, childAges:[8], ratePlan:'BAR', retainRates:'yes' }]) {
      expect(bindCloudAmendInput.safeParse({ ...base, changes }).success).toBe(true);
    }
  });

  it('limits the first approved save to one night before and after with a retained price', () => {
    const oneNight = { ...native, departure: '2027-05-03' };
    const adults = { adults: 3, ratePlan: 'BAR', retainRates: 'yes' as const };
    expect(cloudAmendFirstPilotScopeSupported(oneNight, adults)).toBe(true);
    expect(cloudAmendFirstPilotScopeSupported(oneNight,
      { arrival:'2027-05-03', departure:'2027-05-04', ratePlan:'BAR', retainRates:'yes' })).toBe(true);
    for (const [stay, changes] of [
      [native, adults],
      [oneNight, { ...adults, adults: oneNight.adults }],
      [oneNight, { ...adults, retainRates: 'no' as const }],
      [oneNight, { ...adults, ratePlan: 'OTHER' }],
      [oneNight, { ...adults, departure: '2027-05-04' }],
      [oneNight, { ...adults, children: 1, childAges: [8] }],
    ] as const) expect(cloudAmendFirstPilotScopeSupported(stay, changes as never)).toBe(false);
  });
});
