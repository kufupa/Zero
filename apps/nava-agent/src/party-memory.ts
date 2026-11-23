/** Party booking memory: high-confidence usual fields from prior same-party stays. */
import type { ProposalDraft } from './schema.js';
import { createTrackDefault } from './proposal-fields.js';
import type { LearnedSenderHit } from './party-matching.js';

/** Empirically gated: rate_plan ≥80%; guarantee_type ≥85% per-party (never blanket agency→GTDAGT). */
export const MEMORY_ELIGIBLE_FIELDS = ['rate_plan', 'guarantee_type'] as const;
export type MemoryField = (typeof MEMORY_ELIGIBLE_FIELDS)[number];
export type MemorySuggestion = {
  field: MemoryField; value: string; hits: number; total: number;
  partyKind: 'agency' | 'organization'; reason: string;
};
export type MemoryLookupFn = (args: {
  propertyCode: string; agencyId: string | null | undefined; organizationId: string | null | undefined;
  board?: string | null;
}) => MemorySuggestion[];
export type HistoryStay = {
  propertyCode: string; createdAtMs: number; agencyId?: string | null; organizationId?: string | null;
  board?: string | null;
  fields: Partial<Record<MemoryField, string | null | undefined>>;
};
type Sql = {(strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>};
type HitRow = {party_kind: string; field_name: string; field_value: string; hits: number};

const blank = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
const asId = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;

export function normalizeMemoryBoard(board: unknown): 'BB' | 'DBB' | 'RO' | null {
  const raw = String(board ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === 'BB' || upper === 'DBB' || upper === 'RO') return upper;
  if (/\bDBB\b|DINNER/.test(upper)) return 'DBB';
  if (/\bROOM\s*ONLY\b|\bRO\b/.test(upper)) return 'RO';
  if (/BED\s*(?:AND|&)\s*BREAKFAST|\bB\s*&\s*B\b|\bBB\b|BREAKFAST/.test(upper)) return 'BB';
  return null;
}

function precisionGate(fieldName: string, hits: number, total: number): boolean {
  if (total < 3) return false;
  if (fieldName === 'guarantee_type') return hits / total >= 0.85;
  return hits / total >= 0.80;
}

function pickTop(rows: HitRow[], agencyId: string | null, organizationId: string | null, board?: string | null): MemorySuggestion[] {
  type Acc = {partyKind: 'agency' | 'organization'; fieldName: string; value: string; hits: number; total: number};
  const groups = new Map<string, Acc>();
  for (const row of rows) {
    const fieldName = row.field_name;
    const baseField = fieldName.startsWith('rate_plan:') ? 'rate_plan'
      : MEMORY_ELIGIBLE_FIELDS.includes(fieldName as MemoryField) ? fieldName : null;
    if (!baseField) continue;
    const partyKind = row.party_kind === 'agency' || row.party_kind === 'organization' ? row.party_kind : null;
    if (!partyKind || (partyKind === 'agency' ? !agencyId : !organizationId)) continue;
    const key = `${partyKind}:${fieldName}`;
    const cur = groups.get(key) ?? {partyKind, fieldName, value: row.field_value, hits: 0, total: 0};
    cur.total += Number(row.hits) || 0;
    if (row.hits > cur.hits) { cur.hits = Number(row.hits) || 0; cur.value = String(row.field_value); }
    groups.set(key, cur);
  }

  const boardKey = normalizeMemoryBoard(board);
  const byField = new Map<MemoryField, MemorySuggestion>();

  const consider = (cur: Acc, field: MemoryField) => {
    if (!precisionGate(field === 'guarantee_type' ? 'guarantee_type' : 'rate_plan', cur.hits, cur.total)) return;
    const next: MemorySuggestion = {
      field, value: cur.value, hits: cur.hits, total: cur.total, partyKind: cur.partyKind,
      reason: `Usual for ${cur.partyKind} (${cur.hits}/${cur.total} stays)`,
    };
    const prev = byField.get(field);
    const better = !prev || (cur.partyKind === 'agency' && prev.partyKind !== 'agency')
      || (cur.partyKind === prev.partyKind && (cur.hits / cur.total > prev.hits / prev.total
        || (cur.hits / cur.total === prev.hits / prev.total && cur.total > prev.total)));
    if (better) byField.set(field, next);
  };

  // Board-specific rate_plan first when requested, then plain rate_plan / guarantee_type.
  if (boardKey) {
    for (const cur of groups.values()) {
      if (cur.fieldName === `rate_plan:${boardKey}`) consider(cur, 'rate_plan');
    }
  }
  for (const cur of groups.values()) {
    if (cur.fieldName === 'rate_plan' && !byField.has('rate_plan')) consider(cur, 'rate_plan');
    if (cur.fieldName === 'guarantee_type') consider(cur, 'guarantee_type');
  }
  return [...byField.values()];
}

function memoryFieldWrites(fields: Record<string, unknown>, board?: string | null): Array<{field: string; value: string}> {
  const out: Array<{field: string; value: string}> = [];
  for (const field of MEMORY_ELIGIBLE_FIELDS) {
    const value = fields[field];
    if (blank(value)) continue;
    out.push({field, value: String(value)});
  }
  const rate = fields.rate_plan;
  const boardKey = normalizeMemoryBoard(board ?? fields.board);
  if (!blank(rate) && boardKey) out.push({field: `rate_plan:${boardKey}`, value: String(rate)});
  return out;
}

/** Pure time-gated memory (`createdAtMs < cutoffMs`) — shared by Postgres lookup shape + replay bench. */
export function buildMemoryFromHistory(stays: HistoryStay[], cutoffMs: number): MemoryLookupFn {
  const hits = new Map<string, Map<string, number>>();
  for (const stay of stays) {
    if (!(stay.createdAtMs < cutoffMs)) continue;
    for (const [kind, partyId] of [['agency', stay.agencyId], ['organization', stay.organizationId]] as const) {
      if (!partyId) continue;
      for (const {field, value} of memoryFieldWrites(stay.fields as Record<string, unknown>, stay.board)) {
        const key = `${stay.propertyCode}\0${kind}\0${partyId}\0${field}`;
        const ctr = hits.get(key) ?? new Map<string, number>();
        ctr.set(value, (ctr.get(value) ?? 0) + 1);
        hits.set(key, ctr);
      }
    }
  }
  const rows: Array<HitRow & {property_code: string; party_id: string}> = [];
  for (const [key, ctr] of hits) {
    const [property_code, party_kind, party_id, field_name] = key.split('\0');
    for (const [field_value, n] of ctr) rows.push({property_code, party_kind, party_id, field_name, field_value, hits: n});
  }
  return ({propertyCode, agencyId, organizationId, board}) => pickTop(
    rows.filter(row => row.property_code === propertyCode
      && ((agencyId && row.party_kind === 'agency' && row.party_id === agencyId)
        || (organizationId && row.party_kind === 'organization' && row.party_id === organizationId))),
    asId(agencyId), asId(organizationId), board,
  );
}

export async function lookupPartyMemory(
  sql: Sql, args: {propertyCode: string; agencyId?: string | null; organizationId?: string | null; board?: string | null},
): Promise<MemorySuggestion[]> {
  const agencyId = asId(args.agencyId), organizationId = asId(args.organizationId);
  if (!agencyId && !organizationId) return [];
  const rows = await sql`
    SELECT party_kind, field_name, field_value, hits FROM nava_agent.party_booking_memory
    WHERE property_code = ${args.propertyCode} AND (
      (${agencyId}::text IS NOT NULL AND party_kind = 'agency' AND party_id = ${agencyId})
      OR (${organizationId}::text IS NOT NULL AND party_kind = 'organization' AND party_id = ${organizationId}))`;
  return pickTop(rows as HitRow[], agencyId, organizationId, args.board);
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
    for (const {field, value} of memoryFieldWrites(args.fields)) {
      await sql`
        INSERT INTO nava_agent.party_booking_memory AS m
          (property_code, party_kind, party_id, field_name, field_value, hits)
        VALUES (${args.propertyCode}, ${kind}, ${partyId}, ${field}, ${value}, 1)
        ON CONFLICT (property_code, party_kind, party_id, field_name, field_value)
        DO UPDATE SET hits = m.hits + 1, updated_at = now()`;
    }
  }
}

