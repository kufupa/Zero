/** Party booking memory: high-confidence usual fields from prior same-party stays. */
import type { ProposalDraft } from './schema.js';
import { createTrackDefault } from './proposal-fields.js';

/** Empirically gated: rate_plan ≥80% precision on time-gated 358-dev + 188-Nov-test Creates. */
export const MEMORY_ELIGIBLE_FIELDS = ['rate_plan'] as const;
export type MemoryField = (typeof MEMORY_ELIGIBLE_FIELDS)[number];
export type MemorySuggestion = {
  field: MemoryField; value: string; hits: number; total: number;
  partyKind: 'agency' | 'organization'; reason: string;
};
export type MemoryLookupFn = (args: {
  propertyCode: string; agencyId: string | null | undefined; organizationId: string | null | undefined;
}) => MemorySuggestion[];
export type HistoryStay = {
  propertyCode: string; createdAtMs: number; agencyId?: string | null; organizationId?: string | null;
  fields: Partial<Record<MemoryField, string | null | undefined>>;
};
type Sql = {(strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>};
type HitRow = {party_kind: string; field_name: string; field_value: string; hits: number};

const blank = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
const asId = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;

function pickTop(rows: HitRow[], agencyId: string | null, organizationId: string | null): MemorySuggestion[] {
  type Acc = {partyKind: 'agency' | 'organization'; field: MemoryField; value: string; hits: number; total: number};
  const groups = new Map<string, Acc>();
  for (const row of rows) {
    if (!MEMORY_ELIGIBLE_FIELDS.includes(row.field_name as MemoryField)) continue;
    const partyKind = row.party_kind === 'agency' || row.party_kind === 'organization' ? row.party_kind : null;
    if (!partyKind || (partyKind === 'agency' ? !agencyId : !organizationId)) continue;
    const key = `${partyKind}:${row.field_name}`;
    const cur = groups.get(key) ?? {partyKind, field: row.field_name as MemoryField, value: row.field_value, hits: 0, total: 0};
    cur.total += Number(row.hits) || 0;
    if (row.hits > cur.hits) { cur.hits = Number(row.hits) || 0; cur.value = String(row.field_value); }
    groups.set(key, cur);
  }
  const byField = new Map<MemoryField, MemorySuggestion>();
  for (const cur of groups.values()) {
    if (cur.total < 3 || cur.hits / cur.total < 0.80) continue;
    const next: MemorySuggestion = {
      field: cur.field, value: cur.value, hits: cur.hits, total: cur.total, partyKind: cur.partyKind,
      reason: `Usual for ${cur.partyKind} (${cur.hits}/${cur.total} stays)`,
    };
    const prev = byField.get(cur.field);
    const better = !prev || (cur.partyKind === 'agency' && prev.partyKind !== 'agency')
      || (cur.partyKind === prev.partyKind && (cur.hits / cur.total > prev.hits / prev.total
        || (cur.hits / cur.total === prev.hits / prev.total && cur.total > prev.total)));
    if (better) byField.set(cur.field, next);
  }
  return [...byField.values()];
}

/** Pure time-gated memory (`createdAtMs < cutoffMs`) — shared by Postgres lookup shape + replay bench. */
export function buildMemoryFromHistory(stays: HistoryStay[], cutoffMs: number): MemoryLookupFn {
  const hits = new Map<string, Map<string, number>>();
  for (const stay of stays) {
    if (!(stay.createdAtMs < cutoffMs)) continue;
    for (const [kind, partyId] of [['agency', stay.agencyId], ['organization', stay.organizationId]] as const) {
      if (!partyId) continue;
      for (const field of MEMORY_ELIGIBLE_FIELDS) {
        const value = stay.fields[field];
        if (blank(value)) continue;
        const key = `${stay.propertyCode}\0${kind}\0${partyId}\0${field}`;
        const ctr = hits.get(key) ?? new Map<string, number>();
        ctr.set(String(value), (ctr.get(String(value)) ?? 0) + 1);
        hits.set(key, ctr);
      }
    }
  }
  const rows: Array<HitRow & {property_code: string; party_id: string}> = [];
  for (const [key, ctr] of hits) {
    const [property_code, party_kind, party_id, field_name] = key.split('\0');
    for (const [field_value, n] of ctr) rows.push({property_code, party_kind, party_id, field_name, field_value, hits: n});
  }
  return ({propertyCode, agencyId, organizationId}) => pickTop(
    rows.filter(row => row.property_code === propertyCode
      && ((agencyId && row.party_kind === 'agency' && row.party_id === agencyId)
        || (organizationId && row.party_kind === 'organization' && row.party_id === organizationId))),
    asId(agencyId), asId(organizationId),
  );
}

export async function lookupPartyMemory(
  sql: Sql, args: {propertyCode: string; agencyId?: string | null; organizationId?: string | null},
): Promise<MemorySuggestion[]> {
  const agencyId = asId(args.agencyId), organizationId = asId(args.organizationId);
  if (!agencyId && !organizationId) return [];
  const rows = await sql`
    SELECT party_kind, field_name, field_value, hits FROM nava_agent.party_booking_memory
    WHERE property_code = ${args.propertyCode} AND (
      (${agencyId}::text IS NOT NULL AND party_kind = 'agency' AND party_id = ${agencyId})
      OR (${organizationId}::text IS NOT NULL AND party_kind = 'organization' AND party_id = ${organizationId}))`;
  return pickTop(rows as HitRow[], agencyId, organizationId);
}

export async function recordSavedStayMemory(
  sql: Sql,
  args: {propertyCode: string; agencyId?: string | null; organizationId?: string | null; fields: Record<string, unknown>},
): Promise<void> {
  const parties: Array<['agency' | 'organization', string]> = [];
  const agencyId = asId(args.agencyId), organizationId = asId(args.organizationId);
  if (agencyId) parties.push(['agency', agencyId]);
  if (organizationId) parties.push(['organization', organizationId]);
  for (const [kind, partyId] of parties) {
    for (const field of MEMORY_ELIGIBLE_FIELDS) {
      const value = args.fields[field];
      if (blank(value)) continue;
      await sql`
        INSERT INTO nava_agent.party_booking_memory AS m
          (property_code, party_kind, party_id, field_name, field_value, hits)
        VALUES (${args.propertyCode}, ${kind}, ${partyId}, ${field}, ${String(value)}, 1)
        ON CONFLICT (property_code, party_kind, party_id, field_name, field_value)
        DO UPDATE SET hits = m.hits + 1, updated_at = now()`;
    }
  }
}

/** Prefill silent Create blanks or model defaults (`provenance: 'default'`); never override explicit email evidence. */
export function applyPartyMemoryToDraft(draft: ProposalDraft, lookupFn: MemoryLookupFn): ProposalDraft {
  if (draft.workflow !== 'create') return draft;
  const fieldSpecs = [...draft.field_specs];
  const bookings = draft.bookings.map((booking, index) => {
    const fields = {...booking.fields};
    const propertyCode = String(booking.property_code ?? '').trim().toUpperCase();
    if (!propertyCode) return booking;
    for (const sug of lookupFn({propertyCode, agencyId: asId(fields.agency_id), organizationId: asId(fields.organization_id)})) {
      const path = `/bookings/${index}/fields/${sug.field}`;
      const spec = fieldSpecs.findIndex(field => field.path === path || field.path === path.slice(1));
      const existing = spec >= 0 ? fieldSpecs[spec] : null;
      const isDefault = existing?.provenance === 'default' && !existing.error;
      if (!blank(fields[sug.field]) && !isDefault) continue;
      if (!isDefault && existing && (existing.provenance === 'staff' || existing.evidence.length || existing.error)) continue;
      fields[sug.field] = sug.value;
      const evidence = [{message_id: 'party_memory', attachment_id: null, quote: sug.reason}];
      if (spec >= 0) fieldSpecs[spec] = {...fieldSpecs[spec], path, provenance: 'default', error: null, evidence};
      else fieldSpecs.push({
        path, label: 'Rate plan', provenance: 'default', editable: true, required: false,
        error: null, control: 'text', options: [], evidence,
      });
      if (sug.field === 'rate_plan') {
        const trackPath = `/bookings/${index}/fields/track`;
        const trackIdx = fieldSpecs.findIndex(field => field.path === trackPath || field.path === trackPath.slice(1));
        const trackSpec = trackIdx >= 0 ? fieldSpecs[trackIdx] : null;
        const trackIsDefault = trackSpec?.provenance === 'default' && !trackSpec.error;
        if ((blank(fields.track) || trackIsDefault) && (trackIsDefault || !trackSpec || (trackSpec.provenance !== 'staff' && !trackSpec.evidence.length && !trackSpec.error))) {
          const nextTrack = createTrackDefault(fields);
          if (nextTrack !== (fields.track ?? null)) {
            fields.track = nextTrack;
            if (trackIdx >= 0) fieldSpecs[trackIdx] = {...fieldSpecs[trackIdx], path: trackPath, provenance: nextTrack ? 'default' : 'unknown', error: null, evidence: []};
          }
        }
      }
    }
    return {...booking, fields};
  });
  return {...draft, bookings, field_specs: fieldSpecs};
}
