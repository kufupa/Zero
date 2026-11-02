import { batchChildId, batchDigest, batchManifestSchema, batchRoomDigest, type BatchManifest, type BatchRoom } from './hms-batch-manifest.js';

/** A page-bound, single-use proof issued by a trusted native Cloud adapter, not client JSON. */
export type BatchPreimage = {
  proofId: string;
  arrival: string;
  departure: string;
  observedAt: string;
  expiresAt: string;
  complete: boolean;
  matches: Array<{ confirmation: string; recordDigest: string }>;
};
export type ConfirmedBatchSibling = {
  // Must come from the durable trusted claim, never from browser or caller-supplied JSON.
  manifestDigest: string;
  childId: string;
  status: string;
  confirmation?: string;
  recordDigest?: string;
};

/** Match a complete census against independently read-back earlier children of this exact manifest. */
export function checkBatchPreimage(
  preimage: BatchPreimage, room: BatchRoom, siblings: ConfirmedBatchSibling[],
  manifest: BatchManifest, index: number, now: Date,
): boolean {
  // Reject malformed or duplicate allocations even if a caller bypassed parseLabBatch.
  if (!batchManifestSchema.safeParse(manifest).success) return false;
  const manifestDigest = batchDigest(manifest);
  const childIds = manifest.rooms.map((item) => batchChildId(manifest, item));
  if (new Set(childIds).size !== childIds.length) return false;
  const current = manifest.rooms[index];
  const at = Date.parse(preimage.observedAt), expires = Date.parse(preimage.expiresAt), time = now.getTime();
  if (!Number.isInteger(index) || index < 0 || !current || batchRoomDigest(current) !== batchRoomDigest(room) ||
      !preimage.proofId || !preimage.complete || preimage.arrival !== room.stay.arrival || preimage.departure !== room.stay.departure ||
      !Number.isFinite(at) || !Number.isFinite(expires) || !Number.isFinite(time) || at > time || expires <= time || expires - at > 300_000 ||
      siblings.length !== index) return false;
  if (siblings.some((sibling, i) => {
    const prior = manifest.rooms[i];
    return !prior || sibling.manifestDigest !== manifestDigest || sibling.childId !== childIds[i] || sibling.status !== 'confirmed' ||
      !sibling.confirmation || !/^[a-f0-9]{64}$/.test(sibling.recordDigest ?? '');
  }) || new Set(siblings.map((sibling) => sibling.confirmation)).size !== siblings.length) return false;
  // The native census matches on arrival even when a sibling has another departure.
  const expected = siblings.flatMap((sibling, i) => manifest.rooms[i]?.stay.arrival === room.stay.arrival
    ? [{ confirmation: sibling.confirmation!, recordDigest: sibling.recordDigest! }] : []);
  if (new Set(preimage.matches.map((row) => row.confirmation)).size !== preimage.matches.length ||
      preimage.matches.length !== expected.length) return false;
  return preimage.matches.every((row) => expected.some((item) => item.confirmation === row.confirmation && item.recordDigest === row.recordDigest));
}
