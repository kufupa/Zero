import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// The key, raw IDs and cursor positions are private. Never serialize this context.
const rawId = z.string().min(1).max(4096);
const opaqueId = z.string().regex(/^[0-9a-f]{64}$/);
const completeness = z.enum(['complete', 'partial', 'unavailable', 'unknown']);
const countBand = z.enum(['zero', 'one', 'two_to_ten', 'eleven_to_hundred', 'over_hundred', 'unknown']);
const proposition = z.enum([
  'attachment_parent', 'same_thread', 'exact_header', 'exact_address', 'same_stay',
  'document_version', 'later_observation', 'observation_comparison',
]);
const claimStatus = z.enum(['supported', 'candidate', 'conflicting', 'unknown']);
const inspection = z.enum(['uninspected', 'inspected', 'insufficient']);
const sourceRole = z.enum(['pdf', 'parent_message', 'candidate_message', 'hms_observation', 'other']);
const evidenceType = z.enum([
  'attachment', 'thread', 'header', 'address', 'confirmation_token', 'date', 'document_version', 'observation', 'other',
]);
const addressRole = z.enum([
  'current_from', 'current_to', 'current_cc', 'current_bcc', 'current_reply_to', 'current_sender',
  'original_from', 'original_to', 'original_cc', 'original_bcc', 'original_reply_to', 'original_sender', 'unknown',
]);
const identityRelation = z.enum(['distinct_source_identity', 'unresolved', 'not_applicable']);
const attachmentAttribution = z.enum(['verified_snapshot_parent', 'ambiguous_snapshot_occurrence', 'inventory_only_reference', 'unknown', 'not_applicable']);
const headerRelation = z.enum(['message_id', 'in_reply_to', 'references', 'none', 'unknown']);
const headerDirection = z.enum(['parent_to_target', 'target_to_parent', 'shared', 'none', 'unknown']);
const structuralPageCompleteness = z.enum(['complete', 'partial', 'unavailable', 'unknown', 'not_requested']);
const comparisonField = z.enum(['confirmation', 'arrival', 'departure', 'occupancy', 'room_type', 'rate', 'booking_status', 'other', 'unknown', 'not_applicable']);
const comparisonOutcome = z.enum(['equal', 'different', 'unknown', 'not_comparable', 'not_applicable']);
const observationTime = z.enum(['before', 'same', 'after', 'unknown', 'not_applicable']);
const mailboxClassification = z.enum(['hotel_only', 'includes_non_hotel', 'unknown', 'not_applicable']);
const equality = z.enum(['equal', 'different', 'unknown', 'not_applicable']);
const confirmationStrength = z.enum(['structured', 'labeled', 'unlabeled_numeric', 'unknown', 'not_applicable']);
const dateRelation = z.enum(['before', 'same', 'after', 'overlaps', 'unknown', 'not_applicable']);
const conflict = z.enum(['conflict', 'consistent', 'unknown', 'not_applicable']);

function validHeaderDirection(relation: z.infer<typeof headerRelation>, direction: z.infer<typeof headerDirection>): boolean {
  return relation === 'message_id' ? direction === 'shared' :
    (relation === 'in_reply_to' || relation === 'references') &&
      (direction === 'parent_to_target' || direction === 'target_to_parent');
}

