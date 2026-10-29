import { describe, expect, it } from 'vitest';
import { captureQuoteSourceProof, quoteSourceProofIsCurrent, quoteSourceProofMatchesCopy,
  quoteSourceProofMatchesInput, quoteSourceProofMatchesSingleStay, quoteSourceProofPredatesPolicy } from '../src/ai/child-occupancy.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';

const scope = { transportId: 'transport-centurion', threadId: 't1', messageId: 'm1', propertyCode: 'HRCEN' };
const input = staffQuoteInput.parse({ messageId: 'm1', sourceHash: 'a'.repeat(64), selectionEpoch: 1, inputRevision: 1,
  groups: [{ id: 'r1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1,
    adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'dinner_bb', roomCodes: ['SKNG'],
    sourcePreference: { roomType: 'Standard King', board: 'dbb' } }], salesStrategy: 'BAR' });
function evidence(stayId = 's1', rowId = 'r1') {
  const data = { payload: { contact: { name: null, email: null, phone: null }, agency: null as string | null, endClient: null,
    confirmationNumbers: [], missing: [], stays: [{ id: stayId, hotel: null,
      requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
      guests: [{ name: 'Synthetic Guest', confirmationNumber: null as string | null }],
      action: 'quote_availability' as 'quote_availability' | 'new_booking',
      rows: [{ id: rowId, roomType: 'Standard King' as string | null, rooms: 1, adultsPerRoom: 2,
        childrenPerRoom: 0, childAges: [] as number[], board: 'dbb' as string | null }] }] },
    state: {} as Record<string, unknown>, pinned: 'extract-1', latest: 'extract-1', kind: 'quote',
    conflicts: [] as Array<{ workItemId: string; kind: string; status: string }> };
  const db = { select(selection?: Record<string, unknown>) {
    let table: unknown;
    const conflict = selection && 'workItemId' in selection && 'kind' in selection && 'status' in selection;
    const read = () => conflict ? data.conflicts : table === mailExtraction ? [{ id: data.latest, kind: data.kind, payload: data.payload }] :
      table === workItem ? [{ extractionId: data.pinned, state: data.state }] : [];
    const query = Object.assign(Promise.resolve().then(read), {
      from(value: unknown) { table = value; return query; }, where() { return query; }, orderBy() { return query; },
      limit() { return query; }, for() { return query; },
    });
    return query;
  } } as unknown as DB;
  return { data, db };
}

