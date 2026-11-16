/**
 * Read-only per-field trace export for the reservation pane (Create, Amend, Cancel, Filing, Add-Ons, Quote).
 * One JSONL row per field per work item: what Nava prefilled (and the auto-pick suggestion with its confidence and
 * evidence kinds), whether staff ticked it, what staff changed it to, the value at the Go revision and the HMS readback.
 *
 *   tsx scripts/export-reservation-field-trace.ts [--out FILE] [--since ISO] [--property HRCEN] [--work-item UUID]
 *
 * Sources, all existing: work_item.state.reservationWorkflowV2 (proposal = prefill, fieldOverrides, staffReviews,
 * observations incl. autopick_suggestion and native readbacks, operationResults) and the append-only work_event log
 * (field.edit / field.accept / field.reject by staff with before/after pane state; ai_value + evidence.trace from
 * v2-edit-trace/1 on). Runs inside a READ ONLY transaction and writes only the JSONL file
 * (apps/server-pilot/.private/field-trace/ by default, gitignored).
 */
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { and, asc, gte, inArray, sql } from 'drizzle-orm';
import { createDb } from '../src/db/client.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { user } from '../src/db/schema/auth.js';
import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Draft } from '../src/ai/reservation-workflow-v2-contract.js';
import { hydrateStoredReservationWorkflowV2 } from '../src/ai/reservation-workflow-v2-stored-draft.js';
import { autopickSuggestionSummary, prefillValueAt } from '../src/ai/reservation-workflow-v2-edit-trace.js';

export const FIELD_TRACE_SCHEMA = 'nava-field-trace/1';
const KEY = 'reservationWorkflowV2';
const PREFIX = `${KEY}:`;
const DEFAULT_OUT = join(fileURLToPath(new URL('../.private/', import.meta.url)), 'field-trace', 'field-trace.jsonl');
const USAGE = 'usage: export-reservation-field-trace.ts [--out FILE] [--since ISO] [--property CODE] [--work-item UUID]';
const SKIP_KEYS = new Set(['id', 'kind', 'dateSectionId', 'sourceRefs', 'serviceRefs', 'documentRefs', 'candidateRefs',
  'priceObservationRefs', 'evidenceRefs', 'lookupResultRefs', 'currentObservationRefs', 'previewObservationRefs',
  'suggestedRef', 'ownerRequestId', 'targetRefs', 'uploadArtifactRef', 'documentSourceRef']);
const WORKFLOW_LABEL: Record<string, string> = { create: 'create', amend: 'amend', cancel: 'cancel', filing: 'filing',
  services: 'addons', quote: 'quote', other: 'other' };
/** Create Save readback: draft field key -> native readback field name (labtest-create-readback.mjs). */
const CREATE_READBACK: Record<string, string> = {
  arrival: 'arrivaldate', departure: 'departuredate', adults: 'adults', childCount: 'children', roomType: 'roomtype',
  ratePlan: 'rateplan', mealPlan: 'mealplan', roomTypeForCharge: 'roomtypecharge', reservationNote: 'reservationnote',
  firstName: 'firstname', lastName: 'lastname', sourceOfBusiness: 'sourceofbusinessdesc', organization: 'company',
  guaranteeType: 'guaranteetype', cmsSend: 'udfchkbox04', cmsMessageId: 'udfchar09', cmsRecipient: 'udfchar13',
  email: 'emailaddress', bookerName: 'caller', track: 'track', marketSegment: 'marketsegment', guestOptIn: 'guestoptin4',
  taCommission: 'ta1commission',
};

type Draft = ReservationWorkflowV2Draft;
type Overrides = Draft['fieldOverrides'];
export type TraceEvent = { id: string; type: string; actorKind: string; actorUserId: string | null; fieldPath: string | null;
  value: unknown; aiValue: unknown; evidence: unknown; at: Date };
