import { batchChildId, batchDigest, batchRoomDigest, type BatchManifest } from './hms-batch-manifest.js';
import { batchEventSchema, batchStates, type BatchEvent, type BatchEventRow } from './hms-batch-state.js';

/** Validates an ordered transition only. This is not authentication or write authority. */
export function validateBatchTransition(manifest: BatchManifest, history: BatchEventRow[], candidate: BatchEvent): void {
  const item = batchEventSchema.parse(candidate);
  const index = manifest.rooms.findIndex((room) => batchChildId(manifest, room) === item.childId);
  if (index < 0 || item.digest !== batchDigest(manifest) ||
      (item.kind === 'claimed' && item.childDigest !== batchRoomDigest(manifest.rooms[index]!))) {
    throw new Error('batch_transition_scope');
  }
  const states = batchStates(manifest, history);
  const events = history.map((row) => batchEventSchema.parse(row.value)).filter((event) => event.childId === item.childId);
  const claim = events.find((event) => event.kind === 'claimed');
  if (item.kind === 'claimed') {
    if (events.length || states[index]?.status !== 'unattempted' ||
        states.slice(0, index).some((state) => state.status !== 'confirmed') ||
        states.slice(index + 1).some((state) => state.status !== 'unattempted')) throw new Error('batch_transition_invalid');
  } else if (!claim || claim.runId !== item.runId || claim.digest !== item.digest ||
      events.some((event) => event.kind === item.kind) ||
      (item.kind === 'outcome' && events.some((event) => event.kind === 'reconciled'))) {
    throw new Error('batch_transition_invalid');
  }
  const projected = batchStates(manifest, [...history, { sequence: history.length + 1, value: item }])[index];
  const expected = item.kind === 'claimed' || (item.kind === 'outcome' && ['uncertain', 'failed'].includes(item.status))
    ? 'uncertain' : item.kind === 'reconciled' && item.status === 'not_booked' ? 'reconciled_not_booked' : item.status;
  if (!projected || projected.status !== expected) throw new Error('batch_transition_invalid');
}
