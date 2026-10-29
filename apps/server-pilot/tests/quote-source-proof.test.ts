import { describe, expect, it, vi } from 'vitest';
import { captureQuoteSourceProof, quoteSourceProofIsCurrent, quoteSourceProofMatchesCopy,
  quoteSourceProofMatchesInput, quoteSourceProofMatchesSingleStay, quoteSourceProofPredatesPolicy } from '../src/ai/child-occupancy.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import type { DB } from '../src/db/client.js';
import { quoteSourcePartyDigest } from '../src/ai/quote-source-party.js';
import { quoteDigest } from '../src/quote-proposal/quote-revision.js';

// This file isolates saved-source comparisons. Real source capture and races use disposable Postgres tests.
vi.mock('../src/ai/workflow-classifier/source-fence.js', async (original) => ({
  ...await original<typeof import('../src/ai/workflow-classifier/source-fence.js')>(),
  captureCurrentWitnessedRead: async (db: { fixtureWitness?: (id: string) => unknown }, _scope: unknown, id: string) =>
    db.fixtureWitness?.(id) ?? null,
  withQuoteSourceSnapshot: async (db: DB, read: (tx: DB) => Promise<unknown>) => read(db),
}));

const scope = { transportId: 'transport-centurion', threadId: 't1', messageId: 'm1', propertyCode: 'HRCEN' };
const input = staffQuoteInput.parse({ messageId: 'm1', sourceHash: 'a'.repeat(64), selectionEpoch: 1, inputRevision: 1,
  sourcePartyDigest: quoteSourcePartyDigest({ agency: null, endClient: null }, {}), sourceExtractionId: 'extract-1',
  groups: [{ id: 'r1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1,
    adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'dinner_bb', roomCodes: ['SKNG'],
    sourcePreference: { roomType: 'Standard King', board: 'dbb' } }], salesStrategy: 'BAR' });
function evidence(stayId = 's1', rowId = 'r1') {
  const data = { payload: { contact: { name: null, email: null, phone: null }, agency: null as string | null, endClient: null as string | null,
    confirmationNumbers: [], missing: [], stays: [{ id: stayId, hotel: null,
      requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
      guests: [{ name: 'Synthetic Guest', confirmationNumber: null as string | null }],
      action: 'quote_availability' as 'quote_availability' | 'new_booking',
      rows: [{ id: rowId, roomType: 'Standard King' as string | null, rooms: 1, adultsPerRoom: 2,
        childrenPerRoom: 0, childAges: [] as number[], board: 'dbb' as string | null }] }] },
    state: {} as Record<string, unknown>, pinned: 'extract-1', latest: 'extract-1', kind: 'quote',
    conflicts: [] as Array<{ workItemId: string; kind: string; status: string }> };
  const fixture = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(fixture),
    fixtureWitness: (id: string) => id === data.latest ? {
      read: { id, usage: {} }, source: { digest: 'f'.repeat(64) },
      extractionDigest: quoteDigest({ id: data.latest, kind: data.kind, payload: data.payload }),
    } : null,
    select(selection?: Record<string, unknown>) {
    let table: unknown;
    const conflict = selection && 'workItemId' in selection && 'kind' in selection && 'status' in selection;
    const read = () => conflict ? data.conflicts : table === mailExtraction ? [{ id: data.latest, kind: data.kind, payload: data.payload }] :
      table === workItem ? [{ extractionId: data.pinned, state: data.state }] : [];
    const query = Object.assign(Promise.resolve().then(read), {
      from(value: unknown) { table = value; return query; }, where() { return query; }, orderBy() { return query; },
      limit() { return query; }, for() { return query; },
    });
    return query;
    },
  };
  const db = fixture as unknown as DB;
  return { data, db };
}