type PaneDraft = { proposal: unknown; fieldOverrides: Overrides };

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const isParty = (value: unknown) => { const row = object(value);
  return Boolean(row && 'candidateRefs' in row && 'suggestedRef' in row && 'name' in row); };
const isChange = (value: unknown) => typeof object(value)?.op === 'string';
const decode = (part: string) => { try { return decodeURIComponent(part); } catch { return part; } };

/** Row key for a staff path: party name / native selection edits belong to the party (or guest) field. */
export function rowPathOf(path: string): string {
  return path.replace(/\/nativeSelectionRef$/u, '').replace(/(\/(?:bookingAgency|organization|arAccount))\/name$/u, '$1');
}

function walk(root: unknown, path: string, overrides: Overrides): unknown {
  let value: unknown = root, prefix = '';
  for (const raw of path.split('/').slice(1)) {
    const key = decode(raw);
    value = Array.isArray(value) ? (/^\d+$/.test(key) ? value[Number(key)] : value.find((row) => object(row)?.id === key))
      : object(value)?.[key];
    prefix += `/${raw}`;
    const override = overrides[prefix];
    if (override?.state === 'set') value = override.value;
    else if (override && override.state !== 'inherit') return null;
  }
  return value;
}

/** Effective value with staff overrides, including overrides on children (the pane's effectiveAt). */
export function effectiveValueAt(draft: PaneDraft, path: string, depth = 0): unknown {
  const raw = walk(draft, path, draft.fieldOverrides);
  if (depth > 12) return raw;
  const direct = draft.fieldOverrides[path];
  if (direct && ['none', 'clear', 'unknown'].includes(direct.state)) return null;
  const childKeys = Object.keys(draft.fieldOverrides).filter((key) => key.startsWith(`${path}/`))
    .map((key) => decode(key.slice(path.length + 1).split('/')[0]!));
  if (Array.isArray(raw)) return raw.map((_, index) => effectiveValueAt(draft, `${path}/${index}`, depth + 1));
  if (object(raw) || childKeys.length) {
    return Object.fromEntries([...new Set([...Object.keys(object(raw) ?? {}), ...childKeys])]
      .map((key) => [key, effectiveValueAt(draft, `${path}/${encodeURIComponent(key)}`, depth + 1)]));
  }
  return raw;
}

/** Comparable form: none envelopes are null, parties compare by name + chosen native ref. */
export function comparable(value: unknown): unknown {
  const row = object(value);
  if (row?.kind === 'none' && Object.keys(row).length === 1) return null;
  if (isParty(value)) return { name: row!.name ?? null, ref: row!.nativeSelectionRef ?? row!.suggestedRef ?? null };
  if (row && 'profileIntent' in row) return { ref: row.nativeSelectionRef ?? row.suggestedRef ?? null };
  return value === undefined ? null : value;
}

function leaves(value: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 10) return;
  if (Array.isArray(value)) {
    if (value.every((entry) => !object(entry))) { out.push(path); return; }
    value.forEach((entry, index) => {
      const id = object(entry)?.id;
      leaves(entry, `${path}/${encodeURIComponent(typeof id === 'string' ? id : String(index))}`, out, depth + 1);
    });
    return;
  }
  const row = object(value);
  // Parties and Amend change rows ({ op, field, value }) are one field each.
  if (!row || isParty(value) || isChange(value) || (row.kind === 'none' && Object.keys(row).length === 1)) { out.push(path); return; }
  for (const [key, child] of Object.entries(row)) {
    if (!SKIP_KEYS.has(key)) leaves(child, `${path}/${encodeURIComponent(key)}`, out, depth + 1);
  }
}

