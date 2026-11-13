import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import type { ReservationWorkflowV2Observation, ReservationWorkflowV2Proposal,
  ReservationWorkflowV2Source } from './reservation-workflow-v2-contract.js';
import { partyMatchSearchTerms } from './party-match-v2.js';

type PartyRole = 'agency' | 'organization' | 'ar_account';
type Lead = { value: string; label: string; basis: 'exact_sender' | 'normalized_entity';
  support: number; confirmations: string[]; denominator: number; confidence: number | null; autoSelectable: boolean };
const partyFields = [
  { role: 'agency', field: 'bookingAgency' },
  { role: 'organization', field: 'organization' },
  { role: 'ar_account', field: 'arAccount' },
] satisfies { role: PartyRole; field: 'bookingAgency' | 'organization' | 'arAccount' }[];
const historicalValuesSchema = z.object({ recordView: z.array(z.union([z.string(), z.number(), z.null()])).nullable(),
  stay360: z.array(z.union([z.string(), z.number(), z.null()])).nullable(), incompleteSources: z.array(z.string()) }).passthrough();
const memorySchema = z.object({
  propertyCode: z.string(),
  snapshots: z.array(z.object({ snapshotId: z.string(), startedAt: z.string().nullable(),
    updatedAt: z.string().nullable() }).passthrough()),
  observations: z.array(z.object({ confirmationKey: z.string(), snapshotId: z.string(),
    historicalIdentity: z.object({ nativeConfirmation: z.string() }).passthrough(),
    historicalHints: z.object({ guaranteeType: historicalValuesSchema, track: historicalValuesSchema }).passthrough(),
    historicalAutoTransfer: z.object({ value: z.literal(true), evidence: z.literal('stay360_auto_transfer_card_row') }).nullable().optional(),
    historicalNoteFields: historicalValuesSchema,
    outcomes: z.array(z.object({ combination: z.record(z.string().nullable()), conflictingFields: z.array(z.string()) }).passthrough()) }).passthrough()),
  addressEvidence: z.array(z.object({ confirmationKey: z.string(), role: z.string(), address: z.string(),
    sentAt: z.string().nullable().optional(), messageDbId: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(), linkMethod: z.string().optional(),
    linkProvenance: z.object({ ambiguousAttachment: z.boolean().optional(),
      labeledConfirmationMatch: z.boolean().nullable().optional(), subjectHasOtherConfirmation: z.boolean().nullable().optional() }).passthrough().optional(),
    linkedPmsSnapshotIds: z.array(z.string()).optional() }).passthrough()),
}).passthrough();
const historicalHintSchema = z.object({ values: z.array(z.object({
  value: z.string(), valueTruncated: z.boolean(),
  evidence: z.object({ confirmationRecords: z.array(z.object({ confirmationNumber: z.string().nullable() }).passthrough()),
    truncated: z.boolean() }).passthrough(),
}).passthrough()) }).passthrough();
const querySchema = z.object({ candidates: z.array(z.object({
  combination: z.record(z.string().nullable()),
  conflictingFields: z.array(z.string()),
  evidence: z.object({ confirmationRecords: z.array(z.object({ confirmationNumber: z.string().nullable() }).passthrough()),
    truncated: z.boolean() }).passthrough(),
}).passthrough()), candidatesTruncated: z.boolean(), conflictsTruncated: z.boolean(),
  conflicts: z.array(z.object({ evidence: z.object({ confirmationNumber: z.string().nullable() }).passthrough() }).passthrough()),
  historicalHints: z.object({ ratePlan: historicalHintSchema, roomType: historicalHintSchema }).passthrough() }).passthrough();

const rateMealMappingSchema = z.array(z.object({ propertyCode: z.string(), ratePlan: z.string(),
  countingUnit: z.literal('distinct_verified_stays'), capturedThrough: z.string(), denominator: z.number().int().positive(),
  candidates: z.array(z.object({ mealPlan: z.string(), support: z.number().int().positive(),
    denominator: z.number().int().positive(), confidence: z.number().min(0).max(1) })) }));
const rateTrackMappingSchema = z.array(z.object({ propertyCode: z.string(), ratePlan: z.string(),
  countingUnit: z.literal('distinct_verified_stays'), capturedThrough: z.string(), denominator: z.number().int().positive(),
  candidates: z.array(z.object({ track: z.string(), support: z.number().int().positive(),
    denominator: z.number().int().positive(), confidence: z.number().min(0).max(1) })) }));

