import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './draft-approval.js';
import { hrcenToday } from '../../tooling/hms-cloud/cloud-create-policy.mjs';

const text = z.string().trim().min(1).max(200);
const stableId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const sourceIdentity = z.object({ stayId: stableId, rowId: stableId, roomIndex: z.number().int().min(1).max(999) }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const party = z.object({ nativeId: text, name: text }).strict();
const amount = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('unavailable'), minor: z.number().int().nonnegative().safe().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(), basis: z.enum(['room_night', 'room_stay', 'unknown']),
    tax: z.enum(['included', 'excluded', 'unknown']) }).strict(),
  z.object({ status: z.enum(['estimate', 'confirmed']), minor: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/), basis: z.enum(['room_night', 'room_stay']),
    tax: z.enum(['included', 'excluded', 'unknown']) }).strict(),
]);

const batchRoomSchema = z.object({
  // The allocation is display correlation; stable identity binds the underlying source room.
  allocationId: text, identity: sourceIdentity,
  guest: z.object({ firstName: text, lastName: text, profileId: z.string().regex(/^\d+$/) }).strict(),
  stay: z.object({ arrival: date, departure: date, adults: z.number().int().min(1).max(16),
    childAges: z.array(z.number().int().min(0).max(17)).max(16) }).strict(),
  roomType: text, ratePlan: text, amount,
  bookingAgency: party.nullable(), organization: party.nullable(),
  guaranteeType: text, sourceOfBusiness: text.nullable(), note: z.string().max(200).nullable(),
  track: text.nullable(), marketSegment: text.nullable(), guestOptIn: z.boolean(),
  booker: z.object({ name: text.nullable(), email: text.nullable() }).strict().nullable(),
  cmsSend: z.boolean(), cmsMessageId: text.nullable(),
  cmsRecipient: z.object({ mode: z.enum(['self', 'client', 'custom']), address: text }).strict().nullable(),
}).strict();

// Every field here is covered by the approval. Never attach execution events to this object.
export const batchManifestSchema = z.object({
  version: z.literal('hms-batch/1'),
  propertyCode: text,
  source: z.object({ transportId: text, threadId: text, messageId: text, workItemId: z.string().uuid() }).strict(),
  rooms: z.array(batchRoomSchema).min(2).max(8),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  const identities = new Set<string>();
  manifest.rooms.forEach((room, index) => {
    if (seen.has(room.allocationId)) ctx.addIssue({ code: 'custom', path: ['rooms', index, 'allocationId'], message: 'duplicate allocation' });
    seen.add(room.allocationId);
    const identity = JSON.stringify([room.identity.stayId, room.identity.rowId, room.identity.roomIndex]);
    if (identities.has(identity)) ctx.addIssue({ code: 'custom', path: ['rooms', index, 'identity'], message: 'duplicate source room' });
    identities.add(identity);
    if (room.stay.arrival >= room.stay.departure) ctx.addIssue({ code: 'custom', path: ['rooms', index, 'stay'], message: 'invalid date range' });
    if (room.stay.arrival !== manifest.rooms[0]?.stay.arrival) ctx.addIssue({ code: 'custom', path: ['rooms', index, 'stay', 'arrival'], message: 'multiple arrivals unsupported' });
  });
});
export type BatchManifest = z.infer<typeof batchManifestSchema>;
export type BatchRoom = BatchManifest['rooms'][number];

export function batchDigest(manifest: BatchManifest): string {
  return createHash('sha256').update(canonicalJson(batchManifestSchema.parse(manifest))).digest('hex');
}

/** Identity survives allocation-label changes, but cannot be reused for another source message. */
export function batchChildId(manifest: BatchManifest, room: BatchRoom): string {
  const parsed = batchManifestSchema.parse(manifest);
  const identity = sourceIdentity.parse(room.identity);
  if (!parsed.rooms.some((item) => item.identity.stayId === identity.stayId && item.identity.rowId === identity.rowId &&
      item.identity.roomIndex === identity.roomIndex)) throw new Error('batch_child_not_in_manifest');
  return createHash('sha256').update(canonicalJson({ version: 'hms-batch-child/2', source: parsed.source, identity })).digest('hex');
}

/** A confirmed child is reusable only when all its approved fields still match. */
export function batchRoomDigest(room: BatchRoom): string {
  return createHash('sha256').update(canonicalJson(batchRoomSchema.parse(room))).digest('hex');
}

export function parseLabBatch(input: unknown, capability: 'off' | 'lab' | 'on'): BatchManifest {
  if (capability === 'off') throw new Error('batch_capability_off');
  const manifest = batchManifestSchema.parse(input);
  if (manifest.propertyCode !== 'HRCEN') throw new Error('batch_property_not_hrcen');
  for (const room of manifest.rooms) {
    const labtest = room.guest.firstName === 'Proof' && room.guest.lastName === 'Labtest';
    if (labtest && room.cmsSend) throw new Error('batch_labtest_send_forbidden');
    if (labtest && room.stay.arrival < '2027-01-01') throw new Error('batch_labtest_required');
    if (!labtest && (capability !== 'on' || room.stay.arrival < hrcenToday())) {
      throw new Error('batch_real_guest_not_enabled');
    }
  }
  const freeze = (value: object): void => {
    Object.freeze(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  };
  freeze(manifest);
  return manifest;
}

export type BatchProfileLookup = (propertyCode: string, profileId: string) => Promise<{
  propertyCode: string; profileId: string; firstName: string; lastName: string;
} | null>;

export async function verifyBatchRoomProfile(manifest: BatchManifest, room: BatchRoom, lookup: BatchProfileLookup): Promise<void> {
  const profile = await lookup(manifest.propertyCode, room.guest.profileId);
  if (!profile || profile.propertyCode !== manifest.propertyCode || profile.profileId !== room.guest.profileId ||
      profile.firstName !== room.guest.firstName || profile.lastName !== room.guest.lastName) throw new Error('batch_profile_unverified');
}

/** Before claim, resolve every profile through trusted property-bound HMS reads. */
export async function verifyBatchProfiles(manifest: BatchManifest, lookup: BatchProfileLookup): Promise<void> {
  for (const room of manifest.rooms) await verifyBatchRoomProfile(manifest, room, lookup);
}