describe('source preferences bound to a Centurion price', () => {
  it('holds new and cached quotes when another workflow has prior staff work', async () => {
    const { db, data } = evidence();
    const proof = await captureQuoteSourceProof(db, input, scope);
    expect(proof).not.toBeNull();
    data.conflicts.push({ workItemId: 'old-item', kind: 'booking', status: 'needs_you' });
    expect(await captureQuoteSourceProof(db, input, scope)).toBeNull();
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    expect(await quoteSourceProofMatchesCopy(db, input.groups, scope, proof)).toBe(false);
    expect(await captureQuoteSourceProof(db, input, { ...scope, propertyCode: 'HRDAV' })).not.toBeNull();
  });

  it('rejects pre-policy proofs on every Centurion reuse path but preserves HRDAV', async () => {
    const { db } = evidence();
    const current = await captureQuoteSourceProof(db, input, scope);
    expect(current?.version).toBe(5);
    const revision = { groups: [{ arrivalDate: '2027-10-20', departureDate: '2027-10-21',
      quantity: 1, adults: 2, children: 0, childAges: [] }] };
    for (const version of [1, 2, 3, 4]) {
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

  it.each([
    ['contact.company', 'Synthetic Agency', 'Another Agency'],
    ['contact.endClient', 'Synthetic Company', 'Another Company'],
  ])('invalidates a Centurion price after the saved %s changes or is cleared', async (path, original, changed) => {
    const { data, db } = evidence();
    data.payload.agency = 'Synthetic Agency';
    data.payload.endClient = 'Synthetic Company';
    const submitted = staffQuoteInput.parse({ ...input, agency: data.payload.agency, company: data.payload.endClient,
      sourcePartyDigest: quoteSourcePartyDigest(data.payload, data.state),
      parties: { agency: { kind: 'agency', nativeId: 'AGENCY1', name: data.payload.agency },
        company: { kind: 'company', nativeId: 'COMPANY1', name: data.payload.endClient } } });
    const proof = await captureQuoteSourceProof(db, submitted, scope);
    expect(proof).not.toBeNull();
    for (const unrelated of ['contact.name', 'contact.email', 'contact.phone']) data.state[unrelated] = 'changed';
    expect(await quoteSourceProofIsCurrent(db, submitted.groups, scope, proof)).toBe(true);
    data.state[path] = original;
    expect(await quoteSourceProofIsCurrent(db, submitted.groups, scope, proof)).toBe(true);
    data.state[path] = changed;
    expect(await quoteSourceProofIsCurrent(db, submitted.groups, scope, proof)).toBe(false);
    expect(await quoteSourceProofIsCurrent(db, submitted.groups, { ...scope, propertyCode: 'HRDAV' }, proof)).toBe(true);
    data.state[path] = null;
    expect(await quoteSourceProofIsCurrent(db, submitted.groups, scope, proof)).toBe(false);
    delete data.state[path];
    expect(await quoteSourceProofIsCurrent(db, submitted.groups, scope, proof)).toBe(true);
  });

  it('does not reuse a copied price for a different saved agency or end client', async () => {
    const original = evidence();
    original.data.payload.agency = 'Synthetic Agency';
    original.data.payload.endClient = 'Synthetic Company';
    const proof = await captureQuoteSourceProof(original.db,
      { ...input, sourcePartyDigest: quoteSourcePartyDigest(original.data.payload, original.data.state)! }, scope);
    const copy = evidence('s2', 'r2');
    copy.data.payload.agency = 'Synthetic Agency';
    copy.data.payload.endClient = 'Synthetic Company';
    const copyScope = { ...scope, threadId: 't2', messageId: 'm2' };
    const copiedGroup = { ...input.groups[0]!, id: 'r2' };
    const revision = { groups: [{ arrivalDate: copiedGroup.arrivalDate, departureDate: copiedGroup.departureDate,
      quantity: 1, adults: 2, children: 0, childAges: [] }] };
    expect(await quoteSourceProofMatchesCopy(copy.db, [copiedGroup], copyScope, proof)).toBe(false);
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
    for (const path of ['contact.company', 'contact.endClient']) {
      copy.data.state[path] = 'Different Party';
      expect(await quoteSourceProofMatchesCopy(copy.db, [copiedGroup], copyScope, proof)).toBe(false);
      expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
      expect(await quoteSourceProofMatchesCopy(copy.db, [copiedGroup], { ...copyScope, propertyCode: 'HRDAV' }, proof)).toBe(true);
      delete copy.data.state[path];
    }
    copy.data.payload.agency = 'Different Agency';
    expect(await quoteSourceProofMatchesCopy(copy.db, [copiedGroup], copyScope, proof)).toBe(false);
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
  });

  it('requires the pane-seen party and extraction at Centurion admission', async () => {
    const { data, db } = evidence();
    const captured = await captureQuoteSourceProof(db, input, scope);
    expect(captured).not.toBeNull();
    expect(await captureQuoteSourceProof(db, { ...input, sourcePartyDigest: undefined }, scope)).toBeNull();
    expect(await captureQuoteSourceProof(db, { ...input, sourceExtractionId: undefined }, scope)).toBeNull();
    expect(await captureQuoteSourceProof(db, { ...input, sourcePartyDigest: undefined, sourceExtractionId: undefined },
      { ...scope, propertyCode: 'HRDAV' })).not.toBeNull();

    data.state['contact.company'] = 'New Source Agency';
    expect(await captureQuoteSourceProof(db, input, scope)).toBeNull();
    // A deliberately different HMS choice remains valid once the pane has seen the saved source.
    const seen = staffQuoteInput.parse({ ...input, sourcePartyDigest: quoteSourcePartyDigest(data.payload, data.state),
      agency: 'Picked Agency', parties: { agency: { kind: 'agency', nativeId: 'A1', name: 'Picked Agency' } } });
    expect(await captureQuoteSourceProof(db, seen, scope)).not.toBeNull();
    data.state['contact.company'] = null;
    expect(await captureQuoteSourceProof(db, seen, scope)).toBeNull();
    const cleared = { ...input, sourcePartyDigest: quoteSourcePartyDigest(data.payload, data.state)! };
    expect(cleared.sourcePartyDigest).not.toBe(input.sourcePartyDigest); // explicit clear is not an absent field
    expect(await captureQuoteSourceProof(db, cleared, scope)).not.toBeNull();
    delete data.state['contact.company'];
    expect(await captureQuoteSourceProof(db, cleared, scope)).toBeNull();

    data.latest = data.pinned = 'extract-2';
    expect(await captureQuoteSourceProof(db, input, scope)).toBeNull();
    expect(await captureQuoteSourceProof(db, { ...input, sourceExtractionId: 'extract-2' }, scope)).not.toBeNull();
    // A later read must obtain its own source-bound quote, even for identical fields.
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, captured)).toBe(false);
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

  it('holds a copied message even when its row and preferences match', async () => {
    const original = evidence();
    const proof = await captureQuoteSourceProof(original.db, input, scope);
    const copy = evidence('s2', 'r2');
    const copyScope = { ...scope, threadId: 't2', messageId: 'm2' };
    const copiedGroup = { ...input.groups[0]!, id: 'r2' };
    const revision = { groups: [{ arrivalDate: copiedGroup.arrivalDate, departureDate: copiedGroup.departureDate,
      quantity: 1, adults: 2, children: 0, childAges: [] }] };
    expect(await quoteSourceProofMatchesCopy(copy.db, [copiedGroup], copyScope, proof)).toBe(false);
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
    copy.data.state['stays[s2].rows[r2].roomType'] = 'Standard Twin';
    expect(await quoteSourceProofMatchesCopy(copy.db, [copiedGroup], copyScope, proof)).toBe(false);
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
  });

  it('holds a copied message even when a replacement room matches', async () => {
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
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
    copy.data.state[`${row}.roomType`] = 'Standard Twin';
    expect(await quoteSourceProofMatchesSingleStay(copy.db, revision, copyScope, proof)).toBe(false);
  });

  it('holds pinned old extractions and keeps HRDAV quote behavior on a Centurion mailbox', async () => {
    const { data, db } = evidence();
    const proof = await captureQuoteSourceProof(db, input, scope);
    data.latest = 'extract-2';
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    data.pinned = data.latest;
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    expect(await quoteSourceProofIsCurrent(db, input.groups, { ...scope, propertyCode: 'HRDAV' }, null)).toBe(true);
    expect(await quoteSourceProofIsCurrent(db, input.groups, { ...scope, propertyCode: 'UNKNOWN' }, null)).toBe(false);
    expect(await quoteSourceProofIsCurrent(db, input.groups,
      { ...scope, transportId: 'transport-davinci' }, null)).toBe(false);
  });

  it('does not reuse a price after a same-kind read changes the guest, agency or stay action', async () => {
    const { data, db } = evidence();
    const proof = await captureQuoteSourceProof(db, input, scope);
    data.latest = data.pinned = 'extract-2';
    // Even an identical later read needs its own source-bound quote.
    expect(await quoteSourceProofIsCurrent(db, input.groups, scope, proof)).toBe(false);
    data.latest = data.pinned = 'extract-1';

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