describe('source preferences bound to a Centurion price', () => {
  it('rejects pre-policy proofs on every Centurion reuse path but preserves HRDAV', async () => {
    const { db } = evidence();
    const current = await captureQuoteSourceProof(db, input, scope);
    expect(current?.version).toBe(3);
    const revision = { groups: [{ arrivalDate: '2027-10-20', departureDate: '2027-10-21',
      quantity: 1, adults: 2, children: 0, childAges: [] }] };
    for (const version of [1, 2]) {
      const old = { ...current!, version };
      expect(quoteSourceProofPredatesPolicy(old)).toBe(true);
      expect(quoteSourceProofMatchesInput(old, input)).toBe(false);
      expect(await quoteSourceProofIsCurrent(db, input.groups, scope, old)).toBe(false);
      expect(await quoteSourceProofMatchesCopy(db, input.groups, scope, old)).toBe(false);
      expect(await quoteSourceProofMatchesSingleStay(db, revision, scope, old)).toBe(false);
      expect(await quoteSourceProofIsCurrent(db, input.groups, { ...scope, propertyCode: 'HRDAV' }, old)).toBe(true);
      expect(await quoteSourceProofMatchesCopy(db, input.groups, { ...scope, propertyCode: 'HRDAV' }, old)).toBe(true);
      expect(await quoteSourceProofMatchesSingleStay(db, revision, { ...scope, propertyCode: 'HRDAV' }, old)).toBe(true);
    }
    expect(quoteSourceProofPredatesPolicy(current)).toBe(false);
    expect(quoteSourceProofMatchesInput({ ...current!, extractionDigest: undefined }, input)).toBe(false);
  });

  it('requires the client to have seen the current saved room and board before admission', async () => {
    const { data, db } = evidence();
    expect(await captureQuoteSourceProof(db, input, scope)).not.toBeNull();
    const [group] = input.groups;
    expect(await captureQuoteSourceProof(db, { ...input, groups: [{ ...group!, sourcePreference: undefined }] }, scope)).toBeNull();
    data.state['stays[s1].rows[r1].roomType'] = 'Standard Twin';
    expect(await captureQuoteSourceProof(db, input, scope)).toBeNull();
    data.state['stays[s1].rows[r1].roomType'] = 'Standard King';
    data.state['stays[s1].rows[r1].board'] = 'half_board';
    expect(await captureQuoteSourceProof(db, input, scope)).toBeNull();
    expect(await captureQuoteSourceProof(db, { ...input, groups: [{ ...group!,
      sourcePreference: { roomType: 'Standard King', board: 'half_board' } }] }, scope)).not.toBeNull();
  });

  it('invalidates room or board changes while ignoring unrelated saved edits', async () => {
    const { data, db } = evidence();
    const proof = await captureQuoteSourceProof(db, input, scope);
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(true);
    data.state['contact.phone'] = 'changed';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(true);
    data.state['stays[s1].rows[r1].roomType'] = 'Standard Twin';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    delete data.state['stays[s1].rows[r1].roomType'];
    data.state['stays[s1].rows[r1].board'] = 'bb';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
  });

  it('distinguishes absent source values from staff-cleared values after admission', async () => {
    const { data, db } = evidence();
    data.payload.stays[0]!.rows[0]!.roomType = null;
    data.payload.stays[0]!.rows[0]!.board = null;
    const missing = { ...input, groups: [{ ...input.groups[0]!, sourcePreference: { roomType: null, board: null } }] };
    const proof = await captureQuoteSourceProof(db, missing, scope);
    expect(await quoteSourceProofIsCurrent(db, missing.groups, scope, proof)).toBe(true);
    data.state['stays[s1].rows[r1].roomType'] = null;
    expect(await quoteSourceProofIsCurrent(db, missing.groups, scope, proof)).toBe(false);
    expect(await captureQuoteSourceProof(db, missing, scope)).not.toBeNull();
  });

  it('keeps an explicit rate-card choice and a dinner fallback separate from source preferences', async () => {
    const { db } = evidence();
    const selected = { ...input, groups: [{ ...input.groups[0]!, board: 'bb' as const,
      roomCodes: ['STWN'], rateCode: 'BWS1B' }] };
    const proof = await captureQuoteSourceProof(db, selected, scope);
    expect(proof).not.toBeNull();
    expect(quoteSourceProofMatchesInput(proof, selected)).toBe(true);
    expect(quoteSourceProofMatchesInput(proof, input)).toBe(false);
    expect(await quoteSourceProofIsCurrent(db, selected.groups, scope, proof)).toBe(true);
  });

  it('allows a copied message only for an unambiguous row with the same source preferences', async () => {
    const original = evidence();
    const proof = await captureQuoteSourceProof(original.db, input, scope);
    const copy = evidence('s2', 'r2');
    const copyScope = { ...scope, threadId: 't2', messageId: 'm2' };
    const copiedGroup = { ...input.groups[0]!, id: 'r2' };
    const revision = { groups: [{ arrivalDate: copiedGroup.arrivalDate, departureDate: copiedGroup.departureDate,
      quantity: 1, adults: 2, children: 0, childAges: [] }] };
    expect(await quoteSourceProofMatchesCopy(copy.db, [copiedGroup], copyScope, proof)).toBe(true);
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(true);
    copy.data.state['stays[s2].rows[r2].roomType'] = 'Standard Twin';
    expect(await quoteSourceProofMatchesCopy(copy.db, [copiedGroup], copyScope, proof)).toBe(false);
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
  });

  it('checks the active saved row and its preferences after a copied room is replaced', async () => {
    const original = evidence();
    const proof = await captureQuoteSourceProof(original.db, input, scope);
    const copy = evidence('s2', 'r2');
    const copyScope = { ...scope, threadId: 't2', messageId: 'm2' };
    const revision = { groups: [{ arrivalDate: '2027-10-20', departureDate: '2027-10-21',
      quantity: 1, adults: 2, children: 0, childAges: [] }] };
    const row = 'stays[s2].rows[r_added]';
    copy.data.state = { 'stays[s2].rows[r2].removed': true,
      [`${row}.count`]: 1, [`${row}.adults`]: 2, [`${row}.childrenPerRoom`]: 0, [`${row}.childAges`]: [],
      [`${row}.roomType`]: 'Standard King', [`${row}.board`]: 'dbb' };
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(true);
    copy.data.state[`${row}.roomType`] = 'Standard Twin';
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
  });

  it('holds pinned old extractions and keeps HRDAV quote behavior on a Centurion mailbox', async () => {
    const { data, db } = evidence();
    const proof = await captureQuoteSourceProof(db, input, scope);
    data.latest = 'extract-2';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    data.pinned = data.latest;
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(true);
    expect(await quoteSourceProofIsCurrent(db, input.groups, { ...scope, propertyCode: 'HRDAV' }, null)).toBe(true);
    expect(await quoteSourceProofIsCurrent(db, input.groups, { ...scope, propertyCode: 'UNKNOWN' }, null)).toBe(false);
    expect(await quoteSourceProofIsCurrent(db, input.groups,
      { ...scope, transportId: 'transport-davinci' }, null)).toBe(false);
  });

  it('does not reuse a price after a same-kind read changes the guest, agency or stay action', async () => {
    const { data, db } = evidence();
    const proof = await captureQuoteSourceProof(db, input, scope);
    data.latest = data.pinned = 'extract-2';
    // A truly identical read should not make staff fetch the same rates again.
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(true);

    const stay = data.payload.stays[0]!;
    stay.guests[0]!.name = 'Different Synthetic Guest';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    stay.guests[0]!.name = 'Synthetic Guest';

    data.payload.agency = 'Different Synthetic Agency';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    data.payload.agency = null;

    stay.action = 'new_booking';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    stay.action = 'quote_availability';

    data.kind = 'booking';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
  });
});
