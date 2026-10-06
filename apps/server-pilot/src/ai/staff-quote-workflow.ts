import {
  quoteDigest,
  occupiedDates,
  resolveQuoteRevision,
  type QuoteRevision,
} from '../quote-proposal/quote-revision.js';
import type {
  NativeQuoteRequest,
  createReservationistBusinessServices,
} from './reservationist-business-services.js';
import type { ReservationistExecutionServices } from './reservationist-execution.js';
import type { RevisionProposalHeader } from '../quote-proposal/proposal-pdf.js';
import { deriveQuoteLines } from '../quote-proposal/quote-lines.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const groupSchema = z
  .object({
    id: z.string().min(1).max(64),
    arrivalDate: z.string(),
    departureDate: z.string(),
    quantity: z.number().int().min(1).max(100),
    adults: z.number().int().min(1).max(6),
    childrenAges: z.array(z.number().int().min(0).max(17)).max(6).default([]),
    board: z.enum(['room_only', 'bb', 'dinner_bb']),
    roomCodes: z
      .array(z.string().regex(/^[A-Z0-9_-]{1,16}$/))
      .min(1)
      .max(8)
      .optional(),
  })
  .strict();
/** Prices, native party IDs and qualification flags are deliberately not client inputs. */
export const staffQuoteInput = z
  .object({
    messageId: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectionEpoch: z.number().int().nonnegative(),
    inputRevision: z.number().int().nonnegative(),
    groups: z.array(groupSchema).min(1).max(8),
    salesStrategy: z.enum(['BAR', 'Government']).default('BAR'),
    company: z.string().max(256).default(''),
    agency: z.string().max(256).default(''),
    attention: z.string().max(256).default(''),
    clientEmail: z.string().max(256).default(''),
    clientTelephone: z.string().max(128).default(''),
  })
  .strict();
