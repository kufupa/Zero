import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { workEvent, workItem } from '../db/schema/work.js';

/** Nested HMS commits. Same key as STAY_COMMITS_KEY in work-items.ts. Undo never touches it. */
const STAY_COMMITS_KEY = 'stays';
const SOURCE_TYPES = ['field.edit', 'field.reject', 'field.accept'] as const;

export type PaneState = Record<string, unknown>;
export type PaneRevisionCursor = { revision: number; revisionHead: number; seq: number };
export type PaneRevisionResult =
  | { status: 'not_found' }
  | { status: 'stale'; revision: number; revisionHead: number; seq: number }
  | { status: 'history_stale'; revision: number; revisionHead: number; seq: number }
  | { status: 'at_boundary'; revision: number; revisionHead: number; seq: number }
  | { status: 'applied'; revision: number; revisionHead: number; seq: number; restored: PaneState };

export type PaneRevisionEvidence = {
  paneRevision: number;
  paneSeq: number;
  paneState: PaneState;
  previousPaneState: PaneState;
  extractionId: string | null;
};

type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

function isPaneFieldKey(key: string): boolean {
  return key.startsWith('stays[') || key.startsWith('contact.') || key === 'followUp.draft';
}

export function paneStateOf(state: PaneState): PaneState {
  const pane: PaneState = {};
  for (const [key, value] of Object.entries(state)) {
    if (isPaneFieldKey(key)) pane[key] = value;
  }
  return pane;
}

export function withPaneState(state: PaneState, pane: PaneState): PaneState {
  const next: PaneState = {};
  for (const [key, value] of Object.entries(state)) {
    if (!isPaneFieldKey(key)) next[key] = value;
  }
  for (const [key, value] of Object.entries(paneStateOf(pane))) {
    next[key] = value;
  }
  if (Object.hasOwn(state, STAY_COMMITS_KEY)) next[STAY_COMMITS_KEY] = state[STAY_COMMITS_KEY];
  return next;
}

export function advancePaneRevision(input: {
  revision: number;
  revisionHead: number;
  seq: number;
  previousState: PaneState;
  nextState: PaneState;
  extractionId: string | null;
}): { revision: number; revisionHead: number; evidence: PaneRevisionEvidence } {
  const revision = Math.max(0, input.revision) + 1;
  const paneSeq = Math.max(0, input.seq) + 1;
  return {
    revision,
    revisionHead: revision,
    evidence: {
      paneRevision: revision,
      paneSeq,
      paneState: paneStateOf(input.nextState),
      previousPaneState: paneStateOf(input.previousState),
      extractionId: input.extractionId,
    },
  };
}

function asRevision(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
  return null;
}

function asState(value: unknown): PaneState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as PaneState) };
}

async function latestEvidence(
  tx: WorkTx,
  workItemId: string,
  paneRevision: number,
): Promise<PaneRevisionEvidence | null> {
  const [row] = await tx
    .select({ evidence: workEvent.evidence })
    .from(workEvent)
    .where(
      and(
        eq(workEvent.workItemId, workItemId),
        inArray(workEvent.type, [...SOURCE_TYPES]),
        sql`(${workEvent.evidence} ->> 'paneRevision') = ${String(paneRevision)}`,
      ),
    )
    .orderBy(desc(sql`coalesce((${workEvent.evidence} ->> 'paneSeq')::int, 0)`), desc(workEvent.id))
    .limit(1);
  const raw = row?.evidence;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const evidence = raw as Record<string, unknown>;
  if (asRevision(evidence.paneRevision) !== paneRevision) return null;
  return {
    paneRevision,
    paneSeq: asRevision(evidence.paneSeq) ?? 0,
    paneState: paneStateOf(asState(evidence.paneState)),
    previousPaneState: paneStateOf(asState(evidence.previousPaneState)),
    extractionId: asExtractionId(evidence.extractionId),
  };
}

function asExtractionId(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function extractionMatches(stored: string | null, current: string | null): boolean {
  return stored !== null && stored === current;
}

async function applyHistoryMove(
  db: DB,
  input: {
    transportId: string;
    workItemId: string;
    userId: string;
    expectedSeq?: number;
    direction: 'undo' | 'redo';
  },
): Promise<PaneRevisionResult> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({
        state: workItem.state,
        revision: workItem.revision,
        revisionHead: workItem.revisionHead,
        revisionSeq: workItem.revisionSeq,
        extractionId: workItem.extractionId,
      })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    const revision = item.revision;
    const revisionHead = item.revisionHead;
    const seq = item.revisionSeq;
    if (input.expectedSeq !== undefined && input.expectedSeq !== seq) {
      return { status: 'stale' as const, revision, revisionHead, seq };
    }
    const undo = input.direction === 'undo';
    if (undo ? revision <= 0 : revision >= revisionHead) {
      return { status: 'at_boundary' as const, revision, revisionHead, seq };
    }
    const snapshot = await latestEvidence(tx, input.workItemId, undo ? revision : revision + 1);
    if (!snapshot) return { status: 'at_boundary' as const, revision, revisionHead, seq };
    if (!extractionMatches(snapshot.extractionId, item.extractionId)) {
      return { status: 'history_stale' as const, revision, revisionHead, seq };
    }
    const restored = undo ? snapshot.previousPaneState : snapshot.paneState;
    const nextRevision = undo ? revision - 1 : revision + 1;
    const nextSeq = seq + 1;
    const state = withPaneState(item.state, restored);
    await tx.insert(workEvent).values({
      workItemId: input.workItemId,
      actorKind: 'user',
      actorUserId: input.userId,
      type: undo ? 'history.undo' : 'history.redo',
      value: restored,
      evidence: { fromRevision: revision, toRevision: nextRevision, extractionId: item.extractionId },
    });
    await tx
      .update(workItem)
      .set({ state, revision: nextRevision, revisionSeq: nextSeq, updatedAt: new Date() })
      .where(eq(workItem.id, input.workItemId));
    return { status: 'applied' as const, revision: nextRevision, revisionHead, seq: nextSeq, restored };
  });
}

export async function undoWorkItemRevision(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string; expectedSeq?: number },
): Promise<PaneRevisionResult> {
  return applyHistoryMove(db, { ...input, direction: 'undo' });
}

export async function redoWorkItemRevision(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string; expectedSeq?: number },
): Promise<PaneRevisionResult> {
  return applyHistoryMove(db, { ...input, direction: 'redo' });
}

export async function loadPaneRevisionCursor(
  db: DB,
  input: { transportId: string; workItemId: string },
): Promise<PaneRevisionCursor | null> {
  const [item] = await db
    .select({
      revision: workItem.revision,
      revisionHead: workItem.revisionHead,
      seq: workItem.revisionSeq,
    })
    .from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1);
  return item ?? null;
}
