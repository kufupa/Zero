import type { PropertyConfiguration, ReservationPaneSnapshot, ReservationSourceContext } from './types';
import { effectiveAt, requestPath, valueAt } from './views';
import { quoteFamilyOptions, type QuoteFamilyOption } from '../../../server-pilot/src/ai/reservation-workflow-v2-quote-family';
import { compileQuote, currentQuoteAvailabilityObservation, quoteOverridesMatch } from '../../../server-pilot/src/ai/reservation-workflow-v2-quote-readiness';

export type QuoteOutputArtifact = {
  kind: 'pdf_quote' | 'xlsx_quote'; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; bytesBase64: string;
};
export type QuoteOutput = {
  requestId: string; operationId: string; observationRef: string;
  cover: { to: string; subject: string; body: string } | null;
  artifacts: QuoteOutputArtifact[]; failures: string[]; issues: string[]; stale: boolean; inventoryDecline: boolean;
};
export type QuoteOutputResult = { status: 'saved' | 'created' | 'cancelled' | 'error' | 'unknown'; message: string };
export function completeQuotePackage(output: QuoteOutput): boolean {
  return Boolean(output.cover) && output.issues.length === 0 && output.failures.length === 0 &&
    (output.inventoryDecline || (output.artifacts.some(item => item.kind === 'pdf_quote') &&
      output.artifacts.some(item => item.kind === 'xlsx_quote')));
}
const rec = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

const NATIVE_BOARD_LABELS: Record<string, string> = {
  'room only r': 'room_only',
  'room only nr': 'room_only',
  'bed & breakfast r': 'bb',
  'bed & breakfast nr': 'bb',
  'dinner bed & breakfast r': 'dinner_bb',
  'dinner bed & breakfast nr': 'dinner_bb',
  'dinner, bed & breakfast r': 'dinner_bb',
  'dinner, bed & breakfast nr': 'dinner_bb',
  'dinner, bed, breakfast & beverage r': 'dinner_bb',
  'dinner, bed, breakfast & beverage nr': 'dinner_bb',
};

function boardCode(value: unknown, source: ReservationSourceContext, configuration?: PropertyConfiguration | null): string | null {
  const label = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : '';
  const mapping = configuration?.propertyCode === source.propertyId && configuration.transportId === source.mailboxId
    ? configuration.nativeMealMappings.find(row => row.label.trim().replace(/\s+/gu, ' ').toLowerCase() === label) : undefined;
  if (mapping) return mapping.mealPlan;
  if (source.propertyId !== 'HRCEN') return label === 'room_only' || label === 'bb' || label === 'dinner_bb' ? label : null;
  const mapped = Object.prototype.hasOwnProperty.call(NATIVE_BOARD_LABELS, label) ? NATIVE_BOARD_LABELS[label] : null;
  if (mapped) return mapped;
  const board = label.replace(/[\s&-]+/gu, '_');
  if (['room_only', 'roomonly', 'ro'].includes(board)) return 'room_only';
  if (['bb', 'b_b', 'breakfast', 'bed_and_breakfast'].includes(board)) return 'bb';
  if (['dinner_bb', 'dinner_b_b', 'dinner_bed_breakfast', 'dinner_and_breakfast'].includes(board)) return 'dinner_bb';
  return null;
}

