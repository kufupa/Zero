/**
 * Drafts router: mailbox-scoped draft CRUD.
 *
 * Drafts are scoped to the caller's active transport. A draft may optionally
 * attach to a thread (`threadId`); the thread is verified to belong to the
 * same transport before linking.
 */
import {
  DRAFT_APPROVAL_POLICY_VERSION,
  DraftApprovalError,
  assertDraftApprovalCurrent,
  assertReservationistResultFreshForAction,
  buildDraftApproval,
  getDraftApprovalSigningSecret,
  resolveDraftApprovalRouteBinding,
  type DraftApprovalPayload,
} from '../../ai/draft-approval.js';
import {
  requireThreadForTransport,
  requireMessageForTransport,
  encodePageCursor,
  decodePageCursor,
  keysetBefore,
} from './mail-helpers.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  attachment,
  mailDraft,
  mailDraftRevision,
  message,
} from '../../db/schema/mail.js';
import { workItem } from '../../db/schema/work.js';
import { recordFinalQuoteOutcome, type QuoteOutcomePreparedRef, type QuoteReplyKind } from '../../ai/quote-outcomes.js';
import {
  EvidenceRefSchema,
  isEvidenceFresh,
  type HmsEvidenceRef,
  type MailEvidenceRef,
} from '../../ai/draft-evidence.js';
import {RESERVATIONIST_DRAFT_PROPERTY_CODE,assertSourcePreparedDraftFacts,assertChannelPacketDraftSource,assertReservationistDraftSource,draftSourceMessage,type ReservationistDraftSource} from '../../ai/reservationist-draft-source.js';
import {createDraftArtifactStorage, typedResultDigest, type ReservationistPersistedResult, type PersistedGeneratedArtifact, type DraftArtifactStorage, loadLiveThreadStateVersion } from '../../ai/drafts.js';
import { deriveQuoteLines, deriveAuthorizedExtraLines, type AuthorizedProposalFacts } from '../../quote-proposal/quote-lines.js';
import type { QuoteRevision } from '../../quote-proposal/quote-revision.js';
import { readAuthorizedArtifactBytes } from '../../mail/artifacts/read-artifact.js';
import { createDraftInput, serializedAttachmentInput } from '../wire-compat.js';
import { enqueueAiRun } from '../../ai/run-ledger.js';
import { draftRouteEnqueueLabels } from '../../ai/draft-route-factory.js';
import { prepareOutboundHtml } from '../../mail/prepare-outbound-html.js';
import { sanitizeHtmlBodyForStorage } from '../../mail/sanitize-email-html.js';
import { parseDraftSearchQueryOrThrow } from '../../mail/search/trpc.js';
import { buildDraftSearchConditions } from '../../mail/search/query.js';
import { getS3Storage, type S3Storage } from '../../storage/s3.js';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { and, eq, desc, inArray, like, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, type DB } from '../../db/client.js';
import { toDraftWire } from './draft-wire.js';
import { TRPCError } from '@trpc/server';
import { parseEnv } from '../../env.js';
import { z } from 'zod';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from '../../mail/ingest/limits.js';

function isPostgresUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    if ((err as { code: string }).code === '23505') return true;
  }
  if (err instanceof Error && err.cause !== undefined) {
    return isPostgresUniqueViolation(err.cause);
  }
  return false;
}

type InboundAttachmentIdentityReader = (input: {
  attachmentId: string;
  transportId: string;
  threadId: string;
  expectedS3Key: string;
  expectedSize: number;
}) => Promise<{ sha256: string } | null>;
let inboundAttachmentIdentityReader: InboundAttachmentIdentityReader | null = null;
/** Compose with existing readAuthorizedArtifactBytes and fresh DB grant checks. */
export function configureInboundAttachmentIdentityReader(
  reader: InboundAttachmentIdentityReader | null,
): void {
  inboundAttachmentIdentityReader = reader;
}
let generatedArtifactStorage: DraftArtifactStorage | null = null;
/** Composition root supplies approved storage; tests supply local-only storage. */
export function configureDraftArtifactStorage(storage: DraftArtifactStorage | null): void {
  generatedArtifactStorage = storage;
}
function decodeStaffAttachments(files: z.infer<typeof serializedAttachmentInput>[]) {
  if (files.length > 32) throw new TRPCError({ code: 'BAD_REQUEST', message: 'INVALID_DRAFT_ATTACHMENTS' });
  let total = 0;
  return files.map(file => {
    if (!file.name || file.name.length > 255 || /[/\\]/.test(file.name) || [...file.name].some(char => char.charCodeAt(0) < 32) ||
        !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.type) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > DEFAULT_MAX_ATTACHMENT_BYTES ||
        file.base64.length > Math.ceil(DEFAULT_MAX_ATTACHMENT_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64))
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'INVALID_DRAFT_ATTACHMENTS' });
    const body = Buffer.from(file.base64, 'base64');
    total += body.length;
    if (body.length !== file.size || body.toString('base64') !== file.base64 || total > 32 * 1024 * 1024)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'INVALID_DRAFT_ATTACHMENTS' });
    return { file, body, sourceHash: createHash('sha256').update(body).digest('hex') };
  });
}
async function persistStaffAttachments(
  decoded: ReturnType<typeof decodeStaffAttachments>, transportId: string, draftId: string,
  prior: (typeof mailDraft.$inferSelect)['attachments'] = [],
): Promise<(typeof mailDraft.$inferSelect)['attachments']> {
  if (!decoded.length) return [];
  if (!generatedArtifactStorage) throw new TRPCError({ code: 'CONFLICT', message: 'ARTIFACT_STORAGE_UNAVAILABLE' });
  const result: (typeof mailDraft.$inferSelect)['attachments'] = [];
  for (const { file, body, sourceHash } of decoded) {
    const matches = prior.filter(raw => {
      const a = raw as typeof raw & { sourceHash?: string; artifactRef?: string };
      return a.filename === file.name && a.mimeType === file.type && a.sizeBytes === body.length && a.sourceHash === sourceHash && !!a.artifactRef;
    });
    if (matches.length === 1) {
      await verifyGeneratedAttachments(matches);
      result.push(structuredClone(matches[0]!));
    } else {
      const artifactRef = randomUUID();
      const s3Key = `draft-artifacts/${encodeURIComponent(transportId)}/${encodeURIComponent(draftId)}/${artifactRef}/${sourceHash}`;
      await generatedArtifactStorage.stage(s3Key, body, file.type);
      result.push({ filename: file.name, mimeType: file.type, sizeBytes: body.length, s3Key, artifactRef, sourceHash } as typeof result[number]);
    }
  }
  return result;
}
async function recordSavedQuoteReply(db: DB, input: {
  transportId: string; sourceMessageId: string; userId: string; html: string;
  replyKind: QuoteReplyKind; preparedVersions: readonly QuoteOutcomePreparedRef[];
  attachments: ReturnType<typeof decodeStaffAttachments>;
}): Promise<void> {
  if (input.replyKind !== 'quote' || !input.preparedVersions.length ||
    !input.attachments.some(({ file, body }) => file.type === 'application/pdf' && body.length > 0)) return;
  const [item] = await db.select({ id: workItem.id }).from(workItem).where(and(
    eq(workItem.transportId, input.transportId), eq(workItem.kind, 'quote'), eq(workItem.sourceMessageId, input.sourceMessageId),
  )).limit(1);
  if (item) await recordFinalQuoteOutcome(db, { workItemId: item.id, sourceMessageId: input.sourceMessageId,
    userId: input.userId, preparedVersions: input.preparedVersions,
    output: { replyHtml: input.html, insertedAt: new Date().toISOString(),
      attachments: input.attachments.map(({ file, body, sourceHash }) => ({
        fileName: file.name, mimeType: file.type, sizeBytes: body.length, sha256: sourceHash,
      })) },
  });
}
async function verifyGeneratedAttachments(
  attachments: (typeof mailDraft.$inferSelect)['attachments'],
): Promise<void> {
  for (const raw of attachments) {
    const a = raw as typeof raw & { sourceHash?: string; artifactRef?: string };
    if (!a.artifactRef && !a.sourceHash)
      throw new TRPCError({ code: 'CONFLICT', message: 'ARTIFACT_IDENTITY_UNPROVEN' });
    if (!generatedArtifactStorage)
      throw new TRPCError({ code: 'CONFLICT', message: 'ARTIFACT_STORAGE_UNAVAILABLE' });
    const body = await generatedArtifactStorage.read(a.s3Key);
    if (
      !body ||
      body.length !== a.sizeBytes ||
      createHash('sha256').update(body).digest('hex') !== a.sourceHash
    )
      throw new TRPCError({ code: 'CONFLICT', message: 'ARTIFACT_CHANGED_OR_MISSING' });
  }
}

async function loadDraftReviewSummary(db: DB, draft: typeof mailDraft.$inferSelect) {
  if (!draft.generationId) return undefined;
  const [run] = await db
    .select({ metrics: aiWorkflowRun.metrics })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.generationId, draft.generationId),
        eq(aiWorkflowRun.transportId, draft.transportId),
        eq(aiWorkflowRun.threadId, draft.threadId!),
        eq(aiWorkflowRun.runKind, 'candidate_draft'),
      ),
    )
    .orderBy(desc(aiWorkflowRun.createdAt))
    .limit(1);
  const result = run?.metrics?.reservationistResult;
  const recoveries = result && typeof result === 'object'
    ? (result as { sourceRecoveries?: { sourceKind?: string; sourceRef?: string }[] }).sourceRecoveries : undefined;
  const attachmentIds = Array.isArray(recoveries) ? [...new Set(recoveries
    .filter(item => item?.sourceKind === 'attachment' && typeof item.sourceRef === 'string')
    .map(item => item.sourceRef!))].slice(0, 64) : [];
  const sources = attachmentIds.length && draft.threadId ? await db
    .select({ sourceRef: attachment.id, filename: attachment.filename, messageId: attachment.messageId })
    .from(attachment).innerJoin(message, eq(attachment.messageId, message.id))
    .where(and(inArray(attachment.id, attachmentIds), eq(message.transportId, draft.transportId), eq(message.threadId, draft.threadId))) : [];
  return buildReservationistReviewSummary(result, new Date(), sources);
}

export type ReservationistStaffAction = {
  id: string;
  kind: 'unanswered_question' | 'business_document_failure' | 'pricing_fact';
  text: string;
  sourceRef: string;
  sourceHash: string;
  sourceKind?: 'message' | 'attachment';
  messageId?: string;
  filename?: string;
  reason?: string;
  blockingQuote: boolean;
  status: 'open';
};

