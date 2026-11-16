import { createHash } from 'node:crypto';
import type { ReservationWorkflowV2Draft } from './reservation-workflow-v2-contract.js';

/**
 * Per-field edit trace for later agent eval. Staff edits and ticks already land in work_event
 * (field.edit / field.accept, user, time, override value, before/after pane state). This adds what
 * those rows lacked: Nava's prefilled value at that path (work_event.ai_value), the auto-pick
 * suggestion staff saw (confidence, evidence kinds, alternatives), the generation and the build.
 * Pure and total: a trace problem returns a smaller stamp and never blocks the staff action.
 */
export const EDIT_TRACE_VERSION = 'v2-edit-trace/1';
const MAX_AI_VALUE_BYTES = 8_000;

type Observation = ReservationWorkflowV2Draft['observations'][number];
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function buildCommit(): string | null {
  return process.env.NAVA_BUILD_COMMIT?.trim() || null;
}

/** Nava's value at a pointer, ignoring staff overrides. Undefined for paths outside one proposal row. */
export function prefillValueAt(draft: Pick<ReservationWorkflowV2Draft, 'proposal'>, path: string): unknown {
  const parts = path.split('/').slice(1);
  // /proposal/content/<collection>/<row>/<field...>: never a whole collection or whole row.
  if (parts[0] !== 'proposal' || parts[1] !== 'content' || parts.length < 5) return undefined;
  let value: unknown = draft;
  for (const raw of parts) {
    let key: string;
    try { key = decodeURIComponent(raw); } catch { return undefined; }
    value = Array.isArray(value) ? (/^\d+$/.test(key) ? value[Number(key)]
      : value.find((row) => object(row)?.id === key)) : object(value)?.[key];
    if (value === undefined) return undefined;
  }
  return value;
}

/** The auto-pick suggestion observation for a field, by its selection or value path (contract v1). */
export function autopickSuggestionFor(draft: Pick<ReservationWorkflowV2Draft, 'observations' | 'generationId'>,
  path: string): Observation | undefined {
  const bare = path.replace(/\/nativeSelectionRef$/u, '');
  return draft.observations.find((row) => row.generationId === draft.generationId &&
    row.criteria.kind === 'autopick_suggestion' &&
    (row.criteria.selectionPath === path || row.criteria.valuePath === path || row.criteria.valuePath === bare));
}

export function autopickSuggestionSummary(row: Observation | undefined) {
  const result = object(row?.result);
  if (!row || !result) return null;
  const evidence = Array.isArray(result.evidence) ? result.evidence.map(object).filter(Boolean) as Record<string, unknown>[] : [];
  const alternatives = Array.isArray(result.alternatives) ? result.alternatives.map(object).filter(Boolean) as Record<string, unknown>[] : [];
  return {
    ref: row.ref,
    field: typeof result.field === 'string' ? result.field : null,
    value: typeof result.value === 'string' ? result.value : null,
    label: typeof result.label === 'string' ? result.label : null,
    confidence: result.confidence === 'usual' || result.confidence === 'check' ? result.confidence : null,
    evidenceKinds: evidence.map((entry) => String(entry.kind ?? '')).filter(Boolean),
    evidence: evidence.map((entry) => ({ kind: entry.kind ?? null, count: entry.count ?? null, total: entry.total ?? null,
      lastSeen: entry.lastSeen ?? null })),
    alternatives: alternatives.slice(0, 5).map((entry) => ({ ref: entry.ref ?? null, label: entry.label ?? null,
      count: entry.count ?? null, total: entry.total ?? null })),
  };
}

function bounded(value: unknown): unknown {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  if (json.length <= MAX_AI_VALUE_BYTES) return value;
  return { truncated: true, bytes: json.length, sha256: createHash('sha256').update(json).digest('hex') };
}

/** Stamp for one staff field event. Never throws. */
export function reservationWorkflowV2EditTrace(draft: ReservationWorkflowV2Draft, fieldPath: string): {
  aiValue: unknown; trace: Record<string, unknown>;
} {
  const base = { version: EDIT_TRACE_VERSION, build: buildCommit() };
  try {
    const bare = fieldPath.replace(/\/nativeSelectionRef$/u, '');
    const prefill = prefillValueAt(draft, fieldPath);
    const partyPrefill = prefill === undefined && bare !== fieldPath ? object(prefillValueAt(draft, bare))?.suggestedRef : undefined;
    const annotation = draft.proposal.annotations
      .filter((row) => row.path === fieldPath || row.path === bare || fieldPath.startsWith(`${row.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0];
    const requirement = draft.fieldReviewRequirements[fieldPath] ?? draft.fieldReviewRequirements[bare];
    return {
      aiValue: bounded(prefill ?? partyPrefill),
      trace: { ...base, generationId: draft.generationId, propertyCode: draft.propertyCode,
        prefillBasis: annotation?.basis ?? null, reviewRequired: requirement?.required ?? null,
        priorOverride: draft.fieldOverrides[fieldPath]?.state ?? null,
        priorReview: draft.staffReviews[fieldPath]?.status ?? null,
        suggestion: autopickSuggestionSummary(autopickSuggestionFor(draft, fieldPath)) },
    };
  } catch {
    return { aiValue: null, trace: { ...base, issue: 'trace_unavailable' } };
  }
}
