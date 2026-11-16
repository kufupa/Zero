import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ReservationWorkflowV2Draft, ReservationWorkflowV2Evidence, ReservationWorkflowV2Extraction, ReservationWorkflowV2Observation,
  ReservationWorkflowV2Proposal, ReservationWorkflowV2Source } from './reservation-workflow-v2-contract.js';
import { isExcludedRefundArAccount, reservationEntityKey, type AutopickHistory, type AutopickHistoryField, type AutopickHistoryKey,
  type AutopickHistoryValue } from './reservation-workflow-v2-native-leads.js';
import type { PreloadedNativeCatalog } from './native-catalog-lookup.js';

/**
 * Auto-pick with evidence: one host-side mechanism for every coded Create/Quote field. Every pick is a real native
 * row/code, carries machine-computed counts, and lands where a staff choice already goes. Contract (v1):
 * /home/orca/.local/share/zero/research/autopick-backtest-20261116/suggestion-contract.md
 */
export const AUTOPICK_MAX_ALTERNATIVES = 5;
const MAX_HISTORY_READS = 3 * (AUTOPICK_MAX_ALTERNATIVES + 1);
const MODEL_CANDIDATES = 3;

type PartyField = 'bookingAgency' | 'organization' | 'arAccount';
type CodeField = 'ratePlan' | 'roomType' | 'guaranteeType' | 'sourceOfBusiness';
type Field = PartyField | CodeField;
type PartyRole = 'bookingAgency' | 'organization' | 'ar_account';
type EntityRole = 'agency' | 'organization' | 'ar_account';
type Evidence = { kind: 'sender_history' | 'company_history' | 'agency_domain' | 'email_text' | 'attachment' | 'policy_default' | 'model_choice';
  count: number | null; total: number | null; lastSeen: string | null; key?: string; quote?: string };
type Option = { ref: string; label: string; count: number | null; total: number | null };
export type AutopickSuggestion = { version: 1; field: Field; ref: string; value: string; label: string;
  confidence: 'usual' | 'check'; reason: string; evidence: Evidence[]; alternatives: Option[] };

const partyRole: Record<PartyField, PartyRole> = { bookingAgency: 'bookingAgency', organization: 'organization', arAccount: 'ar_account' };
const entityRole: Record<PartyField, EntityRole> = { bookingAgency: 'agency', organization: 'organization', arAccount: 'ar_account' };
const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const norm = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : '';
const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 24);

/** The Track precedent, shared: >= 2 supporting stays, >= 80% agreement and a clear leader. */
export function clearsHistoryGate(leader: { count: number; agreement: number } | undefined, runnerUp?: { count: number }): boolean {
  return Boolean(leader && leader.count >= 2 && leader.agreement >= 0.8 && (!runnerUp || runnerUp.count < leader.count));
}

const gateFor = (stats: { total: number; values: AutopickHistoryValue[] }, value: string, same: (a: string, b: string) => boolean) => {
  const [leader, runnerUp] = stats.values;
  return Boolean(leader && same(leader.value, value) && clearsHistoryGate({ count: leader.count, agreement: leader.count / stats.total }, runnerUp));
};

/** Exact email span naming `name` (token-wise, case-insensitive), or null. */
export function emailQuote(text: string, name: string, role: EntityRole): string | null {
  const key = reservationEntityKey(name, role);
  if (key.length < 4) return null;
  const tokens = name.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  // Drop the same trailing legal/agency suffixes the entity key drops, so "Acme (Pty) Ltd" also matches "Acme".
  while (tokens.length > 1 && reservationEntityKey(tokens.slice(0, -1).join(' '), role) === key) tokens.pop();
  if (!tokens.length) return null;
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join('[^\\p{L}\\p{N}\\n]{0,3}')}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  return match?.[0] ?? null;
}

/** Native names often carry a short form: "Long Name (ABC)" or "Long Name - ABC". Try each written form. */
export function emailQuoteAny(text: string, name: string, role: EntityRole): string | null {
  const bracketed = [...name.matchAll(/\(([^()]+)\)/g)].map((match) => match[1]!);
  const unbracketed = name.replace(/\([^()]*\)/g, ' ');
  const dashed = unbracketed.split(/\s+[-–]\s+/);
  for (const variant of [name, unbracketed, ...dashed, ...bracketed]) {
    const quote = variant.trim() ? emailQuote(text, variant, role) : null;
    if (quote) return quote;
  }
  return null;
}

function historyEvidence(key: AutopickHistoryKey, row: AutopickHistoryValue | undefined, total: number): Evidence {
  return { kind: key.kind, count: row?.count ?? 0, total, lastSeen: row?.lastSeen ?? null, key: key.key };
}

