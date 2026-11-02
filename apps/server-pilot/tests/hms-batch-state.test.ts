import { describe, expect, it } from 'vitest';
import { batchChildId, batchDigest, batchRoomDigest, type BatchManifest } from '../src/ai/hms-batch-manifest.js';
import { batchStates } from '../src/ai/hms-batch-state.js';

const recordDigest = 'a'.repeat(64);
function fixture() {
  const room: BatchManifest['rooms'][number] = { allocationId: 'a', identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 }, guest: { firstName: 'Proof', lastName: 'Labtest', profileId: '123' },
    stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] }, roomType: 'STQN', ratePlan: 'BAR',
    amount: { status: 'unknown' }, agency: null, organization: null, guaranteeType: 'NGI', sourceOfBusiness: null, note: null,
    track: null, marketSegment: null, guestOptIn: false, booker: null, cmsSend: false, cmsMessageId: null, cmsRecipient: null };
  const manifest: BatchManifest = { version: 'hms-batch/1', propertyCode: 'HRCEN',
    source: { transportId: 'transport', threadId: 'thread', messageId: 'message', workItemId: '11111111-1111-4111-8111-111111111111' },
    rooms: [room, { ...structuredClone(room), allocationId: 'b', identity: { stayId: 's1', rowId: 'r2', roomIndex: 1 }, roomType: 'STWN' }] };
  const claim = { kind: 'claimed', childId: batchChildId(manifest, room), runId: 'r1', digest: batchDigest(manifest), childDigest: batchRoomDigest(room) };
  const outcome = { kind: 'outcome', childId: claim.childId, runId: claim.runId, digest: claim.digest, status: 'confirmed',
    confirmation: 'C1', recordDigest, screenshotRef: 'shot', readbackRef: 'read' };
  return { manifest, claim, outcome };
}
const rows = (...events: unknown[]) => events.map((value, index) => ({ sequence: index + 1, value }));

