import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { workItem } from '../db/schema/work.js';

const STAY_ID = /^[A-Za-z0-9_-]{1,40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
export const STAY_PREVIEWS_KEY = 'stayPreviews';

/** Durable Book preview grant: status + stay digest, never a reusable secret token. */
export type StayPreviewRecord = {
  digest: string;
  status: 'previewed';
  expiresAt: number;
};

type WorkState = Record<string, unknown>;

export function parseStayPreview(value: unknown): StayPreviewRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.status !== 'previewed') return null;
  if (typeof row.digest !== 'string' || !DIGEST.test(row.digest)) return null;
  if (typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt)) return null;
  return { digest: row.digest, status: 'previewed', expiresAt: row.expiresAt };
}

export function stayPreviewsOf(state: WorkState): Record<string, StayPreviewRecord> {
  const raw = state[STAY_PREVIEWS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, StayPreviewRecord> = {};
  for (const [stayId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!STAY_ID.test(stayId)) continue;
    const parsed = parseStayPreview(value);
    if (parsed) out[stayId] = parsed;
  }
  return out;
}

export function stayPreviewOf(state: WorkState, stayId: string): StayPreviewRecord | undefined {
  return stayPreviewsOf(state)[stayId];
}

export function withStayPreview(state: WorkState, stayId: string, record: StayPreviewRecord): WorkState {
  if (!STAY_ID.test(stayId) || !parseStayPreview(record)) return state;
  return { ...state, [STAY_PREVIEWS_KEY]: { ...stayPreviewsOf(state), [stayId]: record } };
}

export function withoutStayPreview(state: WorkState, stayId: string): WorkState {
  const current = stayPreviewsOf(state);
  if (!(stayId in current)) return state;
  const next = { ...current };
  delete next[stayId];
  return { ...state, [STAY_PREVIEWS_KEY]: next };
}

/** Matching unexpired digest grants; any other stored row is stale and must not commit. */
export function stayPreviewGrantOf(
  record: StayPreviewRecord | undefined,
  digest: string,
  now: number,
): StayPreviewRecord | null {
  if (!record || record.status !== 'previewed') return null;
  if (record.digest !== digest || record.expiresAt <= now) return null;
  return record;
}

export async function recordStayPreview(
  db: DB,
  input: { transportId: string; workItemId: string; stayId: string; record: StayPreviewRecord },
): Promise<{ status: 'recorded' } | { status: 'not_found' }> {
  if (!STAY_ID.test(input.stayId) || !parseStayPreview(input.record)) return { status: 'not_found' };
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ state: workItem.state })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    const state = withStayPreview(item.state, input.stayId, input.record);
    await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    return { status: 'recorded' as const };
  });
}

export async function takeStayPreview(
  db: DB,
  input: { transportId: string; workItemId: string; stayId: string; digest: string; now: number },
): Promise<boolean> {
  if (!STAY_ID.test(input.stayId)) return false;
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ state: workItem.state })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return false;
    const grant = stayPreviewGrantOf(stayPreviewOf(item.state, input.stayId), input.digest, input.now);
    await tx
      .update(workItem)
      .set({ state: withoutStayPreview(item.state, input.stayId), updatedAt: new Date() })
      .where(eq(workItem.id, input.workItemId));
    return Boolean(grant);
  });
}

export function createWorkItemPreviewPersist(db: DB, transportId: string, ttlMs: number) {
  return {
    record: async (input: { workItemId: string; stayId: string; digest: string; now: number }) => {
      const saved = await recordStayPreview(db, {
        transportId,
        workItemId: input.workItemId,
        stayId: input.stayId,
        record: { digest: input.digest, status: 'previewed', expiresAt: input.now + ttlMs },
      });
      if (saved.status !== 'recorded') throw new Error('pane_save_preview_persist_unavailable');
    },
    take: async (input: { workItemId: string; stayId: string; digest: string; now: number }) =>
      takeStayPreview(db, { transportId, ...input }),
  };
}