function reasonFor(evidence: Evidence[], confidence: 'usual' | 'check'): string {
  const first = evidence[0]!;
  const from = first.kind === 'sender_history' ? `from ${first.key}` : first.kind === 'agency_domain' ? `from @${first.key}` : `for ${first.key}`;
  const sentence = first.kind === 'email_text' ? `Named in this email ("${first.quote}").`
    : first.kind === 'model_choice' ? `Matched to "${first.quote}" in this email.`
    : first.kind === 'attachment' ? `${first.key} attached.`
    : first.kind === 'policy_default' ? `${first.key}.`
    : `Used on ${first.count} of ${first.total} earlier bookings ${from}.`;
  return confidence === 'check' ? `${sentence} Check before Go.` : sentence;
}

/** History keys for a field in priority order: exact sender, company (named or already picked), sender domain. */
function orderedKeys(history: AutopickHistory, companyKeys: AutopickHistoryKey[], field: AutopickHistoryField,
  exclude?: string): AutopickHistoryKey[] {
  const sender = history.keys.filter((row) => row.kind === 'sender_history');
  const company = companyKeys
    .filter((row, index, all) => all.findIndex((other) => norm(other.key) === norm(row.key)) === index && norm(row.key) !== norm(exclude));
  const domain = history.keys.filter((row) => row.kind === 'agency_domain');
  return [...sender, ...company, ...domain].filter((row) => (row.fields[field]?.total ?? 0) > 0);
}

/** Party names worth an HMS read before synthesis, for party fields the email did not name. */
export function planAutopickPartyReads(input: { extraction: ReservationWorkflowV2Extraction; history: AutopickHistory | null;
  evidence: ReservationWorkflowV2Evidence[] }): { reads: Array<{ role: PartyRole; name: string; requestId: string }>;
    modelSlots: Array<{ requestId: string; field: 'organization'; names: string[] }> } {
  const reads: Array<{ role: PartyRole; name: string; requestId: string }> = [];
  const modelSlots: Array<{ requestId: string; field: 'organization'; names: string[] }> = [];
  if (!input.history) return { reads, modelSlots };
  const text = currentText(input.evidence);
  const add = (role: PartyRole, name: string, requestId: string) => {
    if (reads.length < MAX_HISTORY_READS && !reads.some((row) => row.role === role && norm(row.name) === norm(name)))
      reads.push({ role, name, requestId });
  };
  for (const request of input.extraction.requests) {
    if (request.kind !== 'create' && request.kind !== 'quote') continue;
    const companyKeys = request.parties.flatMap((party) => typeof party.name.value === 'string' &&
      (party.role === 'organization' || party.role === 'bookingAgency') ? [input.history!.companyHistory(party.name.value)] : [])
      .filter((key): key is AutopickHistoryKey => key !== null);
    const fields: PartyField[] = request.kind === 'create' ? ['organization', 'bookingAgency', 'arAccount'] : ['organization', 'bookingAgency'];
    for (const field of fields) {
      if (request.parties.some((party) => party.role === partyRole[field])) continue;
      const key = orderedKeys(input.history, companyKeys, field)[0];
      const stats = key?.fields[field];
      if (!key || !stats) continue;
      const named = stats.values.filter((row) => row.value && (field !== 'arAccount' || !isExcludedRefundArAccount(row.value)));
      const quoted = named.filter((row) => emailQuoteAny(text, row.value, entityRole[field]));
      const searchNames = [...(quoted.length === 1 ? quoted : []), ...orderedKeys(input.history, companyKeys, field)
        .flatMap((row) => row.fields[field]?.values ?? [])].filter((row) => row.value && (field !== 'arAccount' || !isExcludedRefundArAccount(row.value)))
        .filter((row, index, all) => all.findIndex((other) => norm(other.value) === norm(row.value)) === index)
        .slice(0, AUTOPICK_MAX_ALTERNATIVES + 1);
      searchNames.forEach((row) => add(partyRole[field], row.value, request.id));
      const ambiguous = quoted.length !== 1 && field === 'organization' && named.length > 1 &&
        !gateFor(stats, named[0]!.value, (a, b) => norm(a) === norm(b));
      if (ambiguous) {
        const names = searchNames.filter((row) => reads.some((read) => read.role === partyRole[field] && norm(read.name) === norm(row.value)))
          .slice(0, MODEL_CANDIDATES).map((row) => row.value);
        modelSlots.push({ requestId: request.id, field: 'organization', names });
      }
    }
  }
  return { reads, modelSlots };
}

function currentText(evidence: ReservationWorkflowV2Evidence[]): string {
  return evidence.filter((row) => row.relation === 'current_message').map((row) => row.text).join('\n');
}

type NativeRow = { nativeId: string; name: string; read: ReservationWorkflowV2Observation; row: Record<string, unknown> };
function readRows(observations: ReservationWorkflowV2Observation[], role: PartyRole): NativeRow[] {
  return observations.filter((row) => row.kind === 'party_candidate' && row.status === 'complete' && row.coverage.complete &&
    row.criteria.autopick === true && row.criteria.role === role && row.criteria.fieldPath === undefined).flatMap((read) =>
    (Array.isArray(read.result.candidates) ? read.result.candidates : []).flatMap((raw) => {
      const row = rec(raw);
      return row && /^\d{1,30}$/.test(String(row.nativeId ?? '')) && typeof row.name === 'string' && row.name.trim()
        ? [{ nativeId: String(row.nativeId), name: row.name.trim(), read, row }] : [];
    }));
}