function scopeOf(draft: Draft, path: string): { workflow: string; requestId: string | null } {
  const [, , , collection, id] = path.split('/');
  const rowId = decode(id ?? '');
  if (collection === 'requests') {
    const request = draft.proposal.content.requests.find((row) => row.id === rowId);
    return { workflow: WORKFLOW_LABEL[request?.kind ?? ''] ?? 'unknown', requestId: request?.id ?? rowId };
  }
  if (collection === 'services') return { workflow: 'addons', requestId: rowId };
  if (collection === 'documents') {
    const document = draft.proposal.content.documents.find((row) => row.id === rowId);
    return { workflow: 'filing', requestId: document?.ownerRequestId ?? rowId };
  }
  return { workflow: 'unknown', requestId: null };
}

function fieldKey(path: string, prefill?: unknown): string {
  const change = object(prefill);
  if (change && typeof change.op === 'string') return typeof change.field === 'string' ? change.field : change.op;
  const parts = path.split('/').map(decode);
  return parts.at(-1) ?? path;
}

function readbackValue(nativeReadback: unknown, key: string): unknown {
  const native = object(nativeReadback);
  if (!native) return undefined;
  const fields = Array.isArray(native.fields) ? native.fields : null;
  const name = CREATE_READBACK[key] ?? key.toLowerCase();
  if (fields) {
    const hits = fields.map(object).filter((row) => row && row.name === name);
    if (hits.length === 1) return hits[0]!.value;
  }
  return Object.hasOwn(native, key) ? native[key] : undefined;
}

/** Pane state (proposal + overrides) at one draft revision, from the event log's before/after snapshots. */
function paneAtRevision(draft: Draft, events: TraceEvent[], revision: number): PaneDraft | null {
  const pane = (state: unknown): PaneDraft | null => {
    const v2 = object(object(state)?.[KEY]);
    return v2 ? { proposal: v2.proposal ?? draft.proposal, fieldOverrides: (object(v2.fieldOverrides) ?? {}) as Overrides } : null;
  };
  const evidence = (event: TraceEvent) => object(event.evidence);
  const at = [...events].reverse().find((event) => evidence(event)?.paneRevision === revision);
  if (at) return pane(evidence(at)!.paneState);
  const next = events.find((event) => evidence(event)?.paneRevision === revision + 1);
  if (next) return pane(evidence(next)!.previousPaneState);
  return draft.revision === revision ? { proposal: draft.proposal, fieldOverrides: draft.fieldOverrides } : null;
}