/** Read-only human review DTO; stored task/packet bindings remain the authority boundary. */
export function buildReservationistReviewSummary(raw: unknown, now = new Date(), attachmentSources: readonly {sourceRef:string;filename:string;messageId:string}[] = []) {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
  const text = (value: unknown, limit = 160) => typeof value === 'string' ? value.slice(0, limit) : '';
  const money = (value: unknown, currency: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
      ? `${currency} ${(value / 100).toFixed(2)}` : undefined;
  const result = record(raw);
  if (!raw) return undefined;
  if (result.version !== 1) return { readinessLabel: 'Needs review', reason: 'Draft result is unavailable for review.', tasks: [], pricingProof: [] };
  let actionFreshnessReason: string | undefined;
  try { assertReservationistResultFreshForAction(raw, now); }
  catch (error) { actionFreshnessReason = error instanceof DraftApprovalError ? error.message : 'Offer evidence unavailable'; }
  const labels: Record<string, string> = {
    quote: 'Quote accommodation', new_booking: 'Prepare new booking', question: 'Answer question',
    acceptance: 'Review acceptance', change: 'Review changes', existing_document: 'Provide requested document',
    cancel_request: 'Review cancellation', booking: 'Booking action', channel_booking_sync:'Review channel booking',
  };
  const fieldLabels: Record<string, string> = { reservation_status: 'Reservation status', arrival: 'Arrival date', departure: 'Departure date', folio_balance: 'Folio balance', deposit_due: 'Deposit amount due', deposit_recorded: 'Recorded deposit' };
  const recoveryText = (code: string) => {
    const [reason, field] = code.split(':');
    if (reason === 'read_field_unavailable' && fieldLabels[field!]) return `${fieldLabels[field!]} is unavailable; staff must verify it.`;
    if (reason === 'read_partial_total' && fieldLabels[field!]) return `${fieldLabels[field!]} is partial; staff must verify the complete ledger.`;
    return ({
      recorded_quote_request_unavailable: 'An exact PMS quote recording for the requested dates, rooms, occupancy, meals and party context is unavailable.',
      recorded_party_request_unavailable: 'An exact PMS party lookup recording is unavailable.',
      native_quote_business_evidence_unavailable: 'Native quote evidence does not establish qualified rate eligibility and combined room inventory.',
      business_quote_policy_unavailable: 'Applicable quote inclusions and tax terms are unavailable.',
      business_selected_joint_inventory_unavailable: 'Combined availability for the requested room allocation is unproven.',
      business_selected_price_unavailable: 'No available option with qualified pricing covers every requested room-night.',
      business_party_identity_unavailable: 'A unique applicable party identity has not been established.',
      payment_claim_ledger_mismatch: 'The claimed payment differs from the recorded deposit.', payment_clearance_unproven: 'Payment clearance remains unverified.', payment_claim_ledger_missing: 'Payment ledger evidence is unavailable; staff must verify it.', read_inquiry_partial: 'The available ledger information is partial.', read_source_unavailable: 'The requested reservation or ledger record is unavailable.', read_capture_unavailable: 'The requested record evidence is unavailable.', booking_native_prerequisites_unavailable: 'Staff must verify booking availability, duplicate-search evidence and applicable source, track and guarantee rules before preparing the booking.', booking_native_fields_unavailable: 'Staff must verify the required booking system fields and guest assignments before preparing the booking.' } as Record<string, string>)[reason!] ?? 'Requested record details need staff verification.';
  };
  const staffActions: ReservationistStaffAction[] = [];
  const pricingReasons: Record<string, string> = {
    business_dates_unavailable: 'Confirm the missing arrival or departure date.',
    business_room_allocation_unavailable: 'Confirm the rooms and adult/child occupancy.',
    business_room_quantity_unavailable: 'Confirm the number of rooms.',
    business_room_allocation_ambiguous: 'Resolve the conflicting room allocation.',
    business_board_unavailable: 'Confirm the meal plan.',
    business_quote_policy_unavailable: 'Quote inclusions and tax terms are unavailable.',
    business_selected_joint_inventory_unavailable: 'Combined availability for the requested rooms is unproven.',
    business_selected_price_unavailable: 'Qualified pricing does not cover every requested room-night.',
    business_party_identity_unavailable: 'The applicable party identity is unresolved.',
    recorded_quote_request_unavailable: 'The requested quotation evidence is unavailable.',
    recorded_party_request_unavailable: 'The requested party evidence is unavailable.',
    native_quote_business_evidence_unavailable: 'Rate eligibility and combined room inventory are unproven.',
  };
  const originalSource = (value: unknown) => {
    const source = record(value);
    if (typeof source.attachmentId !== 'string' || !source.attachmentId || source.attachmentId.length > 512 || typeof source.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceHash)) return undefined;
    const sourceRef = source.attachmentId, sourceHash = source.sourceHash;
    const messageId = sourceRef.match(/^message(?:-subject)?:([\s\S]+)$/)?.[1];
    return { sourceRef, sourceHash, sourceKind: messageId ? 'message' as const : 'attachment' as const, ...(messageId ? {messageId} : {}) };
  };
  for (const task of rows(result.tasks).slice(0, 32)) {
    if (!['needs_clarification', 'blocked'].includes(String(task.status))) continue;
    const source = record(task.requestSource), identity = originalSource(source);
    if (!identity || typeof source.quote !== 'string' || !source.quote.trim() || source.quote.length > 40000) continue;
    if (!Number.isSafeInteger(source.page) || Number(source.page) < 1 || !Number.isSafeInteger(source.start) || !Number.isSafeInteger(source.end) || Number(source.start) < 0 || Number(source.end) - Number(source.start) !== source.quote.length) continue;
    const taskId = text(task.id, 512);
    if (!taskId) continue;
    if (task.kind === 'question' || task.kind === 'existing_document') {
      staffActions.push({id: `request:${taskId}:${identity.sourceRef}:${source.start}:${source.end}:${identity.sourceHash}`, kind: 'unanswered_question', text: source.quote, ...identity, blockingQuote: false, status: 'open'});
    } else if (task.kind === 'quote') {
      const codes = rows(result.readRecoveries).filter(r => r.taskId === taskId).flatMap(r => Array.isArray(r.codes) ? r.codes : []);
      const code = codes.find((code): code is string => typeof code === 'string' && !!pricingReasons[code]);
      const unresolved = rows(result.sourceRecoveries).find(r => {
        const p = record(r.provenance);
        return r.kind === 'unresolved_fact' && r.disclosure === 'staff_only' && typeof r.reason === 'string' && r.reason.length <= 4096 && p.reason === r.reason && Array.isArray(p.taskIds) && p.taskIds.includes(taskId) && rows(p.sources).some(s => !!originalSource(s));
      });
      const reason = unresolved && typeof unresolved.reason === 'string' ? unresolved.reason : code ? pricingReasons[code] : undefined;
      if (reason) staffActions.push({id: `pricing:${taskId}:${identity.sourceRef}:${source.start}:${source.end}:${identity.sourceHash}`, kind: 'pricing_fact', text: source.quote, ...identity, reason, blockingQuote: true, status: 'open'});
    }
  }
  for (const recovery of rows(result.sourceRecoveries).slice(0, 64)) {
    if (recovery.kind !== 'attachment_manual' || recovery.disclosure !== 'staff_only' || recovery.signatureNoise === true) continue;
    const identity = originalSource({attachmentId: recovery.sourceRef, sourceHash: recovery.sourceHash});
    if (!identity || recovery.sourceKind !== identity.sourceKind || typeof recovery.reason !== 'string' || typeof recovery.messageId !== 'string' || !recovery.messageId || (identity.messageId && recovery.messageId !== identity.messageId)) continue;
    const filenameSource = attachmentSources.find(s => s.sourceRef === identity.sourceRef && s.messageId === recovery.messageId);
    const filename = filenameSource && filenameSource.filename.length <= 255 ? filenameSource.filename : undefined;
    const reasons: Record<string, string> = {
      office_converter_unavailable: 'Document conversion is unavailable.', office_conversion_failed: 'Document conversion failed.',
      office_conversion_invalid: 'Document conversion returned an unreadable result.', unsupported_business_attachment: 'This attachment format could not be read.',
      malformed_or_unsupported_raster: 'This image could not be read.', malformed: 'This document could not be read.',
      no_embedded_text: 'Document text could not be extracted.', page_boundaries_unavailable: 'Document pages could not be identified.',
      too_large: 'This document exceeds the reading limit.', identity_or_authorization_changed: 'The source changed or access is unavailable.',
      encrypted: 'This document is password protected.', timeout: 'Document reading timed out.',
      parser_failure: 'Document reading failed.', too_many_pages: 'This document exceeds the page limit.',
    };
    const reason = reasons[recovery.reason] ?? (/^(?:source_batch_\d+_(?:unavailable|not_attempted)|attachment_batch_unavailable|fact_enrichment_unavailable)$/.test(recovery.reason)
      ? identity.sourceKind === 'message' ? 'Email details could not be extracted.' : 'Attachment details could not be extracted.' : undefined);
    if (!reason) continue;
    const sourceLabel = identity.sourceKind === 'message' ? 'Email' : filename ?? 'Attachment';
    staffActions.push({id: `source:${identity.sourceRef}:${identity.sourceHash}`, kind: 'business_document_failure', text: `${sourceLabel}: ${reason}`, ...identity,
      ...(typeof recovery.messageId === 'string' ? {messageId: recovery.messageId} : {}), ...(filename ? {filename} : {}), reason,
      blockingQuote: rows(result.tasks).some(t => t.kind === 'quote' && ['needs_clarification', 'blocked'].includes(String(t.status)) && (
        record(t.requestSource).attachmentId === identity.sourceRef || Array.isArray(t.evidenceRefs) && t.evidenceRefs.includes(identity.sourceRef) ||
        rows(result.readRecoveries).some(r => r.taskId === t.id && Array.isArray(r.codes) && r.codes.includes('attachment_batch_unavailable') && /^source_batch_|^attachment_batch_|^fact_enrichment_/.test(String(recovery.reason)))
      )), status: 'open'});
  }
  const tasks = rows(result.tasks).slice(0, 32).map(task => {
    const details: string[] = [];
    const taskId = text(task.id), kind = text(task.kind);
    if (taskId) {
      for (const recovery of rows(result.readRecoveries).filter(item => item.taskId === taskId))
        if (Array.isArray(recovery.codes)) for (const code of recovery.codes.slice(0, 16)) if (typeof code === 'string') details.push(recoveryText(code));
      if (kind === 'quote') for (const recovery of rows(result.sourceRecoveries).slice(0, 64)) {
        const provenance = record(recovery.provenance);
        if (recovery.kind === 'unresolved_fact' && recovery.disclosure === 'staff_only' && typeof recovery.reason === 'string' && provenance.reason === recovery.reason && Array.isArray(provenance.taskIds) && provenance.taskIds.includes(taskId))
          details.push(`Source review: ${text(recovery.reason, 256)}`);
      }
      for (const payment of rows(result.paymentComparisons).filter(item => item.taskId === taskId)) {
        const claimed = money(payment.claimedMinor, 'ZAR'), recorded = money(payment.recordedMinor, 'ZAR');
        if (claimed) details.push(`Claimed payment: ${claimed} · Recorded deposit: ${recorded ?? 'Unavailable'} · ${payment.status === 'mismatch' ? 'Amounts differ.' : payment.status === 'match' ? 'Ledger amount matches.' : 'Comparison unavailable.'}`);
        details.push('Payment clearance remains unverified.');
      }
      const packetKinds: Record<string, string> = { acceptance: 'accepted_quote', new_booking: 'new_booking', change: 'change', cancel_request: 'cancel_request', channel_booking_sync:'channel_booking_sync' };
      const expectedKind = packetKinds[kind];
      const packets = rows(result.packets).filter(packet => packet.taskId === taskId);
      if (expectedKind && packets.length === 1) {
        const packet = packets[0]!;
        if (task.status === 'pending_pms_action' && packet.kind === expectedKind && packet.status === 'pending_pms_action' && packet.saved === false && packet.businessRulesValidated === true) {
          if (kind === 'acceptance' || kind === 'new_booking') {
            const total = money(packet.totalMinor, packet.currency);
            if (total) details.push(`${kind === 'acceptance' ? 'Agreed quote total' : 'Selected booking total'}: ${total}`);
            if (kind === 'acceptance') {
              const accepted = record(packet.acceptanceProof), revision = record(accepted.revision), validity = record(revision.validity), sent = record(accepted.sentProof);
              if (revision.authoredDate) details.push(`Quote authored ${text(revision.authoredDate)}${typeof validity.days === 'number' ? ` · Validity: ${validity.days} days from authored date` : ''}${validity.cutoff === 'unresolved' ? '; exact cutoff unresolved' : ''}`);
              if (sent.sentAt) details.push(`Quote sent ${text(sent.sentAt)}`);
              if (accepted.acceptedAt) details.push(`Accepted ${text(accepted.acceptedAt)}`);
            }
            for (const proof of rows(packet.sourceProofs).filter(proof => proof.kind === 'current'))
              if (proof.observedAt) details.push(`Current evidence observed ${text(proof.observedAt)}${proof.expiresAt ? ` · Expires ${text(proof.expiresAt)}` : ''}`);
            for (const room of rows(packet.rooms).slice(0, 96)) {
              const request = record(room.request), pricing = record(room.pricing), source = record(pricing.source), scope = record(pricing.scope);
              const guests = rows(room.guests).slice(0, 16).map(guest => `${text(guest.firstName)} ${text(guest.lastName)}${typeof guest.age === 'number' ? ` (age ${guest.age})` : ''}`.trim()).filter(Boolean);
              details.push(`Room ${typeof room.roomIndex === 'number' ? room.roomIndex : 'unresolved'} · ${guests.join(', ') || 'Guests unresolved'} · ${text(request.arrival)} to ${text(request.departure)} · ${text(scope.roomLabel) || text(request.roomType)} · ${typeof request.adults === 'number' ? request.adults : '?'} adults · ${Array.isArray(request.childAges) ? request.childAges.length : '?'} children · ${text(scope.rateLabel) || text(request.ratePlan)}`);
              const boards: Record<string, string> = {room_only: 'Room only', breakfast: 'Breakfast', dinner_bed_breakfast: 'Dinner, bed and breakfast'};
              if (boards[text(scope.board)]) details.push(`Room ${room.roomIndex} · ${boards[text(scope.board)]}`);
              const inclusions = record(scope.inclusions), terms: string[] = [];
              if (inclusions.vat === 'included') terms.push('VAT included');
              if (inclusions.levy === 'included') terms.push('Tourism levy included');
              if (Array.isArray(inclusions.bundleLabels)) terms.push(...inclusions.bundleLabels.filter((label): label is string => typeof label === 'string').slice(0, 16).map(label => text(label)));
              if (terms.length) details.push(`Room ${room.roomIndex} · ${terms.join(' · ')}`);
              if (Array.isArray(inclusions.authoredDates) && inclusions.authoredDates.length) details.push(`Inclusion terms authored ${inclusions.authoredDates.filter(date => typeof date === 'string').slice(0, 8).map(date => text(date)).join(', ')}`);
              const partyLabels: Record<string,string> = {organization:'Organization',agency:'Agency',arAccount:'Account',guest:'Guest profile'};
              for (const party of rows(scope.partySourceProofs))
                if (partyLabels[text(party.kind)] && party.name) details.push(`Room ${room.roomIndex} · ${partyLabels[text(party.kind)]}: ${text(party.name)}${party.observedAt ? ` · Party evidence observed ${text(party.observedAt)}` : ''}`);
              const fields = [['Source', request.sourceOfBusiness], ['Track', request.track], ['Guarantee', request.guaranteeType], ['Organization', request.organization], ['Agency', request.agency], ['Account', request.arAccount]].filter(([, value]) => typeof value === 'string' && value);
              if (fields.length) details.push(`Room ${room.roomIndex} · ${fields.map(([label, value]) => `${label}: ${text(value)}`).join(' · ')}`);
              const roomTotal = money(pricing.totalMinor, pricing.currency);
              if (roomTotal) details.push(`Room ${room.roomIndex} total: ${roomTotal}`);
              for (const night of rows(pricing.nightly).slice(0, 366)) { const amount = money(night.amountMinor, pricing.currency); if (amount) details.push(`Room ${room.roomIndex} · ${text(night.date)}: ${amount}`); }
              if (source.observedAt) details.push(`Room ${room.roomIndex} · Observed ${text(source.observedAt)}`);
            }
            details.push('No booking has been saved. Staff must complete the booking and verify availability.');
          } else if(kind==='channel_booking_sync'){
            if(!actionFreshnessReason&&packet.sourceAuthority==='customer_channel'&&packet.nativeSaveAcceptance==='untested'){
              const reported=record(packet.reported);
              details.push(`Reported channel booking: ${text(reported.reservationRef)}`);
              details.push(`Reported stay: ${text(reported.arrivalDate)} to ${text(reported.departureDate)}`);
              for(const room of rows(reported.rooms))details.push(`Room ${text(room.roomRef)||'unresolved'} · Quantity ${typeof room.quantity==='number'?room.quantity:'unresolved'} · ${room.adults} adults, ${Array.isArray(room.childAges)?room.childAges.length:'?'} children`);
              for(const guest of rows(reported.guests))details.push(`${text(guest.firstName)} ${text(guest.lastName)} · Room ${text(guest.roomRef)}${typeof guest.roomIndex==='number'?` · Physical room ${guest.roomIndex}`:''}`);
              const request=record(packet.requestBinding);if(request.observedAt)details.push(`Channel request received ${text(request.observedAt)}`);
              details.push('No system update has been saved. The native reservation remains unverified. Staff must review the reported channel booking.');
            }
          } else {
            const current = record(packet.current), requested = record(packet.requested), binding = record(packet.requestBinding);
            details.push(`Reservation ${text(packet.reservationRef)}`);
            if (current.arrivalDate && current.departureDate) details.push(`Recorded stay: ${text(current.arrivalDate)} to ${text(current.departureDate)}`);
            if (kind === 'change' && requested.arrivalDate && requested.departureDate) details.push(`Requested stay: ${text(requested.arrivalDate)} to ${text(requested.departureDate)}`);
            const currentProof = rows(packet.sourceProofs).find(proof => proof.kind === 'current');
            if (currentProof?.observedAt) details.push(`Observed ${text(currentProof.observedAt)}`);
            if (binding.observedAt) details.push(`Requested ${text(binding.observedAt)}`);
            details.push(kind === 'change' ? 'No changes have been saved. Staff must complete the amendment.' : 'No cancellation has been saved. Staff must complete the cancellation.');
          }
        }
      }
    }
    return { label: labels[kind] ?? 'Review request', state: task.status === 'complete' ? 'Ready' : task.status === 'pending_pms_action' ? 'Pending staff action' : 'Needs review', details: [...new Set(details)] };
  });
  const pricingProof: string[] = [];
  for (const quote of rows(result.quoteRevisions).slice(0, 8)) {
    const total = money(quote.totalMinor, quote.currency); if (!total) continue;
    for (const group of rows(quote.groups).slice(0, 8))
      pricingProof.push(`${text(group.roomLabel)} · ${text(group.arrivalDate)} to ${text(group.departureDate)} · ${group.adults} adults, ${group.children} children · ${{ room_only: 'Room only', breakfast: 'Breakfast', dinner_bed_breakfast: 'Dinner, bed and breakfast' }[text(group.board) as 'room_only'] ?? 'Board unresolved'} · ${text(group.rateLabel)} · Observed ${text(group.observedAt)}`);
    pricingProof.push(`${total} total · Price observed; inventory not held.`);
  }
  for (const override of rows(result.approvedOverrides).slice(0, 8)) {
    const approved = money(override.approvedTotalMinor, override.currency);
    const original = money(override.originalTotalMinor, override.currency);
    if (!approved || !original || !override.actorRef || !override.approvedAt || !override.reason) continue;
    pricingProof.push(`Approved adjustment: ${approved} · Original: ${original} · ${text(override.actorRef)} · Approved ${text(override.approvedAt)} · ${text(override.reason)}`);
  }
  return {
    readinessLabel: !actionFreshnessReason && result.readiness === 'ready_for_staff_review' ? 'Ready for staff review' : 'Needs review',
    reason: actionFreshnessReason ?? (result.readiness === 'ready_for_staff_review' ? 'Review reply and attachments before sending.' : result.readiness === 'pending_pms_action' ? 'Staff must review and complete the prepared action. No hotel changes have been saved.' : 'Unresolved tasks or evidence require staff review.'),
    tasks, pricingProof,
    staffActions: [...new Map(staffActions.map(action => [action.id, action])).values()],
  };
}

