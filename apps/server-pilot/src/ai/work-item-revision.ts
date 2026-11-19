import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { hydrateStoredWorkState } from './stored-work-state.js';
import type { DB } from '../db/client.js';
import { workEvent, workItem } from '../db/schema/work.js';
// The v2 engine is retired; old drafts in stored state are carried through untyped.
type ReservationWorkflowV2Draft = {
  operationResults?: Array<{ workflow?: string; status?: string }>;
  prefill?: { status: string } & Record<string, unknown>;
};
const hydrateStoredReservationWorkflowV2 = (value: unknown): unknown => value;

/** Nested HMS commits. Same key as STAY_COMMITS_KEY in work-items.ts. Undo never touches it. */
const STAY_COMMITS_KEY = 'stays';
const RESERVATION_V2_KEY = 'reservationWorkflowV2';
export const RESERVATION_V2_PROPERTY_HISTORY_FLOOR_KEY = 'reservationWorkflowV2PropertyHistoryFloor';
const SOURCE_TYPES = ['field.edit', 'field.reject', 'field.accept', 'field.reset'] as const;

export type PaneState = Record<string, unknown>;
export type PaneRevisionCursor = { revision: number; revisionHead: number; seq: number; extractionId: string | null };
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
  return key.startsWith('stays[') || key.startsWith('requests[') || key.startsWith('contact.') || key === 'followUp.draft' ||
    key === RESERVATION_V2_KEY;
}

function sourceBindingOf(value: unknown): {
  generationId: string; propertyCode: string; threadId: string; messageId: string; sourceHash: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  const source = draft.source && typeof draft.source === 'object' && !Array.isArray(draft.source)
    ? draft.source as Record<string, unknown> : null;
  const binding = source ? { generationId: draft.generationId, propertyCode: draft.propertyCode,
    threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash } : draft.sourceCueBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const { generationId, propertyCode, threadId, messageId, sourceHash } = binding as Record<string, unknown>;
  return typeof generationId === 'string' && generationId && typeof propertyCode === 'string' && propertyCode &&
    typeof threadId === 'string' && threadId && typeof messageId === 'string' && messageId &&
    typeof sourceHash === 'string' && sourceHash
    ? { generationId, propertyCode, threadId, messageId, sourceHash } : null;
}

export function paneStateOf(state: PaneState): PaneState {
  const pane: PaneState = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === RESERVATION_V2_KEY) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const draft = value as Record<string, unknown>;
        const sourceCueBinding = sourceBindingOf(draft);
        pane[key] = { ...(Object.hasOwn(draft, 'proposal') ? { proposal: draft.proposal } : {}),
          ...(sourceCueBinding ? { sourceCueBinding } : {}),
          fieldOverrides: draft.fieldOverrides ?? {}, staffReviews: draft.staffReviews ?? {} };
      }
    } else if (isPaneFieldKey(key)) pane[key] = value;
  }
  return pane;
}