export type StaffQuoteInput = z.infer<typeof staffQuoteInput>;
export type StaffQuoteScope = {
  transportId: string;
  userId: string;
  threadId: string;
  messageId: string;
  sourceHash: string;
  messageAt: string;
  messageText: string;
  propertyCode: string;
};
export type StaffQuoteAttestation = {
  version: 1;
  kind: 'staff_approved_quote';
  transportId: string;
  userId: string;
  threadId: string;
  messageId: string;
  sourceHash: string;
  selectionEpoch: number;
  inputRevision: number;
  inputDigest: string;
  authorizationId: string;
  revisionIds: string[];
  header: Pick<RevisionProposalHeader, 'company' | 'agency'>;
};
export function staffQuoteSourceHash(mail: {
  id: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
}) {
  return quoteDigest({
    id: mail.id,
    subject: mail.subject,
    textBody: mail.textBody,
    htmlBody: mail.htmlBody,
  });
}
export function prepareStaffQuote(
  input: StaffQuoteInput,
  scope: StaffQuoteScope,
  signer: Pick<RevisionProposalHeader, 'signerName' | 'signerEmail'>,
  signal: AbortSignal,
) {
  input = staffQuoteInput.parse(input);
  signal.throwIfAborted();
  if (
    input.messageId !== scope.messageId ||
    input.sourceHash !== scope.sourceHash ||
    !scope.transportId ||
    !scope.userId ||
    !scope.threadId ||
    !scope.propertyCode ||
    !Number.isFinite(Date.parse(scope.messageAt))
  )
    throw new Error('staff_quote_source_changed');
  if (new Set(input.groups.map((g) => g.id)).size !== input.groups.length)
    throw new Error('staff_quote_duplicate_group');
  const dates = new Set(
    input.groups.map((g) => {
      const nights = occupiedDates(g.arrivalDate, g.departureDate);
      if (nights.length > 30) throw new Error('staff_quote_stay_exceeds_native_limit');
      return g.arrivalDate + '/' + g.departureDate;
    }),
  );
  if (dates.size !== 1) throw new Error('staff_quote_separate_stay_required');
  const first = input.groups[0]!,
    request: NativeQuoteRequest = {
      propertyCode: scope.propertyCode,
      arrivalDate: first.arrivalDate,
      departureDate: first.departureDate,
      requestedCurrency: 'ZAR',
      rooms: input.groups.map((g) => ({
        id: g.id,
        quantity: g.quantity,
        adults: g.adults,
        children: g.childrenAges.length,
        childAges: g.childrenAges,
        required: {
          boardBases: [
            g.board === 'bb'
              ? 'breakfast'
              : g.board === 'dinner_bb'
                ? 'dinner_bed_breakfast'
                : 'room_only',
          ],
          ...(g.roomCodes ? { roomCodes: g.roomCodes } : {}),
        },
      })),
      search: {
        includeRestricted: false,
        includeAlternatives: false,
        salesStrategy: input.salesStrategy,
      },
      details: 'full',
      maxOptionsPerGroup: 50,
    };
  const inputDigest = quoteDigest({
      input,
      scope: {
        transportId: scope.transportId,
        userId: scope.userId,
        threadId: scope.threadId,
        messageId: scope.messageId,
        sourceHash: scope.sourceHash,
        propertyCode: scope.propertyCode,
      },
    }),
    authorizationId = 'staff-quote:' + randomUUID();
  const now = new Date().toISOString();
  const context: Parameters<NonNullable<ReservationistExecutionServices['resolveQuoteTask']>>[0] = {
    input: {
      version: 1,
      requestId: scope.messageId,
      propertyCode: scope.propertyCode,
      authorizationScope: { ownerRef: scope.transportId, threadId: scope.threadId },
      trigger: { id: scope.messageId, at: scope.messageAt },
      messages: [
        {
          id: scope.messageId,
          at: scope.messageAt,
          direction: 'inbound',
          text: scope.messageText,
          disclosure: 'guest',
        },
      ],
      authorizedArtifacts: [],
      clock: {
        causalAt: now,
        sourceAt: now,
        sourceMode: 'current_read',
        deadlineAt: Date.now() + 20 * 60000,
      },
      capabilities: { pmsWrite: false, emailSend: false },
    },
    task: {
      id: authorizationId,
      kind: 'quote',
      factIds: [],
      source: { attachmentId: 'message:' + scope.messageId, sourceHash: scope.sourceHash, page: 1 },
    },
    facts: [],
    signal,
    evaluateSourceAt: () => new Date().toISOString(),
  };
  const header: RevisionProposalHeader = {
    attention: input.attention,
    company: input.company,
    agency: input.agency,
    clientEmail: input.clientEmail,
    clientTelephone: input.clientTelephone,
    ...signer,
  };
  return {
    context,
    request,
    header,
    inputDigest,
    authorizationId,
    approval: { context, request, header } satisfies NonNullable<
      Parameters<typeof createReservationistBusinessServices>[1]
    >,
  };
}
export async function executeStaffQuote(
  prepared: ReturnType<typeof prepareStaffQuote>,
  services: ReservationistExecutionServices,
  stillCurrent: () => Promise<boolean>,
) {
  const guard = async () => {
    prepared.context.signal.throwIfAborted();
    if (!(await stillCurrent())) throw new Error('staff_quote_source_changed');
  };
  await guard();
  if (!services.resolveQuoteTask) throw new Error('staff_quote_installation_unavailable');
  const resolved = await services.resolveQuoteTask(prepared.context);
  await guard();
  if (resolved.alternatives?.length) throw new Error('staff_quote_selected_allocation_required');
  const revision = await resolveQuoteRevision(resolved);
  deriveQuoteLines(revision);
  await guard();
  if (
    !services.authorizeGuestProposal ||
    !(await services.authorizeGuestProposal(prepared.context, revision, null))
  )
    throw new Error('staff_quote_proposal_unauthorized');
  await guard();
  return revision;
}
export function attestStaffQuote(
  input: StaffQuoteInput,
  scope: StaffQuoteScope,
  prepared: ReturnType<typeof prepareStaffQuote>,
  revision: QuoteRevision,
): StaffQuoteAttestation {
  if (revision.authorizationId !== prepared.authorizationId)
    throw new Error('staff_quote_attestation_mismatch');
  return {
    version: 1,
    kind: 'staff_approved_quote',
    transportId: scope.transportId,
    userId: scope.userId,
    threadId: scope.threadId,
    messageId: scope.messageId,
    sourceHash: scope.sourceHash,
    selectionEpoch: input.selectionEpoch,
    inputRevision: input.inputRevision,
    inputDigest: prepared.inputDigest,
    authorizationId: prepared.authorizationId,
    revisionIds: [revision.id],
    header: { company: prepared.header.company, agency: prepared.header.agency },
  };
}