/** Explicit composition only; constructing these adapters performs no storage writes. */
export function initializeDraftArtifactServices(storage: S3Storage = getS3Storage()): void {
  configureDraftArtifactStorage(createDraftArtifactStorage(storage));
  configureInboundAttachmentIdentityReader(async (input) => {
    const db = getDb();
    const load = async () => {
      const [row] = await db
        .select({
          id: attachment.id,
          messageId: attachment.messageId,
          s3Key: attachment.s3Key,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })
        .from(attachment)
        .innerJoin(message, eq(attachment.messageId, message.id))
        .where(
          and(
            eq(attachment.id, input.attachmentId),
            eq(message.transportId, input.transportId),
            eq(message.threadId, input.threadId),
          ),
        )
        .limit(1);
      return row ?? null;
    };
    const initial = await load();
    if (
      !initial ||
      initial.s3Key !== input.expectedS3Key ||
      initial.sizeBytes !== input.expectedSize
    )
      return null;
    const bytes = await readAuthorizedArtifactBytes({
      attachmentId: input.attachmentId,
      authorizedAttachmentIds: new Set([input.attachmentId]),
      s3: storage,
      signal: new AbortController().signal,
      expectedLocator: initial,
      resolveLocator: async () => await load(),
      revalidate: async () => {
        const current = await load();
        return (
          !!current &&
          current.s3Key === initial.s3Key &&
          current.sizeBytes === initial.sizeBytes &&
          current.mimeType === initial.mimeType &&
          current.messageId === initial.messageId
        );
      },
    });
    return bytes ? { sha256: bytes.sha256 } : null;
  });
}

type DraftCreateConflictHook = (input: {
  db: DB;
  draftId: string;
  transportId: string;
}) => Promise<void>;

let draftCreateConflictHookForTests: DraftCreateConflictHook | null = null;

/** Deterministic test seam for the id-less unique-conflict select→update gap. */
export function __setDraftCreateConflictHookForTests(hook: DraftCreateConflictHook | null): void {
  draftCreateConflictHookForTests = hook;
}