export function fieldTraceRows(input: {
  item: { id: string; threadId: string | null; sourceMessageId: string | null; transportId: string; createdAt: Date };
  draft: Draft; events: TraceEvent[]; users: Map<string, string>;
}): Record<string, unknown>[] {
  const { item, draft, users } = input;
  // Current generation only: traced events carry their generation; older ones count from the last source rebind.
  const rebind = input.events.filter((event) => event.fieldPath === `${PREFIX}source`).at(-1)?.at.getTime() ?? 0;
  const events = input.events.filter((event) => {
    const trace = object(object(event.evidence)?.trace);
    return typeof trace?.generationId === 'string' ? trace.generationId === draft.generationId : event.at.getTime() >= rebind;
  });
  const fieldEvents = events.filter((event) => event.actorKind === 'user' && event.fieldPath?.startsWith(`${PREFIX}/proposal/content/`) &&
    ['field.edit', 'field.accept', 'field.reject'].includes(event.type));
  const suggestions = draft.observations.filter((row) => row.generationId === draft.generationId &&
    row.criteria.kind === 'autopick_suggestion' && typeof row.criteria.selectionPath === 'string');

  const paths = new Set<string>();
  const content = draft.proposal.content;
  for (const [collection, rows] of [['requests', content.requests], ['services', content.services], ['documents', content.documents]] as const) {
    for (const row of rows) {
      const out: string[] = [];
      leaves(row, `/proposal/content/${collection}/${encodeURIComponent(row.id)}`, out);
      for (const path of out) if (path.split('/').length > 5) paths.add(path);
    }
  }
  const activity = [...Object.keys(draft.fieldOverrides), ...Object.keys(draft.staffReviews),
    ...fieldEvents.map((event) => event.fieldPath!.slice(PREFIX.length)),
    ...suggestions.map((row) => String(row.criteria.selectionPath))];
  for (const path of activity) if (path.startsWith('/proposal/content/') && path.split('/').length > 5) paths.add(rowPathOf(path));

  const operations = draft.operationResults.filter((row) => row.status === 'succeeded' || row.status === 'unknown')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const builds = [...new Set(events.map((event) => object(object(event.evidence)?.trace)?.build).filter((build) => typeof build === 'string'))];
  const who = (id: string | null) => id ? users.get(id) ?? id : null;
  const rows: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const scope = scopeOf(draft, path);
    const mine = (eventPath: string | null) => Boolean(eventPath && rowPathOf(eventPath.slice(PREFIX.length)) === path);
    const own = fieldEvents.filter((event) => mine(event.fieldPath));
    const edits = own.filter((event) => event.type !== 'field.accept');
    const ticks = own.filter((event) => event.type === 'field.accept');
    const firstTraced = own.find((event) => object(object(event.evidence)?.trace));
    const firstEvent = own[0];
    const priorPane = firstEvent ? object(object(object(firstEvent.evidence)?.previousPaneState)?.[KEY]) : null;
    const prefill = firstTraced && firstTraced.fieldPath === `${PREFIX}${path}` ? firstTraced.aiValue
      : prefillValueAt(priorPane?.proposal ? { proposal: priorPane.proposal as Draft['proposal'] } : draft, path);
    const final = effectiveValueAt(draft, path);
    // Own overrides (incl. a party's name / native selection) and whole-object overrides above this field.
    const overridePaths = Object.keys(draft.fieldOverrides).filter((key) => rowPathOf(key) === path || path.startsWith(`${key}/`));
    const overridden = overridePaths.some((key) => draft.fieldOverrides[key]!.state !== 'inherit');
    const reviewKeys = Object.keys(draft.staffReviews).filter((key) => rowPathOf(key) === path);
    const accepted = reviewKeys.some((key) => draft.staffReviews[key]!.status === 'accepted');
    const suggestion = suggestions.find((row) => rowPathOf(String(row.criteria.selectionPath)) === path);
    const annotation = draft.proposal.annotations.filter((row) => row.path === path || path.startsWith(`${row.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0];
    const allocation = /\/allocations\/([^/]+)\//u.exec(path)?.[1];
    const op = [...operations].reverse().find((row) => row.requestId === scope.requestId &&
      (!allocation || !row.allocationId || encodeURIComponent(row.allocationId) === allocation));
    const sentPane = op ? paneAtRevision(draft, events, op.draftRevision) : null;
    const readbackObservation = op ? draft.observations.find((row) => op.observationRefs.includes(row.ref) &&
      object(row.result)?.nativeReadback !== undefined) : undefined;
    const readback = readbackObservation ? readbackValue(object(readbackObservation.result)!.nativeReadback, fieldKey(path, prefill ?? final)) : undefined;
    const prefillComparable = comparable(prefill), finalComparable = comparable(final);
    const changed = JSON.stringify(prefillComparable) !== JSON.stringify(finalComparable);
    rows.push({
      schema: FIELD_TRACE_SCHEMA,
      work_item_id: item.id, transport_id: item.transportId, thread_id: item.threadId,
      message_id: draft.source.messageId ?? item.sourceMessageId, generation_id: draft.generationId,
      property_code: draft.propertyCode, workflow: scope.workflow, request_id: scope.requestId,
      field_key: fieldKey(path, prefill ?? final), field_path: path,
      prefill: { value: prefill ?? null, basis: annotation?.basis ?? null,
        review_required: draft.fieldReviewRequirements[path]?.required ?? null },
      suggestion: autopickSuggestionSummary(suggestion),
      staff: {
        ticked: accepted || ticks.length > 0,
        ticked_at: ticks.at(-1)?.at.toISOString() ?? null, ticked_by: who(ticks.at(-1)?.actorUserId ?? null),
        edited: overridden || edits.length > 0, edit_count: edits.length,
        first_edit_at: edits[0]?.at.toISOString() ?? null, last_edit_at: edits.at(-1)?.at.toISOString() ?? null,
        edited_by: [...new Set(edits.map((event) => who(event.actorUserId)).filter(Boolean))],
        edited_value: overridden ? final ?? null : null,
      },
      final_value: final ?? null,
      outcome: !changed ? (accepted || ticks.length ? 'accepted' : 'unchanged') : prefillComparable === null ? 'filled_by_staff' : 'changed',
      sent: op ? { value: sentPane ? effectiveValueAt(sentPane, path) ?? null : null, operation_id: op.id,
        operation_status: op.status, workflow: op.workflow, draft_revision: op.draftRevision, at: op.updatedAt,
        reconstructed: Boolean(sentPane) } : null,
      readback: readbackObservation ? { value: readback ?? null, mapped: readback !== undefined,
        observation_ref: readbackObservation.ref } : null,
      builds, item_created_at: item.createdAt.toISOString(),
      first_event_at: own[0]?.at.toISOString() ?? null, last_event_at: own.at(-1)?.at.toISOString() ?? null,
    });
  }
  return rows;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    out: { type: 'string' }, since: { type: 'string' }, property: { type: 'string' }, 'work-item': { type: 'string' } } });
  const since = values.since ? new Date(values.since) : null;
  if (positionals.length || (since && Number.isNaN(since.getTime()))) { console.error(USAGE); return 2; }
  const url = env.DATABASE_URL?.trim();
  if (!url) { console.error('DATABASE_URL is not set. The export reads work_item and work_event from it.'); return 2; }
  const { db, conn } = createDb(url);
  const rows: Record<string, unknown>[] = [];
  let items = 0, skipped = 0;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const filters = [sql`(${workItem.state} -> ${KEY}) is not null`];
      if (since) filters.push(gte(workItem.updatedAt, since));
      if (values['work-item']) filters.push(sql`${workItem.id} = ${values['work-item']}::uuid`);
      const found = await tx.select({ id: workItem.id, threadId: workItem.threadId, sourceMessageId: workItem.sourceMessageId,
        transportId: workItem.transportId, createdAt: workItem.createdAt, state: workItem.state })
        .from(workItem).where(and(...filters)).orderBy(asc(workItem.createdAt));
      const users = new Map((await tx.select({ id: user.id, email: user.email }).from(user)).map((row) => [row.id, row.email]));
      for (let start = 0; start < found.length; start += 200) {
        const batch = found.slice(start, start + 200);
        const events = await tx.select({ id: workEvent.id, workItemId: workEvent.workItemId, type: workEvent.type,
          actorKind: workEvent.actorKind, actorUserId: workEvent.actorUserId, fieldPath: workEvent.fieldPath,
          value: workEvent.value, aiValue: workEvent.aiValue, evidence: workEvent.evidence, at: workEvent.at })
          .from(workEvent).where(and(inArray(workEvent.workItemId, batch.map((row) => row.id)),
            sql`${workEvent.fieldPath} like ${`${PREFIX}%`}`)).orderBy(asc(workEvent.at), asc(workEvent.id));
        for (const item of batch) {
          const parsed = reservationWorkflowV2DraftSchema.safeParse(hydrateStoredReservationWorkflowV2(object(item.state)?.[KEY]));
          if (!parsed.success || (values.property && parsed.data.propertyCode !== values.property)) { skipped += 1; continue; }
          items += 1;
          rows.push(...fieldTraceRows({ item, draft: parsed.data, users,
            events: events.filter((event) => event.workItemId === item.id) }));
        }
      }
    });
  } finally {
    await conn.end();
  }
  const out = resolve(values.out ?? DEFAULT_OUT);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  console.log(JSON.stringify({ out, workItems: items, skipped, rows: rows.length }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(`export failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