describe('durable batch child state', () => {
  it('preserves the originating manifest digest only for complete confirmed evidence', () => {
    const f = fixture();
    expect(batchStates(f.manifest, [])[0]!.status).toBe('unattempted');
    expect(batchStates(f.manifest, rows(f.claim))[0]!.status).toBe('uncertain');
    expect(batchStates(f.manifest, rows(f.claim, f.outcome))[0]).toMatchObject({ status: 'confirmed',
      childId: f.claim.childId, manifestDigest: f.claim.digest, confirmation: 'C1', recordDigest });
    expect(batchStates(f.manifest, rows(f.claim, { ...f.outcome, screenshotRef: undefined }))[0]!.status).toBe('uncertain');
  });
  it('does not reuse a confirmed sibling from a different ordered manifest', () => {
    const f = fixture(), changed = structuredClone(f.manifest);
    changed.rooms[1]!.ratePlan = 'OTHER';
    expect(batchChildId(changed, changed.rooms[0]!)).toBe(f.claim.childId);
    expect(batchRoomDigest(changed.rooms[0]!)).toBe(f.claim.childDigest);
    expect(batchStates(changed, rows(f.claim, f.outcome))[0]!.status).toBe('uncertain');
  });
  it('holds duplicate, orphaned or contradictory event histories', () => {
    const f = fixture();
    expect(batchStates(f.manifest, rows(f.outcome))[0]!.status).toBe('uncertain');
    expect(batchStates(f.manifest, rows(f.claim, f.claim, f.outcome))[0]!.status).toBe('uncertain');
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, f.outcome))[0]!.status).toBe('uncertain');
    expect(batchStates(f.manifest, rows(f.claim, { ...f.outcome, digest: 'b'.repeat(64) }))[0]!.status).toBe('uncertain');
    const contradictory = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'not_booked', readbackRef: 'negative-read' };
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, contradictory))[0]!.status).toBe('uncertain');
  });
  it('holds multiple claim runs until trusted event ordering is established', () => {
    const f = fixture();
    const laterClaim = { ...f.claim, runId: 'r2' };
    const negative = { kind: 'reconciled', childId: f.claim.childId, runId: 'r2', digest: f.claim.digest,
      status: 'not_booked', readbackRef: 'negative-read' };
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, laterClaim, negative))[0]!.status).toBe('uncertain');
    const firstNegative = { ...negative, runId: 'r1' };
    const secondOutcome = { ...f.outcome, runId: 'r2' };
    expect(batchStates(f.manifest, rows(f.claim, firstNegative, laterClaim, secondOutcome))[0]!.status).toBe('uncertain');
  });
  it('holds every child when two confirmations reuse the same number', () => {
    const f = fixture(), other = f.manifest.rooms[1]!;
    const otherClaim = { ...f.claim, childId: batchChildId(f.manifest, other), runId: 'r2', childDigest: batchRoomDigest(other) };
    const otherOutcome = { ...f.outcome, childId: otherClaim.childId, runId: otherClaim.runId };
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, otherClaim, otherOutcome)).map((state) => state.status))
      .toEqual(['uncertain', 'uncertain']);
  });
  it('holds a confirmed room when an uncertain sibling reports the same confirmation', () => {
    const f = fixture(), other = f.manifest.rooms[1]!;
    const otherClaim = { ...f.claim, childId: batchChildId(f.manifest, other), runId: 'r2', childDigest: batchRoomDigest(other) };
    const pending = { kind: 'outcome', childId: otherClaim.childId, runId: otherClaim.runId, digest: f.claim.digest,
      status: 'uncertain', confirmation: 'C1', screenshotRef: 'distinct-shot', readbackRef: 'distinct-read' };
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, otherClaim, pending)).map((state) => state.status))
      .toEqual(['uncertain', 'uncertain']);
  });
  it('holds shared screenshot or readback evidence across otherwise distinct confirmations', () => {
    const f = fixture(), other = f.manifest.rooms[1]!;
    const otherClaim = { ...f.claim, childId: batchChildId(f.manifest, other), runId: 'r2', childDigest: batchRoomDigest(other) };
    const otherOutcome = { ...f.outcome, childId: otherClaim.childId, runId: otherClaim.runId, confirmation: 'C2', readbackRef: 'read-2' };
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, otherClaim, otherOutcome)).map((state) => state.status))
      .toEqual(['uncertain', 'uncertain']);
    otherOutcome.screenshotRef = 'shot-2'; otherOutcome.readbackRef = f.outcome.readbackRef;
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, otherClaim, otherOutcome)).map((state) => state.status))
      .toEqual(['uncertain', 'uncertain']);
    const sameArtifact = { ...f.outcome, readbackRef: f.outcome.screenshotRef };
    expect(batchStates(f.manifest, rows(f.claim, sameArtifact))[0]!.status).toBe('uncertain');
  });
  it('holds a confirmation that contradicts a definitely unsent outcome', () => {
    const f = fixture();
    const notDispatched = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest, status: 'not_dispatched' };
    const confirmed = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'confirmed', confirmation: 'C1', recordDigest, screenshotRef: 'shot', readbackRef: 'read' };
    expect(batchStates(f.manifest, rows(f.claim, notDispatched, confirmed))[0]!.status).toBe('uncertain');
  });
  it('treats a generic failure as uncertain unless independent evidence reconciles it', () => {
    const f = fixture();
    const failed = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest, status: 'failed' };
    expect(batchStates(f.manifest, rows(f.claim, failed))[0]!.status).toBe('uncertain');
    const notDispatched = { ...failed, status: 'not_dispatched' };
    expect(batchStates(f.manifest, rows(f.claim, notDispatched))[0]!.status).toBe('not_dispatched');
    const negative = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'not_booked', readbackRef: 'negative-read' };
    expect(batchStates(f.manifest, rows(f.claim, failed, negative))[0]!.status).toBe('reconciled_not_booked');
  });
  it('holds unknown children and mismatched manifest claims even for negative outcomes', () => {
    const f = fixture();
    const foreign = { ...f.claim, childId: 'f'.repeat(64) };
    expect(batchStates(f.manifest, rows(foreign)).map((state) => state.status)).toEqual(['uncertain', 'uncertain']);
    const changed = structuredClone(f.manifest); changed.rooms[1]!.ratePlan = 'OTHER';
    const notDispatched = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId,
      digest: f.claim.digest, status: 'not_dispatched' };
    expect(batchStates(changed, rows(f.claim, notDispatched))[0]!.status).toBe('uncertain');
  });
  it('requires ordered durable event sequences and claim-before-evidence ordering', () => {
    const f = fixture();
    expect(batchStates(f.manifest, rows(f.outcome, f.claim))[0]!.status).toBe('uncertain');
    const negative = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'not_booked', readbackRef: 'negative-read' };
    const failed = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest, status: 'failed' };
    expect(batchStates(f.manifest, rows(f.claim, negative, failed))[0]!.status).toBe('uncertain');
    expect(() => batchStates(f.manifest, [{ sequence: 2, value: f.claim }, { sequence: 1, value: f.outcome }])).toThrow('batch_event_order_unverified');
    expect(() => batchStates(f.manifest, [{ sequence: 1, value: f.claim }, { sequence: 1, value: f.outcome }])).toThrow('batch_event_order_unverified');
  });
  it('holds conflicting negative or not-dispatched evidence', () => {
    const f = fixture();
    const notDispatched = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'not_dispatched', confirmation: 'C1' };
    expect(batchStates(f.manifest, rows(f.claim, notDispatched))[0]!.status).toBe('uncertain');
    const negative = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'not_booked', readbackRef: 'negative-read', confirmation: 'C1' };
    expect(batchStates(f.manifest, rows(f.claim, negative))[0]!.status).toBe('uncertain');
  });
  it('does not reuse a confirmed sibling readback for a negative reconciliation', () => {
    const f = fixture(), other = f.manifest.rooms[1]!;
    const otherClaim = { ...f.claim, childId: batchChildId(f.manifest, other), runId: 'r2', childDigest: batchRoomDigest(other) };
    const negative = { kind: 'reconciled', childId: otherClaim.childId, runId: otherClaim.runId,
      digest: f.claim.digest, status: 'not_booked', readbackRef: f.outcome.readbackRef };
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, otherClaim, negative)).map((state) => state.status))
      .toEqual(['uncertain', 'uncertain']);
  });
  it('holds reconciliation that contradicts evidence from an uncertain outcome', () => {
    const f = fixture();
    const pending = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'uncertain', confirmation: 'C1', recordDigest };
    const negative = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'not_booked', readbackRef: 'negative-read' };
    expect(batchStates(f.manifest, rows(f.claim, pending, negative))[0]!.status).toBe('uncertain');
    const confirmed = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'confirmed', confirmation: 'C2', recordDigest, screenshotRef: 'shot', readbackRef: 'read' };
    expect(batchStates(f.manifest, rows(f.claim, pending, confirmed))[0]!.status).toBe('uncertain');
    expect(batchStates(f.manifest, rows(f.claim, pending, { ...confirmed, confirmation: 'C1' }))[0]!.status).toBe('confirmed');
  });
  it('holds evidence reused from an earlier uncertain outcome after reconciliation', () => {
    const f = fixture(), other = f.manifest.rooms[1]!;
    const pending = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'uncertain', screenshotRef: 'shared-shot' };
    const reconciled = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'confirmed', confirmation: 'C1', recordDigest, screenshotRef: 'shot-1', readbackRef: 'read-1' };
    const otherClaim = { ...f.claim, childId: batchChildId(f.manifest, other), runId: 'r2', childDigest: batchRoomDigest(other) };
    const otherOutcome = { ...f.outcome, childId: otherClaim.childId, runId: otherClaim.runId,
      confirmation: 'C2', screenshotRef: 'shared-shot', readbackRef: 'read-2' };
    expect(batchStates(f.manifest, rows(f.claim, pending, reconciled, otherClaim, otherOutcome)).map((state) => state.status))
      .toEqual(['uncertain', 'uncertain']);
  });
  it('accepts distinct children under the same parent workflow run', () => {
    const f = fixture(), other = f.manifest.rooms[1]!;
    const otherClaim = { ...f.claim, childId: batchChildId(f.manifest, other), childDigest: batchRoomDigest(other) };
    const otherOutcome = { ...f.outcome, childId: otherClaim.childId, confirmation: 'C2',
      screenshotRef: 'shot-2', readbackRef: 'read-2' };
    expect(batchStates(f.manifest, rows(f.claim, f.outcome, otherClaim, otherOutcome)).map((state) => state.status))
      .toEqual(['confirmed', 'confirmed']);
  });
  it('requires reconciliation readback to be distinct from earlier evidence on the same child', () => {
    const f = fixture();
    const pending = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'uncertain', screenshotRef: 'old-shot', readbackRef: 'old-read' };
    const negative = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'not_booked', readbackRef: 'new-read' };
    expect(batchStates(f.manifest, rows(f.claim, pending, negative))[0]!.status).toBe('reconciled_not_booked');
    for (const readbackRef of ['old-shot', 'old-read']) {
      expect(batchStates(f.manifest, rows(f.claim, pending, { ...negative, readbackRef }))[0]!.status).toBe('uncertain');
    }
    const confirmed = { ...negative, status: 'confirmed', confirmation: 'C1', recordDigest,
      screenshotRef: 'old-shot' };
    expect(batchStates(f.manifest, rows(f.claim, pending, confirmed))[0]!.status).toBe('confirmed');
    expect(batchStates(f.manifest, rows(f.claim, pending, { ...confirmed, screenshotRef: 'old-read' }))[0]!.status).toBe('uncertain');
    expect(batchStates(f.manifest, rows(f.claim, pending, { ...confirmed, readbackRef: 'old-read' }))[0]!.status).toBe('uncertain');
  });
  it('allows independently reconciled negative evidence without claiming a booking', () => {
    const f = fixture();
    const uncertain = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest, status: 'uncertain' };
    const negative = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId, digest: f.claim.digest,
      status: 'not_booked', readbackRef: 'negative-read' };
    expect(batchStates(f.manifest, rows(f.claim, uncertain, negative))[0]!.status).toBe('reconciled_not_booked');
  });
});