/** Bump when candidate tool registry / claim schemas change. */
export { HMS_CANDIDATE_TOOLSET_VERSION } from '../../ai/candidate-draft-agent.js';
import { HMS_CANDIDATE_TOOLSET_VERSION } from '../../ai/candidate-draft-agent.js';

export const DEFAULT_HMS_CANDIDATE_PROMPT_VERSION = 'draft-v1';

export type HmsCandidateFreshness = 'fresh' | 'stale_thread' | 'stale_evidence' | 'unknown';

export type HmsCandidateActiveRunState = 'queued' | 'claimed' | 'running' | 'retry_wait';

export type HmsCandidateState = {
  visibleCandidate: ReturnType<typeof toDraftWire> | null;
  activeRun: {
    id: string;
    state: HmsCandidateActiveRunState;
  } | null;
  outcome: 'candidate' | 'needs_clarification' | 'insufficient_evidence' | null;
  freshness: HmsCandidateFreshness;
  unresolvedFields: string[];
  refreshedAt: string | null;
};

const ACTIVE_REFRESH_STATES = new Set<string>(['queued', 'claimed', 'running', 'retry_wait']);

export function buildHmsRefreshIdempotencyKey(input: {
  transportId: string;
  threadId: string;
  threadStateVersion: string;
  toolsetVersion?: string;
}): string {
  const toolset = input.toolsetVersion ?? HMS_CANDIDATE_TOOLSET_VERSION;
  return `hms-refresh:${input.transportId}:${input.threadId}:${input.threadStateVersion}:${toolset}`;
}

/**
 * Refresh run outcome never clears a prior candidate — candidate query is
 * independent of activeRun (failed/dead_letter → activeRun null, prior stays).
 */
export function resolveHmsCandidateVisibility(input: {
  priorCandidateId: string | null;
  refreshRun: { id: string; state: string } | null;
}): {
  visibleCandidateId: string | null;
  activeRun: { id: string; state: HmsCandidateActiveRunState } | null;
} {
  const activeRun =
    input.refreshRun && ACTIVE_REFRESH_STATES.has(input.refreshRun.state)
      ? {
          id: input.refreshRun.id,
          state: input.refreshRun.state as HmsCandidateActiveRunState,
        }
      : null;
  return {
    visibleCandidateId: input.priorCandidateId,
    activeRun,
  };
}

/** Skeleton / off-mode generations skip HMS freshness hard-blocks. */
export function isHmsEnrichedGeneration(generation: {
  outcome: string | null;
  threadStateVersion: string | null;
  evidence: unknown[] | null;
}): boolean {
  // Mail-only/off-mode candidates may carry a durable outcome while making
  // no HMS claim.  Freshness fences apply only once the generation carries a
  // pinned thread snapshot or factual evidence; outcome alone is not proof
  // that an HMS-enriched path ran.
  if (generation.threadStateVersion) return true;
  return Array.isArray(generation.evidence) && generation.evidence.length > 0;
}

/**
 * Pure mirror of assertHmsDraftFreshForAction promote/send gate (no DB).
 * Off-mode skeleton → never blocked. Enriched + non-fresh → blocked.
 */
export function hmsPromoteBlockedByFreshness(input: {
  generation: {
    outcome: string | null;
    threadStateVersion: string | null;
    evidence: unknown[] | null;
  };
  liveThreadStateVersion: string;
  now?: Date;
  attachmentSourceHashes?: ReadonlyMap<string, string>;
  missingAttachmentIds?: ReadonlySet<string>;
}): boolean {
  if (!isHmsEnrichedGeneration(input.generation)) return false;
  const freshness = evaluateHmsCandidateFreshness({
    threadStateVersion: input.generation.threadStateVersion,
    liveThreadStateVersion: input.liveThreadStateVersion,
    evidence: input.generation.evidence ?? [],
    now: input.now,
    attachmentSourceHashes: input.attachmentSourceHashes,
    missingAttachmentIds: input.missingAttachmentIds,
  });
  return freshness !== 'fresh';
}

export function evaluateHmsEvidenceFreshness(input: {
  evidence: unknown[];
  now?: Date;
  /**
   * Current attachmentId → sha256 hex of attachment bytes.
   * Missing key → unknown for that ref (fail closed for promote/send).
   */
  attachmentSourceHashes?: ReadonlyMap<string, string>;
  /** Evidence attachment IDs absent from DB → stale_evidence. */
  missingAttachmentIds?: ReadonlySet<string>;
}): Exclude<HmsCandidateFreshness, 'stale_thread'> {
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) return 'unknown';
  const now = input.now ?? new Date();
  for (const raw of input.evidence) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success) return 'unknown';
    const evidence = parsed.data as HmsEvidenceRef | MailEvidenceRef;
    if (evidence.kind === 'hms') {
      if (!isEvidenceFresh(evidence, now)) return 'stale_evidence';
      continue;
    }
    if (input.missingAttachmentIds?.has(evidence.attachmentId)) {
      return 'stale_evidence';
    }
    const current = input.attachmentSourceHashes?.get(evidence.attachmentId);
    if (current === undefined) return 'unknown';
    if (current !== evidence.sourceHash) return 'stale_evidence';
  }
  return 'fresh';
}

export function evaluateHmsCandidateFreshness(input: {
  threadStateVersion: string | null;
  liveThreadStateVersion: string;
  evidence: unknown[];
  now?: Date;
  attachmentSourceHashes?: ReadonlyMap<string, string>;
  missingAttachmentIds?: ReadonlySet<string>;
}): HmsCandidateFreshness {
  if (!input.threadStateVersion) return 'unknown';
  if (input.threadStateVersion !== input.liveThreadStateVersion) return 'stale_thread';
  return evaluateHmsEvidenceFreshness({
    evidence: input.evidence,
    now: input.now,
    attachmentSourceHashes: input.attachmentSourceHashes,
    missingAttachmentIds: input.missingAttachmentIds,
  });
}

/**
 * Resolve live attachment hashes for mail_attachment evidence.
 *
 * Prefer caller-injected hashes (tests / future contentHash column). Otherwise
 * load attachment rows for the thread: missing row → missingIds (stale).
 * Attachment table has no contentHash today → no hash entries → fail closed
 * `unknown` for present mail attachments until hashes are injectable/stored.
 */
export async function resolveMailAttachmentFreshnessInputs(input: {
  db: DB;
  transportId: string;
  threadId: string;
  evidence: unknown[];
  attachmentSourceHashes?: ReadonlyMap<string, string>;
}): Promise<{
  attachmentSourceHashes: ReadonlyMap<string, string>;
  missingAttachmentIds: ReadonlySet<string>;
}> {
  const attachmentIds = new Set<string>();
  for (const raw of input.evidence) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success) continue;
    if (parsed.data.kind === 'mail_attachment') {
      attachmentIds.add(parsed.data.attachmentId);
    }
  }

  if (attachmentIds.size === 0) {
    return {
      attachmentSourceHashes: input.attachmentSourceHashes ?? new Map(),
      missingAttachmentIds: new Set(),
    };
  }

  const rows = await input.db
    .select({
      id: attachment.id,
      // Reserved for future contentHash column / dialect extension.
      s3Key: attachment.s3Key,
      sizeBytes: attachment.sizeBytes,
    })
    .from(attachment)
    .innerJoin(message, eq(attachment.messageId, message.id))
    .where(
      and(
        eq(message.transportId, input.transportId),
        eq(message.threadId, input.threadId),
        inArray(attachment.id, [...attachmentIds]),
      ),
    );

  const found = new Set(rows.map((r) => r.id));
  const missingAttachmentIds = new Set([...attachmentIds].filter((id) => !found.has(id)));

  // Injected hashes win. DB has no contentHash column yet — do not invent
  // metadata fingerprints that cannot match evidence.sourceHash (body sha256).
  const hashes = new Map<string, string>(input.attachmentSourceHashes ?? []);
  if (inboundAttachmentIdentityReader) {
    for (const row of rows) {
      const proof = await inboundAttachmentIdentityReader({
        attachmentId: row.id,
        transportId: input.transportId,
        threadId: input.threadId,
        expectedS3Key: row.s3Key,
        expectedSize: row.sizeBytes,
      });
      if (proof && /^[a-f0-9]{64}$/.test(proof.sha256)) hashes.set(row.id, proof.sha256);
    }
  }

  return { attachmentSourceHashes: hashes, missingAttachmentIds };
}

export function collectUnresolvedFields(input: {
  outcome: string | null;
  evidence: unknown[];
}): string[] {
  if (input.outcome === 'needs_clarification' || input.outcome === 'insufficient_evidence') {
    return ['evidence'];
  }
  const fields: string[] = [];
  for (const raw of input.evidence) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const unresolved = (raw as { unresolvedFields?: unknown }).unresolvedFields;
    if (Array.isArray(unresolved)) {
      for (const f of unresolved) {
        if (typeof f === 'string' && f.length > 0) fields.push(f);
      }
    }
  }
  return [...new Set(fields)];
}

/**
 * Query newest successful AI candidate independently from any active Refresh run.
 */
export async function loadHmsCandidateState(input: {
  db: DB;
  transportId: string;
  threadId: string;
  now?: Date;
  attachmentSourceHashes?: ReadonlyMap<string, string>;
}): Promise<HmsCandidateState> {
  const now = input.now ?? new Date();

  const [activeRunRow] = await input.db
    .select({
      id: aiWorkflowRun.id,
      state: aiWorkflowRun.state,
      createdAt: aiWorkflowRun.createdAt,
    })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, input.transportId),
        eq(aiWorkflowRun.threadId, input.threadId),
        eq(aiWorkflowRun.runKind, 'candidate_draft'),
        eq(aiWorkflowRun.executorLane, 'default'),
        inArray(aiWorkflowRun.state, ['queued', 'claimed', 'running', 'retry_wait']),
      ),
    )
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
    .limit(1);

  const [candidate] = await input.db
    .select()
    .from(mailDraft)
    .where(
      and(
        eq(mailDraft.transportId, input.transportId),
        eq(mailDraft.threadId, input.threadId),
        eq(mailDraft.isSent, false),
        eq(mailDraft.status, 'candidate'),
        eq(mailDraft.origin, 'ai'),
      ),
    )
    .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
    .limit(1);

  const visibility = resolveHmsCandidateVisibility({
    priorCandidateId: candidate?.id ?? null,
    refreshRun: activeRunRow ? { id: activeRunRow.id, state: activeRunRow.state } : null,
  });
  const activeRun = visibility.activeRun;

  if (!candidate?.generationId) {
    return {
      visibleCandidate: null,
      activeRun,
      outcome: null,
      freshness: 'unknown',
      unresolvedFields: [],
      refreshedAt: null,
    };
  }

  const [generation] = await input.db
    .select()
    .from(aiDraftGeneration)
    .where(
      and(
        eq(aiDraftGeneration.id, candidate.generationId),
        eq(aiDraftGeneration.transportId, input.transportId),
      ),
    )
    .limit(1);

  const outcomeRaw = generation?.outcome ?? null;
  const outcome =
    outcomeRaw === 'candidate' ||
    outcomeRaw === 'needs_clarification' ||
    outcomeRaw === 'insufficient_evidence'
      ? outcomeRaw
      : null;

  let freshness: HmsCandidateFreshness = 'unknown';
  if (generation && isHmsEnrichedGeneration(generation)) {
    const evidence = generation.evidence ?? [];
    // Omit latestDraftRevisionId → load live thread-affecting revision (Task-2 contract).
    const live = await loadLiveThreadStateVersion(input.db, {
      transportId: input.transportId,
      threadId: input.threadId,
    });
    const attachmentFreshness = await resolveMailAttachmentFreshnessInputs({
      db: input.db,
      transportId: input.transportId,
      threadId: input.threadId,
      evidence,
      attachmentSourceHashes: input.attachmentSourceHashes,
    });
    if(evidence.length===0&&generation.threadStateVersion===live){
      try{await assertSealedReservationistDraftFresh({db:input.db,transportId:input.transportId,draft:candidate,generation,now});freshness='fresh';}catch{freshness='unknown';}
    }else freshness = evaluateHmsCandidateFreshness({
      threadStateVersion: generation.threadStateVersion,
      liveThreadStateVersion: live,
      evidence,
      now,
      attachmentSourceHashes: attachmentFreshness.attachmentSourceHashes,
      missingAttachmentIds: attachmentFreshness.missingAttachmentIds,
    });
  }

  return {
    visibleCandidate: toDraftWire(
      candidate,
      freshness !== 'fresh',
      await loadDraftReviewSummary(input.db, candidate),
    ),
    activeRun,
    outcome,
    freshness,
    unresolvedFields: collectUnresolvedFields({
      outcome,
      evidence: generation?.evidence ?? [],
    }),
    refreshedAt: generation?.createdAt?.toISOString() ?? null,
  };
}