/** Model choice among host-read candidates, reusing the synthesis call. */
export type AutopickModelSlot = { slot: string; requestId: string; field: 'organization';
  candidates: Array<{ token: string; label: string; nativeId: string }> };
export type AutopickModelResult = { slot: string; requestId: string; field: 'organization';
  outcome: 'chosen' | 'abstained' | 'hallucination' | 'parse_failure'; candidateRefs: string[];
  choice: string | null; quote: string | null; problems: string[]; nativeId: string | null };

export function autopickModelSlots(planned: Array<{ requestId: string; field: 'organization'; names: string[] }>,
  observations: ReservationWorkflowV2Observation[]): AutopickModelSlot[] {
  const rows = readRows(observations, 'organization');
  return planned.flatMap((slot) => {
    const candidates = slot.names.flatMap((name) => rows.filter((row) =>
      reservationEntityKey(row.name, 'organization') === reservationEntityKey(name, 'organization')).slice(0, 1))
      .filter((row, index, all) => all.findIndex((other) => other.nativeId === row.nativeId) === index)
      .map((row) => ({ token: row.read.ref + ':' + row.nativeId, label: row.name, nativeId: row.nativeId }));
    return candidates.length > 1 ? [{ slot: `${slot.requestId}:${slot.field}`, requestId: slot.requestId, field: slot.field, candidates }] : [];
  });
}

export const AUTOPICK_SYNTHESIS_RULES = 'Host autopick choices: for each entry in autopickChoices, return one autopick item ' +
  '{ slot, choice, quote }. choice must be one of that slot\'s candidate tokens, or "abstain" when the current email does not ' +
  'clearly indicate one candidate. quote must be the exact text copied from the current email that names or clearly indicates ' +
  'the chosen candidate (null only when abstaining). Never invent a candidate.';

/** Constrain the response schema: choices are enum-limited to supplied tokens or abstain. */
export function withAutopickResponseSchema(schema: Record<string, unknown>, slots: AutopickModelSlot[]): Record<string, unknown> {
  if (!slots.length) return schema;
  const properties = rec(schema.properties) ?? {};
  return { ...schema, properties: { ...properties, autopick: { type: 'array', maxItems: slots.length, items: {
    type: 'object', additionalProperties: false, required: ['slot', 'choice', 'quote'],
    properties: { slot: { type: 'string', enum: slots.map((slot) => slot.slot) },
      choice: { type: 'string', enum: [...new Set([...slots.flatMap((slot) => slot.candidates.map((row) => row.token)), 'abstain'])] },
      quote: { type: ['string', 'null'], maxLength: 300 } } } } } };
}

const modelEntrySchema = z.object({ slot: z.string().min(1).max(200), choice: z.string().min(1).max(200),
  quote: z.string().max(300).nullable() }).strict();
const STOP_WORDS = new Set(['the', 'and', 'for', 'our', 'from', 'with', 'team', 'group', 'company', 'pty', 'ltd', 'limited',
  'travel', 'travels', 'tours', 'agency', 'services', 'department', 'south', 'african', 'africa']);
const squash = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

/** Deterministic check of model output: parse failures and hallucinations are recorded separately, never merged. */
export function validateAutopickModelOutput(raw: unknown, slots: AutopickModelSlot[],
  evidence: ReservationWorkflowV2Evidence[]): AutopickModelResult[] {
  const text = currentText(evidence);
  const entries = Array.isArray(raw) ? raw : null;
  return slots.map((slot): AutopickModelResult => {
    const base = { slot: slot.slot, requestId: slot.requestId, field: slot.field,
      candidateRefs: slot.candidates.map((row) => row.token), choice: null, quote: null, nativeId: null };
    if (!entries) return { ...base, outcome: 'parse_failure' as const, problems: [raw === undefined ? 'autopick_missing' : 'autopick_not_array'] };
    const matching = entries.filter((entry) => rec(entry)?.slot === slot.slot);
    if (matching.length !== 1) return { ...base, outcome: 'parse_failure' as const,
      problems: [matching.length ? 'slot_duplicated' : 'slot_missing'] };
    const parsed = modelEntrySchema.safeParse(matching[0]);
    if (!parsed.success) return { ...base, outcome: 'parse_failure' as const, problems: ['schema_invalid'] };
    const { choice, quote } = parsed.data;
    const result = { ...base, choice, quote };
    if (choice === 'abstain') return { ...result, outcome: 'abstained' as const, problems: [] };
    const problems: string[] = [];
    const candidate = slot.candidates.find((row) => row.token === choice);
    if (!candidate) problems.push('choice_not_in_candidates');
    if (!quote?.trim()) return { ...result, outcome: problems.length ? 'hallucination' as const : 'parse_failure' as const,
      problems: problems.length ? problems : ['quote_missing'] };
    if (!text.includes(quote)) problems.push('quote_not_in_email');
    // The quote must name the choice: share a significant word with it (an acronym counts as a word).
    const words = (value: string) => new Set((squash(value).match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word)));
    const labelWords = candidate ? words(candidate.label) : new Set<string>();
    if (candidate && ![...words(quote)].some((word) => labelWords.has(word))) problems.push('quote_not_about_choice');
    return problems.length ? { ...result, outcome: 'hallucination' as const, problems }
      : { ...result, outcome: 'chosen' as const, problems, nativeId: candidate!.nativeId };
  });
}