export async function lookupSenderPartyMemory(
  sql: Sql,
  args: {propertyCode: string; host: string; kind: 'agency' | 'organization'},
): Promise<LearnedSenderHit | null> {
  const host = args.host.trim().toLowerCase();
  if (!host) return null;
  const rows = await sql`
    SELECT host, party_name, native_id, hits, direct_misses FROM nava_agent.sender_party_memory
    WHERE property_code = ${args.propertyCode} AND party_kind = ${args.kind}
      AND (host = ${host} OR ${host} LIKE '%.' || host)
    ORDER BY length(host) DESC, hits DESC`;
  if (!rows.length) return null;
  const matchedHost = String(rows[0]!.host);
  const scoped = rows.filter(row => String(row.host) === matchedHost);
  const directMisses = Math.max(0, ...scoped.map(row => Number(row.direct_misses) || 0));
  const totalHits = scoped.reduce((sum, row) => sum + (Number(row.hits) || 0), 0);
  const best = scoped.reduce((a, b) => (Number(b.hits) || 0) > (Number(a.hits) || 0) ? b : a);
  const hits = Number(best.hits) || 0;
  const total = totalHits + (args.kind === 'agency' ? directMisses : 0);
  if (total < 3 || hits / total < 0.80) return null;
  if (args.kind === 'agency' && hits / (hits + directMisses) < 0.85) return null;
  return {
    host: matchedHost,
    kind: args.kind,
    name: String(best.party_name),
    nativeId: best.native_id == null ? null : String(best.native_id),
    support: hits,
  };
}