/** Sealed worker results retain causal byte checks alongside their typed current-read proofs. */
async function assertSealedReservationistDraftFresh(input:{db:DB;transportId:string;draft:typeof mailDraft.$inferSelect;generation:typeof aiDraftGeneration.$inferSelect;now?:Date}):Promise<void>{
 const [run]=await input.db.select().from(aiWorkflowRun).where(and(eq(aiWorkflowRun.generationId,input.generation.id),eq(aiWorkflowRun.transportId,input.transportId),eq(aiWorkflowRun.threadId,input.draft.threadId!),eq(aiWorkflowRun.triggerMessageId,input.draft.replyToMessageId!),eq(aiWorkflowRun.runKind,'candidate_draft'),eq(aiWorkflowRun.state,'succeeded'))).orderBy(desc(aiWorkflowRun.finishedAt),desc(aiWorkflowRun.createdAt)).limit(1);
 const metrics=run?.metrics as (typeof run.metrics&{reservationistDraftSource?:ReservationistDraftSource})|undefined,result=metrics?.reservationistResult as ReservationistPersistedResult|undefined;
 if(!run||!result||result.version!==1||!Array.isArray(result.tasks)||!Array.isArray(result.artifactRefs)||!Array.isArray(result.quoteRevisionIds)||!metrics?.reservationistDraftSource||input.generation.requestedByUserId!==input.draft.createdByUserId||metrics.resultDigest!==typedResultDigest(result,input.draft.attachments as PersistedGeneratedArtifact[]))throw new Error('reservationist_draft_source_unavailable');
 const selectedQuotes=(result.quoteRevisions??[]) as QuoteRevision[];
 const quoted=selectedQuotes.length>0;
 const typedQuoteFactKeys=new Set<string>();
 const selectedQuoteTotals=new Map<string,number>();
 if((result.rateComparisons?.length??0)||(result.paymentComparisons?.length??0)||(result.importedOffers?.length??0)||(result.approvedOverrides?.length??0)||(result.readReceipts?.length??0)||(result.existingDocumentReceipts?.length??0)||(result.recipientPreparations?.length??0)||(result.packets??[]).some(packet=>(packet as {kind?:string}).kind!=='channel_booking_sync')||!quoted&&((result.proposalFacts?.length??0)||(result.quoteRevisionIds?.length??0)||(result.currentNativeObservations?.length??0)))throw new Error('reservationist_hotel_evidence_unavailable');
 if(quoted){
  const tasks=result.tasks.map(raw=>{const task=raw as {kind?:string;status?:string;evidenceRefs?:string[]};if(!task||!Array.isArray(task.evidenceRefs)||task.evidenceRefs.some(ref=>typeof ref!=='string'))throw new Error('reservationist_quote_task_invalid');return {...task,evidenceRefs:task.evidenceRefs};});
  if(new Set(result.quoteRevisionIds).size!==selectedQuotes.length||result.quoteRevisionIds.length!==selectedQuotes.length||selectedQuotes.some(revision=>revision.propertyCode!==RESERVATIONIST_DRAFT_PROPERTY_CODE||!result.quoteRevisionIds.includes(revision.id)))throw new Error('reservationist_quote_binding_invalid');
  for(const revision of selectedQuotes){
   deriveQuoteLines(revision);selectedQuoteTotals.set(revision.id,revision.totalMinor);
   if(!tasks.some(task=>task.kind==='quote'&&task.status==='complete'&&revision.groups.every(group=>task.evidenceRefs.includes(group.sourceRef))&&task.evidenceRefs.some(ref=>result.artifactRefs.includes(ref))))throw new Error('reservationist_quote_task_unavailable');
  }
  for(const proposal of result.proposalFacts??[]){const facts=proposal.facts as AuthorizedProposalFacts;const revision=selectedQuotes.find(revision=>revision.id===facts?.revisionId);if(!revision)throw new Error('reservationist_quote_extra_binding_invalid');const extraTotal=deriveAuthorizedExtraLines(revision,facts).reduce((sum,line)=>sum+line.totalMinor,0),total=revision.totalMinor+extraTotal;if(!Number.isSafeInteger(total)||selectedQuoteTotals.get(revision.id)!==revision.totalMinor)throw new Error('reservationist_quote_extra_total_invalid');selectedQuoteTotals.set(revision.id,total);}
  for(const fact of result.preparedFacts??[]){
   if(fact.key.startsWith('quote_total_')){
    const revision=selectedQuotes.find(revision=>revision.groups[0]?.sourceRef===fact.evidenceRef),amount=revision?(selectedQuoteTotals.get(revision.id)!/100).toFixed(2):undefined;
    if(!revision||fact.source!=='hms'||fact.status!=='known'||fact.authority!=='authorized'||fact.scopeVerified!==true||fact.disclosure!=='guest'||!fact.value||typeof fact.value!=='object'||Object.keys(fact.value).length!==3||(fact.value as {amount?:string;currency?:string;total?:string}).amount!==amount||(fact.value as {amount?:string;currency?:string;total?:string}).currency!==revision.currency||(fact.value as {amount?:string;currency?:string;total?:string}).total!==`${revision.currency} ${amount}`)throw new Error('reservationist_quote_total_fact_invalid');
    typedQuoteFactKeys.add(fact.key);
   }else if((result.currentNativeObservations??[]).some(receipt=>receipt.fact.key===fact.key)||fact.key.startsWith('quote_terms_')&&tasks.some(task=>task.status==='complete'&&task.evidenceRefs.includes(fact.evidenceRef??''))&&selectedQuotes.some(revision=>revision.groups.some(group=>group.inclusions.sourceHashes.includes(fact.sourceHash??''))))typedQuoteFactKeys.add(fact.key);
  }
 }
 assertReservationistResultFreshForAction(result,input.now);
 const causalAt=metrics.reservationistDraftSource.causalAt,cutoff=Date.parse(causalAt);
 if(!Number.isFinite(cutoff)||(input.now??new Date()).getTime()<cutoff)throw new Error('reservationist_draft_source_time_invalid');
 const sourceMessages=await input.db.select().from(message).where(and(eq(message.transportId,input.transportId),eq(message.threadId,input.draft.threadId!)));
 const causal=sourceMessages.filter(row=>{const date=row.direction==='inbound'?row.receivedAt:row.sentAt;return date&&date.getTime()<=cutoff;}).map(draftSourceMessage).sort((a,b)=>a.id.localeCompare(b.id));
 const originalIds=causal.map(row=>row.id),attached=originalIds.length?await input.db.select().from(attachment).where(inArray(attachment.messageId,originalIds)):[];
 if(attached.length>256||attached.some(item=>!Number.isSafeInteger(item.sizeBytes)||item.sizeBytes<0)||attached.reduce((sum,item)=>sum+item.sizeBytes,0)>20*1024*1024)throw new Error('reservationist_attachment_source_limit');
 const saved=metrics.reservationistDraftSource;
 assertReservationistDraftSource(saved,{version:1,runId:run.id,generationId:input.generation.id,transportId:input.transportId,propertyCode:RESERVATIONIST_DRAFT_PROPERTY_CODE,threadId:input.draft.threadId!,requestedByUserId:input.generation.requestedByUserId!,triggerMessageId:input.draft.replyToMessageId!,causalAt,resultDigest:metrics.resultDigest!,messages:causal,attachments:attached.map(item=>({attachmentId:item.id,messageId:item.messageId,s3Key:item.s3Key,mimeType:item.mimeType,sizeBytes:item.sizeBytes,inline:item.isInline,sourceHash:saved.attachments?.find(a=>a.attachmentId===item.id)?.sourceHash??''})).sort((a,b)=>a.attachmentId.localeCompare(b.attachmentId)),...(saved.arrivalAcknowledgements?{arrivalAcknowledgements:saved.arrivalAcknowledgements}:{}),...(saved.operationalAnswers?{operationalAnswers:saved.operationalAnswers}:{})});
 assertSourcePreparedDraftFacts(quoted?{...result,preparedFacts:result.preparedFacts?.filter(fact=>!typedQuoteFactKeys.has(fact.key))}:result,saved,sourceMessages.filter(row=>causal.some(item=>item.id===row.id)),new AbortController().signal);

 const sources:ReservationistDraftSource['attachments']=[];
 for(const item of attached){
  if(!inboundAttachmentIdentityReader)throw new Error('reservationist_attachment_reader_unavailable');
  const bytes=await inboundAttachmentIdentityReader({attachmentId:item.id,transportId:input.transportId,threadId:input.draft.threadId!,expectedS3Key:item.s3Key,expectedSize:item.sizeBytes});
  if(!bytes)throw new Error('reservationist_attachment_source_unavailable');
  sources.push({attachmentId:item.id,messageId:item.messageId,s3Key:item.s3Key,mimeType:item.mimeType,sizeBytes:item.sizeBytes,sourceHash:bytes.sha256,inline:item.isInline});
 }
 assertReservationistDraftSource(metrics.reservationistDraftSource,{version:1,runId:run.id,generationId:input.generation.id,transportId:input.transportId,propertyCode:RESERVATIONIST_DRAFT_PROPERTY_CODE,threadId:input.draft.threadId!,requestedByUserId:input.generation.requestedByUserId!,triggerMessageId:input.draft.replyToMessageId!,causalAt,resultDigest:metrics.resultDigest!,messages:causal,attachments:sources.sort((a,b)=>a.attachmentId.localeCompare(b.attachmentId)),...(saved.arrivalAcknowledgements?{arrivalAcknowledgements:saved.arrivalAcknowledgements}:{}),...(saved.operationalAnswers?{operationalAnswers:saved.operationalAnswers}:{})});
 for(const packet of result.packets??[])assertChannelPacketDraftSource(packet,saved,input.now??new Date());
 await verifyGeneratedAttachments(input.draft.attachments);
}