export function withPaneState(state: PaneState, pane: PaneState): PaneState {
  const next: PaneState = {};
  for (const [key, value] of Object.entries(state)) {
    if (!isPaneFieldKey(key) || key === RESERVATION_V2_KEY) next[key] = value;
  }
  for (const [key, value] of Object.entries(paneStateOf(pane))) {
    if (key === RESERVATION_V2_KEY) {
      const currentValue = hydrateStoredReservationWorkflowV2(state[key]);
      const current = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
        ? currentValue as Record<string, unknown> : {};
      const restoredValue = hydrateStoredReservationWorkflowV2(value);
      const restored = restoredValue && typeof restoredValue === 'object' && !Array.isArray(restoredValue)
        ? restoredValue as Record<string, unknown> : {};
      // Old snapshots have no proposal. Native observations, receipts, source and generation always survive.
      next[key] = { ...current, ...(Object.hasOwn(restored, 'proposal') ? { proposal: restored.proposal } : {}),
        fieldOverrides: restored.fieldOverrides ?? {}, staffReviews: restored.staffReviews ?? {} };
    } else next[key] = value;
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
  return hydrateStoredWorkState(value as PaneState);
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

// Compare the fields consumed by Amend for a particular saved stay. Resolve
// overrides before selecting by hint ID, since structural edits can reindex rows.
function amendTargetBinding(draft: Record<string, unknown>, requestId: string, hintId: string): unknown | null {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const content = object(object(draft.proposal).content);
  const requests = Array.isArray(content.requests) ? content.requests : [];
  const request = object(requests.find((row) => object(row).id === requestId));
  if (request.kind !== 'amend') return null;
  const fields = object(draft.fieldOverrides);
  const effective = (path: string, source: unknown): unknown => {
    const override = object(fields[path]);
    let value = source;
    if (override.state === 'set') value = override.value;
    else if (override.state === 'unknown') return { __amendOverride: 'unknown' };
    else if (override.state === 'none' || override.state === 'clear') return { __amendOverride: 'none' };
    if (value && typeof value === 'object' && !Array.isArray(value) && object(value).kind === 'none')
      return { __amendOverride: 'none' };
    if (Array.isArray(value)) return value.map((row, index) => effective(`${path}/${index}`, row));
    if (!value || typeof value !== 'object') return value;
    const sourceObject = object(value), keys = new Set(Object.keys(sourceObject)), prefix = `${path}/`;
    for (const overridePath of Object.keys(fields)) {
      if (!overridePath.startsWith(prefix)) continue;
      const child = overridePath.slice(prefix.length).split('/')[0];
      if (child) try { keys.add(decodeURIComponent(child)); } catch { /* Invalid paths cannot be edited. */ }
    }
    return Object.fromEntries([...keys].sort().map((key) =>
      [key, effective(`${path}/${encodeURIComponent(key)}`, sourceObject[key])]));
  };
  const path = `/proposal/content/requests/${encodeURIComponent(requestId)}/body`;
  const rawBody = object(request.body), body = object(effective(path, request.body));
  const targets = object(body.targets), include = Array.isArray(targets.include) ? targets.include : [];
  const matches = include.filter((row) => object(row).id === hintId);
  const perTarget = effective(`${path}/perTarget`, rawBody.perTarget);
  const perRows = Array.isArray(perTarget) ? perTarget.filter((row) => object(row).hintId === hintId) : [];
  if (matches.length !== 1 || perRows.length !== 1) return null;
  const exclude = Array.isArray(targets.exclude) ? targets.exclude : [];
  return { kind: request.kind, mode: targets.mode, hint: matches[0],
    excluded: exclude.some((row) => object(row).id === hintId), perTarget: perRows[0],
    sharedChanges: effective(`${path}/sharedChanges`, rawBody.sharedChanges) };
}

export function nativeStructureIsSafe(currentState: PaneState, restoredState: PaneState): boolean {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const current = record(currentState[RESERVATION_V2_KEY]), next = record(restoredState[RESERVATION_V2_KEY]);
  const oldContent = record(record(current.proposal).content), newContent = record(record(next.proposal).content);
  const rows = (content: Record<string, unknown>, key: string) => Array.isArray(content[key]) ? content[key] as unknown[] : [];
  const results = Array.isArray(current.operationResults) ? current.operationResults : [];
  for (const entry of results) {
    const result = record(entry);
    if ((result.status !== 'succeeded' && result.status !== 'unknown') || typeof result.requestId !== 'string') continue;
    const id = result.requestId;
    if (result.workflow === 'guest_profile' && typeof result.allocationId === 'string') {
      const exists = (content: Record<string, unknown>) => {
        const request = record(rows(content, 'requests').find((row) => record(row).id === id));
        return request.kind === 'create' && Array.isArray(record(request.body).allocations) &&
          (record(request.body).allocations as unknown[]).some((row) => record(row).id === result.allocationId);
      };
      if (!exists(newContent)) return false;
      continue;
    }
    if (result.workflow === 'create' && typeof result.allocationId === 'string') {
      const target = (content: Record<string, unknown>) => {
        const request = record(rows(content, 'requests').find((row) => record(row).id === id));
        const body = record(request.body), allocations = Array.isArray(body.allocations) ? body.allocations : [];
        const allocation = record(allocations.find((row) => record(row).id === result.allocationId));
        const sections = Array.isArray(body.dateSections) ? body.dateSections : [];
        const section = record(sections.find((row) => record(row).id === allocation.dateSectionId));
        const { requestedRooms: _requestedRooms, unassignedGuestNames: _unassigned, ...businessSection } = section;
        return { kind: request.kind, shared: body.shared, allocation, section: businessSection };
      };
      if (JSON.stringify(target(oldContent)) !== JSON.stringify(target(newContent))) return false;
      continue;
    }
    if (result.workflow === 'amend' && typeof result.allocationId === 'string' && result.allocationId) {
      const before = amendTargetBinding(current, id, result.allocationId);
      const after = amendTargetBinding(next, id, result.allocationId);
      if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) return false;
      continue;
    }
    if (result.workflow === 'amend') {
      // A legacy receipt without a hint binding cannot safely be scoped.
      const bodyOverrides = (draft: Record<string, unknown>, content: Record<string, unknown>) => {
        const index = rows(content, 'requests').findIndex((row) => record(row).id === id);
        const prefixes = [`/proposal/content/requests/${encodeURIComponent(id)}/body`,
          `/proposal/content/requests/${index}/body`];
        return Object.fromEntries(Object.entries(record(draft.fieldOverrides)).filter(([path]) => prefixes.some((prefix) =>
          path === prefix || path.startsWith(`${prefix}/`))).sort(([a], [b]) => a.localeCompare(b)));
      };
      if (JSON.stringify(bodyOverrides(current, oldContent)) !== JSON.stringify(bodyOverrides(next, newContent))) return false;
    }
    if (result.workflow === 'services' && Array.isArray(result.observationRefs) && Array.isArray(current.observations)) {
      const refs = result.observationRefs;
      const observation = current.observations.map(record).find((row) => refs.includes(row.ref) &&
        typeof record(row.criteria).serviceId === 'string');
      const serviceId = record(observation?.criteria).serviceId;
      if (typeof serviceId === 'string') {
        const targetRef = record(record(observation?.criteria).targetRef);
        const hintId = targetRef.kind === 'saved_target' && targetRef.requestId === id && typeof targetRef.hintId === 'string'
          ? targetRef.hintId : null;
        const binding = (content: Record<string, unknown>) => ({
          request: (() => { const request = record(rows(content, 'requests').find((row) => record(row).id === id));
            const targets = record(record(request.body).targets), include = Array.isArray(targets.include) ? targets.include : [];
            return { kind: request.kind, targets: hintId ? { mode: targets.mode, exclude: targets.exclude,
              hint: include.find((row) => record(row).id === hintId) } : record(request.body).targets }; })(),
          service: rows(content, 'services').find((row) => record(row).id === serviceId),
        });
        if (JSON.stringify(binding(oldContent)) !== JSON.stringify(binding(newContent))) return false;
        const selection = (draft: Record<string, unknown>, content: Record<string, unknown>) => {
          const fields = record(draft.fieldOverrides), index = rows(content, 'services').findIndex((row) => record(row).id === serviceId);
          const prefixes = [`/proposal/content/services/${encodeURIComponent(serviceId)}/`, `/proposal/content/services/${index}/`];
          return Object.fromEntries(Object.entries(fields).filter(([path]) => prefixes.some((prefix) => path.startsWith(prefix) &&
            (/\/(?:target|savedRowCandidateRef|itemCandidateRef)$/.test(path) || path === `${prefix}targets`)))
            .sort(([a], [b]) => a.localeCompare(b)));
        };
        if (JSON.stringify(selection(current, oldContent)) !== JSON.stringify(selection(next, newContent))) return false;
        const targetSelection = (draft: Record<string, unknown>, content: Record<string, unknown>) => {
          const fields = record(draft.fieldOverrides), index = rows(content, 'requests').findIndex((row) => record(row).id === id);
          const prefixes = [`/proposal/content/requests/${encodeURIComponent(id)}/body/targets`,
            `/proposal/content/requests/${index}/body/targets`];
          if (!hintId) return Object.fromEntries(Object.entries(fields).filter(([path]) => prefixes.some((prefix) =>
            path === prefix || path.startsWith(`${prefix}/`))).sort(([a], [b]) => a.localeCompare(b)));
          const request = record(rows(content, 'requests')[index]), targets = record(record(request.body).targets);
          const include = Array.isArray(targets.include) ? targets.include : [];
          const targetIndex = include.findIndex((row) => record(row).id === hintId);
          const selected: Record<string, unknown> = {};
          for (const [path, value] of Object.entries(fields)) for (const prefix of prefixes) {
            if (path === prefix || path === `${prefix}/mode` || path === `${prefix}/exclude` || path === `${prefix}/include`) {
              selected[path.slice(prefix.length)] = value;
            }
            for (const targetPath of [`${prefix}/include/${targetIndex}`, `${prefix}/include/${encodeURIComponent(hintId)}`]) {
              if (path === targetPath || path.startsWith(`${targetPath}/`)) selected[`/hint${path.slice(targetPath.length)}`] = value;
            }
          }
          return Object.fromEntries(Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)));
        };
        if (JSON.stringify(targetSelection(current, oldContent)) !== JSON.stringify(targetSelection(next, newContent))) return false;
        continue;
      }
    }
    const references = (row: unknown, property: string) => {
      const values = record(row)[property];
      return Array.isArray(values) && values.some((entry) => record(record(entry).target ?? entry).requestId === id);
    };
    const boundRequest = (content: Record<string, unknown>) => {
      const request = rows(content, 'requests').find((row) => record(row).id === id);
      if (result.workflow !== 'amend' || record(request).kind !== 'amend') return request;
      // These host-owned review cues do not change the native amendment.
      const body = record(record(request).body);
      const { sourceCues: _sourceCues, ...nativeBody } = body;
      return { ...record(request), body: nativeBody };
    };
    const bound = (content: Record<string, unknown>) => ({
      request: boundRequest(content),
      services: rows(content, 'services').filter((row) => record(row).ownerRequestId === id || references(row, 'targets')),
      documents: rows(content, 'documents').filter((row) => record(row).ownerRequestId === id || references(row, 'targetRefs')),
    });
    if (JSON.stringify(bound(oldContent)) !== JSON.stringify(bound(newContent))) return false;
    const targetOverrides = (draft: Record<string, unknown>, content: Record<string, unknown>) => {
      const fields = record(draft.fieldOverrides), requestIndex = rows(content, 'requests').findIndex((row) => record(row).id === id);
      const requestPrefixes = [`/proposal/content/requests/${encodeURIComponent(id)}/body/targets`,
        `/proposal/content/requests/${requestIndex}/body/targets`];
      return Object.fromEntries(Object.entries(fields).filter(([path]) => requestPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
        .sort(([a], [b]) => a.localeCompare(b)));
    };
    if (JSON.stringify(targetOverrides(current, oldContent)) !== JSON.stringify(targetOverrides(next, newContent))) return false;
  }
  return true;
}

