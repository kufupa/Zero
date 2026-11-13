import { describe, expect, it } from 'vitest';
import { batchChildId, batchDigest, batchManifestSchema, batchRoomDigest, parseLabBatch, verifyBatchProfiles, type BatchManifest } from '../src/ai/hms-batch-manifest.js';

function manifest(): BatchManifest {
  const room: BatchManifest['rooms'][number] = {
    allocationId: 'group-a:1', identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 }, guest: { firstName: 'Proof', lastName: 'Labtest', profileId: '123' },
    stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] },
    roomType: 'STQN', ratePlan: 'BAR', amount: { status: 'unknown' }, bookingAgency: null, organization: null,
    guaranteeType: 'NGI', sourceOfBusiness: null, note: null, track: null, marketSegment: null,
    guestOptIn: false, booker: null, cmsSend: false, cmsMessageId: null, cmsRecipient: null,
  };
  return { version: 'hms-batch/1', propertyCode: 'HRCEN',
    source: { transportId: 'transport-centurion', threadId: 'thread', messageId: 'message', workItemId: '11111111-1111-4111-8111-111111111111' },
    rooms: [room, { ...structuredClone(room), allocationId: 'group-b:1', identity: { stayId: 's1', rowId: 'r2', roomIndex: 1 }, roomType: 'STWN' }] };
}