export async function assertHmsDraftFreshForAction(input: {
  db: DB;
  transportId: string;
  draft: typeof mailDraft.$inferSelect;
  conflict: 'STALE_AI_CANDIDATE' | 'STALE_AI_DRAFT';
  now?: Date;
  attachmentSourceHashes?: ReadonlyMap<string, string>;
}): Promise<void> {
  if (input.draft.origin !== 'ai') return;
  if (!input.draft.generationId || !input.draft.threadId) return;

  const [generation] = await input.db
    .select()
    .from(aiDraftGeneration)
    .where(
      and(
        eq(aiDraftGeneration.id, input.draft.generationId),
        eq(aiDraftGeneration.transportId, input.transportId),
      ),
    )
    .limit(1);
  const [qualifiedRun] = await input.db.select({ metrics: aiWorkflowRun.metrics }).from(aiWorkflowRun).where(and(eq(aiWorkflowRun.generationId, input.draft.generationId), eq(aiWorkflowRun.transportId, input.transportId), eq(aiWorkflowRun.threadId, input.draft.threadId), eq(aiWorkflowRun.runKind, 'candidate_draft'))).orderBy(desc(aiWorkflowRun.createdAt)).limit(1);
  try {
    assertReservationistResultFreshForAction(qualifiedRun?.metrics?.reservationistResult, input.now);
  } catch (error) {
    if (error instanceof DraftApprovalError) throw new TRPCError({ code: 'CONFLICT', message: error.message });
    throw error;
  }
  if (!generation || !isHmsEnrichedGeneration(generation)) return;

  const evidence = generation.evidence ?? [];
  // Omit latestDraftRevisionId → load live thread-affecting revision.
  const live = await loadLiveThreadStateVersion(input.db, {
    transportId: input.transportId,
    threadId: input.draft.threadId,
  });
  const attachmentFreshness = await resolveMailAttachmentFreshnessInputs({
    db: input.db,
    transportId: input.transportId,
    threadId: input.draft.threadId,
    evidence,
    attachmentSourceHashes: input.attachmentSourceHashes,
  });
  if(evidence.length===0&&generation.threadStateVersion===live){
    try{await assertSealedReservationistDraftFresh({...input,generation});return;}catch{throw new TRPCError({code:'CONFLICT',message:input.conflict});}
  }
  const freshness = evaluateHmsCandidateFreshness({
    threadStateVersion: generation.threadStateVersion,
    liveThreadStateVersion: live,
    evidence,
    now: input.now,
    attachmentSourceHashes: attachmentFreshness.attachmentSourceHashes,
    missingAttachmentIds: attachmentFreshness.missingAttachmentIds,
  });
  if (freshness !== 'fresh') {
    throw new TRPCError({ code: 'CONFLICT', message: input.conflict });
  }
}

export async function enqueueHmsCandidateRefresh(input: {
  db: DB;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  requestedByUserId: string;
  modelId?: string;
  promptVersion?: string;
}): Promise<{
  runId: string;
  runState:
    | 'queued'
    | 'claimed'
    | 'running'
    | 'retry_wait'
    | 'succeeded'
    | 'dead_letter'
    | 'superseded';
  idempotencyKey: string;
  threadStateVersion: string;
}> {
  // Shadow mode: Task 5 isolated ops CLI is the only manual enqueue path.
  // Fail before any insert — never pre-create aiDraftGeneration or unscoped run.
  const hmsMode = parseEnv(
    process.env as Record<string, string | undefined>,
  ).HMS_DRAFT_ENRICHMENT_MODE;
  if (hmsMode === 'shadow') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'HMS_MANUAL_OPS_REQUIRED',
    });
  }

  const threadStateVersion = await loadLiveThreadStateVersion(input.db, {
    transportId: input.transportId,
    threadId: input.threadId,
  });
  const idempotencyKey = buildHmsRefreshIdempotencyKey({
    transportId: input.transportId,
    threadId: input.threadId,
    threadStateVersion,
  });

  // A worker must never see the queued run before its requesting user and
  // generation exist. The row lock also serializes idempotent refreshes.
  const run = await input.db.transaction(async (tx) => {
    const run = await enqueueAiRun(
      {
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: input.triggerMessageId,
        runKind: 'candidate_draft',
        idempotencyKey,
        modelId: input.modelId ?? draftRouteEnqueueLabels().modelId,
        promptVersion: input.promptVersion ?? DEFAULT_HMS_CANDIDATE_PROMPT_VERSION,
        // Visible drafting is owned by the normal default worker. The isolated
        // HMS lane remains read/shadow-only and cannot claim this run.
        executorLane: 'default',
      },
      tx as unknown as DB,
    );
    const [lockedRun] = await tx
      .select({ generationId: aiWorkflowRun.generationId })
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.id, run.id))
      .limit(1)
      .for('update');
    if (!lockedRun) throw new Error(`refresh run disappeared before generation link: ${run.id}`);

    const generationId = lockedRun.generationId ?? `${run.id}-generation`;
    if (!lockedRun.generationId) {
      await tx.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: input.transportId,
        threadId: input.threadId,
        requestedByUserId: input.requestedByUserId,
        contextMessageIds: [input.triggerMessageId],
        model: input.modelId ?? draftRouteEnqueueLabels().modelId,
        promptVersion: input.promptVersion ?? DEFAULT_HMS_CANDIDATE_PROMPT_VERSION,
        status: 'queued',
        threadStateVersion,
        evidence: [],
        createdAt: new Date(),
      });
      await tx
        .update(aiWorkflowRun)
        .set({ generationId, updatedAt: new Date() })
        .where(and(eq(aiWorkflowRun.id, run.id), sql`${aiWorkflowRun.generationId} IS NULL`));
    }
    return run;
  });

  return {
    runId: run.id,
    runState: run.state,
    idempotencyKey,
    threadStateVersion,
  };
}

/**
 * Revisions written by saveReply carry this id prefix. Their kind stays honest ('created' or 'edited', a human action),
 * so eval data never reads a saved reply as AI output. The prefix tells an untouched saved reply from a hand edit
 * without a migration, the same way follow-up drafts are told apart by their draft id.
 */
const SAVED_REPLY_REVISION_PREFIX = 'saved-reply:';