// All objects are strict: even nested unknown keys are errors, never stripped.
function packetShape(id: typeof rawId) {
  const evidence = z.object({
    evidenceId: id,
    sourceId: id,
    observationSourceId: id.nullable(),
    subjectId: id,
    objectId: id,
    sourceRole,
    provenanceAvailable: z.boolean(),
    type: evidenceType,
    attachmentAttribution,
    identityRelation,
    parentAddressRoles: z.array(addressRole),
    candidateAddressRoles: z.array(addressRole),
    headerRelation,
    headerDirection,
    mailboxClassification,
    confirmationEquality: equality,
    confirmationStrength,
    dateRelation,
    observationConflict: conflict,
    comparisonField,
    comparisonOutcome,
    // Object capture time relative to subject capture time; never a stay date.
    objectObservationTime: observationTime,
  }).strict().refine((item) => {
    // For attachment evidence this flag refers to the parent link, not merely
    // the existence of the inventory row. Do not promote unresolved anchors.
    if (item.type === 'attachment') {
      if (item.attachmentAttribution === 'not_applicable' ||
          item.provenanceAvailable !== (item.attachmentAttribution === 'verified_snapshot_parent')) return false;
    } else if (item.attachmentAttribution !== 'not_applicable') return false;
    if (item.type === 'address' ? item.identityRelation === 'not_applicable' :
        item.identityRelation !== 'not_applicable') return false;
    if (item.type === 'header' && item.headerRelation !== 'none' && item.headerRelation !== 'unknown' &&
        !validHeaderDirection(item.headerRelation, item.headerDirection)) return false;
    if (item.type === 'header' && (item.headerRelation === 'none' || item.headerRelation === 'unknown') &&
        item.headerDirection !== 'none' && item.headerDirection !== 'unknown') return false;
    if ((item.comparisonOutcome === 'equal' || item.comparisonOutcome === 'different') &&
        (item.comparisonField === 'unknown' || item.comparisonField === 'not_applicable')) return false;
    if (item.comparisonField === 'confirmation' &&
        (item.comparisonOutcome === 'equal' || item.comparisonOutcome === 'different') &&
        (item.confirmationEquality === 'equal' || item.confirmationEquality === 'different') &&
        item.comparisonOutcome !== item.confirmationEquality) return false;
    if ((item.observationConflict === 'conflict' && item.comparisonOutcome === 'equal') ||
        (item.observationConflict === 'consistent' && item.comparisonOutcome === 'different')) return false;
    return true;
  });
  const claim = z.object({
    claimId: id,
    subjectId: id,
    objectId: id,
    proposition,
    status: claimStatus,
    inspection,
    evidence: z.array(evidence),
  }).strict().refine((value) => {
    // Deterministic facts may be present without adjudication, but a claim
    // remains unknown until it has been inspected with sufficient evidence.
    if (value.status !== 'unknown' && value.inspection !== 'inspected') return false;
    if (value.proposition === 'observation_comparison') {
      // A comparison concerns exactly these two source endpoints, independent
      // of which capture came first. Callers must validate private references.
      if (value.subjectId === value.objectId || value.evidence.length < 2 ||
          new Set(value.evidence.map((item) => item.evidenceId)).size !== value.evidence.length) return false;
      const first = value.evidence[0]!;
      const pdfObservations = value.evidence.filter((item) => item.sourceRole === 'pdf').map((item) => item.observationSourceId);
      if (!pdfObservations.length || pdfObservations[0] === null || pdfObservations[0] === value.subjectId ||
          pdfObservations[0] === value.objectId || pdfObservations.some((id) => id !== pdfObservations[0])) return false;
      if (first.comparisonField === 'not_applicable' || first.objectObservationTime === 'not_applicable') return false;
      const valid = value.evidence.every((item) => item.type === 'observation' && item.provenanceAvailable &&
        item.subjectId === value.subjectId && item.objectId === value.objectId &&
        ((item.sourceRole === 'pdf' && item.sourceId === value.subjectId && item.observationSourceId === pdfObservations[0]) ||
          (item.sourceRole === 'hms_observation' && item.sourceId === value.objectId && item.observationSourceId === value.objectId)) &&
        item.comparisonField === first.comparisonField && item.comparisonOutcome === first.comparisonOutcome &&
        item.objectObservationTime === first.objectObservationTime && item.observationConflict === first.observationConflict &&
        item.confirmationEquality === first.confirmationEquality && item.confirmationStrength === first.confirmationStrength &&
        item.dateRelation === first.dateRelation &&
        (item.observationConflict !== 'conflict' || item.comparisonOutcome === 'different') &&
        (item.observationConflict !== 'consistent' || item.comparisonOutcome === 'equal'));
      if (!valid || !value.evidence.some((item) => item.sourceRole === 'pdf') ||
          !value.evidence.some((item) => item.sourceRole === 'hms_observation')) return false;
      if (value.status === 'supported') return first.comparisonOutcome === 'equal' || first.comparisonOutcome === 'different';
      if (value.status === 'conflicting') return first.comparisonOutcome === 'different' && first.observationConflict === 'conflict';
      return true;
    }
    if (value.evidence.some((item) => item.observationSourceId !== null)) return false;
    if (value.proposition === 'attachment_parent' && value.status !== 'unknown' &&
        (!value.evidence.some((item) => item.type === 'attachment') ||
         value.evidence.some((item) => item.type === 'attachment' && item.attachmentAttribution !== 'verified_snapshot_parent'))) return false;
    if (value.status === 'unknown' || value.status === 'candidate') return true;
    // The comparison must explicitly identify both claim endpoints, on the same
    // provenanced item whose source is one of those endpoints. A provenance
    // flag on unrelated evidence is not enough.
    const relevant = value.evidence.filter((item) => item.provenanceAvailable &&
      item.subjectId === value.subjectId && item.objectId === value.objectId &&
      (item.sourceId === value.subjectId || item.sourceId === value.objectId));
    if (value.status === 'conflicting') {
      if (new Set(value.evidence.map((item) => item.evidenceId)).size !== value.evidence.length) return false;
      // Contradiction must concern the proposition and the same signal, with
      // explicit conflict and independent provenance at both endpoints.
      const types: Record<z.infer<typeof proposition>, readonly z.infer<typeof evidenceType>[]> = {
        attachment_parent: ['attachment'],
        same_thread: ['thread'],
        exact_header: ['header'],
        exact_address: ['address'],
        same_stay: ['confirmation_token', 'date', 'document_version', 'observation'],
        document_version: ['document_version'],
        later_observation: ['observation'],
        observation_comparison: ['observation'],
      };
      const contradicting = relevant.filter((item) => {
        if (!types[value.proposition].includes(item.type) || item.observationConflict !== 'conflict') return false;
        if (item.type === 'header') return validHeaderDirection(item.headerRelation, item.headerDirection);
        if (item.type === 'address') return item.parentAddressRoles.length > 0 && item.candidateAddressRoles.length > 0;
        if (item.type === 'confirmation_token') return item.confirmationEquality === 'different' &&
          (item.confirmationStrength === 'structured' || item.confirmationStrength === 'labeled');
        if (item.type === 'date') return item.dateRelation !== 'unknown' && item.dateRelation !== 'not_applicable';
        if (item.type === 'document_version' || item.type === 'observation') return item.comparisonField !== 'unknown' && item.comparisonField !== 'not_applicable' &&
          item.comparisonOutcome === 'different' &&
          (item.type !== 'observation' || item.objectObservationTime === 'after');
        return true;
      });
      return contradicting.some((left) => contradicting.some((right) =>
        left.type === right.type && left.sourceId !== right.sourceId &&
        left.comparisonField === right.comparisonField && left.comparisonOutcome === right.comparisonOutcome));
    }
    switch (value.proposition) {
      case 'attachment_parent':
        return relevant.some((item) => item.type === 'attachment' && item.sourceRole === 'pdf' && item.sourceId === value.subjectId);
      case 'same_thread':
        return relevant.some((item) => item.type === 'thread' &&
          (item.sourceRole === 'parent_message' || item.sourceRole === 'candidate_message'));
      case 'exact_header':
        return relevant.some((item) => item.type === 'header' && validHeaderDirection(item.headerRelation, item.headerDirection));
      case 'exact_address':
        return relevant.some((item) => item.type === 'address' &&
          item.parentAddressRoles.length > 0 && item.candidateAddressRoles.length > 0);
      case 'same_stay': {
        const confirmations = relevant.filter((item) => item.type === 'confirmation_token' &&
          item.confirmationEquality === 'equal' &&
          (item.confirmationStrength === 'structured' || item.confirmationStrength === 'labeled'));
        const corroborations = relevant.filter((item) =>
          (item.type === 'address' && item.parentAddressRoles.length > 0 && item.candidateAddressRoles.length > 0 &&
            item.mailboxClassification === 'includes_non_hotel') ||
          (item.type === 'date' && (item.dateRelation === 'same' || item.dateRelation === 'overlaps')));
        return confirmations.some((confirmation) =>
          corroborations.some((corroboration) => confirmation.sourceId !== corroboration.sourceId));
      }
      case 'document_version':
        return relevant.some((item) => item.type === 'document_version' && item.sourceRole === 'pdf');
      case 'later_observation':
        return relevant.some((item) => item.type === 'observation' && item.sourceRole === 'hms_observation' &&
          item.objectObservationTime === 'after');
    }
  });

  return z.object({
    version: z.literal('centurion-evidence-packet-v1'),
    kind: z.literal('case'),
    searchWindow: z.enum(['full', 'reviewed']),
    windowSourceId: id.nullable(),
    manifestId: id,
    caseId: id,
    pdfId: id,
    parentId: id.nullable(),
    search: z.object({
      snapshot: completeness,
      candidates: completeness,
      participants: completeness,
      headers: completeness,
      pdfText: completeness,
      hms: completeness,
    }).strict(),
    candidateCountBand: countBand,
    structuralPageCompleteness,
    structuralCountBand: countBand,
    structuralPageCountBand: countBand,
    claims: z.array(claim),
    nextCursor: id.nullable(),
    nextStructuralCursor: id.nullable(),
  }).strict().refine((value) =>
    value.claims.every((claim) =>
      (claim.proposition !== 'observation_comparison' || claim.subjectId === value.pdfId) &&
      (claim.proposition !== 'attachment_parent' ||
        (value.parentId !== null && claim.subjectId === value.pdfId && claim.objectId === value.parentId &&
          claim.evidence.every((item) => item.sourceRole !== 'pdf' || item.sourceId === value.pdfId)))) &&
    (value.nextStructuralCursor === null || value.structuralPageCompleteness === 'partial') &&
    (value.structuralPageCompleteness !== 'not_requested' ||
      (value.nextStructuralCursor === null && value.structuralCountBand === 'unknown' &&
        value.structuralPageCountBand === 'unknown')));
}

