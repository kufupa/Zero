import type { PropertyConfiguration, ReservationPaneSnapshot, ReservationSourceContext } from './types';
import { effectiveAt, requestPath, valueAt } from './views';

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
  const textOnly = Array.isArray(result.artifacts) && raw.length === 0 && outputKinds.length === 1 && outputKinds[0] === 'email_quote' &&
    Array.isArray(result.outputKinds) && result.outputKinds.length === 1 && result.outputKinds[0] === 'email_quote' &&
    operation.status === 'succeeded' && observation.status === 'complete' && observation.coverage.complete &&
    failures.length === 0 && parsedCover !== null;
  if (!outputKinds.length || outputKinds.some((kind) => !['email_quote', 'pdf_quote', 'xlsx_quote'].includes(kind)) ||
      new Set(outputKinds).size !== outputKinds.length) issues.push('The requested output types are unclear. Generate the quote again.');
  if (result.sourceHash !== source.sourceHash) issues.push('The generated output no longer matches this email.');
  if (raw.length > 32 || new Set(artifacts.map((item) => item.kind)).size !== artifacts.length) issues.push('The generated attachments are ambiguous.');
  if (artifacts.some((item) => !outputKinds.includes(item.kind))) issues.push('A generated attachment was not requested. Generate the quote again.');
  // An independently generated cover is still useful when one or both document builders fail. Keep
  // that unsent draft actionable and let staff decide whether to continue without those files.
  if (!artifacts.length && !textOnly && failures.length === 0 && !inventoryDecline) issues.push('No quotation file was generated. Generate the quote again.');
  if (!inventoryDecline && outputKinds.includes('pdf_quote') && !artifacts.some((item) => item.kind === 'pdf_quote') && !failures.some((failure) => failure.startsWith('pdf_'))) issues.push('The PDF is missing. Generate the quote again.');
  if (!inventoryDecline && outputKinds.includes('xlsx_quote') && !artifacts.some((item) => item.kind === 'xlsx_quote') && !failures.some((failure) => failure.startsWith('xlsx_'))) issues.push('The Excel file is missing. Generate the quote again.');
  if (outputKinds.includes('email_quote') && !parsedCover) issues.push('The cover reply is missing. Generate the quote again.');
  if (stale) issues.push('The quote changed after these files were generated. Generate the quote again.');
  return { requestId, operationId: operation.id, observationRef: observation.ref, cover: parsedCover,
    artifacts, failures, issues, stale, inventoryDecline };
}

export function quoteCoverHtml(body: string): string {
  return body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
}