/** Native stay evidence, scoped to the selected message's arrival; no rate-code guessing. */
export async function loadReservationRateMealMapping(input: { propertyCode: string; arrivedAt: string; env?: NodeJS.ProcessEnv }):
  Promise<{ status: 'available'; mappings: z.infer<typeof rateMealMappingSchema> } | { status: 'unavailable'; issue: string }> {
  const env = input.env ?? process.env;
  const dir = env.HMS_MEMORY_DATA_DIR || '/home/orca/.local/share/zero/research/halloween/raw-data';
  try {
    const module = await import(new URL('../../tooling/hms-cloud/hms-booking-memory.mjs', import.meta.url).href);
    const parsed = rateMealMappingSchema.safeParse(await module.loadHmsRateMealMapping({ propertyCode: input.propertyCode,
      asOf: input.arrivedAt, pmsPaths: [env.HMS_MEMORY_PMS_PATH || `${dir}/stay360-1a-1b-1c-20261029-run01.json`],
      observationsPath: env.HMS_MEMORY_OBSERVATIONS_PATH || undefined }));
    if (!parsed.success) return { status: 'unavailable', issue: 'RATE_MEAL_MEMORY_INVALID' };
    return { status: 'available', mappings: parsed.data };
  } catch {
    return { status: 'unavailable', issue: 'RATE_MEAL_MEMORY_UNAVAILABLE' };
  }
}

/** Native stay rate/Track evidence scoped to the selected message's arrival. */
export async function loadReservationRateTrackMapping(input: { propertyCode: string; arrivedAt: string; env?: NodeJS.ProcessEnv }):
  Promise<{ status: 'available'; mappings: z.infer<typeof rateTrackMappingSchema> } | { status: 'unavailable'; issue: string }> {
  const env = input.env ?? process.env;
  const dir = env.HMS_MEMORY_DATA_DIR || '/home/orca/.local/share/zero/research/halloween/raw-data';
  try {
    const module = await import(new URL('../../tooling/hms-cloud/hms-booking-memory.mjs', import.meta.url).href);
    const parsed = rateTrackMappingSchema.safeParse(await module.loadHmsRateTrackMapping({ propertyCode: input.propertyCode,
      asOf: input.arrivedAt, pmsPaths: [env.HMS_MEMORY_PMS_PATH || `${dir}/stay360-1a-1b-1c-20261029-run01.json`],
      observationsPath: env.HMS_MEMORY_OBSERVATIONS_PATH || undefined }));
    if (!parsed.success) return { status: 'unavailable', issue: 'RATE_TRACK_MEMORY_INVALID' };
    return { status: 'available', mappings: parsed.data };
  } catch {
    return { status: 'unavailable', issue: 'RATE_TRACK_MEMORY_UNAVAILABLE' };
  }
}