describe('batch manifest', () => {
  it('binds source, order and every child field to the digest and freezes the parsed copy', () => {
    const original = manifest(), parsed = parseLabBatch(original, 'lab');
    expect(Object.isFrozen(parsed.rooms)).toBe(true);
    expect(Object.isFrozen(parsed.rooms[0]!.stay.childAges)).toBe(true);
    const reordered = structuredClone(original); reordered.rooms.reverse();
    expect(batchDigest(reordered)).not.toBe(batchDigest(parsed));
    const changedIdentity = structuredClone(original); changedIdentity.rooms[1]!.identity.roomIndex = 2;
    expect(batchDigest(changedIdentity)).not.toBe(batchDigest(parsed));
    expect(batchChildId(changedIdentity, changedIdentity.rooms[1]!)).not.toBe(batchChildId(parsed, parsed.rooms[1]!));
    const changedAllocation = structuredClone(original); changedAllocation.rooms[1]!.allocationId = 'new-date-group:1';
    expect(batchDigest(changedAllocation)).not.toBe(batchDigest(parsed));
    expect(batchChildId(changedAllocation, changedAllocation.rooms[1]!)).toBe(batchChildId(parsed, parsed.rooms[1]!));
    expect(() => batchChildId(parsed, { ...parsed.rooms[1]!, identity: { stayId: 's1', rowId: 'other', roomIndex: 1 } }))
      .toThrow('batch_child_not_in_manifest');
    const changed = structuredClone(original); changed.rooms[1]!.roomType = 'DIFFERENT';
    expect(batchDigest(changed)).not.toBe(batchDigest(parsed));
    expect(batchRoomDigest(changed.rooms[1]!)).not.toBe(batchRoomDigest(parsed.rooms[1]!));
    expect(batchChildId(changed, changed.rooms[1]!)).toBe(batchChildId(parsed, parsed.rooms[1]!));
    changed.source.messageId = 'different';
    expect(batchChildId(changed, changed.rooms[1]!)).not.toBe(batchChildId(parsed, parsed.rooms[1]!));
  });

  it('refuses duplicate or invalid allocations, impossible dates and more than eight children', () => {
    const duplicate = manifest(); duplicate.rooms[1]!.allocationId = duplicate.rooms[0]!.allocationId;
    expect(batchManifestSchema.safeParse(duplicate).success).toBe(false);
    const duplicateIdentity = manifest(); duplicateIdentity.rooms[1]!.identity = { ...duplicateIdentity.rooms[0]!.identity };
    expect(batchManifestSchema.safeParse(duplicateIdentity).success).toBe(false);
    const malformedIdentity = manifest(); malformedIdentity.rooms[0]!.identity.stayId = 'd:2027-03-01';
    expect(batchManifestSchema.safeParse(malformedIdentity).success).toBe(false);
    const badDate = manifest(); badDate.rooms[0]!.stay.arrival = '2027-02-30';
    expect(batchManifestSchema.safeParse(badDate).success).toBe(false);
    const multipleArrivals = manifest(); multipleArrivals.rooms[1]!.stay.arrival = '2027-03-02';
    expect(batchManifestSchema.safeParse(multipleArrivals).success).toBe(false);
    const tooMany = manifest(); tooMany.rooms = Array.from({ length: 9 }, (_, i) => ({ ...structuredClone(tooMany.rooms[0]!),
      allocationId: `room-${i}`, identity: { stayId: 's1', rowId: 'r1', roomIndex: i + 1 } }));
    expect(batchManifestSchema.safeParse(tooMany).success).toBe(false);
    expect(batchManifestSchema.safeParse({ ...manifest(), extra: true }).success).toBe(false);
  });

  it('normalizes child and room hashes the same way as the approved manifest', () => {
    const raw = manifest();
    raw.source.messageId = ' message ';
    raw.rooms[0]!.allocationId = ' group-a:1 ';
    raw.rooms[0]!.roomType = ' STQN ';
    const parsed = parseLabBatch(raw, 'lab');
    expect(batchDigest(raw)).toBe(batchDigest(parsed));
    expect(batchChildId(raw, raw.rooms[0]!)).toBe(batchChildId(parsed, parsed.rooms[0]!));
    expect(batchRoomDigest(raw.rooms[0]!)).toBe(batchRoomDigest(parsed.rooms[0]!));
  });

  it('limits lab saves to HRCEN Proof Labtest 2027+, with CMS sending off', () => {
    expect(parseLabBatch(manifest(), 'on').propertyCode).toBe('HRCEN');
    const wrongHotel = manifest(); wrongHotel.propertyCode = 'HRDAV';
    expect(() => parseLabBatch(wrongHotel, 'lab')).toThrow('batch_property_not_hrcen');
    const realGuest = manifest(); realGuest.rooms[0]!.guest.lastName = 'Guest';
    expect(() => parseLabBatch(realGuest, 'lab')).toThrow('batch_real_guest_not_enabled');
    expect(parseLabBatch(realGuest, 'on').rooms[0]!.guest.lastName).toBe('Guest');
    const oldDate = manifest();
    for (const room of oldDate.rooms) room.stay.arrival = '2026-12-29';
    expect(() => parseLabBatch(oldDate, 'lab')).toThrow('batch_labtest_required');
    const email = structuredClone(manifest());
    email.rooms[0]!.cmsSend = true;
    expect(() => parseLabBatch(email, 'lab')).toThrow('batch_labtest_send_forbidden');
  });

  it('binds send choice, confirmation type and recipient while Labtest still refuses sending', () => {
    const base = manifest(), real = structuredClone(base);
    real.rooms[0]!.cmsSend = true;
    real.rooms[0]!.cmsMessageId = '03';
    real.rooms[0]!.cmsRecipient = { mode: 'client', address: 'guest@example.test' };
    expect(batchManifestSchema.safeParse(real).success).toBe(true);
    expect(batchDigest(real)).not.toBe(batchDigest(base));
    const sendOnly = structuredClone(base); sendOnly.rooms[0]!.cmsSend = true;
    expect(batchDigest(sendOnly)).not.toBe(batchDigest(base));
    expect(() => parseLabBatch(real, 'lab')).toThrow('batch_labtest_send_forbidden');
    const changedRecipient = structuredClone(real);
    changedRecipient.rooms[0]!.cmsRecipient!.address = 'other@example.test';
    expect(batchDigest(changedRecipient)).not.toBe(batchDigest(real));
    const changedMessage = structuredClone(real); changedMessage.rooms[0]!.cmsMessageId = '04';
    expect(batchDigest(changedMessage)).not.toBe(batchDigest(real));
    const missing = structuredClone(base) as unknown as { rooms: Array<Record<string, unknown>> };
    delete missing.rooms[0]!.cmsRecipient;
    expect(batchManifestSchema.safeParse(missing).success).toBe(false);
  });
  it('requires a fresh trusted property-bound profile match for every child', async () => {
    await expect(verifyBatchProfiles(manifest(), async (propertyCode, profileId) => ({
      propertyCode, profileId, firstName: 'Proof', lastName: 'Labtest',
    }))).resolves.toBeUndefined();
    await expect(verifyBatchProfiles(manifest(), async (_propertyCode, profileId) => ({
      propertyCode: 'HRDAV', profileId, firstName: 'Proof', lastName: 'Labtest',
    }))).rejects.toThrow('batch_profile_unverified');
    await expect(verifyBatchProfiles(manifest(), async () => null)).rejects.toThrow('batch_profile_unverified');
  });
});