function stayNights(arrival: unknown, departure: unknown): string[] {
  if (typeof arrival !== 'string' || typeof departure !== 'string') return [];
  const start = Date.parse(`${arrival}T00:00:00.000Z`), end = Date.parse(`${departure}T00:00:00.000Z`);
  const count = (end - start) / 86_400_000;
  if (!Number.isInteger(count) || count < 1 || count > 30) return [];
  return Array.from({ length: count }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function hasCurrentUnavailableInventoryProof(snapshot: ReservationPaneSnapshot, source: ReservationSourceContext,
  requestId: string, document: ReservationWorkflowV2DraftObservation, configuration?: PropertyConfiguration | null): boolean {
  const draft = snapshot.session.draft;
  const payload = rec(document.result), marker = rec(payload.unavailableInventory);
  const documentCriteria = rec(document.criteria);
  const availabilityRef = typeof marker.availabilityObservationRef === 'string' ? marker.availabilityObservationRef : '';
  if (marker.kind !== 'requested_room_unavailable' || !availabilityRef || !document.sourceRefs.includes(availabilityRef) ||
      document.status !== 'complete' || !document.coverage.complete || payload.companyShownInCover !== false ||
      payload.sourceHash !== source.sourceHash || typeof documentCriteria.inputDigest !== 'string' || !documentCriteria.inputDigest) return false;
  const request = draft.proposal.content.requests.find((item) => item.id === requestId && item.kind === 'quote');
  const effectiveBody = rec(effectiveAt(snapshot, `${requestPath(requestId)}/body`));
  const effectiveGroups = Array.isArray(effectiveBody.groups) ? effectiveBody.groups.map(rec) : [];
  const group = request?.kind === 'quote' && effectiveGroups.length === 1 ? effectiveGroups[0]! : null;
  const roomCodes = Array.isArray(group?.roomCodes) ? group.roomCodes : [];
  const nights = stayNights(group?.arrival, group?.departure);
  if (!group || roomCodes.length !== 1 || !group.ratePlan || !nights.length ||
      marker.groupId !== group.id || marker.roomCode !== roomCodes[0] || marker.rateCode !== group.ratePlan ||
      marker.mealPlan !== boardCode(group.mealPlan, source, configuration) || marker.arrivalDate !== group.arrival ||
      marker.departureDate !== group.departure || marker.quantity !== group.quantity) return false;
  const availability = draft.observations.find((item) => item.ref === availabilityRef);
  const native = rec(availability?.result), criteria = rec(availability?.criteria), shortfall = rec(native.shortfall);
  const expires = Date.parse(typeof marker.freshUntil === 'string' ? marker.freshUntil : '');
  const nativeExpires = Date.parse(typeof native.freshUntil === 'string' ? native.freshUntil : '');
  if (!availability || availability.kind !== 'rate_availability' || availability.status !== 'failed' ||
      availability.generationId !== draft.generationId || availability.propertyCode !== draft.propertyCode ||
      availability.sourceMessageId !== source.messageId || criteria.workflow !== 'quote' || criteria.requestId !== requestId ||
      criteria.sourceHash !== source.sourceHash || criteria.inputDigest !== documentCriteria.inputDigest ||
      native.failureCode !== 'native_quote_insufficient_inventory' || native.failureKind !== 'proven_shortage' ||
      native.sourceHash !== source.sourceHash || native.inputDigest !== documentCriteria.inputDigest || native.availabilityTruncated !== false ||
      !Number.isFinite(nativeExpires) || nativeExpires <= Date.now() || !Number.isFinite(expires) || expires <= Date.now() ||
      shortfall.roomCode !== marker.roomCode || shortfall.roomLabel !== marker.roomLabel ||
      shortfall.demand !== marker.quantity || shortfall.supply !== 0 || !nights.includes(String(shortfall.date))) return false;
  const latestAvailability = [...draft.observations].reverse().find((item) => {
    const currentCriteria = rec(item.criteria);
    return item.kind === 'rate_availability' && item.generationId === draft.generationId &&
      item.propertyCode === draft.propertyCode && item.sourceMessageId === source.messageId &&
      currentCriteria.workflow === 'quote' && currentCriteria.requestId === requestId &&
      currentCriteria.sourceHash === source.sourceHash && currentCriteria.inputDigest === documentCriteria.inputDigest;
  });
  if (latestAvailability?.ref !== availabilityRef) return false;
  const diagnostics: Array<Record<string, unknown>> = Array.isArray(native.quoteDiagnostics)
    ? native.quoteDiagnostics.map(rec).filter((item) => Object.keys(item).length > 0) : [];
  const diagnostic = [...diagnostics].reverse().find((item) => item.kind === 'requested' && item.contextMatchesSelection === true);
  const diagnosticExpiry = Date.parse(typeof diagnostic?.freshUntil === 'string' ? diagnostic.freshUntil : '');
  if (!diagnostic || diagnostic.availabilityTruncated !== false || diagnostic.freshUntil !== marker.freshUntil ||
      !Number.isFinite(diagnosticExpiry) || diagnosticExpiry <= Date.now()) return false;
  const board: Array<Record<string, unknown>> = Array.isArray(diagnostic.availabilityBoard)
    ? diagnostic.availabilityBoard.map(rec).filter((item) => Object.keys(item).length > 0) : [];
  const rows = board.filter((item) => item.groupId === group.id && item.roomCode === marker.roomCode &&
    item.rateCode === marker.rateCode && boardCode(item.mealPlanLabel ?? item.mealPlan, source, configuration) === marker.mealPlan);
  if (rows.length !== 1) return false;
  const row = rows[0]!, coverage = rec(row.coverage), nightCoverage = rec(row.nightCoverage);
  const facts: Array<Record<string, unknown>> = Array.isArray(row.nightly)
    ? row.nightly.map(rec).filter((item) => Object.keys(item).length > 0) : [];
  const byDate = new Map(facts.map((fact) => [fact.date, fact]));
  return row.availability === 'unavailable' && row.roomsLeft === 0 &&
    coverage.search === 'complete' && coverage.requiredFacts === 'complete' &&
    coverage.matchingRowsUnseen !== true && coverage.optionsTruncated !== true &&
    nightCoverage.complete === true && nightCoverage.expected === nights.length && nightCoverage.observed === nights.length &&
    facts.length === nights.length && byDate.size === nights.length && nights.every((date) => {
      const fact = byDate.get(date);
      return fact?.availableCount === 0 && fact.requestedCount === group.quantity && fact.stockStatus === 'sold';
    });
}

type ReservationWorkflowV2DraftObservation = ReservationPaneSnapshot['session']['draft']['observations'][number];

/** Only durable host-generated output, attached to this source and generation, is eligible. */
export function getQuoteOutput(source: ReservationSourceContext, snapshot: ReservationPaneSnapshot | null,
  requestId: string, configuration?: PropertyConfiguration | null): QuoteOutput | null {
  if (!snapshot) return null;
  const draft = snapshot.session.draft;
  if (!source.mailboxId || !source.threadId || draft.transportId !== source.mailboxId ||
      draft.propertyCode !== source.propertyId || draft.source.messageId !== source.messageId ||
      draft.source.threadId !== source.threadId || draft.source.sourceHash !== source.sourceHash ||
      snapshot.sourceMessageId !== source.messageId ||
      !draft.proposal.content.requests.some((request) => request.id === requestId && request.kind === 'quote')) return null;
  const operation = [...draft.operationResults].reverse().find((row) => row.requestId === requestId &&
    row.workflow === 'quote' && row.generationId === draft.generationId &&
    (row.status === 'succeeded' || row.status === 'failed'));
  if (!operation) return null;
  const observation = [...draft.observations].reverse().find((row) => operation.observationRefs.includes(row.ref) &&
    row.kind === 'document' && row.generationId === draft.generationId && row.propertyCode === draft.propertyCode &&
    row.sourceMessageId === source.messageId && row.criteria.workflow === 'quote' &&
    row.criteria.requestId === requestId && row.criteria.operationId === operation.id);
  if (!observation) return null;
  const result = rec(observation.result), cover = rec(result.coverEmail);
  const raw = Array.isArray(result.artifacts) ? result.artifacts : [];
  const artifacts: QuoteOutputArtifact[] = [];
  const issues: string[] = [];
  for (const entry of raw) {
    const item = rec(entry), kind = item.kind;
    if ((kind !== 'pdf_quote' && kind !== 'xlsx_quote') || typeof item.fileName !== 'string' ||
        typeof item.mimeType !== 'string' || typeof item.sizeBytes !== 'number' ||
        typeof item.sha256 !== 'string' || typeof item.bytesBase64 !== 'string') {
      issues.push('A generated attachment is incomplete. Generate the quote again.');
      continue;
    }
    artifacts.push({ kind, fileName: item.fileName, mimeType: item.mimeType, sizeBytes: item.sizeBytes,
      sha256: item.sha256, bytesBase64: item.bytesBase64 });
  }
  const failures = Array.isArray(result.failures) ? result.failures.filter((item): item is string => typeof item === 'string' && !!item) : [];
  const requested = valueAt(snapshot, `${requestPath(requestId)}/body/outputIntent/artifacts`);
  const outputKinds = Array.isArray(requested) ? requested : [];
  const requestedOutputKinds = Array.isArray(result.requestedOutputKinds) ? result.requestedOutputKinds : [];
  const sameOutputChoice = requestedOutputKinds.length === outputKinds.length &&
    outputKinds.every((kind, index) => requestedOutputKinds[index] === kind);
  const parsedCover = typeof cover.to === 'string' && !!cover.to.trim() &&
    typeof cover.subject === 'string' && !!cover.subject.trim() && typeof cover.body === 'string' && !!cover.body.trim()
    ? { to: cover.to, subject: cover.subject, body: cover.body } : null;
  const stale = operation.draftRevision !== snapshot.session.revision;
  const inventoryDecline = result.unavailableInventory !== undefined &&
    operation.status === 'succeeded' && !stale && sameOutputChoice &&
    hasCurrentUnavailableInventoryProof(snapshot, source, requestId, observation, configuration);
  if (result.unavailableInventory !== undefined && !inventoryDecline)
    issues.push('The unavailability reply no longer matches a complete current Infor result. Refresh the search before using it.');
  if (result.unavailableInventory === undefined) {
    const priceRef = typeof result.preparedObservationRef === 'string' ? result.preparedObservationRef : '';
    const price = draft.observations.find((item) => item.ref === priceRef);
    const priceCriteria = rec(price?.criteria), priceResult = rec(price?.result);
    const expiry = Date.parse(typeof priceResult.freshUntil === 'string' ? priceResult.freshUntil : '');
    if (!price || !observation.sourceRefs.includes(priceRef) || price.kind !== 'rate_availability' ||
        price.status !== 'complete' || !price.coverage.complete || price.generationId !== draft.generationId ||
        price.propertyCode !== draft.propertyCode || price.sourceMessageId !== source.messageId ||
        priceCriteria.workflow !== 'quote' || priceCriteria.requestId !== requestId ||
        priceCriteria.sourceHash !== source.sourceHash || priceCriteria.inputDigest !== rec(observation.criteria).inputDigest ||
        !Number.isFinite(expiry) || expiry <= Date.now()) {
      issues.push('The Infor price is no longer current. Generate the quote again.');
    }
  }
  const textOnly = Array.isArray(result.artifacts) && raw.length === 0 && outputKinds.length === 1 && outputKinds[0] === 'email_quote' &&
    Array.isArray(result.outputKinds) && result.outputKinds.length === 1 && result.outputKinds[0] === 'email_quote' &&
    operation.status === 'succeeded' && observation.status === 'complete' && observation.coverage.complete &&
    failures.length === 0 && parsedCover !== null;
  if (!outputKinds.length || outputKinds.some((kind) => !['email_quote', 'pdf_quote', 'xlsx_quote'].includes(kind)) ||
      new Set(outputKinds).size !== outputKinds.length) issues.push('The requested output types are unclear. Generate the quote again.');
  if (result.sourceHash !== source.sourceHash) issues.push('The generated output no longer matches this email.');
  if (raw.length > 32 || new Set(artifacts.map((item) => item.kind)).size !== artifacts.length) issues.push('The generated attachments are ambiguous.');
  if (artifacts.some((item) => !outputKinds.includes(item.kind))) issues.push('A generated attachment was not requested. Generate the quote again.');
  if (!artifacts.length && !textOnly && failures.length === 0 && !inventoryDecline) issues.push('No quotation file was generated. Generate the quote again.');
  if (!inventoryDecline && outputKinds.includes('pdf_quote') && !artifacts.some((item) => item.kind === 'pdf_quote') && !failures.some((failure) => failure.startsWith('pdf_'))) issues.push('The PDF is missing. Generate the quote again.');
  if (!inventoryDecline && outputKinds.includes('xlsx_quote') && !artifacts.some((item) => item.kind === 'xlsx_quote') && !failures.some((failure) => failure.startsWith('xlsx_'))) issues.push('The Excel file is missing. Generate the quote again.');
  if (outputKinds.includes('email_quote') && !parsedCover) issues.push('The cover reply is missing. Generate the quote again.');
  if (stale) issues.push('The quote changed after these files were generated. Generate the quote again.');
  return { requestId, operationId: operation.id, observationRef: observation.ref, cover: parsedCover,
    artifacts, failures, issues, stale, inventoryDecline };
}

/** Reject incomplete or inconsistent families before pricing or delivering any option. */
export function quoteFamilyMembers(snapshot: ReservationPaneSnapshot | null, requestId: string): Array<{ requestId: string; label: string }> | null {
  const draft = snapshot?.session.draft;
  if (!draft || !quoteFamilyOptions(draft, requestId)) return null;
  const requests = draft.proposal.content.requests;
  const request = requests?.find(row => row.id === requestId && row.kind === 'quote');
  if (!request || request.kind !== 'quote') return null;
  const family = request.body.quoteFamily;
  if (!family) return [{ requestId, label: 'Quote' }];
  return family.members;
}

/** The option receipt must still bind every current prepared date run. */
function currentOptionReceipt(snapshot: ReservationPaneSnapshot, option: QuoteFamilyOption,
  options: QuoteFamilyOption[], output: QuoteOutput): boolean {
  if (output.inventoryDecline) return option.members.length === 1;
  const draft = snapshot.session.draft;
  const document = draft.observations.find(row => row.ref === output.observationRef && row.kind === 'document');
  const payload = rec(document?.result), receipt = rec(payload.optionReceipt);
  if (!payload.optionReceipt) return option.members.length === 1;
  if (option.members.length > 1 && receipt.inventoryValidation !== 'joint-inventory/v1') return false;
  const entries = Array.isArray(receipt.members) ? receipt.members.map(rec) : [];
  const leader = draft.proposal.content.requests.find(row => row.id === option.members[0]?.requestId && row.kind === 'quote');
  const familyId = leader?.kind === 'quote' ? leader.body.quoteFamily?.id ?? null : null;
  if (!document || receipt.familyId !== familyId || receipt.optionId !== option.id || JSON.stringify(receipt.familyOptions) !== JSON.stringify(options) ||
      entries.length !== option.members.length || typeof receipt.totalMinor !== 'number' ||
      !Number.isSafeInteger(receipt.totalMinor) || typeof receipt.currency !== 'string') return false;
  let total = 0;
  for (const [index, member] of option.members.entries()) {
    const request = draft.proposal.content.requests.find(row => row.id === member.requestId && row.kind === 'quote');
    if (!request || request.kind !== 'quote') return false;
    const compiled = compileQuote(draft, request, true);
    if (compiled.status !== 'ok') return false;
    const price = currentQuoteAvailabilityObservation(draft, member.requestId, compiled.inputDigest);
    const result = rec(price?.result), criteria = rec(price?.criteria), entry = entries[index]!;
    const prepared = [...draft.operationResults].reverse().find(row => row.workflow === 'quote' &&
      row.requestId === member.requestId && row.generationId === draft.generationId && row.status === 'prepared');
    if (!price || price.status !== 'complete' || !price.coverage.complete || !prepared?.observationRefs.includes(price.ref) ||
        !document.sourceRefs.includes(price.ref) || entry.requestId !== member.requestId ||
        entry.preparedObservationRef !== price.ref || entry.inputDigest !== compiled.inputDigest ||
        criteria.sourceHash !== draft.source.sourceHash || criteria.inputDigest !== compiled.inputDigest ||
        entry.revisionRef !== rec(result.revision).id || entry.nativeInputDigest !== (result.nativeInputDigest ?? null) ||
        entry.workflowRunId !== (result.workflowRunId ?? null) || entry.freshUntil !== result.freshUntil ||
        !Number.isFinite(Date.parse(String(result.freshUntil))) || Date.parse(String(result.freshUntil)) <= Date.now() ||
        !quoteOverridesMatch(draft, member.requestId, result.inputOverrides) ||
        typeof result.totalMinor !== 'number' || !Number.isSafeInteger(result.totalMinor) || result.currency !== receipt.currency) return false;
    total += result.totalMinor;
  }
  const rawArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts.map(rec) : [];
  return Number.isSafeInteger(total) && total === receipt.totalMinor && rawArtifacts.every(artifact =>
    artifact.totalMinor === total && artifact.currency === receipt.currency);
}

/** Every complete option is validated before one unsent draft is assembled. */
export function getQuotePackageOutput(source: ReservationSourceContext, snapshot: ReservationPaneSnapshot | null,
  requestId: string, configuration?: PropertyConfiguration | null): QuoteOutput | null {
  if (!snapshot) return null;
  const options = quoteFamilyOptions(snapshot.session.draft, requestId);
  if (!options) return null;
  if (options.length === 1 && options[0]!.members.length === 1) return getQuoteOutput(source, snapshot, requestId, configuration);
  const outputs = options.map(option => getQuoteOutput(source, snapshot, option.members[0]!.requestId, configuration));
  if (outputs.some(output => !output || !completeQuotePackage(output))) return null;
  const complete = outputs.filter((output): output is QuoteOutput => output !== null);
  if (complete.some((output, index) => !currentOptionReceipt(snapshot, options[index]!, options, output))) return null;
  const recipient = complete[0]?.cover?.to.trim();
  if (!recipient || complete.some(output => output.cover?.to.trim().toLowerCase() !== recipient.toLowerCase())) return null;
  if (complete.length === 1) return { ...complete[0]!, requestId };
  const artifacts = complete.flatMap((output, index) => output.artifacts.map(item => {
    const prefix = `Option ${index + 1} - `;
    const dot = item.fileName.lastIndexOf('.');
    const extension = dot > 0 ? item.fileName.slice(dot) : '';
    const name = dot > 0 ? item.fileName.slice(0, dot) : item.fileName;
    return { ...item, fileName: `${prefix}${name.slice(0, 255 - prefix.length - extension.length)}${extension}` };
  }));
  if (new Set(artifacts.map(item => item.fileName.toLowerCase())).size !== artifacts.length) return null;
  return { requestId, operationId: JSON.stringify(complete.map(output => output.operationId)),
    observationRef: JSON.stringify(complete.map(output => output.observationRef)),
    cover: { to: recipient, subject: complete[0]!.cover!.subject,
      body: ['Please find the separately priced options below.', ...complete.map((output, index) =>
        `${options[index]!.label}\n\n${output.cover!.body}`)].join('\n\n') },
    artifacts, failures: [], issues: [], stale: false, inventoryDecline: complete.every(output => output.inventoryDecline) };
}

export function quoteCoverHtml(body: string): string {
  return body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}

