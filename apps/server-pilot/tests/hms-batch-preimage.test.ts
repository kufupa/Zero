import { describe, expect, it } from 'vitest';
import { batchChildId, batchDigest, type BatchManifest } from '../src/ai/hms-batch-manifest.js';
import { checkBatchPreimage, type BatchPreimage, type ConfirmedBatchSibling } from '../src/ai/hms-batch-preimage.js';

const now = new Date('2027-01-01T10:00:00Z');
const digest = 'a'.repeat(64);
function fixture() {
  const room: BatchManifest['rooms'][number] = { allocationId: 'a', identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 }, guest: { firstName: 'Proof', lastName: 'Labtest', profileId: '123' },
    stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] }, roomType: 'STQN', ratePlan: 'BAR',
    amount: { status: 'unknown' }, agency: null, organization: null, guaranteeType: 'NGI', sourceOfBusiness: null, note: null,
    track: null, marketSegment: null, guestOptIn: false, booker: null, cmsSend: false, cmsMessageId: null, cmsRecipient: null };
  const manifest: BatchManifest = { version: 'hms-batch/1', propertyCode: 'HRCEN',
    source: { transportId: 'transport', threadId: 'thread', messageId: 'message', workItemId: '11111111-1111-4111-8111-111111111111' },
    rooms: [room, { ...structuredClone(room), allocationId: 'b', identity: { stayId: 's1', rowId: 'r2', roomIndex: 1 }, roomType: 'STWN' }] };
  const sibling: ConfirmedBatchSibling = { manifestDigest: batchDigest(manifest), childId: batchChildId(manifest, room), status: 'confirmed', confirmation: 'C1', recordDigest: digest };
  const preimage: BatchPreimage = { proofId: 'proof', arrival: '2027-03-01', departure: '2027-03-03', observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(), complete: true, matches: [{ confirmation: 'C1', recordDigest: digest }] };
  return { manifest, sibling, preimage, room: manifest.rooms[1]! };
}

describe('batch census validation', () => {
  it('accepts only a matching confirmed sibling, including a different sibling departure', () => {
    const f = fixture();
    expect(checkBatchPreimage(f.preimage, f.room, [f.sibling], f.manifest, 1, now)).toBe(true);
    f.manifest.rooms[0]!.stay.departure = '2027-03-04';
    // Even an unchanged child identity cannot authorize a different manifest.
    expect(checkBatchPreimage(f.preimage, f.room, [f.sibling], f.manifest, 1, now)).toBe(false);
    f.sibling.manifestDigest = batchDigest(f.manifest);
    expect(checkBatchPreimage(f.preimage, f.room, [f.sibling], f.manifest, 1, now)).toBe(true);
  });
  it('rejects unrelated, altered, duplicate or missing records and siblings', () => {
    const f = fixture();
    expect(checkBatchPreimage({ ...f.preimage, matches: [] }, f.room, [f.sibling], f.manifest, 1, now)).toBe(false);
    expect(checkBatchPreimage({ ...f.preimage, matches: [...f.preimage.matches, { confirmation: 'OTHER', recordDigest: digest }] }, f.room, [f.sibling], f.manifest, 1, now)).toBe(false);
    expect(checkBatchPreimage({ ...f.preimage, matches: [{ confirmation: 'C1', recordDigest: 'b'.repeat(64) }] }, f.room, [f.sibling], f.manifest, 1, now)).toBe(false);
    expect(checkBatchPreimage({ ...f.preimage, matches: [...f.preimage.matches, ...f.preimage.matches] }, f.room, [f.sibling], f.manifest, 1, now)).toBe(false);
    expect(checkBatchPreimage(f.preimage, f.room, [{ ...f.sibling, childId: 'wrong' }], f.manifest, 1, now)).toBe(false);
    expect(checkBatchPreimage(f.preimage, f.room, [{ ...f.sibling, status: 'uncertain' }], f.manifest, 1, now)).toBe(false);
    expect(checkBatchPreimage(f.preimage, { ...f.room, roomType: 'OTHER' }, [f.sibling], f.manifest, 1, now)).toBe(false);
  });
  it('rejects sibling provenance from another manifest, missing provenance and duplicate child identity', () => {
    const f = fixture();
    const changed = structuredClone(f.manifest);
    changed.rooms[1]!.ratePlan = 'OTHER';
    expect(batchChildId(changed, changed.rooms[0]!)).toBe(f.sibling.childId);
    expect(checkBatchPreimage(f.preimage, changed.rooms[1]!, [f.sibling], changed, 1, now)).toBe(false);
    expect(checkBatchPreimage(f.preimage, f.room, [{ ...f.sibling, manifestDigest: '' }], f.manifest, 1, now)).toBe(false);
    const { manifestDigest: _missing, ...unbound } = f.sibling;
    expect(checkBatchPreimage(f.preimage, f.room, [unbound as ConfirmedBatchSibling], f.manifest, 1, now)).toBe(false);
    const duplicate = structuredClone(f.manifest);
    duplicate.rooms[1]!.allocationId = duplicate.rooms[0]!.allocationId;
    expect(checkBatchPreimage(f.preimage, duplicate.rooms[1]!, [f.sibling], duplicate, 1, now)).toBe(false);
  });
  it('uses the same canonical identity for parsed and unparsed manifests', () => {
    const f = fixture();
    f.manifest.source.messageId = ' message ';
    f.manifest.rooms[1]!.roomType = ' STWN ';
    f.sibling.manifestDigest = batchDigest(f.manifest);
    f.sibling.childId = batchChildId(f.manifest, f.manifest.rooms[0]!);
    expect(checkBatchPreimage(f.preimage, f.manifest.rooms[1]!, [f.sibling], f.manifest, 1, now)).toBe(true);
  });
  it('rejects incomplete, stale, future-dated and overlong proofs', () => {
    const f = fixture(), check = (proof: BatchPreimage, clock = now) => checkBatchPreimage(proof, f.room, [f.sibling], f.manifest, 1, clock);
    expect(check({ ...f.preimage, complete: false })).toBe(false);
    expect(check(f.preimage, new Date(now.getTime() + 300_000))).toBe(false);
    expect(check({ ...f.preimage, observedAt: new Date(now.getTime() + 1).toISOString() })).toBe(false);
    expect(check({ ...f.preimage, expiresAt: new Date(now.getTime() + 300_001).toISOString() })).toBe(false);
    expect(check({ ...f.preimage, proofId: '' })).toBe(false);
  });
});
