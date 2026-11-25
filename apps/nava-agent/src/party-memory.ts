/** Party booking memory: high-confidence usual fields from prior same-party stays. */
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import type { ProposalDraft } from './schema.js';
import { createRoomTypeCode, createTrackDefault, normalizeMemoryBoard } from './proposal-fields.js';
import { normalizePartyName, type LearnedSenderHit } from './party-matching.js';
import { normalizeGuaranteeCode } from './guarantee-normalize.mjs';
import { bookingPolicyKeys, HISTORY_FIELDS, historyRowKey, policyKeys, type HistoryKey, type PolicyKeys, type PolicyRow } from './history-policy.js';

export { normalizeMemoryBoard };

export const MEMORY_ELIGIBLE_FIELDS = ['board', 'rate_plan', 'room_type', 'guarantee_type',
  'ar_account_name', 'billing_reference', 'agency_name', 'organization_name'] as const;
export type MemoryField = (typeof MEMORY_ELIGIBLE_FIELDS)[number];
export type MemorySuggestion = {
  field: MemoryField; value: string; hits: number; total: number;
  partyKind?: 'agency' | 'organization'; reason: string; historyPolicy?: true;
};
export type MemoryLookupArgs = {
  propertyCode: string; agencyId: string | null | undefined; organizationId: string | null | undefined;
  board?: string | null; keys?: PolicyKeys;
};
export type MemoryLookupFn = (args: MemoryLookupArgs) => MemorySuggestion[];
export type HistoryPolicyLookup = (keys: PolicyKeys) => PolicyRow[];
export type HistoryStay = {
  propertyCode: string; createdAtMs: number; agencyId?: string | null; organizationId?: string | null;
  board?: string | null;
  fields: Partial<Record<MemoryField, string | null | undefined>>;
};
type Sql = {(strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>>};
type HitRow = {party_kind: string; field_name: string; field_value: string; hits: number};

const blank = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
const asId = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;

const keyLabels: Record<HistoryKey, string> = {
  booker_email: 'this booker', booker_domain: 'this sender domain', company: 'this company',
  ta1: 'this agency', guest_id: 'this guest profile',
};

function mergePolicyMemory(policy: PolicyRow[], fallback: MemorySuggestion[], property: string, board?: string | null): MemorySuggestion[] {
  const byField = new Map<MemoryField, MemorySuggestion>();
  const requestedBoard = normalizeMemoryBoard(board);
  for (const row of policy) {
    const field = HISTORY_FIELDS[row.field];
    if (!field || byField.has(field)) continue;
    if (field === 'rate_plan' && requestedBoard) {
      const partyBoard = policy.find(other => other.field === 'mealplan' && other.key_type === row.key_type && other.key === row.key);
      const usualBoard = normalizeMemoryBoard(partyBoard?.value);
      if (usualBoard && usualBoard !== requestedBoard) continue;
    }
    const value = field === 'board' ? normalizeMemoryBoard(row.value)
      : property === 'HRCEN' && field === 'guarantee_type' ? normalizeGuaranteeCode(row.value)
        : property === 'HRCEN' && field === 'room_type' ? createRoomTypeCode(row.value) : row.value;
    if (!value) continue;
    const hits = Math.round(row.agreement * row.support);
    byField.set(field, {field, value, hits, total: row.support, historyPolicy: true,
      reason: `HMS history for ${keyLabels[row.key_type]} (${hits}/${row.support} stays; last seen ${row.last_seen.slice(0, 10)})`});
  }
  for (const suggestion of fallback) if (!byField.has(suggestion.field)) byField.set(suggestion.field, suggestion);
  return MEMORY_ELIGIBLE_FIELDS.flatMap(field => byField.has(field) ? [byField.get(field)!] : []);
}

export function memoryLookupArgs(propertyCode: string, fields: Record<string, unknown>, sender?: PolicyKeys): MemoryLookupArgs {
  return {
    propertyCode, agencyId: asId(fields.agency_id), organizationId: asId(fields.organization_id),
    board: normalizeMemoryBoard(fields.board) ?? asId(fields.board), keys: bookingPolicyKeys(fields, sender),
  };
}

/** Verified direct employer/org only — never intermediary invoice addressee as organization. */
export function verifiedDirectOrgMatch(
  hit: LearnedSenderHit | null | undefined,
  agencyName?: string | null,
): LearnedSenderHit | null {
  if (!hit || hit.kind !== 'organization' || (!hit.name && !hit.nativeId)) return null;
  if (agencyName && normalizePartyName(hit.name) === normalizePartyName(agencyName)) return null;
  return hit;
}

function precisionGate(fieldName: string, hits: number, total: number): boolean {
  if (total < 3) return false;
  if (fieldName === 'guarantee_type' || fieldName === 'board' || fieldName.startsWith('rate_plan:org=')) return hits / total >= 0.85;
  return hits / total >= 0.80;
}

/** HRCEN only: merge guarantee aliases; keep unknown hits in the precision denominator. */
function coalesceHrcenGuaranteeRows(rows: HitRow[]): HitRow[] {
  const out: HitRow[] = [];
  const guarantee = new Map<string, HitRow>();
  for (const row of rows) {
    if (row.field_name !== 'guarantee_type') {
      out.push(row);
      continue;
    }
    const hits = Number(row.hits) || 0;
    const code = normalizeGuaranteeCode(row.field_value);
    if (!code) {
      out.push({...row, hits});
      continue;
    }
    const key = `${row.party_kind}\0${code}`;
    const cur = guarantee.get(key);
    if (cur) cur.hits += hits;
    else guarantee.set(key, {...row, field_value: code, hits});
  }
  return out.concat([...guarantee.values()]);
}

function pickTop(rows: HitRow[], agencyId: string | null, organizationId: string | null, board?: string | null, propertyCode?: string): MemorySuggestion[] {
  type Acc = {partyKind: 'agency' | 'organization'; fieldName: string; value: string; hits: number; total: number};
  const groups = new Map<string, Acc>();
  const normalized = propertyCode === 'HRCEN' ? coalesceHrcenGuaranteeRows(rows) : rows;
  for (const row of normalized) {
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

  const byField = new Map<MemoryField, MemorySuggestion>();

  const consider = (cur: Acc, field: MemoryField, preferOrg = false) => {
    if (field === 'guarantee_type' && propertyCode === 'HRCEN' && !normalizeGuaranteeCode(cur.value)) return;
    if (!precisionGate(cur.fieldName, cur.hits, cur.total)) return;
    const labelKind = cur.fieldName.startsWith('rate_plan:org=') ? 'agency+company' : cur.partyKind;
    const next: MemorySuggestion = {
      field, value: cur.value, hits: cur.hits, total: cur.total, partyKind: cur.partyKind,
      reason: `Usual for ${labelKind} (${cur.hits}/${cur.total} stays)`,
    };
    const prev = byField.get(field);
    const preferredKind = preferOrg ? 'organization' : 'agency';
    const better = !prev || (cur.partyKind === preferredKind && prev.partyKind !== preferredKind)
      || (cur.partyKind === prev.partyKind && (cur.hits / cur.total > prev.hits / prev.total
        || (cur.hits / cur.total === prev.hits / prev.total && cur.total > prev.total)));
    if (better) byField.set(field, next);
  };

  // 1. Resolve board first (never overrides explicit email board at apply time) so rate_plan can cascade on it.
  for (const cur of groups.values()) {
    if (cur.fieldName === 'board') consider(cur, 'board');
  }
  const boardKey = normalizeMemoryBoard(board) ?? normalizeMemoryBoard(byField.get('board')?.value);

  // 2. Rate plan cascade: agency+org+board → agency+org → org/agency+board → plain rate_plan.
  if (agencyId && organizationId && boardKey) {
    for (const cur of groups.values()) {
      if (cur.partyKind === 'agency' && cur.fieldName === `rate_plan:org=${organizationId}:${boardKey}`) consider(cur, 'rate_plan');
    }
  }
  if (agencyId && organizationId && !byField.has('rate_plan')) {
    for (const cur of groups.values()) {
      if (cur.partyKind === 'agency' && cur.fieldName === `rate_plan:org=${organizationId}`) consider(cur, 'rate_plan');
    }
  }
  if (boardKey && !byField.has('rate_plan')) {
    for (const cur of groups.values()) {
      if (cur.fieldName === `rate_plan:${boardKey}`) consider(cur, 'rate_plan', true);
    }
  }
  for (const cur of groups.values()) {
    if (cur.fieldName === 'rate_plan' && !byField.has('rate_plan')) consider(cur, 'rate_plan');
    if (cur.fieldName === 'guarantee_type') consider(cur, 'guarantee_type');
  }
  return MEMORY_ELIGIBLE_FIELDS.flatMap(f => byField.has(f) ? [byField.get(f)!] : []);
}

function memoryFieldWrites(
  fields: Record<string, unknown>,
  board?: string | null,
  partyKind?: 'agency' | 'organization',
  organizationId?: string | null,
  propertyCode?: string,
): Array<{field: string; value: string}> {
  const out: Array<{field: string; value: string}> = [];
  const boardKey = normalizeMemoryBoard(board ?? fields.board);
  if (boardKey) out.push({field: 'board', value: boardKey});
  for (const field of ['rate_plan', 'guarantee_type'] as const) {
    const value = fields[field];
    if (blank(value)) continue;
    if (field === 'guarantee_type' && propertyCode === 'HRCEN') {
      const code = normalizeGuaranteeCode(value);
      if (!code) continue;
      out.push({field, value: code});
      continue;
    }
    out.push({field, value: String(value)});
  }
  const rate = fields.rate_plan;
  if (!blank(rate) && boardKey) out.push({field: `rate_plan:${boardKey}`, value: String(rate)});
  if (partyKind === 'agency' && organizationId && !blank(rate)) {
    out.push({field: `rate_plan:org=${organizationId}`, value: String(rate)});
    if (boardKey) out.push({field: `rate_plan:org=${organizationId}:${boardKey}`, value: String(rate)});
  }
  return out;
}

/** Native Record View names → memory field. Only unique observed values teach. */
const READBACK_MEMORY_FIELDS = {
  mealplan: 'board',
  rateplan: 'rate_plan',
  guaranteetype: 'guarantee_type',
} as const;

function uniqueReadbackValue(readback: unknown, nativeName: string): string | null {
  const fields = Array.isArray((readback as {fields?: unknown})?.fields)
    ? (readback as {fields: Array<Record<string, unknown>>}).fields : null;
  if (!fields) return null;
  const matches = fields.filter(row => row && String(row.name ?? '') === nativeName);
  if (matches.length !== 1) return null;
  const value = matches[0]!.value;
  if (value == null || (typeof value !== 'string' && typeof value !== 'number')) return null;
  const text = String(value).trim();
  return text || null;
}

function readbackMismatchBlocks(readback: unknown, memoryField: MemoryField): boolean {
  const mismatches = Array.isArray((readback as {mismatches?: unknown})?.mismatches)
    ? (readback as {mismatches: unknown[]}).mismatches : null;
  if (!mismatches) return true; // cannot confirm without mismatches array
  if (!mismatches.length) return false;
  const aliases: Partial<Record<MemoryField, string[]>> = {
    board: ['mealPlan', 'mealplan', 'board'],
    rate_plan: ['ratePlan', 'rateplan'],
    guarantee_type: ['guaranteeType', 'guaranteetype', 'guaranteeTypeCode'],
  };
  return mismatches.some(item => {
    if (!item || typeof item !== 'object') return true;
    const field = String((item as {field?: unknown}).field ?? '');
    return aliases[memoryField]?.some(alias => field.toLowerCase() === alias.toLowerCase()) ?? false;
  });
}

/** Per-role sender attribution signal: positive name, confirmed negative (explicit empty), or unobserved (abstain). */
export type PartyAttribution = 'positive' | 'negative' | 'unobserved';

/**
 * ta1/company readback → attribution signal. Exactly one field with an explicit
 * empty value and no role mismatch is a confirmed negative; a unique non-empty
 * value is positive; anything else (absent, duplicate, null, invalid, mismatched)
 * is unobserved — the writer must abstain, not guess a negative.
 */
function readbackRoleAttribution(
  readback: unknown,
  nativeName: string,
  role: 'agency' | 'organization',
): { signal: 'positive'; name: string } | { signal: 'negative' | 'unobserved' } {
  const fields = Array.isArray((readback as {fields?: unknown})?.fields)
    ? (readback as {fields: Array<Record<string, unknown>>}).fields : null;
  if (!fields) return {signal: 'unobserved'};
  const matches = fields.filter(row => row && String(row.name ?? '') === nativeName);
  if (matches.length !== 1) return {signal: 'unobserved'};
  const value = matches[0]!.value;
  if (value == null) return {signal: 'unobserved'};
  if (typeof value !== 'string' && typeof value !== 'number') return {signal: 'unobserved'};
  const name = String(value).trim();
  if (partyReadbackMismatch(readback, role)) return {signal: 'unobserved'};
  return name ? {signal: 'positive', name} : {signal: 'negative'};
}

/** True when readback recorded a mismatch on party native fields (ta1/company). */
function partyReadbackMismatch(readback: unknown, role: 'agency' | 'organization'): boolean {
  const mismatches = Array.isArray((readback as {mismatches?: unknown})?.mismatches)
    ? (readback as {mismatches: unknown[]}).mismatches : null;
  if (!mismatches) return true;
  const aliases = role === 'agency'
    ? ['ta1', 'agency', 'travelagency']
    : ['company', 'organization', 'org'];
  return mismatches.some(item => {
    if (!item || typeof item !== 'object') return false;
    const field = String((item as {field?: unknown}).field ?? '').toLowerCase();
    return aliases.includes(field);
  });
}

function isLabtestReadback(readback: unknown, bookingFields: Record<string, unknown>): boolean {
  const first = uniqueReadbackValue(readback, 'firstname')
    ?? (typeof bookingFields.first_name === 'string' ? bookingFields.first_name : null);
  const last = uniqueReadbackValue(readback, 'lastname')
    ?? (typeof bookingFields.last_name === 'string' ? bookingFields.last_name : null);
  return /^proof$/i.test(String(first ?? '').trim()) && /^labtest$/i.test(String(last ?? '').trim());
}

export type ObservedStayChoice = {
  propertyCode: string;
  nativeEventId: string;
  reservationId: string | null;
  agencyId: string | null;
  organizationId: string | null;
  agencyName: string | null;
  organizationName: string | null;
  fields: Record<string, string>;
  host: string | null;
  availableAt: string | null;
  evidenceRef: string;
  origin: 'native_readback' | 'staff_correction';
  attribution: {agency: PartyAttribution; organization: PartyAttribution};
};

/**
 * Independently verified per-room choices from native readback — never draft echo.
 * Skip: non-live, Labtest, missing confirmation/readback, unobserved or mismatch-blocked fields.
 */
export function extractObservedStayChoice(args: {
  propertyCode: string;
  confirmation: string | null | undefined;
  reservationId: string | null | undefined;
  readback: unknown;
  bookingFields?: Record<string, unknown>;
  host?: string | null;
  evidenceRef: string;
  mode?: string | null;
  availableAt?: string | null;
}): {ok: true; choice: ObservedStayChoice} | {ok: false; reason: string} {
  // Fail closed: missing/unknown mode never defaults to live learning.
  const mode = typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim() : '';
  if (mode !== 'live') return {ok: false, reason: mode ? 'non_live' : 'mode_unobserved'};
  const propertyCode = String(args.propertyCode ?? '').trim().toUpperCase();
  if (!propertyCode) return {ok: false, reason: 'missing_property'};
  const confirmation = typeof args.confirmation === 'string' && /^\d+-\d+$/.test(args.confirmation)
    ? args.confirmation : null;
  if (!confirmation) return {ok: false, reason: 'missing_confirmation'};
  if (args.readback == null || typeof args.readback !== 'object') return {ok: false, reason: 'missing_readback'};
  const bookingFields = args.bookingFields ?? {};
  if (isLabtestReadback(args.readback, bookingFields)) return {ok: false, reason: 'labtest'};
  if (!Array.isArray((args.readback as {fields?: unknown}).fields)) return {ok: false, reason: 'unobserved_fields'};
  if (!Array.isArray((args.readback as {mismatches?: unknown}).mismatches)) {
    return {ok: false, reason: 'readback_unconfirmed'};
  }

  const fields: Record<string, string> = {};
  for (const [nativeName, memoryField] of Object.entries(READBACK_MEMORY_FIELDS) as Array<[keyof typeof READBACK_MEMORY_FIELDS, MemoryField]>) {
    if (readbackMismatchBlocks(args.readback, memoryField)) continue;
    const raw = uniqueReadbackValue(args.readback, nativeName);
    if (!raw) continue;
    if (memoryField === 'board') {
      const board = normalizeMemoryBoard(raw);
      if (board) fields.board = board;
      continue;
    }
    if (memoryField === 'guarantee_type') {
      const code = propertyCode === 'HRCEN' ? normalizeGuaranteeCode(raw) : raw;
      if (code) fields.guarantee_type = code;
      continue;
    }
    fields[memoryField] = raw;
  }
  if (!Object.keys(fields).length) return {ok: false, reason: 'no_confirmed_memory_fields'};

  const agencyAttr = readbackRoleAttribution(args.readback, 'ta1', 'agency');
  const orgAttr = readbackRoleAttribution(args.readback, 'company', 'organization');
  const observedAgency = agencyAttr.signal === 'positive' ? agencyAttr.name : null;
  const observedOrg = orgAttr.signal === 'positive' ? orgAttr.name : null;
  const draftAgencyId = asId(bookingFields.agency_id);
  const draftOrgId = asId(bookingFields.organization_id);
  const draftAgencyName = typeof bookingFields.agency_name === 'string' ? bookingFields.agency_name.trim() : null;
  const draftOrgName = typeof bookingFields.organization_name === 'string' ? bookingFields.organization_name.trim() : null;
  // Bind native IDs only when draft name AND observed name agree — blank draft name never binds a stale ID.
  const agencyId = draftAgencyId && observedAgency && draftAgencyName
    && !partyReadbackMismatch(args.readback, 'agency')
    && normalizePartyName(draftAgencyName) === normalizePartyName(observedAgency)
    ? draftAgencyId : null;
  const organizationId = draftOrgId && observedOrg && draftOrgName
    && !partyReadbackMismatch(args.readback, 'organization')
    && normalizePartyName(draftOrgName) === normalizePartyName(observedOrg)
    ? draftOrgId : null;

  return {
    ok: true,
    choice: {
      propertyCode,
      nativeEventId: confirmation,
      reservationId: typeof args.reservationId === 'string' && /^\d+$/.test(args.reservationId) ? args.reservationId : null,
      agencyId,
      organizationId,
      agencyName: observedAgency,
      organizationName: observedOrg,
      fields,
      host: args.host ?? null,
      availableAt: args.availableAt ?? null,
      evidenceRef: args.evidenceRef,
      origin: 'native_readback',
      attribution: {agency: agencyAttr.signal, organization: orgAttr.signal},
    },
  };
}

/** Pure time-gated memory (`createdAtMs < cutoffMs`) — shared by Postgres lookup shape + replay bench. */
export function buildMemoryFromHistory(stays: HistoryStay[], cutoffMs: number, policy?: HistoryPolicyLookup): MemoryLookupFn {
  const hits = new Map<string, Map<string, number>>();
  for (const stay of stays) {
    if (!(stay.createdAtMs < cutoffMs)) continue;
    const orgId = asId(stay.organizationId);
    for (const [kind, partyId] of [['agency', asId(stay.agencyId)], ['organization', orgId]] as const) {
      if (!partyId) continue;
      for (const {field, value} of memoryFieldWrites(stay.fields as Record<string, unknown>, stay.board, kind, orgId, stay.propertyCode)) {
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
  return ({propertyCode, agencyId, organizationId, board, keys}) => mergePolicyMemory(
    propertyCode === 'HRCEN' && keys ? policy?.(keys) ?? [] : [], pickTop(
    rows.filter(row => row.property_code === propertyCode
      && ((agencyId && row.party_kind === 'agency' && row.party_id === agencyId)
        || (organizationId && row.party_kind === 'organization' && row.party_id === organizationId))),
    asId(agencyId), asId(organizationId), board, propertyCode,
    ), propertyCode, board);
}

export async function lookupPartyMemory(
  sql: Sql, args: Omit<MemoryLookupArgs, 'agencyId' | 'organizationId'> & {agencyId?: string | null; organizationId?: string | null},
): Promise<MemorySuggestion[]> {
  const agencyId = asId(args.agencyId), organizationId = asId(args.organizationId);
  const keys = args.propertyCode === 'HRCEN' && args.keys ? policyKeys(args.keys).map(([type, key]) => historyRowKey(type, key)) : [];
  const [rows, observed] = await Promise.all([
    agencyId || organizationId ? sql`
    SELECT party_kind, field_name, field_value, hits FROM nava_agent.party_booking_memory
    WHERE property_code = ${args.propertyCode} AND (
      (${agencyId}::text IS NOT NULL AND party_kind = 'agency' AND party_id = ${agencyId})
      OR (${organizationId}::text IS NOT NULL AND party_kind = 'organization' AND party_id = ${organizationId}))` : [],
    keys.length ? sql`
      SELECT entries -> key AS choices FROM nava_agent.history_policy
      CROSS JOIN jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb) WITH ORDINALITY AS wanted(key, priority)
      WHERE property_code = ${args.propertyCode} ORDER BY priority` : [],
  ]);
  return mergePolicyMemory(observed.flatMap(row => (row.choices ?? []) as PolicyRow[]),
    pickTop(rows as HitRow[], agencyId, organizationId, args.board, args.propertyCode), args.propertyCode, args.board);
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
    for (const {field, value} of memoryFieldWrites(args.fields, undefined, kind, organizationId, args.propertyCode)) {
      await sql`
        INSERT INTO nava_agent.party_booking_memory AS m
          (property_code, party_kind, party_id, field_name, field_value, hits)
        VALUES (${args.propertyCode}, ${kind}, ${partyId}, ${field}, ${value}, 1)
        ON CONFLICT (property_code, party_kind, party_id, field_name, field_value)
        DO UPDATE SET hits = m.hits + 1, updated_at = now()`;
    }
  }
}

/**
 * Idempotent observation append by (property, native stay, party role, field).
 * Same value → no-op; correction → new version, supersede prior. Never retries Save.
 * Projects into legacy aggregate tables only once per new observation (shadow).
 * Memory-only transaction — Save must never be retried or moved inside it.
 */
export async function recordMemoryObservation(db: postgres.Sql, choice: ObservedStayChoice): Promise<{recorded:number; skipped:string[]}> {
  return db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([choice.propertyCode, choice.nativeEventId])}, 0))`;
    const result = await appendMemoryObservation(tx, choice);
    // Sender vote only when a new observation landed (no double-count on dup skips) —
    // applied in this same stay-locked transaction so retries/replays stay atomic.
    // Attribution must be known positive or negative; missing/unobserved abstains.
    const att = choice.attribution ?? {agency: 'unobserved' as const, organization: 'unobserved' as const};
    if (result.recorded > 0 && choice.host && (att.agency !== 'unobserved' || att.organization !== 'unobserved')) {
      await recordSavedSenderParty(tx, {
        propertyCode: choice.propertyCode, nativeEventId: choice.nativeEventId, host: choice.host,
        agencyName: choice.agencyName, agencyId: choice.agencyId,
        organizationName: choice.organizationName, organizationId: choice.organizationId,
        attribution: att,
      });
    }
    return result;
  });
}

async function appendMemoryObservation(
  sql: Sql,
  choice: ObservedStayChoice,
): Promise<{recorded: number; skipped: string[]}> {
  const skipped: string[] = [];
  let recorded = 0;
  const parties: Array<['agency' | 'organization', string]> = [];
  if (choice.agencyId) parties.push(['agency', choice.agencyId]);
  if (choice.organizationId) parties.push(['organization', choice.organizationId]);
  if (!parties.length) return {recorded: 0, skipped: ['no_bound_party_id']};

  for (const [kind, partyId] of parties) {
    const scopedWrites = memoryFieldWrites(choice.fields, choice.fields.board, kind, choice.organizationId, choice.propertyCode);
    if (!scopedWrites.length) {
      skipped.push(`no_field_writes:${kind}`);
      continue;
    }
    for (const {field, value} of scopedWrites) {
      const [latest] = await sql`
        SELECT id, party_id, field_value, version, available_at FROM nava_agent.memory_observation
        WHERE property_code = ${choice.propertyCode}
          AND native_event_id = ${choice.nativeEventId}
          AND party_kind = ${kind}
          AND field_name = ${field}
          AND superseded_at IS NULL
        ORDER BY version DESC LIMIT 1`;
      if (latest && String(latest.field_value) === value && String(latest.party_id) === partyId) {
        skipped.push(`dup:${kind}:${field}`);
        continue;
      }
      if (latest) {
        const priorAt = latest.available_at;
        if (priorAt != null && String(priorAt).trim()) {
          const choiceAt = choice.availableAt;
          const priorMs = priorAt instanceof Date ? priorAt.getTime() : Date.parse(String(priorAt));
          const choiceMs = choiceAt != null ? Date.parse(String(choiceAt)) : NaN;
          if (!choiceAt || Number.isNaN(choiceMs) || Number.isNaN(priorMs) || !(choiceMs > priorMs)) {
            skipped.push('stale_or_ambiguous');
            continue;
          }
        }
      }
      const nextVersion = latest ? Number(latest.version) + 1 : 1;
      const id = randomUUID();
      const availableAt = choice.availableAt ?? null;
      const inserted = await sql`
        INSERT INTO nava_agent.memory_observation
          (id, property_code, native_event_id, party_kind, party_id, field_name, field_value,
           evidence_ref, available_at, origin, coverage, version)
        VALUES (
          ${id}, ${choice.propertyCode}, ${choice.nativeEventId}, ${kind}, ${partyId},
          ${field}, ${value}, ${choice.evidenceRef},
          ${availableAt}, ${choice.origin}, 'complete', ${nextVersion}
        )
        ON CONFLICT (property_code, native_event_id, party_kind, field_name, version) DO NOTHING
        RETURNING id`;
      if (!inserted.length) {
        skipped.push(`conflict:${kind}:${field}:v${nextVersion}`);
        continue;
      }
      if (latest) {
        await sql`
          UPDATE nava_agent.memory_observation SET superseded_at = now()
          WHERE id = ${String(latest.id)} AND superseded_at IS NULL`;
        await sql`
          UPDATE nava_agent.party_booking_memory SET hits=GREATEST(hits-1,0), updated_at=now()
          WHERE property_code=${choice.propertyCode} AND party_kind=${kind} AND party_id=${String(latest.party_id)}
            AND field_name=${field} AND field_value=${String(latest.field_value)} AND hits>0`;
      }
      // Shadow into legacy aggregate only when the observation row was newly inserted.
      await sql`
        INSERT INTO nava_agent.party_booking_memory AS m
          (property_code, party_kind, party_id, field_name, field_value, hits)
        VALUES (${choice.propertyCode}, ${kind}, ${partyId}, ${field}, ${value}, 1)
        ON CONFLICT (property_code, party_kind, party_id, field_name, field_value)
        DO UPDATE SET hits = m.hits + 1, updated_at = now()`;
      recorded += 1;
    }
  }
  return {recorded, skipped};
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

/**
 * Stay-scoped sender vote: one contribution per (property, native stay, role, host).
 * Field corrections, reconcile retries and replays reuse the same contribution and
 * add no hit; a proven party-name correction moves the vote instead of stacking.
 * Per-role attribution is tri-state: positive name votes once, a confirmed
 * negative (explicit empty) records at most one miss, unobserved abstains
 * entirely — never inferred as a negative. Call inside the memory observation
 * transaction — never in the Save transaction.
 */
export async function recordSavedSenderParty(
  sql: Sql,
  args: {
    propertyCode: string; nativeEventId: string; host: string;
    agencyName?: string | null; agencyId?: string | null;
    organizationName?: string | null; organizationId?: string | null;
    attribution?: {agency?: PartyAttribution; organization?: PartyAttribution};
  },
): Promise<void> {
  const host = args.host.trim().toLowerCase();
  if (!host || !args.propertyCode || !args.nativeEventId) return;
  const nameOf = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
  const hit = (kind: 'agency' | 'organization', partyName: string, nativeId: string | null, delta: 1 | -1) => delta === 1
    ? sql`
      INSERT INTO nava_agent.sender_party_memory AS m
        (property_code, host, party_kind, party_name, native_id, hits, direct_misses)
      VALUES (${args.propertyCode}, ${host}, ${kind}, ${partyName}, ${nativeId}, 1, 0)
      ON CONFLICT (property_code, host, party_kind, party_name)
      DO UPDATE SET hits = m.hits + 1,
        native_id = COALESCE(EXCLUDED.native_id, m.native_id),
        updated_at = now()`
    : sql`
      UPDATE nava_agent.sender_party_memory
      SET hits = GREATEST(hits - 1, 0), updated_at = now()
      WHERE property_code = ${args.propertyCode} AND host = ${host} AND party_kind = ${kind}
        AND party_name = ${partyName} AND hits > 0`;

  for (const [kind, sig, rawName, nativeId] of [
    ['agency', args.attribution?.agency ?? 'unobserved', nameOf(args.agencyName), asId(args.agencyId)],
    ['organization', args.attribution?.organization ?? 'unobserved', nameOf(args.organizationName), asId(args.organizationId)],
  ] as const) {
    // Unobserved (absent/duplicate/invalid/mismatched) never writes; a positive signal
    // without a name is internally inconsistent — fail closed in both cases.
    if (sig === 'unobserved' || (sig === 'positive' && !rawName)) continue;
    const name = sig === 'positive' ? rawName : null;
    const miss = (delta: 1 | -1) => kind !== 'agency' ? Promise.resolve([]) : sql`
      UPDATE nava_agent.sender_party_memory
      SET direct_misses = GREATEST(direct_misses + ${delta}, 0), updated_at = now()
      WHERE property_code = ${args.propertyCode} AND host = ${host} AND party_kind = 'agency'`;
    const lockRow = async () => (await sql`
      SELECT party_name, native_id FROM nava_agent.sender_party_stay
      WHERE property_code = ${args.propertyCode} AND native_event_id = ${args.nativeEventId}
        AND party_kind = ${kind} AND host = ${host}
      FOR UPDATE`)[0];
    let stay = await lockRow();
    if (!stay) {
      // Claim the contribution; only the inserter may add the vote or the miss.
      const inserted = await sql`
        INSERT INTO nava_agent.sender_party_stay
          (property_code, native_event_id, party_kind, host, party_name, native_id)
        VALUES (${args.propertyCode}, ${args.nativeEventId}, ${kind}, ${host}, ${name}, ${name ? nativeId : null})
        ON CONFLICT (property_code, native_event_id, party_kind, host) DO NOTHING
        RETURNING party_name`;
      if (inserted.length) {
        if (name) await hit(kind, name, nativeId, 1);
        else await miss(1); // confirmed negative — one miss per stay, replay-safe via the row
        continue;
      }
      // Concurrent contributor committed first — re-read and reconcile below.
      stay = await lockRow();
      if (!stay) continue; // contributor rolled back — fail closed, no vote
    }
    const prior = stay.party_name == null ? null : String(stay.party_name);
    if (prior === name) {
      // Same attribution: no new vote or miss. Freshen the bound native id if newly known.
      if (name && nativeId && nativeId !== (stay.native_id == null ? null : String(stay.native_id))) {
        await sql`
          UPDATE nava_agent.sender_party_memory SET native_id = ${nativeId}, updated_at = now()
          WHERE property_code = ${args.propertyCode} AND host = ${host} AND party_kind = ${kind} AND party_name = ${name}`;
        await sql`
          UPDATE nava_agent.sender_party_stay SET native_id = ${nativeId}, updated_at = now()
          WHERE property_code = ${args.propertyCode} AND native_event_id = ${args.nativeEventId}
            AND party_kind = ${kind} AND host = ${host}`;
      }
      continue;
    }
    // Proven transition on this stay's contribution — move, never accumulate.
    if (prior !== null) await hit(kind, prior, null, -1);
    else await miss(-1); // prior contribution was a recorded negative — undo it
    if (name) await hit(kind, name, nativeId, 1);
    else await miss(1); // correction emptied the party — one confirmed miss
    await sql`
      UPDATE nava_agent.sender_party_stay
      SET party_name = ${name}, native_id = ${name ? nativeId : null}, updated_at = now()
      WHERE property_code = ${args.propertyCode} AND native_event_id = ${args.nativeEventId}
        AND party_kind = ${kind} AND host = ${host}`;
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
  return ['[Client Memory Card]', ...lines].join('\n');
}

export type SenderPartySuggestion = {
  agency?: LearnedSenderHit | null;
  organization?: LearnedSenderHit | null;
};

function canInstallPartyDefault(
  current: unknown,
  spec: {provenance: string; evidence: Array<{message_id: string | null}>; error: string | null} | null,
): boolean {
  if (spec?.provenance === 'staff' || spec?.error) return false;
  if (spec?.evidence.some(item => !['default_room', 'party_memory', 'sender_party_memory'].includes(item.message_id ?? ''))) return false;
  return blank(current) || spec?.provenance === 'default';
}

/** Prefill silent Create blanks or model defaults (`provenance: 'default'`); never override explicit email evidence. */
export function applyPartyMemoryToDraft(
  draft: ProposalDraft,
  lookupFn: MemoryLookupFn,
  senderParties?: SenderPartySuggestion,
  senderKeys?: PolicyKeys,
): ProposalDraft {
  if (draft.workflow !== 'create') return draft;
  const fieldSpecs = [...draft.field_specs];
  const filled = new Set<string>();
  const bookings = draft.bookings.map((booking, index) => {
    const fields = {...booking.fields};
    const propertyCode = String(booking.property_code ?? '').trim().toUpperCase();
    if (!propertyCode) return booking;
    if (senderParties?.agency && blank(fields.agency_id)) {
      const agPath = `/bookings/${index}/fields/agency_name`;
      const agIdx = fieldSpecs.findIndex(field => field.path === agPath || field.path === agPath.slice(1));
      const agSpec = agIdx >= 0 ? fieldSpecs[agIdx] : null;
      if (canInstallPartyDefault(fields.agency_name, agSpec)) {
        fields.agency_name = senderParties.agency.name;
        filled.add(agPath);
        if (senderParties.agency.nativeId) fields.agency_id = senderParties.agency.nativeId;
        const quote = `Usual agency for ${senderParties.agency.host} (${senderParties.agency.support} stays)`;
        const evidence = [{message_id: 'sender_party_memory', attachment_id: null, quote}];
        if (agIdx >= 0) fieldSpecs[agIdx] = {...fieldSpecs[agIdx], path: agPath, provenance: 'default', error: null, evidence};
        else fieldSpecs.push({
          path: agPath, label: 'Booking agency', provenance: 'default', editable: true, required: false,
          error: null, control: 'text', options: [], evidence,
        });
      }
    }
    const orgHit = verifiedDirectOrgMatch(
      senderParties?.organization,
      typeof fields.agency_name === 'string' ? fields.agency_name : senderParties?.agency?.name,
    );
    if (orgHit && blank(fields.organization_id)) {
      const orgPath = `/bookings/${index}/fields/organization_name`;
      const orgIdx = fieldSpecs.findIndex(field => field.path === orgPath || field.path === orgPath.slice(1));
      const orgSpec = orgIdx >= 0 ? fieldSpecs[orgIdx] : null;
      if (canInstallPartyDefault(fields.organization_name, orgSpec)) {
        fields.organization_name = orgHit.name;
        filled.add(orgPath);
        if (orgHit.nativeId) fields.organization_id = orgHit.nativeId;
        const quote = `Usual company for ${orgHit.host} (${orgHit.support} stays)`;
        const evidence = [{message_id: 'sender_party_memory', attachment_id: null, quote}];
        if (orgIdx >= 0) fieldSpecs[orgIdx] = {...fieldSpecs[orgIdx], path: orgPath, provenance: 'default', error: null, evidence};
        else fieldSpecs.push({
          path: orgPath, label: 'Company', provenance: 'default', editable: true, required: false,
          error: null, control: 'text', options: [], evidence,
        });
      }
    }
    for (const sug of lookupFn(memoryLookupArgs(propertyCode, fields, senderKeys))) {
      const path = `/bookings/${index}/fields/${sug.field}`;
      const spec = fieldSpecs.findIndex(field => field.path === path || field.path === path.slice(1));
      const existing = spec >= 0 ? fieldSpecs[spec] : null;
      if (sug.field === 'agency_name' && (!blank(fields.agency_id) || !blank(fields.agency_name))) continue;
      if (sug.field === 'organization_name' && (!blank(fields.organization_id) || !blank(fields.organization_name)
        || (typeof fields.agency_name === 'string' && normalizePartyName(fields.agency_name) === normalizePartyName(sug.value)))) continue;
      if (!canInstallPartyDefault(fields[sug.field], existing)) continue;
      fields[sug.field] = sug.value;
      filled.add(path);
      const evidence = [{message_id: 'party_memory', attachment_id: null, quote: sug.reason}];
      const baseLabel = {board: 'Meal plan', rate_plan: 'Rate plan', room_type: 'Room type', guarantee_type: 'Guarantee type',
        ar_account_name: 'A/R account', billing_reference: 'Billing reference', agency_name: 'Booking agency', organization_name: 'Company'}[sug.field];
      // The deployed pane already renders field labels and editable default markers.
      const label = sug.historyPolicy ? `${baseLabel} · HMS history` : existing?.label ?? baseLabel;
      if (spec >= 0) fieldSpecs[spec] = {...fieldSpecs[spec], path, label, provenance: 'default', editable: true, error: null, evidence};
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
  const missing = draft.missing.filter(path => !filled.has(path.startsWith('/') ? path : '/' + path));
  return {...draft, bookings, field_specs: fieldSpecs, missing};
}