/** Mechanical aliases stay within their entity type; commercial names remain display evidence. */
export function reservationEntityKey(value: string, role: PartyRole): string {
  const tokens = value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const suffixes = new Set(['pty', 'ltd', 'limited', 'inc', 'llc', 'cc', 'plc']);
  if (role === 'agency') for (const word of ['travel', 'travels', 'tour', 'tours', 'agency', 'agencies']) suffixes.add(word);
  while (tokens.length > 1 && suffixes.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join('');
}

const normalizedPartyName = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

type Memory = z.infer<typeof memorySchema>;
type NativeLeadsInput = { propertyCode: string;
  source: ReservationWorkflowV2Source; generationId: string; proposal: ReservationWorkflowV2Proposal;
  fromAddress: string | null | undefined; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  db?: DB; transportId?: string; sourceThreadMessageIds?: readonly string[];
};
type SavedAmendBaseline = { requestId: string; hintId: string; selectedRef: string; prepareRef: string;
  selectionPath: string; draftRevision: number; confirmation: string;
  parties: Array<{ kind: 'organization' | 'arAccount'; nativeId: string; name: string }> };

const selectedBaselinePartySchema = z.object({ state: z.enum(['selected', 'blank', 'unknown']),
  nativeId: z.string().optional(), name: z.string().optional() }).passthrough();
const savedStayIdentitySchema = z.object({ source: z.literal('record_view_ext_model'), propertyCode: z.literal('HRCEN'),
  confirmation: z.string().regex(/^\d{6,10}-\d{1,2}$/), reservationStayId: z.string().regex(/^\d+$/),
  reservationId: z.string().regex(/^\d+$/), recordId: z.string().regex(/^\d+$/), guestId: z.string().regex(/^\d+$/) }).passthrough();

function verifiedAmendBaseline(input: NativeLeadsInput & { prepareObservation: ReservationWorkflowV2Observation;
  targetObservation: ReservationWorkflowV2Observation }): SavedAmendBaseline | null {
  const prepare = input.prepareObservation, target = input.targetObservation;
  if (prepare.kind !== 'rate_availability' || prepare.status !== 'complete' || !prepare.coverage.complete ||
      target.kind !== 'stay_candidate' || target.status !== 'complete' || !target.coverage.complete ||
      [prepare, target].some(row => row.generationId !== input.generationId || row.propertyCode !== input.propertyCode ||
        row.sourceMessageId !== input.source.messageId) || prepare.criteria.workflow !== 'amend' ||
      prepare.result.outcome !== 'prepared' || target.criteria.workflow !== 'amend' || target.criteria.kind !== 'saved_target') return null;
  const requestId = prepare.criteria.requestId, hintId = prepare.criteria.hintId, selectedRef = prepare.criteria.selectedRef;
  const selectionPath = target.criteria.selectionPath, draftRevision = prepare.criteria.draftRevision;
  const targetAt = Date.parse(target.observedAt), preparedAt = Date.parse(prepare.observedAt);
  if (typeof requestId !== 'string' || typeof hintId !== 'string' || typeof selectedRef !== 'string' ||
      typeof selectionPath !== 'string' || typeof draftRevision !== 'number' || !Number.isSafeInteger(draftRevision) || draftRevision < 0 ||
      selectedRef !== target.ref || target.criteria.requestId !== requestId || target.criteria.hintId !== hintId ||
      !Number.isFinite(targetAt) || !Number.isFinite(preparedAt) || targetAt > preparedAt) return null;
  const request = input.proposal.content.requests.find(row => row.id === requestId && row.kind === 'amend');
  if (!request || request.kind !== 'amend') return null;
  const targetPrefix = `/proposal/content/requests/${encodeURIComponent(requestId)}/body/targets/include/`;
  if (!selectionPath.startsWith(targetPrefix) || !/^\d+\/suggestedRef$/.test(selectionPath.slice(targetPrefix.length))) return null;
  const before = savedStayIdentitySchema.safeParse(prepare.result.before);
  const selected = savedStayIdentitySchema.safeParse(target.result.candidate);
  if (!before.success || !selected.success || target.result.confirmation !== before.data.confirmation ||
      target.result.nativeStayId !== before.data.reservationStayId ||
      (['confirmation', 'reservationStayId', 'reservationId', 'recordId', 'guestId'] as const).some(key =>
        before.data[key] !== selected.data[key])) return null;
  const baseline = z.object({ beforeParties: z.record(z.unknown()) }).passthrough().safeParse(prepare.result.recoveryBaseline);
  const semantic = z.object({ baseChanges: z.record(z.unknown()) }).passthrough().safeParse(prepare.result.semanticInput);
  const verified = z.object({ organization: selectedBaselinePartySchema, arAccount: selectedBaselinePartySchema })
    .safeParse(prepare.result.nativePartyBaseline);
  if (!baseline.success || !semantic.success || !verified.success) return null;
  const parties: SavedAmendBaseline['parties'] = [];
  for (const kind of ['organization', 'arAccount'] as const) {
    if (Object.hasOwn(semantic.data.baseChanges, kind)) continue;
    const party = verified.data[kind];
    const name = party.name;
    if (party.state !== 'selected' || !party.nativeId || !/^[1-9]\d*$/.test(party.nativeId) || !name?.trim()) continue;
    const id = baseline.data.beforeParties[kind === 'organization' ? 'companyid' : 'araccountid'];
    const names = (kind === 'organization' ? ['company', 'companyname'] : ['araccountname'])
      .map(key => baseline.data.beforeParties[key]).filter(value => value !== null && value !== undefined && value !== '');
    if (String(id ?? '').trim() !== party.nativeId || !names.length ||
        names.some(value => typeof value !== 'string' || normalizedPartyName(value) !== normalizedPartyName(name))) continue;
    parties.push({ kind, nativeId: party.nativeId, name });
  }
  return { requestId, hintId, selectedRef, prepareRef: prepare.ref, selectionPath, draftRevision,
    confirmation: before.data.confirmation, parties };
}

let cached: { key: string; loadedAt: number; value: Promise<Memory | null> } | undefined;
async function loadMemory(env: NodeJS.ProcessEnv): Promise<Memory | null> {
  const key = JSON.stringify([env.HMS_MEMORY_PMS_PATH, env.HMS_MEMORY_OUTBOUND_PATH, env.HMS_MEMORY_DATA_DIR, env.HMS_MEMORY_OBSERVATIONS_PATH]);
  if (!cached || cached.key !== key || Date.now() - cached.loadedAt > 5 * 60_000) {
    const value = (async () => {
      const tool = await import(new URL('../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href);
      const dir = env.HMS_MEMORY_DATA_DIR || '/home/orca/.local/share/zero/research/halloween/raw-data';
      const loaded = await tool.loadOptionalBookingMemory({
        pmsPath: env.HMS_MEMORY_PMS_PATH || `${dir}/stay360-1a-1b-1c-20261029-run01.json`,
        outboundPdfPath: env.HMS_MEMORY_OUTBOUND_PATH || (env.HMS_MEMORY_PMS_PATH ? undefined : `${dir}/centurion-outbound-pdf-records-2026-10-29.jsonl`),
        observationsPath: env.HMS_MEMORY_OBSERVATIONS_PATH || undefined,
      });
      const parsed = memorySchema.safeParse(loaded.memory);
      return parsed.success ? parsed.data : null;
    })();
    cached = { key, loadedAt: Date.now(), value };
  }
  return cached.value;
}

type MemoryGuidanceValue = { value: string; support: number; denominator: number; confidence: number };

/** Time-eligible, identity-bound native notes and booking codes, before current mail arrived. */
export async function loadReservationMemoryGuidance(input: { propertyCode: string; source: ReservationWorkflowV2Source;
  fromAddress?: string | null; agencyName?: string | null; organizationName?: string | null;
  excludedConfirmations?: readonly string[]; sourceThreadMessageIds?: readonly string[]; db?: DB; transportId?: string;
  env?: NodeJS.ProcessEnv }): Promise<
  { status: 'available'; denominator: number; notes: MemoryGuidanceValue[]; guarantees: MemoryGuidanceValue[];
    tracks: MemoryGuidanceValue[]; complete: boolean; multiClientDomain: boolean } |
  { status: 'unavailable'; issue: string }
> {
  try {
    const memory = await loadMemory(input.env ?? process.env), cutoff = Date.parse(input.source.arrivedAt);
    if (!memory || memory.propertyCode !== input.propertyCode || !Number.isFinite(cutoff)) {
      return { status: 'unavailable', issue: 'booking_memory_unavailable' };
    }
    if (!input.db && !input.sourceThreadMessageIds) return { status: 'unavailable', issue: 'source_thread_unavailable' };
    const sourceMessages = new Set([input.source.messageId, ...(input.sourceThreadMessageIds ?? [])]);
    if (input.db) {
      if (!input.transportId) return { status: 'unavailable', issue: 'source_transport_unavailable' };
      const thread = await input.db.select({ id: message.id }).from(message).where(and(
        eq(message.transportId, input.transportId), eq(message.threadId, input.source.threadId),
        lt(MESSAGE_ARRIVED_AT, sql`${input.source.arrivedAt}::timestamptz at time zone 'UTC'`))).limit(2001);
      if (thread.length > 2000) return { status: 'unavailable', issue: 'source_thread_incomplete' };
      for (const row of thread) sourceMessages.add(row.id);
    }
    const eligibleSnapshots = new Set(memory.snapshots.flatMap(snapshot => {
      const timestamps = [snapshot.startedAt, snapshot.updatedAt].filter((value): value is string => Boolean(value));
      return timestamps.length && timestamps.every(value => Number.isFinite(Date.parse(value))) &&
        Math.max(...timestamps.map(value => Date.parse(value))) < cutoff ? [snapshot.snapshotId] : [];
    }));
    const excluded = new Set(input.excludedConfirmations ?? []);
    for (const row of memory.addressEvidence) if ((row.messageDbId && sourceMessages.has(row.messageDbId)) || row.threadId === input.source.threadId) {
      excluded.add(row.confirmationKey);
    }
    const addresses = [...new Set((input.fromAddress?.match(/[^\s@,;<>]+@[^\s@,;<>]+/g) ?? [])
      .map(value => value.replace(/^mailto:/i, '').replace(/[.!?]+$/, '').toLocaleLowerCase('en-US')))];
    const address = addresses.length === 1 ? addresses[0] : '';
    const verifiedAddresses = memory.addressEvidence.filter(row => row.sentAt && Number.isFinite(Date.parse(row.sentAt)) &&
      Date.parse(row.sentAt) < cutoff && row.linkMethod === 'attachment-id' && row.linkProvenance?.ambiguousAttachment === false &&
      row.linkProvenance.labeledConfirmationMatch === true && row.linkProvenance.subjectHasOtherConfirmation !== true &&
      row.linkedPmsSnapshotIds?.some(id => eligibleSnapshots.has(id)) && !excluded.has(row.confirmationKey));
    const senderKeys = new Set(verifiedAddresses.filter(row => row.address === address &&
      ['inbound-sender', 'outbound-recipient'].includes(row.role)).map(row => row.confirmationKey));
    const domain = address.includes('@') ? address.split('@')[1] : '';
    const domainKeys = new Set(verifiedAddresses.filter(row => domain && row.address.endsWith(`@${domain}`) &&
      ['inbound-sender', 'outbound-recipient'].includes(row.role)).map(row => row.confirmationKey));
    const eligible = memory.observations.filter(row => eligibleSnapshots.has(row.snapshotId) &&
      row.historicalIdentity.nativeConfirmation === 'matched' && !excluded.has(row.confirmationKey));
    const organizations = new Set(eligible.filter(row => domainKeys.has(row.confirmationKey)).flatMap(row => row.outcomes.flatMap(outcome => {
      const name = outcome.combination.organization;
      return name && !outcome.conflictingFields.includes('organization') ? [normalizedPartyName(name)] : [];
    })));
    const multiClientDomain = organizations.size > 1;
    const hasEntity = Boolean(input.agencyName || input.organizationName);
    if (!hasEntity && !senderKeys.size) return { status: 'unavailable', issue: 'booking_memory_identity_unavailable' };
    if (!hasEntity && multiClientDomain) return { status: 'unavailable', issue: 'multiple_client_domain' };
    const rows = eligible.filter(row => (!senderKeys.size || senderKeys.has(row.confirmationKey)) && row.outcomes.some(outcome => {
      const matches = (field: 'bookingAgency' | 'organization', name?: string | null) => !name ||
        Boolean(outcome.combination[field] && !outcome.conflictingFields.includes(field) &&
          normalizedPartyName(outcome.combination[field]) === normalizedPartyName(name));
      return matches('bookingAgency', input.agencyName) && matches('organization', input.organizationName);
    }));
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) grouped.set(row.confirmationKey, [...(grouped.get(row.confirmationKey) ?? []), row]);
    const denominator = grouped.size;
    const aggregate = (select: (row: typeof rows[number]) => z.infer<typeof historicalValuesSchema>) => {
      const counts = new Map<string, { value: string; support: number }>();
      for (const records of grouped.values()) {
        const values = records.flatMap(row => {
          const field = select(row);
          return [...(field.recordView ?? []), ...(field.stay360 ?? [])].flatMap(value =>
            typeof value === 'string' || typeof value === 'number' ? [String(value).trim()] : []).filter(Boolean);
        });
        const distinct = new Map(values.map(value => [value.normalize('NFKC').toLocaleLowerCase('en-US'), value]));
        if (distinct.size !== 1) continue;
        const [key, value] = [...distinct][0]!;
        const prior = counts.get(key);
        counts.set(key, { value, support: (prior?.support ?? 0) + 1 });
      }
      return [...counts.values()].map(row => ({ ...row, denominator, confidence: row.support / denominator }))
        .sort((a, b) => b.support - a.support || a.value.localeCompare(b.value));
    };
    const notes = aggregate(row => row.historicalNoteFields), guarantees = aggregate(row => row.historicalHints.guaranteeType),
      tracks = aggregate(row => row.historicalHints.track);
    return { status: 'available', denominator, notes: notes.slice(0, 200), guarantees: guarantees.slice(0, 200),
      tracks: tracks.slice(0, 200), complete: notes.length <= 200 && guarantees.length <= 200 && tracks.length <= 200, multiClientDomain };
  } catch { return { status: 'unavailable', issue: 'booking_memory_invalid' }; }
}

/** Existing captured memory supplies ranked names/codes only, after source projection has finished. */
export async function loadReservationNativeLeads(input: NativeLeadsInput): Promise<ReservationWorkflowV2Observation[]> {
  return loadReservationNativeLeadsInternal(input);
}

async function loadReservationNativeLeadsInternal(input: NativeLeadsInput & { savedAmendBaseline?: SavedAmendBaseline }):
  Promise<ReservationWorkflowV2Observation[]> {
  if (input.propertyCode !== 'HRCEN' || input.signal?.aborted || (!input.db && !input.sourceThreadMessageIds)) return [];
  try {
    const loaded = await loadMemory(input.env ?? process.env);
    input.signal?.throwIfAborted();
    if (!loaded || loaded.propertyCode !== input.propertyCode) return [];
    const cutoff = Date.parse(input.source.arrivedAt);
    const snapshotTimes = new Map(loaded.snapshots.flatMap(snapshot => {
      const captured = [snapshot.startedAt, snapshot.updatedAt].filter((value): value is string => Boolean(value));
      if (!captured.length || captured.some(value => !Number.isFinite(Date.parse(value)))) return [];
      const latest = Math.max(...captured.map(value => Date.parse(value)));
      return latest < cutoff ? [[snapshot.snapshotId, new Date(latest).toISOString()] satisfies [string, string]] : [];
    }));
    if (!snapshotTimes.size) return [];
    const excluded = new Set(JSON.stringify(input.proposal).match(/\b\d{6,10}-\d{1,2}\b/g) ?? []);
    if (input.savedAmendBaseline) excluded.add(input.savedAmendBaseline.confirmation);
    const sourceMessages = new Set([input.source.messageId, ...(input.sourceThreadMessageIds ?? [])]);
    if (input.db) {
      if (!input.transportId) return [];
      const rows = await input.db.select({ id: message.id }).from(message).where(and(
        eq(message.transportId, input.transportId), eq(message.threadId, input.source.threadId),
        lt(MESSAGE_ARRIVED_AT, sql`${input.source.arrivedAt}::timestamptz at time zone 'UTC'`))).limit(2001);
      input.signal?.throwIfAborted();
      if (rows.length > 2000) return [];
      for (const row of rows) sourceMessages.add(row.id);
    }
    for (const address of loaded.addressEvidence) if (address.messageDbId && sourceMessages.has(address.messageDbId) ||
      address.threadId === input.source.threadId) excluded.add(address.confirmationKey);
    const memory = { ...loaded, observations: loaded.observations.filter(row =>
      snapshotTimes.has(row.snapshotId) && row.historicalIdentity.nativeConfirmation === 'matched' && !excluded.has(row.confirmationKey)),
      addressEvidence: loaded.addressEvidence.filter(row => !excluded.has(row.confirmationKey) && row.sentAt &&
        Number.isFinite(Date.parse(row.sentAt)) && Date.parse(row.sentAt) < cutoff && row.linkMethod === 'attachment-id' &&
        row.linkProvenance?.ambiguousAttachment === false && row.linkProvenance.labeledConfirmationMatch === true &&
        row.linkProvenance.subjectHasOtherConfirmation !== true &&
        row.linkedPmsSnapshotIds?.some(id => snapshotTimes.has(id))) };
    if (!memory.observations.length) return [];
    const module = await import(new URL('../../tooling/hms-cloud/hms-booking-memory.mjs', import.meta.url).href);
    const query = (criteria: object) => {
      const parsed = querySchema.safeParse(module.queryHmsBookingMemory(memory, criteria,
        { sourceOfBusiness: 'E-Mail', limit: 200, hintLimit: 200, includeEvidence: true, evidenceLimit: 200, noteLimit: 1 }));
      return parsed.success ? parsed.data : null;
    };
    const common = await import(new URL('../../tooling/hms-cloud/hms-booking-memory-common.mjs', import.meta.url).href);
    const addresses = z.array(z.string().email()).safeParse(common.emailsIn(input.fromAddress));
    const email = addresses.success && addresses.data.length === 1 ? addresses.data[0] : null;
    const sender = email
      ? [query({ email, role: 'inbound-sender' }), query({ email, role: 'outbound-recipient' })].filter(row => row !== null) : [];
    const domain = email?.split('@')[1];
    const domainResults = domain ? [query({ domain, role: 'inbound-sender' }), query({ domain, role: 'outbound-recipient' })]
      .filter(row => row !== null) : [];
    const organizations = new Set(domainResults.flatMap(result => result.candidates.flatMap(candidate => {
      const value = candidate.combination.organization;
      return value && !candidate.conflictingFields.includes('organization') ? [normalizedPartyName(value)] : [];
    })));
    const multiClientDomain = organizations.size > 1 || domainResults.some(result => result.candidatesTruncated || result.conflictsTruncated);
    const observations: ReservationWorkflowV2Observation[] = [];
    const latestStays = new Map<string, { capturedAt: string; rows: Memory['observations'] }>();
    for (const row of memory.observations) {
      const capturedAt = snapshotTimes.get(row.snapshotId);
      if (!capturedAt) continue;
      const current = latestStays.get(row.confirmationKey);
      if (!current || capturedAt > current.capturedAt) latestStays.set(row.confirmationKey, { capturedAt, rows: [row] });
      else if (capturedAt === current.capturedAt) current.rows.push(row);
    }
    const autoTransferHint = (requestId: string, workflow: 'create' | 'amend', fieldPath: string,
      partyKind: 'organization' | 'arAccount', partyQuery: string, binding?: Record<string, unknown>) => {
      const key = normalizedPartyName(partyQuery);
      if (!key) return;
      let denominator = 0, support = 0;
      let observedThrough = '';
      for (const stay of latestStays.values()) {
        const fields = stay.rows.flatMap(row => row.outcomes.flatMap(outcome => {
          if (outcome.conflictingFields.includes(partyKind)) return [];
          const value = outcome.combination[partyKind];
          return value ? [normalizedPartyName(value)] : [];
        })).filter(Boolean);
        if (!fields.length || fields.some(value => value !== key) ||
            stay.rows.some(row => row.outcomes.some(outcome => outcome.conflictingFields.includes(partyKind)))) continue;
        denominator += 1;
        if (stay.rows.some(row => row.historicalAutoTransfer?.value === true)) {
          support += 1;
          if (stay.capturedAt > observedThrough) observedThrough = stay.capturedAt;
        }
      }
      const confidence = denominator ? support / denominator : 0;
      if (confidence < 0.8) return;
      observations.push({ ref: randomUUID(), generationId: input.generationId, kind: 'stay_candidate', status: 'partial',
        observedAt: new Date().toISOString(), propertyCode: input.propertyCode, sourceMessageId: input.source.messageId,
        sourceRefs: [], criteria: { kind: 'historical_auto_transfer_hint', workflow, requestId,
          sourceHash: input.source.sourceHash, fieldPath, partyKind, partyQuery, ...binding },
        coverage: { complete: false, notes: ['Prior native stays are informational; missing Auto Transfer details are unknown.'] },
        result: { value: true, support, denominator, confidence, evidence: 'stay360_auto_transfer_card_row', observedThrough } });
    };
    if (input.savedAmendBaseline) {
      const { requestId, hintId, selectedRef, prepareRef, selectionPath, draftRevision, parties } = input.savedAmendBaseline;
      for (const party of parties) autoTransferHint(requestId, 'amend', selectionPath, party.kind, party.name,
        { binding: 'saved_amend_baseline', hintId, selectedRef, prepareRef, selectionPath,
          draftRevision, partyNativeId: party.nativeId });
      return observations;
    }
    for (const request of input.proposal.content.requests) {
      const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body`;
      if (request.kind === 'create') {
        const slots = [{ path: `${root}/shared`, fields: request.body.shared },
          ...request.body.dateSections.map((section, index) => ({ path: `${root}/dateSections/${index}/defaults`, fields: section.defaults })),
          ...request.body.allocations.map((allocation, index) => ({ path: `${root}/allocations/${index}/overrides`, fields: allocation.overrides }))];
        for (const slot of slots) for (const kind of ['organization', 'arAccount'] as const) {
          const party = slot.fields[kind];
          if (party && 'name' in party && typeof party.name === 'string' && party.name.trim())
            autoTransferHint(request.id, 'create', `${slot.path}/${kind}`, kind, party.name);
        }
      } else if (request.kind === 'amend') {
        const groups = [{ path: `${root}/sharedChanges`, changes: request.body.sharedChanges },
          ...request.body.perTarget.map((target, index) => ({ path: `${root}/perTarget/${index}/changes`, changes: target.changes }))];
        for (const group of groups) for (const [index, change] of group.changes.entries()) {
          if (change.op !== 'set' || (change.field !== 'organization' && change.field !== 'arAccount') ||
              !change.value || typeof change.value !== 'object' || !('name' in change.value) ||
              typeof change.value.name !== 'string' || !change.value.name.trim()) continue;
          autoTransferHint(request.id, 'amend', `${group.path}/${index}/value`, change.field, change.value.name);
        }
      }
    }
    for (const request of input.proposal.content.requests) {
      if (request.kind !== 'create' && request.kind !== 'quote') continue;
      const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body`;
      const slots = request.kind === 'create'
        ? [{ path: `${root}/shared`, fields: request.body.shared },
          ...request.body.dateSections.map((section, index) => ({ path: `${root}/dateSections/${index}/defaults`, fields: section.defaults })),
          ...request.body.allocations.map((allocation, index) => ({ path: `${root}/allocations/${index}/overrides`, fields: allocation.overrides }))]
        : [{ path: `${root}/parties`, fields: { bookingAgency: request.body.parties.bookingAgency, organization: request.body.parties.organization } }];
      const names = new Map<PartyRole, string[]>();
      for (const spec of partyFields) names.set(spec.role, slots.flatMap(slot => {
        const party = spec.field === 'bookingAgency' ? slot.fields.bookingAgency : spec.field === 'organization'
          ? slot.fields.organization : 'arAccount' in slot.fields ? slot.fields.arAccount : undefined;
        return party && typeof party === 'object' && 'name' in party && party.name ? [party.name] : [];
      }).slice(0, 2));
      const related = [...names].flatMap(([role, values]) => values.flatMap(name =>
        partyMatchSearchTerms(name).slice(0, 2).flatMap(term => {
          const result = query({ name: term });
          return result ? [{ role, name, result }] : [];
        })));
      for (const role of [...partyFields.map(spec => spec.role), 'rate_plan', 'room_type'] satisfies Array<PartyRole | 'rate_plan' | 'room_type'>) {
        const field = role === 'rate_plan' ? 'ratePlan' : role === 'room_type' ? 'roomType' : partyFields.find(spec => spec.role === role)?.field;
        if (!field) continue;
        const leads = new Map<string, Lead>();
        const denominators = new Map<Lead['basis'], Set<string>>();
        const incomplete = new Set<Lead['basis']>();
        const add = (value: string, basis: Lead['basis'], confirmations: Array<string | null>) => {
          const ids = confirmations.filter((id): id is string => Boolean(id));
          if (!value.trim() || !ids.length || (role === 'ar_account' && /^refund\s+account\b/i.test(value.trim()))) return;
          const key = role === 'rate_plan' || role === 'room_type' ? value.toUpperCase() : normalizedPartyName(value);
          if (!key) return;
          const prior = leads.get(key);
          if (prior?.basis === 'exact_sender' && basis === 'normalized_entity') return;
          const combined = [...new Set([...(prior?.basis === basis ? prior.confirmations : []), ...ids])];
          leads.set(key, { value, label: value, basis,
            support: combined.length, confirmations: combined, denominator: 0, confidence: null, autoSelectable: false });
        };
        const accept = (result: z.infer<typeof querySchema>, basis: Lead['basis'], name?: string, relatedRole?: PartyRole) => {
          const conflicts = new Set(result.conflicts.flatMap(conflict => conflict.evidence.confirmationNumber ? [conflict.evidence.confirmationNumber] : []));
          const relatedField = partyFields.find(spec => spec.role === relatedRole)?.field;
          const sourceMatches = (candidate: z.infer<typeof querySchema>['candidates'][number]) => !name || !relatedRole || !relatedField ||
            Boolean(candidate.combination[relatedField] && !candidate.conflictingFields.includes(relatedField) &&
              normalizedPartyName(candidate.combination[relatedField]) === normalizedPartyName(name));
          const ids = (candidate: z.infer<typeof querySchema>['candidates'][number]) => candidate.evidence.confirmationRecords
            .map(row => row.confirmationNumber).filter((id): id is string => Boolean(id) && !conflicts.has(id ?? ''));
          const denominator = denominators.get(basis) ?? new Set<string>();
          for (const candidate of result.candidates.filter(sourceMatches)) for (const id of ids(candidate)) denominator.add(id);
          denominators.set(basis, denominator);
          if (result.candidatesTruncated || result.conflictsTruncated || result.candidates.some(candidate => candidate.evidence.truncated)) incomplete.add(basis);
          if (role === 'rate_plan' || role === 'room_type') {
            const matching = name && relatedRole && relatedField ? new Set(result.candidates.flatMap(candidate => {
              const value = candidate.combination[relatedField];
              return value && !candidate.conflictingFields.includes(relatedField) &&
                normalizedPartyName(value) === normalizedPartyName(name)
                ? candidate.evidence.confirmationRecords.map(row => row.confirmationNumber) : [];
            })) : null;
            for (const hint of result.historicalHints[role === 'rate_plan' ? 'ratePlan' : 'roomType'].values) {
              if (hint.evidence.truncated) incomplete.add(basis);
              if (!hint.valueTruncated && /^[A-Z0-9]{1,12}$/.test(hint.value)) {
                add(hint.value, basis, hint.evidence.confirmationRecords.map(row => row.confirmationNumber)
                  .filter((id): id is string => Boolean(id) && denominator.has(id ?? '') && (!matching || matching.has(id))));
              }
            }
          } else for (const candidate of result.candidates) {
            const value = candidate.combination[field];
            if (value && !candidate.conflictingFields.includes(field) && sourceMatches(candidate))
              add(value, basis, ids(candidate));
          }
        };
        for (const result of sender) accept(result, 'exact_sender');
        for (const item of related) if (role === 'rate_plan' || role === 'room_type' || item.role === role ||
          (role === 'ar_account' && (item.role === 'agency' || item.role === 'organization')))
          accept(item.result, 'normalized_entity', item.name, item.role);
        for (const lead of leads.values()) {
          lead.denominator = denominators.get(lead.basis)?.size ?? 0;
          lead.confidence = lead.denominator && !incomplete.has(lead.basis) ? lead.support / lead.denominator : null;
          lead.autoSelectable = lead.confidence !== null && lead.confidence >= 0.8 &&
            (role === 'agency' || (role === 'organization' && lead.basis === 'exact_sender' && !multiClientDomain));
        }
        const ranked = [...leads.values()].sort((a, b) => Number(b.basis === 'exact_sender') - Number(a.basis === 'exact_sender') ||
          b.support - a.support || a.value.localeCompare(b.value)).slice(0, 3);
        if (!ranked.length) continue;
        const actualField = field;
        const fieldPaths = role === 'room_type' && request.kind === 'quote' ? [] : role === 'rate_plan' && request.kind === 'quote'
          ? request.body.groups.map((_, index) => `${root}/groups/${index}/ratePlan`)
          : role === 'ar_account' && request.kind === 'quote' ? [] : slots.map(slot => `${slot.path}/${actualField}/nativeSelectionRef`);
        if ((role === 'rate_plan' || role === 'room_type') && request.kind === 'create') fieldPaths.splice(0, fieldPaths.length, ...slots.map(slot => `${slot.path}/${field}`));
        if (!fieldPaths.length) continue;
        for (const fieldPath of fieldPaths) {
          const slot = slots.find(row => fieldPath === `${row.path}/${actualField}/nativeSelectionRef` ||
            fieldPath === `${row.path}/${field}`);
          const party = slot ? role === 'agency' ? slot.fields.bookingAgency : role === 'organization'
            ? slot.fields.organization : 'arAccount' in slot.fields ? slot.fields.arAccount : undefined : undefined;
          const code = request.kind === 'quote' ? request.body.groups.find((_, index) => fieldPath === `${root}/groups/${index}/ratePlan`)?.ratePlan
            : role === 'room_type' && slot && 'roomType' in slot.fields ? slot.fields.roomType
              : slot && 'ratePlan' in slot.fields ? slot.fields.ratePlan : undefined;
          const sourceQuery = role === 'rate_plan' || role === 'room_type' ? typeof code === 'string' ? code : null
            : party && typeof party === 'object' && 'name' in party ? party.name : null;
          observations.push({ ref: randomUUID(), generationId: input.generationId,
            kind: role === 'rate_plan' || role === 'room_type' ? 'rate_availability' : 'party_candidate', status: 'partial',
            observedAt: new Date().toISOString(), propertyCode: input.propertyCode, sourceMessageId: input.source.messageId,
            sourceRefs: [], criteria: { kind: 'historical_lookup_leads', workflow: request.kind, requestId: request.id,
              sourceHash: input.source.sourceHash, role: role === 'agency' ? 'bookingAgency' : role,
              query: sourceQuery, fieldPath, fieldPaths: [fieldPath], rankBasis: ['exact_sender', 'normalized_entity'],
              multiClientDomain, snapshotTimes: [...snapshotTimes.values()] },
            coverage: { complete: false, notes: ['Historical names/codes require a current Infor search and staff selection.',
              'Support counts observed confirmations; journey/room grouping is unavailable where source links are missing.'] },
            result: { leads: ranked.map(lead => ({ ...lead, confirmations: lead.confirmations.slice(0, 3) })),
              excludedConfirmations: [...excluded] } });
        }
      }
    }
    return observations.slice(0, 100);
  } catch {
    input.signal?.throwIfAborted();
    return [];
  }
}

/** Historical guidance for a fresh saved Amend baseline; no native fields are changed. */
export async function loadReservationAmendBaselineAutoTransferLeads(input: Omit<NativeLeadsInput, 'fromAddress'> & {
  prepareObservation: ReservationWorkflowV2Observation; targetObservation: ReservationWorkflowV2Observation;
}): Promise<ReservationWorkflowV2Observation[]> {
  const savedAmendBaseline = verifiedAmendBaseline({ ...input, fromAddress: null });
  if (!savedAmendBaseline?.parties.length) return [];
  return loadReservationNativeLeadsInternal({ ...input, fromAddress: null, savedAmendBaseline });
}