async function applyHistoryMove(
  db: DB,
  input: {
    transportId: string;
    workItemId: string;
    userId: string;
    expectedSeq?: number;
    expectedExtractionId?: string | null;
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
    const pendingGuest = (item.state[RESERVATION_V2_KEY] as ReservationWorkflowV2Draft | undefined)?.operationResults;
    if (pendingGuest?.some((row) => row.workflow === 'guest_profile' && row.status === 'unknown')) {
      return { status: 'history_stale' as const, revision: item.revision, revisionHead: item.revisionHead, seq: item.revisionSeq };
    }
    const revision = item.revision;
    const revisionHead = item.revisionHead;
    const seq = item.revisionSeq;
    if (
      (input.expectedSeq !== undefined && input.expectedSeq !== seq) ||
      (input.expectedExtractionId !== undefined && input.expectedExtractionId !== item.extractionId)
    ) {
      return { status: 'stale' as const, revision, revisionHead, seq };
    }
    const undo = input.direction === 'undo';
    const historyFloor = asRevision(item.state[RESERVATION_V2_PROPERTY_HISTORY_FLOOR_KEY]) ?? 0;
    if (undo ? revision <= historyFloor : revision >= revisionHead) {
      return { status: 'at_boundary' as const, revision, revisionHead, seq };
    }
    const snapshot = await latestEvidence(tx, input.workItemId, undo ? revision : revision + 1);
    if (!snapshot) return { status: 'at_boundary' as const, revision, revisionHead, seq };
    const v2WithoutLegacyRead = item.extractionId === null && snapshot.extractionId === null &&
      Object.hasOwn(asState(item.state), RESERVATION_V2_KEY);
    if (!extractionMatches(snapshot.extractionId, item.extractionId) && !v2WithoutLegacyRead) {
      return { status: 'history_stale' as const, revision, revisionHead, seq };
    }
    const restored = undo ? snapshot.previousPaneState : snapshot.paneState;
    const nextRevision = undo ? revision - 1 : revision + 1;
    const nextSeq = seq + 1;
    const state = withPaneState(hydrateStoredWorkState(item.state), restored);
    if (!nativeStructureIsSafe(item.state, state)) return { status: 'history_stale' as const, revision, revisionHead, seq };
    const restoredV2 = state[RESERVATION_V2_KEY] as ReservationWorkflowV2Draft | undefined;
    if (restoredV2?.prefill && ['queued', 'running'].includes(restoredV2.prefill.status)) {
      restoredV2.prefill = { ...restoredV2.prefill, status: 'superseded', finishedAt: new Date().toISOString() };
    }
  const v2 = state[RESERVATION_V2_KEY];
  if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) {
    state[RESERVATION_V2_KEY] = { ...(v2 as Record<string, unknown>), revision: nextRevision };
  }
    // Undo/redo invalidates an earlier filing review, even when pane fields return to their old values.
    if (state.action === 'attach_document') {
      state.filingHistorySeq = nextSeq;
      delete state.hmsSnapshot;
    }
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
  input: { transportId: string; workItemId: string; userId: string; expectedSeq?: number; expectedExtractionId?: string | null },
): Promise<PaneRevisionResult> {
  return applyHistoryMove(db, { ...input, direction: 'undo' });
}

export async function redoWorkItemRevision(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string; expectedSeq?: number; expectedExtractionId?: string | null },
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
      extractionId: workItem.extractionId,
    })
    .from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1);
  return item ?? null;
}
