import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { profileFor } from '../../tooling/playwright-quote/property-profile.mjs';
import { canonicalJson } from './draft-approval.js';
import { batchManifestSchema } from './hms-batch-manifest.js';
import { paneCreateIdentitySchema, type PaneCreateIdentity } from './pane-create-scope.js';

// Server-owned state key, never a client-provided proof.
export const BATCH_CHOICES_KEY = 'batchRoomChoices';

const text = z.string().min(1).max(200).refine((value) => value === value.trim() &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const sourceSchema = z.object({ transportId: text, threadId: text, messageId: text, workItemId: z.string().uuid() }).strict();
const cursorSchema = z.object({ extractionId: z.string().uuid(), revision: z.number().int().nonnegative().safe(),
  revisionHead: z.number().int().nonnegative().safe(), seq: z.number().int().nonnegative().safe() }).strict()
  .refine((cursor) => cursor.revision <= cursor.revisionHead);
const roomCode = z.string().regex(/^[A-Z0-9_-]{1,40}$/);
const sourceDigest = z.string().regex(/^[a-f0-9]{64}$/);
const choiceSchema = z.object({ identity: paneCreateIdentitySchema, roomType: roomCode, actorUserId: text }).strict();
export const paneBatchChoiceSnapshotSchema = z.object({
  version: z.literal('pane-batch-choice/1'), source: sourceSchema, cursor: cursorSchema, sourceDigest,
  propertyCode: text, generation: z.string().uuid(), choices: z.array(choiceSchema).min(1).max(8),
}).strict().superRefine((snapshot, ctx) => {
  const seen = new Set<string>();
  snapshot.choices.forEach((choice, index) => {
    const key = identityKey(choice.identity);
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['choices', index], message: 'Duplicate child identity.' });
    seen.add(key);
  });
});
export type PaneBatchChoiceSnapshot = z.infer<typeof paneBatchChoiceSnapshotSchema>;
export type PaneBatchChoiceContext = Pick<PaneBatchChoiceSnapshot, 'source' | 'cursor' | 'sourceDigest' | 'propertyCode'>;
const identityKey = (identity: PaneCreateIdentity) => JSON.stringify([identity.stayId, identity.rowId, identity.roomIndex]);
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

function knownRoom(propertyCode: string, code: string): boolean {
  // Do not use the global room-name fallback for an unknown property.
  try {
    const profile = profileFor(propertyCode);
    return Boolean(profile?.roomCapacity && Object.hasOwn(profile.roomCapacity, code));
  } catch { return false; }
}

/**
 * Pure construction only, never staff authority. The caller must authenticate the staff member,
 * lock the correct work item, load `previous` from that item, verify source/cursor under the lock,
 * validate each child against the same active source row and persist the result atomically.
 * Advance only the monotonic sequence. Room choices are not pane-field undo steps. The source digest excludes the choice
 * snapshot and must still match trusted source rows; its choice digest is bound separately.
 * Every choice changes generation; source edits and undo invalidate via seq.
 */
export function updatePaneBatchChoiceSnapshot(input: {
  previous: unknown | null; expectedGeneration: string | null; context: PaneBatchChoiceContext;
  choice: { identity: PaneCreateIdentity; roomType: string }; actorUserId: string;
  selected: PaneCreateIdentity[];
  isActiveChild: (identity: PaneCreateIdentity) => boolean;
}): PaneBatchChoiceSnapshot {
  const context = z.object({ source: sourceSchema, cursor: cursorSchema, sourceDigest, propertyCode: text }).strict().parse(input.context);
  const choice = choiceSchema.parse({ ...input.choice, actorUserId: input.actorUserId });
  const previous = input.previous === null ? null : paneBatchChoiceSnapshotSchema.parse(input.previous);
  if ((previous?.generation ?? null) !== input.expectedGeneration) throw new Error('batch_choice_stale');
  if (previous && (previous.source.workItemId !== context.source.workItemId ||
      previous.source.transportId !== context.source.transportId)) throw new Error('batch_choice_source_mismatch');
  const selected = z.array(paneCreateIdentitySchema).min(1).max(8).parse(input.selected);
  const keys = selected.map(identityKey);
  if (new Set(keys).size !== keys.length || !keys.includes(identityKey(choice.identity)) ||
      !knownRoom(context.propertyCode, choice.roomType) || typeof input.isActiveChild !== 'function' ||
      selected.some((identity) => input.isActiveChild(identity) !== true) ||
      context.cursor.seq === Number.MAX_SAFE_INTEGER) throw new Error('batch_choice_invalid');
  const eligible = previous && same(previous.source, context.source) && same(previous.cursor, context.cursor) &&
    previous.sourceDigest === context.sourceDigest && previous.propertyCode === context.propertyCode ? previous.choices : [];
  const choices = eligible.filter((item) => keys.includes(identityKey(item.identity)) &&
    identityKey(item.identity) !== identityKey(choice.identity));
  choices.push(choice);
  // A booking-card choice is not part of pane field undo/redo. Preserve both
  // history cursors and invalidate approvals with the monotonic sequence only.
  const cursor = { ...context.cursor, seq: context.cursor.seq + 1 };
  return paneBatchChoiceSnapshotSchema.parse({ version: 'pane-batch-choice/1', ...context, cursor,
    generation: randomUUID(), choices });
}

export function paneBatchChoiceDigest(snapshot: PaneBatchChoiceSnapshot): string {
  return createHash('sha256').update(canonicalJson(paneBatchChoiceSnapshotSchema.parse(snapshot))).digest('hex');
}

/**
 * Use only with a snapshot reloaded from the locked server-owned item. This compares shape and
 * values, not authentication or authorization. Callers must separately prove source ownership,
 * the current property catalogue, active source row/count, grant, actor and native dispatch fence.
 */
export function matchesPaneBatchChoices(input: {
  snapshot: unknown; context: PaneBatchChoiceContext; expectedGeneration: string; manifest: unknown;
}): boolean {
  const snapshot = paneBatchChoiceSnapshotSchema.safeParse(input.snapshot);
  const manifest = batchManifestSchema.safeParse(input.manifest);
  const context = z.object({ source: sourceSchema, cursor: cursorSchema, sourceDigest, propertyCode: text }).strict().safeParse(input.context);
  if (!snapshot.success || !manifest.success || !context.success || snapshot.data.generation !== input.expectedGeneration ||
      !same(snapshot.data.source, context.data.source) || !same(snapshot.data.cursor, context.data.cursor) ||
      snapshot.data.sourceDigest !== context.data.sourceDigest ||
      snapshot.data.propertyCode !== context.data.propertyCode || !same(manifest.data.source, context.data.source) ||
      manifest.data.propertyCode !== context.data.propertyCode) return false;
  return manifest.data.rooms.every((room) => snapshot.data.choices.some((choice) =>
    identityKey(choice.identity) === identityKey(room.identity) && choice.roomType === room.roomType &&
    knownRoom(context.data.propertyCode, choice.roomType)));
}