export async function recordSavedSenderParty(
  sql: Sql,
  args: {
    propertyCode: string; host: string;
    agencyName?: string | null; agencyId?: string | null;
    organizationName?: string | null; organizationId?: string | null;
  },
): Promise<void> {
  const host = args.host.trim().toLowerCase();
  if (!host || !args.propertyCode) return;
  const agencyName = typeof args.agencyName === 'string' && args.agencyName.trim() ? args.agencyName.trim() : null;
  const organizationName = typeof args.organizationName === 'string' && args.organizationName.trim() ? args.organizationName.trim() : null;

  if (agencyName) {
    await sql`
      INSERT INTO nava_agent.sender_party_memory AS m
        (property_code, host, party_kind, party_name, native_id, hits, direct_misses)
      VALUES (${args.propertyCode}, ${host}, 'agency', ${agencyName}, ${asId(args.agencyId)}, 1, 0)
      ON CONFLICT (property_code, host, party_kind, party_name)
      DO UPDATE SET hits = m.hits + 1,
        native_id = COALESCE(EXCLUDED.native_id, m.native_id),
        updated_at = now()`;
  } else {
    await sql`
      UPDATE nava_agent.sender_party_memory
      SET direct_misses = direct_misses + 1, updated_at = now()
      WHERE property_code = ${args.propertyCode} AND host = ${host} AND party_kind = 'agency'`;
  }

  if (organizationName) {
    await sql`
      INSERT INTO nava_agent.sender_party_memory AS m
        (property_code, host, party_kind, party_name, native_id, hits, direct_misses)
      VALUES (${args.propertyCode}, ${host}, 'organization', ${organizationName}, ${asId(args.organizationId)}, 1, 0)
      ON CONFLICT (property_code, host, party_kind, party_name)
      DO UPDATE SET hits = m.hits + 1,
        native_id = COALESCE(EXCLUDED.native_id, m.native_id),
        updated_at = now()`;
  }
}

/** Compact Turn-1 prompt card; null when nothing useful. */
export function formatClientCard(args: {
  senderHost?: string | null;
  agency?: LearnedSenderHit | null;
  organization?: LearnedSenderHit | null;
  memory?: MemorySuggestion[];
}): string | null {
  const lines: string[] = [];
  if (args.senderHost) lines.push(`Host: ${args.senderHost}`);
  if (args.agency) {
    lines.push(`Agency: ${args.agency.name}${args.agency.nativeId ? ` [${args.agency.nativeId}]` : ''} (${args.agency.support})`);
  }
  if (args.organization) {
    lines.push(`Company: ${args.organization.name}${args.organization.nativeId ? ` [${args.organization.nativeId}]` : ''} (${args.organization.support})`);
  }
  for (const sug of args.memory ?? []) {
    lines.push(`${sug.field}: ${sug.value} (${sug.hits}/${sug.total})`);
  }
  if (!lines.length) return null;
  return ['[Client Memory Card]', ...lines.slice(0, 4)].join('\n');
}

/** Prefill silent Create blanks or model defaults (`provenance: 'default'`); never override explicit email evidence. */
export function applyPartyMemoryToDraft(draft: ProposalDraft, lookupFn: MemoryLookupFn): ProposalDraft {
  if (draft.workflow !== 'create') return draft;
  const fieldSpecs = [...draft.field_specs];
  const bookings = draft.bookings.map((booking, index) => {
    const fields = {...booking.fields};
    const propertyCode = String(booking.property_code ?? '').trim().toUpperCase();
    if (!propertyCode) return booking;
    const board = typeof fields.board === 'string' ? fields.board : null;
    for (const sug of lookupFn({
      propertyCode, agencyId: asId(fields.agency_id), organizationId: asId(fields.organization_id), board,
    })) {
      const path = `/bookings/${index}/fields/${sug.field}`;
      const spec = fieldSpecs.findIndex(field => field.path === path || field.path === path.slice(1));
      const existing = spec >= 0 ? fieldSpecs[spec] : null;
      const isDefault = existing?.provenance === 'default' && !existing.error;
      if (!blank(fields[sug.field]) && !isDefault) continue;
      if (!isDefault && existing && (existing.provenance === 'staff' || existing.evidence.length || existing.error)) continue;
      fields[sug.field] = sug.value;
      const evidence = [{message_id: 'party_memory', attachment_id: null, quote: sug.reason}];
      const label = sug.field === 'guarantee_type' ? 'Guarantee type' : 'Rate plan';
      if (spec >= 0) fieldSpecs[spec] = {...fieldSpecs[spec], path, provenance: 'default', error: null, evidence};
      else fieldSpecs.push({
        path, label, provenance: 'default', editable: true, required: false,
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