const privateInputSchema = packetShape(rawId);
const evidencePacketSchema = packetShape(opaqueId);
const packetErrorSchema = z.object({
  code: z.enum(['INVALID_INPUT', 'INVALID_PACKET', 'INVALID_CURSOR', 'INVALID_RUN_KEY', 'INVALID_CURSOR_STATE', 'INTERNAL_ERROR']),
}).strict();

export type PrivatePacketInput = z.infer<typeof privateInputSchema>;
export type EvidencePacket = z.infer<typeof evidencePacketSchema> & { packetMac: string };
export type PacketError = z.infer<typeof packetErrorSchema>;
export type PrivateCursorScope = { manifestId: string; caseId: string };
export type PacketCursorScope = PrivateCursorScope & {
  searchWindow: 'full' | 'reviewed'; windowSourceId: string | null; parentId: string | null;
};
export type PacketCursorKind = 'candidate' | 'structural';
export type PacketResult<T> = { ok: true; value: T } | { ok: false; error: PacketError };

type IdKind = 'packet' | 'manifest' | 'window-source' | 'case' | 'source' | 'claim' | 'evidence' | 'cursor' | 'cursor-state';
const packetCursorScopeSchema = z.object({
  manifestId: rawId, caseId: rawId, searchWindow: z.enum(['full', 'reviewed']),
  windowSourceId: rawId.nullable(), parentId: rawId.nullable(),
}).strict();
const cursorStateSchema = z.object({
  version: z.literal('centurion-packet-cursor-v2'),
  mac: opaqueId,
  entries: z.array(z.object({
    token: opaqueId, manifestId: rawId, caseId: rawId,
    searchWindow: z.enum(['full', 'reviewed']), windowSourceId: rawId.nullable(), parentId: rawId.nullable(),
    position: rawId, kind: z.enum(['candidate', 'structural']),
  }).strict()),
}).strict();
/** Private-only: entries contain raw manifest, case and cursor positions. */
export type PacketCursorState = z.infer<typeof cursorStateSchema>;
const failure = (code: PacketError['code']): { ok: false; error: PacketError } => ({
  ok: false,
  error: { code },
});