export const draftsRouter = tRouter({
  getArtifact: mailboxProcedure
    .input(z.object({ draftId: z.string(), artifactRef: z.string().max(160) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const [draft] = await db
        .select()
        .from(mailDraft)
        .where(
          and(eq(mailDraft.id, input.draftId), eq(mailDraft.transportId, ctx.activeTransportId)),
        )
        .limit(1);
      if (!draft) throw new TRPCError({ code: 'NOT_FOUND', message: 'DRAFT_NOT_FOUND' });
      const matches = draft.attachments.filter(
        (a) => (a as typeof a & { artifactRef?: string }).artifactRef === input.artifactRef,
      );
      if (matches.length !== 1)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'ARTIFACT_NOT_FOUND' });
      await verifyGeneratedAttachments(matches);
      const a = matches[0];
      const body = await generatedArtifactStorage!.read(a.s3Key);
      if (
        !body ||
        body.length !== a.sizeBytes ||
        createHash('sha256').update(body).digest('hex') !==
          (a as typeof a & { sourceHash: string }).sourceHash
      )
        throw new TRPCError({ code: 'CONFLICT', message: 'ARTIFACT_CHANGED_OR_MISSING' });
      return {
        artifactRef: input.artifactRef,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        sourceHash: (a as typeof a & { sourceHash: string }).sourceHash,
        base64: body.toString('base64'),
      };
    }),
  list: mailboxProcedure
    .input(
      z.object({
        q: z.string().max(512).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        threadId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const parsedSearch = input.q && input.q.trim() ? parseDraftSearchQueryOrThrow(input.q) : null;
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const limit = input.limit;

      const conditions = [
        eq(mailDraft.transportId, transportId),
        eq(mailDraft.isSent, false),
        inArray(mailDraft.status, ['active', 'candidate']),
      ];

      if (input.threadId) {
        await requireThreadForTransport(db, input.threadId, transportId);
        conditions.push(eq(mailDraft.threadId, input.threadId));
      }

      if (parsedSearch) {
        conditions.push(...buildDraftSearchConditions(parsedSearch));
      }

      if (input.cursor) {
        const decoded = decodePageCursor(input.cursor);
        if (decoded) {
          conditions.push(keysetBefore(mailDraft.updatedAt, mailDraft.id, decoded.ts, decoded.id));
        } else {
          const cursorDraft = await db
            .select({ updatedAt: mailDraft.updatedAt, id: mailDraft.id })
            .from(mailDraft)
            .where(and(eq(mailDraft.id, input.cursor), eq(mailDraft.transportId, transportId)))
            .limit(1);
          if (cursorDraft.length > 0) {
            const row = cursorDraft[0]!;
            conditions.push(
              keysetBefore(mailDraft.updatedAt, mailDraft.id, row.updatedAt ?? new Date(0), row.id),
            );
          }
        }
      }

      let rows = await db
        .select()
        .from(mailDraft)
        .where(and(...conditions))
        .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
        .limit(limit + 1);

      let nextPageToken: string | null = null;
      if (rows.length > limit) {
        const last = rows[limit - 1]!;
        rows = rows.slice(0, limit);
        nextPageToken = encodePageCursor(last.updatedAt, last.id);
      }

      return {
        threads: rows.map((r) => toDraftWire(r)),
        nextPageToken,
      };
    }),

  get: mailboxProcedure.input(z.object({ id: z.string() })).query(async ({ input, ctx }) => {
    const db = getDb();
    const transportId = ctx.activeTransportId;
    const rows = await db
      .select()
      .from(mailDraft)
      .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)))
      .limit(1);
    if (rows.length === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
    }
    const r = rows[0]!;
    return toDraftWire(r, false, await loadDraftReviewSummary(db, r));
  }),

  /**
   * Bind an explicit human review of the current AI draft to one send
   * payload. The token is intentionally opaque and is re-read at send and
   * immediately before SMTP; it is never a general-purpose send grant.
   */
  approve: mailboxProcedure
    .input(
      z.object({
        draftId: z.string().min(1),
        subject: z.string(),
        html: z.string(),
        text: z.string().default(''),
        originalMessage: z.string().optional(),
        to: z.array(z.string()),
        cc: z.array(z.string()).default([]),
        bcc: z.array(z.string()).default([]),
        attachments: z.array(serializedAttachmentInput).default([]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const [draft] = await db
        .select()
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.id, input.draftId),
            eq(mailDraft.transportId, transportId),
            eq(mailDraft.isSent, false),
            eq(mailDraft.status, 'active'),
            eq(mailDraft.origin, 'ai'),
          ),
        )
        .limit(1);
      if (!draft || !draft.generationId || !draft.threadId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_REQUIRED' });
      }

      const [generation] = await db
        .select()
        .from(aiDraftGeneration)
        .where(
          and(
            eq(aiDraftGeneration.id, draft.generationId),
            eq(aiDraftGeneration.transportId, transportId),
            eq(aiDraftGeneration.threadId, draft.threadId),
          ),
        )
        .limit(1);
      const [latestRevision] = await db
        .select({ id: mailDraftRevision.id })
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, draft.id))
        .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
        .limit(1);
      if (!generation || !latestRevision) {
        throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
      }

      const [candidateRun] = await db
        .select({ metrics: aiWorkflowRun.metrics })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.generationId, draft.generationId),
            eq(aiWorkflowRun.runKind, 'candidate_draft'),
            eq(aiWorkflowRun.state, 'succeeded'),
          ),
        )
        .orderBy(desc(aiWorkflowRun.finishedAt), desc(aiWorkflowRun.createdAt))
        .limit(1);
      const routeBinding = resolveDraftApprovalRouteBinding(candidateRun?.metrics);
      if (!routeBinding?.release) {
        throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
      }

      await verifyGeneratedAttachments(draft.attachments);
      for (const raw of draft.attachments) {
        const artifact = raw as typeof raw & { sourceHash?: string };
        const matches = input.attachments.filter(
          (a) =>
            a.name === artifact.filename &&
            a.type === artifact.mimeType &&
            a.size === artifact.sizeBytes &&
            createHash('sha256').update(Buffer.from(a.base64, 'base64')).digest('hex') ===
              artifact.sourceHash,
        );
        if (matches.length !== 1)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'DRAFT_REQUIRED_ARTIFACT_MISSING_OR_CHANGED',
          });
      }
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId,
        threadId: draft.threadId,
      });
      const payload: DraftApprovalPayload = {
        draftId: draft.id,
        generationId: draft.generationId,
        transportId,
        threadId: draft.threadId,
        revisionId: latestRevision.id,
        threadStateVersion,
        evidence: generation.evidence ?? [],
        ...((candidateRun?.metrics as { resultDigest?: string } | null)?.resultDigest
          ? { resultDigest: (candidateRun!.metrics as { resultDigest: string }).resultDigest }
          : {}),
        ...(routeBinding ? { routeBinding } : {}),
        policyVersion: DRAFT_APPROVAL_POLICY_VERSION,
        approvedByUserId: ctx.sessionUser.id,
        approvedAt: new Date().toISOString(),
        origin: 'ai',
        subject: input.subject,
        html: prepareOutboundHtml(
          input.originalMessage?.trim() &&
            !input.html.includes(
              input.originalMessage
                .trim()
                .slice(0, Math.min(80, input.originalMessage.trim().length)),
            )
            ? `${input.html}${input.originalMessage}`
            : input.html,
        ),
        text: input.text,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        attachments: input.attachments.map((attachment) => ({
          filename: attachment.name,
          mimeType: attachment.type,
          sizeBytes: attachment.size,
          contentBase64: attachment.base64,
        })),
      };

      try {
        const signingSecret = getDraftApprovalSigningSecret();
        const approval = buildDraftApproval(payload, signingSecret);
        await assertDraftApprovalCurrent({
          db,
          approval,
          payload,
          loadThreadStateVersion: loadLiveThreadStateVersion,
          signingSecret,
        });
        return approval;
      } catch (error) {
        if (error instanceof DraftApprovalError) {
          throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
        }
        throw error;
      }
    }),

  ensureEditableForReply: mailboxProcedure
    .input(
      z.object({
        threadId: z.string(),
        replyToMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const replyToMessageId = input.replyToMessageId;
      if (!replyToMessageId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_REQUIRED' });
      }
      await requireThreadForTransport(db, input.threadId, transportId);
      const replyParent = await requireMessageForTransport(db, replyToMessageId, transportId);
      if (replyParent.threadId !== input.threadId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_THREAD_MISMATCH' });
      }

      try {
        const promoted = await db.transaction(async (tx) => {
          const activeRows = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'active'),
              ),
            )
            .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
            .limit(1);

          const activeDraft = activeRows[0];
          if (activeDraft) return activeDraft;

          const candidateRows = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'candidate'),
                eq(mailDraft.origin, 'ai'),
                eq(mailDraft.replyToMessageId, replyToMessageId),
              ),
            )
            .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
            .limit(1);

          const candidate = candidateRows[0];
          if (!candidate) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'DRAFT_NOT_FOUND' });
          }

          await verifyGeneratedAttachments(candidate.attachments);
          await assertHmsDraftFreshForAction({
            db: tx as unknown as DB,
            transportId,
            draft: candidate,
            conflict: 'STALE_AI_CANDIDATE',
          });

          await tx
            .update(mailDraft)
            .set({ status: 'discarded', updatedAt: new Date() })
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.status, 'candidate'),
                eq(mailDraft.origin, 'ai'),
                eq(mailDraft.replyToMessageId, replyToMessageId),
                sql`${mailDraft.id} <> ${candidate.id}`,
              ),
            );

          await tx
            .update(mailDraft)
            .set({ status: 'active', updatedAt: new Date() })
            .where(and(eq(mailDraft.id, candidate.id), eq(mailDraft.transportId, transportId)));

          await tx.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId: candidate.id,
            generationId: candidate.generationId,
            actorUserId: ctx.sessionUser.id,
            kind: 'promoted',
            toAddresses: candidate.toAddresses,
            ccAddresses: candidate.ccAddresses,
            bccAddresses: candidate.bccAddresses,
            subject: candidate.subject,
            textBody: candidate.textBody,
            htmlBody: candidate.htmlBody,
            attachments: structuredClone(candidate.attachments),
          });
          return { ...candidate, status: 'active' as const, updatedAt: new Date() };
        });
        return toDraftWire(promoted);
      } catch (error) {
        if (!isPostgresUniqueViolation(error)) throw error;
        const activeRows = await db
          .select()
          .from(mailDraft)
          .where(
            and(
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.threadId, input.threadId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
          .limit(1);
        if (activeRows[0]) return toDraftWire(activeRows[0]);
        throw error;
      }
    }),

  create: mailboxProcedure.input(createDraftInput).mutation(async ({ input, ctx }) => {
    const decodedAttachments = decodeStaffAttachments(input.attachments);
    const db = getDb();
    const transportId = ctx.activeTransportId;
    if (input.threadId) {
      await requireThreadForTransport(db, input.threadId, transportId);
    }
    if (input.replyToMessageId) await requireMessageForTransport(db, input.replyToMessageId, transportId);
    const draftId = input.id ?? randomUUID();
    const existing = await db
      .select()
      .from(mailDraft)
      .where(and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, transportId)))
      .limit(1);
    const row = {
      threadId: input.threadId,
      replyToMessageId: input.replyToMessageId,
      toAddresses: input.to,
      ccAddresses: input.cc,
      bccAddresses: input.bcc,
      subject: input.subject || null,
      textBody: input.html || null,
      htmlBody: input.html || null,
      attachments: [] as (typeof mailDraft.$inferSelect)['attachments'],
      updatedAt: new Date(),
    };
    if (existing.length > 0) {
      return await db.transaction(async (tx) => {
        const [prior] = await tx
          .select()
          .from(mailDraft)
          .where(and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, transportId)))
          .limit(1)
          .for('update');
        if (!prior || prior.isSent || prior.status !== 'active') {
          throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });
        }

        row.attachments = await persistStaffAttachments(decodedAttachments, transportId, draftId, prior.attachments);

        const [updated] = await tx
          .update(mailDraft)
          .set({ ...row, status: 'active' as const })
          .where(
            and(
              eq(mailDraft.id, draftId),
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .returning({ id: mailDraft.id });
        if (!updated) {
          throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });
        }

        const changed =
          JSON.stringify(prior.toAddresses ?? []) !== JSON.stringify(row.toAddresses) ||
          JSON.stringify(prior.ccAddresses ?? []) !== JSON.stringify(row.ccAddresses) ||
          JSON.stringify(prior.bccAddresses ?? []) !== JSON.stringify(row.bccAddresses) ||
          prior.subject !== row.subject ||
          prior.textBody !== row.textBody ||
          prior.htmlBody !== row.htmlBody ||
          JSON.stringify(prior.attachments ?? []) !== JSON.stringify(row.attachments);
        if (changed) {
          await tx.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId,
            generationId: prior.generationId,
            actorUserId: ctx.sessionUser.id,
            kind: 'edited',
            toAddresses: row.toAddresses,
            ccAddresses: row.ccAddresses,
            bccAddresses: row.bccAddresses,
            subject: row.subject,
            textBody: row.textBody,
            htmlBody: row.htmlBody,
            attachments: row.attachments,
          });
        }
        return { id: draftId };
      });
    }

    try {
      return await db.transaction(async (tx) => {
        row.attachments = await persistStaffAttachments(decodedAttachments, transportId, draftId);
        await tx.insert(mailDraft).values({
          id: draftId,
          transportId,
          createdByUserId: ctx.sessionUser.id,
          isSent: false,
          status: 'active',
          origin: 'manual',
          ...row,
        });
        await tx.insert(mailDraftRevision).values({
          id: randomUUID(),
          draftId,
          actorUserId: ctx.sessionUser.id,
          kind: 'created',
          toAddresses: input.to,
          ccAddresses: input.cc,
          bccAddresses: input.bcc,
          subject: input.subject || null,
          textBody: input.html || null,
          htmlBody: input.html || null,
          attachments: row.attachments,
        });
        return { id: draftId };
      });
    } catch (error) {
      // One active draft per thread — FE may omit draftId while latestDraft already exists.
      if (!isPostgresUniqueViolation(error) || !input.threadId) throw error;
      const activeRows = await db
        .select({ id: mailDraft.id })
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.transportId, transportId),
            eq(mailDraft.threadId, input.threadId),
            eq(mailDraft.isSent, false),
            eq(mailDraft.status, 'active'),
          ),
        )
        .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
        .limit(1);
      const activeId = activeRows[0]?.id;
      if (!activeId) throw error;
      if (draftCreateConflictHookForTests) {
        await draftCreateConflictHookForTests({
          db,
          draftId: activeId,
          transportId,
        });
      }
      return await db.transaction(async (tx) => {
        const [prior] = await tx
          .select()
          .from(mailDraft)
          .where(and(eq(mailDraft.id, activeId), eq(mailDraft.transportId, transportId)))
          .limit(1)
          .for('update');
        if (!prior || prior.isSent || prior.status !== 'active') {
          throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });
        }

        row.attachments = await persistStaffAttachments(decodedAttachments, transportId, activeId, prior.attachments);

        const [updated] = await tx
          .update(mailDraft)
          .set({ ...row, status: 'active' as const })
          .where(
            and(
              eq(mailDraft.id, activeId),
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .returning({ id: mailDraft.id });
        if (!updated) {
          throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });
        }

        const changed =
          JSON.stringify(prior.toAddresses ?? []) !== JSON.stringify(row.toAddresses) ||
          JSON.stringify(prior.ccAddresses ?? []) !== JSON.stringify(row.ccAddresses) ||
          JSON.stringify(prior.bccAddresses ?? []) !== JSON.stringify(row.bccAddresses) ||
          prior.subject !== row.subject ||
          prior.textBody !== row.textBody ||
          prior.htmlBody !== row.htmlBody ||
          JSON.stringify(prior.attachments ?? []) !== JSON.stringify(row.attachments);
        if (changed) {
          await tx.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId: activeId,
            generationId: prior.generationId,
            actorUserId: ctx.sessionUser.id,
            kind: 'edited',
            toAddresses: row.toAddresses,
            ccAddresses: row.ccAddresses,
            bccAddresses: row.bccAddresses,
            subject: row.subject,
            textBody: row.textBody,
            htmlBody: row.htmlBody,
            attachments: row.attachments,
          });
        }
        return { id: activeId };
      });
    }
  }),

  update: mailboxProcedure
    .input(
      z.object({
        id: z.string(),
        to: z.array(z.string()).optional(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string().optional(),
        content: z.string().optional(),
        html: z.string().optional(),
        threadId: z.string().optional(),
        replyToMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      // Verify ownership: draft must be on this transport.
      const existing = await db
        .select({ id: mailDraft.id, status: mailDraft.status, isSent: mailDraft.isSent })
        .from(mailDraft)
        .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)))
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
      }
      if (existing[0]!.isSent || existing[0]!.status === 'sent') {
        throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });
      }
      if (input.threadId) {
        await requireThreadForTransport(db, input.threadId, transportId);
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.to) patch.toAddresses = input.to;
      if (input.cc) patch.ccAddresses = input.cc;
      if (input.bcc) patch.bccAddresses = input.bcc;
      if (input.subject !== undefined) patch.subject = input.subject || null;
      if (input.content !== undefined) patch.textBody = input.content || null;
      if (input.html !== undefined) patch.htmlBody = input.html || null;
      if (input.threadId !== undefined) patch.threadId = input.threadId || null;
      if (input.replyToMessageId !== undefined) patch.replyToMessageId = input.replyToMessageId;
      // The body and its revision commit together. saveReply locks this row and reads the latest revision, so a hand
      // edit is never saved without the revision that tells a confirmed replace the draft changed.
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(mailDraft)
          .set(patch)
          .where(
            and(
              eq(mailDraft.id, input.id),
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .returning({ id: mailDraft.id });
        if (!updated) {
          throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });
        }

        const mergedRows = await tx
          .select()
          .from(mailDraft)
          .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)))
          .limit(1);
        const merged = mergedRows[0]!;
        const latestRevision = await tx
          .select()
          .from(mailDraftRevision)
          .where(eq(mailDraftRevision.draftId, input.id))
          .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
          .limit(1);

        const changed =
          latestRevision[0]?.subject !== merged.subject ||
          latestRevision[0]?.textBody !== merged.textBody ||
          latestRevision[0]?.htmlBody !== merged.htmlBody ||
          JSON.stringify(latestRevision[0]?.toAddresses ?? []) !==
            JSON.stringify(merged.toAddresses ?? []) ||
          JSON.stringify(latestRevision[0]?.ccAddresses ?? []) !==
            JSON.stringify(merged.ccAddresses ?? []) ||
          JSON.stringify(latestRevision[0]?.bccAddresses ?? []) !==
            JSON.stringify(merged.bccAddresses ?? []);

        if (changed) {
          await tx.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId: input.id,
            generationId: merged.generationId,
            actorUserId: ctx.sessionUser.id,
            kind: 'edited',
            toAddresses: merged.toAddresses,
            ccAddresses: merged.ccAddresses,
            bccAddresses: merged.bccAddresses,
            subject: merged.subject,
            textBody: merged.textBody,
            htmlBody: merged.htmlBody,
            attachments: merged.attachments ?? [],
          });
        }
      });
      return { id: input.id };
    }),

  delete: mailboxProcedure.input(z.object({ id: z.string() })).mutation(async ({ input, ctx }) => {
    const db = getDb();
    const transportId = ctx.activeTransportId;
    const existing = await db
      .select({ id: mailDraft.id })
      .from(mailDraft)
      .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)))
      .limit(1);
    if (existing.length === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
    }
    await db
      .update(mailDraft)
      .set({ status: 'discarded', updatedAt: new Date() })
      .where(
        and(
          eq(mailDraft.id, input.id),
          eq(mailDraft.transportId, transportId),
          inArray(mailDraft.status, ['active', 'candidate']),
        ),
      );
    return { deleted: true };
  }),

  /**
   * Save the pane's reply to the thread's one active draft, as a revision. Any other active draft (an AI draft,
   * someone else's, or one edited by hand since the last save) is refused with DRAFT_REPLACE_CONFIRM_REQUIRED:<token>,
   * the token naming that draft and its latest revision. The UI asks, then sends the token back as replaceDraft, and the
   * draft is replaced only if it is still that draft at that revision (else DRAFT_CHANGED). Replacing discards it and
   * starts a new draft; it is never overwritten.
   */
  saveReply: mailboxProcedure
    .input(
      z.object({
        threadId: z.string(),
        replyToMessageId: z.string(),
        to: z.array(z.string()).max(50).default([]),
        subject: z.string().max(998).default(''),
        html: z.string(),
        replyKind: z.enum(['quote', 'decline', 'missing_details', 'other']).default('other'),
        preparedVersions: z.array(z.object({ workflowRunId: z.string().min(1).max(200), revisionRef: z.string().min(1).max(200) }).strict()).max(32).default([]),
        attachments: z.array(serializedAttachmentInput).max(32).default([]),
        replaceDraft: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const decodedAttachments = decodeStaffAttachments(input.attachments);
      const db = getDb();
      const transportId = ctx.activeTransportId;
      await requireThreadForTransport(db, input.threadId, transportId);
      const replyParent = await requireMessageForTransport(db, input.replyToMessageId, transportId);
      if (replyParent.threadId !== input.threadId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_THREAD_MISMATCH' });
      }
      const html = sanitizeHtmlBodyForStorage(input.html) ?? '';
      try {
        return await db.transaction(async (tx) => {
          const [prior] = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'active'),
              ),
            )
            .limit(1)
            .for('update');
          // The draft the confirm named was discarded or sent meanwhile: ask again rather than undo that.
          if (!prior && input.replaceDraft !== undefined) {
            throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_CHANGED' });
          }
          let untouchedSavedReply = false;
          if (prior) {
            const [latest] = await tx
              .select({ id: mailDraftRevision.id, actorUserId: mailDraftRevision.actorUserId })
              .from(mailDraftRevision)
              .where(eq(mailDraftRevision.draftId, prior.id))
              .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
              .limit(1);
            untouchedSavedReply =
              latest?.id.startsWith(SAVED_REPLY_REVISION_PREFIX) === true &&
              latest.actorUserId === ctx.sessionUser.id;
            // The confirm names the draft as staff saw it. Someone else's newer work since then asks again.
            const replaceToken = `${prior.id}:${latest?.id ?? ''}`;
            if (!untouchedSavedReply && input.replaceDraft === undefined) {
              throw new TRPCError({ code: 'CONFLICT', message: `DRAFT_REPLACE_CONFIRM_REQUIRED:${replaceToken}` });
            }
            // A confirm names one draft at one revision. Any other current draft (even this user's newer save from
            // another tab) asks again rather than being overwritten.
            if (input.replaceDraft !== undefined && input.replaceDraft !== replaceToken) {
              throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_CHANGED' });
            }
            if (!untouchedSavedReply) {
              // Replace = discard, the status delete gives it (as useFollowUp does). The old draft keeps its
              // origin, generationId and revisions, so an AI draft's version stays for eval.
              await tx
                .update(mailDraft)
                .set({ status: 'discarded', updatedAt: new Date() })
                .where(and(eq(mailDraft.id, prior.id), eq(mailDraft.transportId, transportId)));
            }
          }
          const updateInPlace = prior !== undefined && untouchedSavedReply;
          const draftId = updateInPlace ? prior.id : randomUUID();
          const attachments = await persistStaffAttachments(
            decodedAttachments,
            transportId,
            draftId,
            updateInPlace ? prior.attachments : [],
          );
          const content = {
            threadId: input.threadId,
            replyToMessageId: input.replyToMessageId,
            toAddresses: input.to,
            ccAddresses: [],
            bccAddresses: [],
            subject: input.subject || null,
            textBody: html,
            htmlBody: html,
            attachments,
            updatedAt: new Date(),
          };
          if (updateInPlace) {
            await tx
              .update(mailDraft)
              .set(content)
              .where(and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, transportId)));
          } else {
            await tx.insert(mailDraft).values({
              id: draftId,
              transportId,
              createdByUserId: ctx.sessionUser.id,
              isSent: false,
              status: 'active',
              // Human-reviewed pane reply: no AI approval gate, and no generation to go stale.
              origin: 'manual',
              ...content,
            });
          }
          await tx.insert(mailDraftRevision).values({
            id: `${SAVED_REPLY_REVISION_PREFIX}${randomUUID()}`,
            draftId,
            actorUserId: ctx.sessionUser.id,
            kind: updateInPlace ? 'edited' : 'created',
            toAddresses: input.to,
            ccAddresses: [],
            bccAddresses: [],
            subject: input.subject || null,
            textBody: html,
            htmlBody: html,
            attachments,
          });
          await recordSavedQuoteReply(tx as unknown as DB, {
            transportId,
            sourceMessageId: input.replyToMessageId,
            userId: ctx.sessionUser.id,
            html,
            replyKind: input.replyKind,
            preparedVersions: input.preparedVersions,
            attachments: decodedAttachments,
          });
          return { id: draftId, replaced: prior !== undefined && !untouchedSavedReply };
        });
      } catch (error) {
        if (isPostgresUniqueViolation(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_CHANGED' });
        }
        throw error;
      }
    }),

  /** The thread's saved reply (saveReply) with its PDFs, or null. Feeds the Outlook pane's Insert saved reply. */
  savedReply: mailboxProcedure
    .input(z.object({ threadId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      await requireThreadForTransport(db, input.threadId, transportId);
      const [draft] = await db
        .select()
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.transportId, transportId),
            eq(mailDraft.threadId, input.threadId),
            eq(mailDraft.isSent, false),
            eq(mailDraft.status, 'active'),
            eq(mailDraft.origin, 'manual'),
          ),
        )
        .limit(1);
      if (!draft) return null;
      const [saved] = await db
        .select({ id: mailDraftRevision.id })
        .from(mailDraftRevision)
        .where(
          and(
            eq(mailDraftRevision.draftId, draft.id),
            like(mailDraftRevision.id, `${SAVED_REPLY_REVISION_PREFIX}%`),
          ),
        )
        .limit(1);
      if (!saved) return null;
      if (draft.attachments.length && !generatedArtifactStorage) {
        throw new TRPCError({ code: 'CONFLICT', message: 'ARTIFACT_STORAGE_UNAVAILABLE' });
      }
      const attachments: { fileName: string; pdfBase64: string }[] = [];
      for (const raw of draft.attachments) {
        const a = raw as typeof raw & { sourceHash?: string };
        const body = await generatedArtifactStorage!.read(a.s3Key);
        if (
          !body ||
          body.length !== a.sizeBytes ||
          createHash('sha256').update(body).digest('hex') !== a.sourceHash
        ) {
          throw new TRPCError({ code: 'CONFLICT', message: 'ARTIFACT_CHANGED_OR_MISSING' });
        }
        attachments.push({ fileName: a.filename, pdfBase64: body.toString('base64') });
      }
      return { id: draft.id, html: draft.htmlBody ?? '', attachments };
    }),
});