type Choice = { code: string; meaning: string };
type ApplyInput = {
  proposal: ReservationWorkflowV2Proposal; observations: ReservationWorkflowV2Observation[]; history: AutopickHistory | null;
  evidence: ReservationWorkflowV2Evidence[]; catalog: PreloadedNativeCatalog | null; guaranteeChoices: Choice[];
  modelResults: AutopickModelResult[]; extractionIdByProposalRequestId: ReadonlyMap<string, string>;
  generationId: string; propertyCode: ReservationWorkflowV2Observation['propertyCode'];
  source: ReservationWorkflowV2Source;
};

/** Pre-select the best native candidate for each coded field that is still empty, with evidence and alternatives. */
export function applyAutopick(input: ApplyInput): { proposal: ReservationWorkflowV2Proposal;
  observations: ReservationWorkflowV2Observation[]; requirements: ReservationWorkflowV2Draft['fieldReviewRequirements'] } {
  const proposal = structuredClone(input.proposal);
  const added: ReservationWorkflowV2Observation[] = [];
  const requirements: ReservationWorkflowV2Draft['fieldReviewRequirements'] = {};
  const text = currentText(input.evidence);
  const observations = input.observations.filter((row) => row.propertyCode === input.propertyCode &&
    row.generationId === input.generationId && row.sourceMessageId === input.source.messageId);
  const history = input.history?.propertyCode === input.propertyCode ? input.history : null;
  const catalog = input.catalog?.propertyCode === input.propertyCode ? input.catalog : null;
  const now = new Date().toISOString();
  const observation = (criteria: Record<string, unknown>, result: Record<string, unknown>, sourceRefs: string[] = []) => {
    const row: ReservationWorkflowV2Observation = { ref: `obs_autopick_${hash(input.generationId, JSON.stringify(criteria))}`,
      generationId: input.generationId, kind: 'source', status: 'complete', observedAt: now, propertyCode: input.propertyCode,
      sourceMessageId: input.source.messageId, sourceRefs, criteria: { version: 1, ...criteria },
      coverage: { complete: true, notes: [] }, result };
    added.push(row);
    return row;
  };
  for (const result of input.modelResults) {
    const owner = proposal.content.requests.find((row) => (input.extractionIdByProposalRequestId.get(row.id) ?? row.id) === result.requestId);
    observation({ kind: 'autopick_model_choice', workflow: owner?.kind ?? null, requestId: owner?.id ?? result.requestId,
      extractionRequestId: result.requestId, field: result.field, valuePath: owner ? `/proposal/content/requests/${encodeURIComponent(owner.id)}/body/${
        owner.kind === 'quote' ? 'parties' : 'shared'}/${result.field}` : null }, { outcome: result.outcome, candidateRefs: result.candidateRefs,
      choice: result.choice, quote: result.quote, problems: result.problems });
    console.info('autopick_model_choice', { outcome: result.outcome, field: result.field, problems: result.problems });
  }
  const quoteRefs = (quote: string | undefined) => quote ? input.evidence.filter((row) =>
    row.relation === 'current_message' && row.text.includes(quote)).map((row) => row.ref).slice(0, 20) : [];
  const record = (request: ReservationWorkflowV2Proposal['content']['requests'][number], field: Field, valuePath: string,
    selectionPath: string, suggestion: Omit<AutopickSuggestion, 'version' | 'field' | 'reason'>, basis: 'native_read' | 'policy') => {
    const full: AutopickSuggestion = { version: 1, field, ...suggestion, alternatives: suggestion.alternatives.slice(0, AUTOPICK_MAX_ALTERNATIVES),
      reason: reasonFor(suggestion.evidence, suggestion.confidence) };
    const row = observation({ kind: 'autopick_suggestion', workflow: request.kind, requestId: request.id, field, valuePath, selectionPath },
      full, quoteRefs(suggestion.evidence.find((item) => item.quote)?.quote));
    proposal.annotations.push({ path: valuePath, basis, evidenceRefs: [row.ref] });
    proposal.lookupResultRefs = [...new Set([...proposal.lookupResultRefs, row.ref])].slice(0, 1000);
    if (full.confidence === 'check') requirements[selectionPath] = { required: true, reasons: [full.reason], evidenceRefs: [row.ref] };
  };

  for (const request of proposal.content.requests) {
    if (request.kind === 'amend') {
      const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body`;
      const extractionId = input.extractionIdByProposalRequestId.get(request.id) ?? request.id;
      const changes = [...request.body.sharedChanges.map((change, index) => ({ change, path: `${root}/sharedChanges/${index}/value` })),
        ...request.body.perTarget.flatMap((target, targetIndex) => target.changes.map((change, index) =>
          ({ change, path: `${root}/perTarget/${targetIndex}/changes/${index}/value` })))];
      for (const { change, path } of changes) {
        if (change.op !== 'set' || !['bookingAgency', 'organization', 'arAccount'].includes(change.field)) continue;
        const field = change.field === 'bookingAgency' ? 'bookingAgency' : change.field === 'organization' ? 'organization' : 'arAccount';
        const party = rec(change.value);
        const name = typeof party?.name === 'string' ? party.name : typeof change.value === 'string' ? change.value : '';
        if (!name.trim() || party?.kind === 'none' || typeof party?.suggestedRef === 'string') continue;
        const role = entityRole[field], selectionPath = `${path}/nativeSelectionRef`;
        const same = (a: string, b: string) => reservationEntityKey(a, role) === reservationEntityKey(b, role);
        const key = history ? orderedKeys(history, [], field, name)[0] : undefined;
        const stats = key?.fields[field];
        const statFor = (value: string) => stats?.values.find((row) => row.value && same(row.value, value));
        const candidates = observations.filter((row) => row.kind === 'party_candidate' && row.status === 'complete' &&
          row.coverage.complete && row.criteria.role === partyRole[field] && norm(row.criteria.name) === norm(name) &&
          (row.criteria.requestId === extractionId || row.sourceRefs.some((ref) => change.sourceRefs.includes(ref))))
          .flatMap((read) => (Array.isArray(read.result.candidates) ? read.result.candidates : []).flatMap((raw) => {
            const row = rec(raw);
            return row && /^\d{1,30}$/.test(String(row.nativeId ?? '')) && typeof row.name === 'string' && row.name.trim() &&
              (field !== 'arAccount' || !isExcludedRefundArAccount(row.name)) ? [{ read, row, nativeId: String(row.nativeId), name: row.name }] : [];
          })).filter((row, index, all) => all.findIndex((other) => other.nativeId === row.nativeId) === index)
          .sort((a, b) => Number(same(b.name, name)) - Number(same(a.name, name)) ||
            (statFor(b.name)?.count ?? 0) - (statFor(a.name)?.count ?? 0) || a.name.localeCompare(b.name));
        if (!candidates.length) continue;
        const bound = candidates.slice(0, AUTOPICK_MAX_ALTERNATIVES + 1).map((native) => {
          const ref = `obs_autopick_${hash(input.generationId, request.id, selectionPath, native.nativeId)}`;
          added.push({ ...native.read, ref, criteria: { ...native.read.criteria, workflow: 'amend', kind: 'party_name',
            requestId: request.id, role: partyRole[field], query: name, fieldPath: selectionPath, fieldPaths: [selectionPath] },
            result: { ...native.read.result, candidates: [native.row] } });
          return { ...native, ref };
        });
        const pick = bound[0]!;
        change.value = { name, candidateRefs: bound.map((row) => row.ref), suggestedRef: pick.ref };
        proposal.lookupResultRefs = [...new Set([...proposal.lookupResultRefs, ...bound.map((row) => row.ref)])].slice(0, 1000);
        const evidence: Evidence[] = [];
        if (key && stats && statFor(pick.name)) evidence.push(historyEvidence(key, statFor(pick.name), stats.total));
        const quote = emailQuoteAny(text, name, role);
        if (quote) evidence.push({ kind: 'email_text', count: null, total: null, lastSeen: null, quote });
        if (!evidence.length) evidence.push({ kind: 'policy_default', count: null, total: null, lastSeen: null,
          key: 'Best current HMS match for the requested party' });
        record(request, field, path, selectionPath, { ref: pick.ref, value: pick.nativeId, label: pick.name,
          confidence: key && stats && candidates.filter((row) => same(row.name, pick.name)).length === 1 &&
            gateFor(stats, pick.name, same) ? 'usual' : 'check', evidence,
          alternatives: bound.slice(1).map((row) => ({ ref: row.ref, label: row.name,
            count: statFor(row.name)?.count ?? null, total: statFor(row.name) ? stats!.total : null })) }, 'native_read');
      }
      continue;
    }
    if (request.kind !== 'create' && request.kind !== 'quote') continue;
    const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body`;
    const allocationId = request.kind === 'create' ? request.body.allocations[0]?.id : undefined;
    const owner = (request.kind === 'create' ? request.body.shared : request.body.parties) as Record<string, unknown>;
    const ownerPath = request.kind === 'create' ? `${root}/shared` : `${root}/parties`;
    const companyKeys = ['organization', 'bookingAgency'].flatMap((field) => {
      const name = rec(owner[field])?.name;
      return history && typeof name === 'string' ? [history.companyHistory(name)] : [];
    }).filter((key): key is AutopickHistoryKey => key !== null);
    // Do not fight a per-room or per-date value: shared picks only when nothing below overrides the field.
    const overridden = (field: Field) => request.kind === 'create' && [...request.body.dateSections.map((row) => row.defaults),
      ...request.body.allocations.map((row) => row.overrides)].some((fields) => (fields as Record<string, unknown>)[field] != null);

    const partyFields: PartyField[] = request.kind === 'create' ? ['organization', 'bookingAgency', 'arAccount'] : ['organization', 'bookingAgency'];
    for (const field of partyFields) {
      if (request.kind === 'create' && !allocationId || overridden(field)) continue;
      const current = owner[field], valuePath = `${ownerPath}/${field}`, selectionPath = `${valuePath}/nativeSelectionRef`;
      const party = rec(current);
      if (party?.kind === 'none' || (party && typeof party.suggestedRef === 'string')) continue;
      const role = entityRole[field];
      const same = (a: string, b: string) => reservationEntityKey(a, role) === reservationEntityKey(b, role);
      const keys = history ? orderedKeys(history, companyKeys, field, party && typeof party.name === 'string' ? party.name : undefined) : [];
      const rows = readRows(observations, partyRole[field]).filter((row) => field !== 'arAccount' || !isExcludedRefundArAccount(row.name))
        .filter((row, index, all) =>
        all.findIndex((other) => other.nativeId === row.nativeId) === index);
      const key = party && typeof party.name === 'string' && party.name.trim() ? keys[0]
        : keys.find((key) => key.fields[field]?.values.some((value) => value.value && rows.some((row) => same(row.name, value.value))));
      const stats = key?.fields[field];
      const statFor = (name: string) => stats?.values.find((row) => row.value && same(row.value, name));
      let candidates: Array<{ ref: string; nativeId: string; name: string }> = [];
      let pickIndex = -1;
      const evidence: Evidence[] = [];
      if (party && typeof party.name === 'string' && party.name.trim()) {
        candidates = observations.filter((row) => row.criteria.requestId === request.id &&
          Array.isArray(row.criteria.fieldPaths) && row.criteria.fieldPaths.includes(selectionPath)).flatMap((row) => {
          const native = rec((Array.isArray(row?.result.candidates) ? row.result.candidates : [])[0]);
          return row?.kind === 'party_candidate' && row.status === 'complete' && row.coverage.complete &&
            row.criteria.requestId === request.id && row.criteria.role === partyRole[field] &&
            Array.isArray(row.criteria.fieldPaths) && row.criteria.fieldPaths.includes(selectionPath) &&
            native && typeof native.name === 'string' && (field !== 'arAccount' || !isExcludedRefundArAccount(native.name)) &&
            /^\d{1,30}$/.test(String(native.nativeId ?? ''))
            ? [{ ref: row.ref, nativeId: String(native.nativeId), name: native.name }] : [];
        }).filter((row, index, all) => all.findIndex((other) => other.nativeId === row.nativeId) === index);
        if (!candidates.length) continue;
        if (request.kind === 'quote' && candidates.filter(row => norm(row.name) === norm(party.name)).length !== 1) continue;
        candidates = candidates.map((row, index) => ({ row, index })).sort((a, b) =>
          (request.kind === 'quote' ? Number(norm(b.row.name) === norm(party.name)) - Number(norm(a.row.name) === norm(party.name))
            : Number(same(b.row.name, String(party.name))) - Number(same(a.row.name, String(party.name)))) ||
          (statFor(b.row.name)?.count ?? 0) - (statFor(a.row.name)?.count ?? 0) || a.index - b.index).map(({ row }) => row);
        pickIndex = 0;
        const quote = emailQuoteAny(text, party.name, role) ?? undefined;
        if (quote) evidence.push({ kind: 'email_text', count: null, total: null, lastSeen: null, quote });
        if (key && stats && statFor(candidates[0]!.name)) evidence.unshift(historyEvidence(key, statFor(candidates[0]!.name), stats.total));
        if (!evidence.length) evidence.push({ kind: 'policy_default', count: null, total: null, lastSeen: null,
          key: 'Best current HMS match for the requested party' });
      } else {
        if (!key || !stats) continue;
        const named = stats.values.filter((row) => row.value && (field !== 'arAccount' || !isExcludedRefundArAccount(row.value)));
        const matched = named.flatMap((row) => {
          const native = rows.filter((candidate) => same(candidate.name, row.value));
          return native.length ? [{ stat: row, native }] : [];
        });
        if (!matched.length) continue;
        const extractionId = input.extractionIdByProposalRequestId.get(request.id) ?? request.id;
        const model = input.modelResults.find((row) => row.requestId === extractionId && row.field === field && row.outcome === 'chosen');
        const quoted = matched.filter((row) => emailQuoteAny(text, row.stat.value, role));
        const chosen = model ? matched.find((row) => row.native.some((native) => native.nativeId === model.nativeId))
          : quoted.length === 1 ? quoted[0] : matched[0];
        if (!chosen) continue;
        const ordered = [chosen, ...matched.filter((row) => row !== chosen)];
        // History-matched rows first, then the other rows HMS returned for the same searches (e.g. branches).
        const bound = [...ordered.flatMap((row) => row.native), ...rows]
          .filter((row, index, all) => all.findIndex((other) => other.nativeId === row.nativeId) === index)
          .slice(0, AUTOPICK_MAX_ALTERNATIVES + 1);
        candidates = bound.map((native) => {
          const fieldPath = selectionPath;
          const ref = `obs_autopick_${hash(input.generationId, request.id, fieldPath, native.nativeId)}`;
          const result = { ...native.read.result, ...(request.kind === 'quote' ? { nativeId: native.nativeId, name: native.name } : {}),
            candidates: [native.row] };
          added.push({ ...native.read, ref, generationId: input.generationId, criteria: { ...native.read.criteria,
            workflow: request.kind, requestId: request.id, role: partyRole[field], ...(allocationId ? { allocationId } : {}),
            fieldPath, fieldPaths: [fieldPath], nativeCandidateCount: Array.isArray(native.read.result.candidates) ? native.read.result.candidates.length : 0 },
          result });
          return { ref, nativeId: native.nativeId, name: native.name };
        });
        pickIndex = 0;
        evidence.push(historyEvidence(key, chosen.stat, stats.total));
        const quote = quoted.length === 1 && quoted[0] === chosen ? emailQuoteAny(text, chosen.stat.value, role) : null;
        if (model?.quote) evidence.unshift({ kind: 'model_choice', count: null, total: null, lastSeen: null, quote: model.quote });
        else if (quote) evidence.unshift({ kind: 'email_text', count: null, total: null, lastSeen: null, quote });
        owner[field] = { name: candidates[0]!.name, candidateRefs: [], suggestedRef: null };
      }
      const pick = candidates[pickIndex]!;
      const target = rec(owner[field])!;
      if (request.kind !== 'quote' || typeof target.name !== 'string' || !target.name.trim()) target.name = pick.name;
      const candidateRefs = candidates.slice(0, AUTOPICK_MAX_ALTERNATIVES + 1).map((row) => row.ref);
      target.candidateRefs = candidateRefs;
      target.suggestedRef = pick.ref;
      proposal.lookupResultRefs = [...new Set([...proposal.lookupResultRefs, ...candidateRefs])].slice(0, 1000);
      const uniqueNative = candidates.filter((row) => same(row.name, pick.name)).length === 1;
      const usual = Boolean(key && stats && uniqueNative && gateFor(stats, pick.name, same));
      record(request, field, valuePath, selectionPath, { ref: pick.ref, value: pick.nativeId, label: pick.name,
        confidence: usual ? 'usual' : 'check', evidence,
        alternatives: candidates.filter((row) => row !== pick).map((row) => ({ ref: row.ref, label: row.name,
          count: statFor(row.name)?.count ?? null, total: statFor(row.name) ? stats!.total : null })) }, 'native_read');
      if (history && field !== 'arAccount') {
        const keyed = history.companyHistory(pick.name);
        if (keyed) companyKeys.push(keyed);
      }
    }
    // Company keys also come from parties already chosen in the email or by staff.
    for (const field of partyFields) {
      const name = rec(owner[field])?.name;
      if (history && typeof name === 'string' && name.trim() && !companyKeys.some((row) => norm(row.key) === norm(name))) {
        const keyed = history.companyHistory(name);
        if (keyed) companyKeys.push(keyed);
      }
    }

    const codeSlots: Array<{ field: 'ratePlan' | 'roomType'; fields: Record<string, unknown>; path: string }> = request.kind === 'create'
      ? (['ratePlan', 'roomType'] as const).filter((field) => !overridden(field)).map((field) => ({ field, fields: request.body.shared as Record<string, unknown>, path: `${root}/shared/${field}` }))
      : request.body.groups.map((group, index) => ({ field: 'ratePlan' as const, fields: group as Record<string, unknown>, path: `${root}/groups/${index}/ratePlan` }));
    for (const slot of codeSlots) {
      if (slot.fields[slot.field] != null || !history || !catalog) continue;
      if (slot.field === 'roomType' && request.kind === 'create' && [request.body.shared,
        ...request.body.dateSections.map((section) => section.defaults), ...request.body.allocations.map((allocation) => allocation.overrides)]
        .some((fields) => typeof fields.requestedRoomDescription === 'string' && fields.requestedRoomDescription.trim())) continue;
      const kind = slot.field === 'ratePlan' ? 'rate' : 'room';
      const native = (code: string) => {
        const found = catalog!.lookupVerifiedCode(kind, code);
        return found.status === 'unique' && found.record ? found.record : null;
      };
      const keys = orderedKeys(history, companyKeys, slot.field);
      const key = keys.find((row) => row.fields[slot.field]!.values.some((value) => value.value && native(value.value)));
      if (!key) continue;
      const stats = key.fields[slot.field]!;
      const options = stats.values.flatMap((row) => {
        const code = row.value ? native(row.value) : null;
        return code ? [{ row, code }] : [];
      });
      const pick = options[0]!;
      const sameCode = (a: string, b: string) => a.toLocaleUpperCase('en-US') === b.toLocaleUpperCase('en-US');
      slot.fields[slot.field] = pick.code.code;
      record(request, slot.field, slot.path, slot.path, { ref: pick.code.code, value: pick.code.code,
        label: `${pick.code.code} - ${pick.code.meaning}`, confidence: gateFor(stats, pick.row.value, sameCode) ? 'usual' : 'check',
        evidence: [historyEvidence(key, pick.row, stats.total)],
        alternatives: options.slice(1).map(({ row, code }) => ({ ref: code.code, label: `${code.code} - ${code.meaning}`,
          count: row.count, total: stats.total })) }, 'native_read');
    }
    if (request.kind !== 'create') continue;
    const shared = request.body.shared as Record<string, unknown>;

    if (shared.guaranteeType == null && !overridden('guaranteeType') && input.guaranteeChoices.length) {
      const resolve = (value: string) => input.guaranteeChoices.filter((row) => norm(row.code) === norm(value) || norm(row.meaning) === norm(value));
      const choice = (value: string) => resolve(value).length === 1 ? resolve(value)[0]! : null;
      const keys = history ? orderedKeys(history, companyKeys, 'guaranteeType') : [];
      // Guarantee follows the sender's or company's own history only; a shared domain is too loose for a payment term.
      const gated = keys.filter((key) => key.kind !== 'agency_domain').map((key) => ({ key, stats: key.fields.guaranteeType! })).find(({ stats }) =>
        stats.values[0]?.value && choice(stats.values[0].value) && gateFor(stats, stats.values[0].value, (a, b) => norm(a) === norm(b)));
      const documentKinds = new Set(proposal.content.documents.filter((row) => row.ownerRequestId === request.id ||
        request.documentRefs.includes(row.id) || row.targetRefs.some((target) => target.requestId === request.id)).map((row) => row.kind));
      const attached = documentKinds.has('payment_proof') ? { meaning: 'Guaranteed By Deposit', key: 'Proof of payment' }
        : documentKinds.has('voucher') ? { meaning: 'Guaranteed By Agent', key: 'Voucher' } : null;
      const first = keys[0]?.fields.guaranteeType;
      let picked: { choice: Choice; evidence: Evidence[]; usual: boolean } | null = null;
      if (gated) picked = { choice: choice(gated.stats.values[0]!.value)!, usual: true,
        evidence: [historyEvidence(gated.key, gated.stats.values[0], gated.stats.total)] };
      else if (attached && choice(attached.meaning)) picked = { choice: choice(attached.meaning)!, usual: false,
        evidence: [{ kind: 'attachment', count: null, total: null, lastSeen: null, key: attached.key }] };
      else if (choice('Deposit Requested')) picked = { choice: choice('Deposit Requested')!, usual: false,
        evidence: [{ kind: 'policy_default', count: null, total: null, lastSeen: null, key: 'Default when history does not decide' }] };
      if (picked) {
        const pickedChoice = picked.choice;
        shared.guaranteeType = pickedChoice.code;
        const alternatives = [...(first?.values ?? []).flatMap((row) => {
          const option = row.value ? choice(row.value) : null;
          return option && option.code !== pickedChoice.code ? [{ ref: option.code, label: option.meaning, count: row.count, total: first!.total }] : [];
        }), ...input.guaranteeChoices.filter((row) => row.code !== pickedChoice.code).map((row) =>
          ({ ref: row.code, label: row.meaning, count: null, total: null }))]
          .filter((row, index, all) => all.findIndex((other) => other.ref === row.ref) === index);
        record(request, 'guaranteeType', `${root}/shared/guaranteeType`, `${root}/shared/guaranteeType`, { ref: pickedChoice.code,
          value: pickedChoice.code, label: pickedChoice.meaning, confidence: picked.usual ? 'usual' : 'check',
          evidence: picked.evidence, alternatives }, picked.usual ? 'native_read' : 'policy');
      }
    }
    if (shared.sourceOfBusiness == null && !overridden('sourceOfBusiness')) {
      shared.sourceOfBusiness = 'E-Mail';
      record(request, 'sourceOfBusiness', `${root}/shared/sourceOfBusiness`, `${root}/shared/sourceOfBusiness`, { ref: 'E-Mail',
        value: 'E-Mail', label: 'E-Mail', confidence: 'usual',
        evidence: [{ kind: 'policy_default', count: null, total: null, lastSeen: null, key: 'Booked from an email' }], alternatives: [] }, 'policy');
    }
  }
  return { proposal, observations: added, requirements };
}

/** Planned history reads as ordinary party lookups; criteria.autopick marks them as history-derived, not source-cited. */
export function autopickReadCriteria(read: { role: PartyRole; name: string; requestId: string }): Record<string, unknown> {
  return { role: read.role, name: read.name, raw: read.name, autopick: true, requestId: read.requestId };
}