/** Private-only result: store the returned key in owner-only run state, never in model output. */
export function createPacketRunKey(): PacketResult<Buffer> {
  try {
    return { ok: true, value: randomBytes(32) };
  } catch {
    return failure('INTERNAL_ERROR');
  }
}

/**
 * Creates a run-local generator. Use a fresh random key per run; restore the same
 * privately stored key and authenticated cursor state for a resume. Packet MACs
 * authenticate the full canonical content without a growing issuance registry.
 * Stateless mode records no cursor positions; the private caller reconstructs them.
 */
export function createPacketGenerator(runKey: Uint8Array, cursorState?: unknown, options?: { cursorMode?: 'stateful' | 'stateless' }) {
  let key: Buffer | null = null;
  try {
    if (runKey instanceof Uint8Array && runKey.byteLength === 32) key = Buffer.from(runKey);
  } catch {
    // Invalid key objects are handled like any other invalid run key.
  }
  const cursors = new Map<string, PacketCursorScope & { position: string; kind: PacketCursorKind }>();
  let stateless = false;
  let invalidState = false;
  try {
    stateless = options?.cursorMode === 'stateless';
    invalidState = options !== undefined && (!options || Object.keys(options).some((name) => name !== 'cursorMode') ||
      (options.cursorMode !== undefined && options.cursorMode !== 'stateful' && options.cursorMode !== 'stateless'));
  } catch { invalidState = true; }

  function token(kind: IdKind, raw: string): string {
    // Called only after checking the copied run key.
    return createHmac('sha256', key!).update('centurion-evidence-packet-v1\0')
      .update(kind).update('\0').update(raw, 'utf16le').digest('hex');
  }

  function cursorToken(kind: PacketCursorKind, scope: PacketCursorScope, position: string): string {
    return token('cursor', JSON.stringify([kind, scope.manifestId, scope.caseId, scope.searchWindow,
      scope.windowSourceId, scope.parentId, position]));
  }
  const stateMac = (entries: PacketCursorState['entries']): string => token('cursor-state', JSON.stringify([
    'centurion-packet-cursor-v2', entries.map((entry) => [entry.token, entry.manifestId, entry.caseId,
      entry.searchWindow, entry.windowSourceId, entry.parentId, entry.position, entry.kind]),
  ]));
  const equalMac = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

  if (key !== null && cursorState !== undefined) {
    try {
      const parsed = cursorStateSchema.safeParse(cursorState);
      if (!parsed.success || !equalMac(parsed.data.mac, stateMac(parsed.data.entries)) || (stateless && parsed.data.entries.length !== 0)) invalidState = true;
      else for (const entry of parsed.data.entries) {
        if (!equalMac(entry.token, cursorToken(entry.kind, entry, entry.position)) || cursors.has(entry.token)) {
          invalidState = true;
          break;
        }
        const { token: _token, ...value } = entry;
        cursors.set(entry.token, value);
      }
    } catch {
      invalidState = true;
    }
    if (invalidState) cursors.clear();
  }

  /** Private-only. The caller constructs positions from the correct, frozen factorized source. */
  function createCursorToken(scope: unknown, position: unknown, kind: PacketCursorKind = 'candidate'): PacketResult<string> {
    if (key === null) return failure('INVALID_RUN_KEY');
    if (invalidState) return failure('INVALID_CURSOR_STATE');
    try {
      const parsed = packetCursorScopeSchema.safeParse(scope);
      const p = rawId.safeParse(position);
      if (!parsed.success || !p.success || (kind !== 'candidate' && kind !== 'structural')) return failure('INVALID_CURSOR');
      return { ok: true, value: cursorToken(kind, parsed.data, p.data) };
    } catch { return failure('INVALID_CURSOR'); }
  }

  /** Verify one caller-reconstructed private position; false means no match. */
  function verifyCursorPosition(cursor: unknown, scope: unknown, position: unknown, kind: PacketCursorKind = 'candidate'): PacketResult<boolean> {
    const generated = createCursorToken(scope, position, kind);
    if (!generated.ok) return generated;
    try {
      if (!opaqueId.safeParse(cursor).success) return failure('INVALID_CURSOR');
      return { ok: true, value: equalMac(cursor as string, generated.value) };
    } catch { return failure('INVALID_CURSOR'); }
  }

  function generate(input: unknown): PacketResult<EvidencePacket> {
    if (key === null) return failure('INVALID_RUN_KEY');
    if (invalidState) return failure('INVALID_CURSOR_STATE');
    try {
      const parsed = privateInputSchema.safeParse(input);
      if (!parsed.success) return failure('INVALID_INPUT');
      const id = token;
      const value = parsed.data;
      const cursorScope: PacketCursorScope = { manifestId: value.manifestId, caseId: value.caseId,
        searchWindow: value.searchWindow, windowSourceId: value.windowSourceId, parentId: value.parentId };
      const packet: z.infer<typeof evidencePacketSchema> = {
        version: value.version,
        kind: value.kind,
        searchWindow: value.searchWindow,
        windowSourceId: value.windowSourceId === null ? null : id('window-source', value.windowSourceId),
        manifestId: id('manifest', value.manifestId),
        caseId: id('case', value.caseId),
        pdfId: id('source', value.pdfId),
        parentId: value.parentId === null ? null : id('source', value.parentId),
        search: value.search,
        candidateCountBand: value.candidateCountBand,
        structuralPageCompleteness: value.structuralPageCompleteness,
        structuralCountBand: value.structuralCountBand,
        structuralPageCountBand: value.structuralPageCountBand,
        claims: value.claims.map((claim) => ({
          claimId: id('claim', claim.claimId),
          subjectId: id('source', claim.subjectId),
          objectId: id('source', claim.objectId),
          proposition: claim.proposition,
          status: claim.status,
          inspection: claim.inspection,
          evidence: claim.evidence.map((item) => ({
            evidenceId: id('evidence', item.evidenceId),
            sourceId: id('source', item.sourceId),
            observationSourceId: item.observationSourceId === null ? null : id('source', item.observationSourceId),
            subjectId: id('source', item.subjectId),
            objectId: id('source', item.objectId),
            sourceRole: item.sourceRole,
            provenanceAvailable: item.provenanceAvailable,
            type: item.type,
            attachmentAttribution: item.attachmentAttribution,
            identityRelation: item.identityRelation,
            parentAddressRoles: item.parentAddressRoles,
            candidateAddressRoles: item.candidateAddressRoles,
            headerRelation: item.headerRelation,
            headerDirection: item.headerDirection,
            mailboxClassification: item.mailboxClassification,
            confirmationEquality: item.confirmationEquality,
            confirmationStrength: item.confirmationStrength,
            dateRelation: item.dateRelation,
            observationConflict: item.observationConflict,
            comparisonField: item.comparisonField,
            comparisonOutcome: item.comparisonOutcome,
            objectObservationTime: item.objectObservationTime,
          })),
        })),
        nextCursor: value.nextCursor === null ? null :
          cursorToken('candidate', cursorScope, value.nextCursor),
        nextStructuralCursor: value.nextStructuralCursor === null ? null :
          cursorToken('structural', cursorScope, value.nextStructuralCursor),
      };
      const checked = evidencePacketSchema.safeParse(packet);
      if (!checked.success) return failure('INTERNAL_ERROR');
      const canonical = checked.data;
      if (!stateless && canonical.nextCursor !== null && value.nextCursor !== null) {
        cursors.set(canonical.nextCursor, { ...cursorScope, kind: 'candidate', position: value.nextCursor });
      }
      if (!stateless && canonical.nextStructuralCursor !== null && value.nextStructuralCursor !== null) {
        cursors.set(canonical.nextStructuralCursor, { ...cursorScope, kind: 'structural', position: value.nextStructuralCursor });
      }
      return { ok: true, value: { ...canonical, packetMac: token('packet', JSON.stringify(canonical)) } };
    } catch {
      // Never include exception messages, stack traces, paths or source values.
      return failure('INTERNAL_ERROR');
    }
  }

  function validate(input: unknown): PacketResult<EvidencePacket> {
    if (key === null) return failure('INVALID_RUN_KEY');
    if (invalidState) return failure('INVALID_CURSOR_STATE');
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('INVALID_PACKET');
      const { packetMac, ...body } = input as Record<string, unknown>;
      const mac = opaqueId.safeParse(packetMac);
      const parsed = evidencePacketSchema.safeParse(body);
      if (!mac.success || !parsed.success || !equalMac(mac.data, token('packet', JSON.stringify(parsed.data)))) return failure('INVALID_PACKET');
      return { ok: true, value: { ...parsed.data, packetMac: mac.data } };
    } catch {
      return failure('INVALID_PACKET');
    }
  }

  /** Serialize only freshly revalidated data at the model-output boundary. */
  function serialize(input: unknown): PacketResult<string> {
    const validated = validate(input);
    if (!validated.ok) return validated;
    try {
      return { ok: true, value: JSON.stringify(validated.value) };
    } catch {
      return failure('INTERNAL_ERROR');
    }
  }

  /** Local-only: scope and returned position are private, never model output. */
  function resolvePrivateCursor(cursor: unknown, scope: unknown, kind: PacketCursorKind = 'candidate'): PacketResult<string> {
    if (key === null) return failure('INVALID_RUN_KEY');
    if (invalidState) return failure('INVALID_CURSOR_STATE');
    try {
      const parsed = packetCursorScopeSchema.safeParse(scope);
      if ((kind !== 'candidate' && kind !== 'structural') || typeof cursor !== 'string' ||
          !opaqueId.safeParse(cursor).success || !parsed.success) {
        return failure('INVALID_CURSOR');
      }
      const entry = cursors.get(cursor);
      if (!entry || entry.kind !== kind || !equalMac(cursor, cursorToken(kind, parsed.data, entry.position))) {
        return failure('INVALID_CURSOR');
      }
      return { ok: true, value: entry.position };
    } catch {
      return failure('INVALID_CURSOR');
    }
  }

  /** Private-only: persist in owner-only run state; never emit to the model. */
  function exportCursorState(): PacketResult<PacketCursorState> {
    if (key === null) return failure('INVALID_RUN_KEY');
    if (invalidState) return failure('INVALID_CURSOR_STATE');
    try {
      const entries = [...cursors].map(([cursor, value]) => ({ token: cursor, ...value }))
        .sort((a, b) => a.token < b.token ? -1 : a.token > b.token ? 1 : 0);
      return { ok: true, value: { version: 'centurion-packet-cursor-v2', entries, mac: stateMac(entries) } };
    } catch {
      return failure('INTERNAL_ERROR');
    }
  }

  return { generate, validate, serialize, createCursorToken, verifyCursorPosition, resolvePrivateCursor, exportCursorState };
}
