/**
 * Pure deadline admission for HMS read branches.
 * Worst-case queue + login + nav + reads + capture + cleanup must fit run deadline.
 */
import {
  readAdmissionSchema,
  readInputDigest,
  readReservationRef,
  readTimestampSchema,
  documentsListReadRequestSchema,
  documentsReadReadRequestSchema,
  quoteStayReadRequestSchema,
  type DocumentsListReadRequest,
  type DocumentsReadReadRequest,
  type ReadAdmission,
} from './read-service-contracts.js';
import { HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS } from './browser-artifacts.js';
import type { QuoteRequest } from './quote-request-normalization.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Default Playwright/page timeout used for login and navigation budgets. */
const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
/** Shared cleanup reserve used by the AI run fence and read admission floor. */
export const READ_CLEANUP_RESERVE_MS = 10_000;

/**
 * Documented worst-case components for one read branch under the 150s run deadline.
 * Sum is the constant admission floor; includes CLEANUP_RESERVE_MS.
 */
export const READ_BRANCH_WORST_CASE_COMPONENTS = {
  /** Bounded queue wait before session lock (waiter cap × short wait budget). */
  QUEUE_WAIT_MS: 30_000,
  LOGIN_MS: DEFAULT_PAGE_TIMEOUT_MS,
  NAVIGATION_MS: DEFAULT_PAGE_TIMEOUT_MS,
  /** Find + up to two followup reads under reservation plan caps. */
  READS_MS: 45_000,
  CAPTURE_FINALIZE_MS: HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS,
  CLEANUP_RESERVE_MS: READ_CLEANUP_RESERVE_MS,
} as const;

export const READ_BRANCH_WORST_CASE_MS =
  READ_BRANCH_WORST_CASE_COMPONENTS.QUEUE_WAIT_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.LOGIN_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.NAVIGATION_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.READS_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.CAPTURE_FINALIZE_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.CLEANUP_RESERVE_MS;

export type AdmitReadBranchCode = 'RUN_DEADLINE' | 'DEADLINE_ADMISSION_REJECTED';

export type AdmitReadBranchResult = { ok: true } | { ok: false; code: AdmitReadBranchCode };

export function admitReadBranch(input: {
  deadlineAt: Date;
  now: Date;
  worstCaseMs?: number;
}): AdmitReadBranchResult {
  const worstCaseMs = input.worstCaseMs ?? READ_BRANCH_WORST_CASE_MS;
  const remaining = input.deadlineAt.getTime() - input.now.getTime();
  if (remaining <= 0) {
    return { ok: false, code: 'RUN_DEADLINE' };
  }
  if (remaining < worstCaseMs) {
    return { ok: false, code: 'DEADLINE_ADMISSION_REJECTED' };
  }
  return { ok: true };
}

/** Maximum lifetime for a server-issued resolved reservation reference. */
export const READ_ADMISSION_POLICY_TTL_MS = 5 * 60_000;

const readIssuerRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected opaque read issuer reference');

/**
 * Source facts used by the issuer. These values are populated only after the
 * authenticated mailbox route has looked up the current access row, exact
 * thread, and inbound trigger. The issuer never accepts a requester id from
 * the external request; mailboxAccessId becomes the requester binding.
 */
export type ReadAdmissionSource = {
  userId: string;
  mailboxAccessId: string;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  releaseId: string;
  requestBranchId: string;
  /** Private read-result reference that the browser artifact must join. */
  captureBindingRef?: string;
};

type ReadAdmissionIssuerMarker = {
  readonly __readAdmissionIssuer: true;
};

/**
 * A ticket is deliberately not representable in the JSON read request. The
 * private symbol is checked by enqueueAiRun; JSON serialization, object spread
 * from an untrusted payload, and a caller-authored admission all lose it.
 */
const READ_ADMISSION_ISSUER_MARKER = Symbol('hms-read-admission-issuer');

export type ReadAdmissionIssuer = ReadAdmissionIssuerMarker & {
  readonly [READ_ADMISSION_ISSUER_MARKER]: true;
  readonly schemaVersion: 1;
  readonly issuerId: string;
  readonly userId: string;
  readonly mailboxAccessId: string;
  readonly transportId: string;
  readonly threadId: string;
  readonly triggerMessageId: string;
  readonly parentReadResultRef: string | null;
  readonly evidenceExpiresAt: string | null;
  readonly reservationRef: string | null;
  readonly reservationRefIssuedAt: string | null;
  readonly reservationRefExpiresAt: string | null;
  readonly inputDigest: string;
};

export const persistedReadAdmissionIssuerSchema = z
  .object({
    schemaVersion: z.literal(1),
    issuerId: readIssuerRefSchema,
    userId: readIssuerRefSchema,
    mailboxAccessId: readIssuerRefSchema,
    transportId: readIssuerRefSchema,
    threadId: readIssuerRefSchema,
    triggerMessageId: readIssuerRefSchema,
    parentReadResultRef: readIssuerRefSchema.nullable(),
    evidenceExpiresAt: readTimestampSchema.nullable(),
    reservationRef: readIssuerRefSchema.nullable(),
    reservationRefIssuedAt: readTimestampSchema.nullable(),
    reservationRefExpiresAt: readTimestampSchema.nullable(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PersistedReadAdmissionIssuer = z.infer<typeof persistedReadAdmissionIssuerSchema>;

export type IssuedReadAdmission = {
  admission: ReadAdmission;
  readRequest: Record<string, unknown>;
  issuer: ReadAdmissionIssuer;
};

type ReservationIssueReadAdmissionInput = {
  source: ReadAdmissionSource;
  now?: Date;
  candidateId: string;
  toolId: 'hms_find_reservation' | 'hms_read_reservation' | 'hms_read_folio';
  sections?: readonly string[];
  detail?: 'summary' | 'detail';
  parentReadResultRef?: string;
  evidenceExpiresAt?: Date | string;
};

type QuoteIssueReadAdmissionInput = {
  source: ReadAdmissionSource;
  now?: Date;
  toolId: 'hms_quote_stay';
  quoteRequest: QuoteRequest;
  detail?: 'summary' | 'detail';
};

type DocumentIssueReadAdmissionInput = {
  source: ReadAdmissionSource;
  now?: Date;
  toolId: 'documents_list_existing' | 'documents_read_existing';
  request:
    | Omit<DocumentsListReadRequest, 'toolId' | 'admission'>
    | Omit<DocumentsReadReadRequest, 'toolId' | 'admission'>;
};

type IssueReadAdmissionInput =
  | ReservationIssueReadAdmissionInput
  | QuoteIssueReadAdmissionInput
  | DocumentIssueReadAdmissionInput;

function requiredRef(value: string, label: string): string {
  const parsed = readIssuerRefSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be a non-empty opaque reference`);
  return parsed.data;
}

function toIso(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function createIssuerTicket(input: {
  source: ReadAdmissionSource;
  inputDigest: string;
  parentReadResultRef: string | null;
  evidenceExpiresAt: string | null;
  reservationRef: string | null;
  reservationRefIssuedAt: string | null;
  reservationRefExpiresAt: string | null;
}): ReadAdmissionIssuer {
  const source = input.source;
  const ticket = {
    schemaVersion: 1 as const,
    issuerId: randomUUID(),
    userId: requiredRef(source.userId, 'userId'),
    mailboxAccessId: requiredRef(source.mailboxAccessId, 'mailboxAccessId'),
    transportId: requiredRef(source.transportId, 'transportId'),
    threadId: requiredRef(source.threadId, 'threadId'),
    triggerMessageId: requiredRef(source.triggerMessageId, 'triggerMessageId'),
    parentReadResultRef: input.parentReadResultRef,
    evidenceExpiresAt: input.evidenceExpiresAt,
    reservationRef: input.reservationRef,
    reservationRefIssuedAt: input.reservationRefIssuedAt,
    reservationRefExpiresAt: input.reservationRefExpiresAt,
    inputDigest: input.inputDigest,
  };
  Object.defineProperty(ticket, READ_ADMISSION_ISSUER_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
  });
  return ticket as ReadAdmissionIssuer;
}

/**
 * Issue the closed admission after the caller boundary has supplied
 * server-owned source facts. The only clock and reservation expiry used here
 * are the server clock and the bounded policy/evidence minimum.
 */
export function issueReadAdmission(input: IssueReadAdmissionInput): IssuedReadAdmission {
  const now = input.now ?? new Date();
  const issuedAtMs = now.getTime();
  if (!Number.isFinite(issuedAtMs)) throw new Error('read admission server clock is invalid');

  const source = input.source;
  requiredRef(source.userId, 'userId');
  requiredRef(source.mailboxAccessId, 'mailboxAccessId');
  requiredRef(source.transportId, 'transportId');
  requiredRef(source.threadId, 'threadId');
  requiredRef(source.triggerMessageId, 'triggerMessageId');
  requiredRef(source.releaseId, 'releaseId');
  requiredRef(source.requestBranchId, 'requestBranchId');
  const captureRequired =
    input.toolId === 'hms_find_reservation' ||
    input.toolId === 'hms_read_reservation' ||
    input.toolId === 'hms_read_folio' ||
    input.toolId === 'hms_quote_stay';
  const captureBindingRef = captureRequired
    ? requiredRef(source.captureBindingRef ?? '', 'captureBindingRef')
    : null;
  let candidateId: string | null;
  if (
    input.toolId === 'documents_list_existing' ||
    input.toolId === 'documents_read_existing' ||
    input.toolId === 'hms_quote_stay'
  ) {
    candidateId = null;
  } else {
    const reservationInput = input as ReservationIssueReadAdmissionInput;
    candidateId = requiredRef(reservationInput.candidateId, 'candidateId');
  }

  let reservationRef: string | null = null;
  let reservationRefIssuedAt: string | null = null;
  let reservationRefExpiresAt: string | null = null;
  let evidenceExpiresAt: string | null = null;
  let parentReadResultRef: string | null = null;

  if (input.toolId === 'hms_read_reservation' || input.toolId === 'hms_read_folio') {
    if (candidateId === null) {
      throw new Error('reservation admission requires a candidate reference');
    }
    parentReadResultRef = requiredRef(input.parentReadResultRef ?? '', 'parentReadResultRef');
    if (input.evidenceExpiresAt === undefined) {
      throw new Error('resolved read admission requires verified evidence expiry');
    }
    evidenceExpiresAt = toIso(input.evidenceExpiresAt, 'evidence expiry');
    const evidenceExpiryMs = Date.parse(evidenceExpiresAt);
    const policyExpiryMs = issuedAtMs + READ_ADMISSION_POLICY_TTL_MS;
    const expiresAtMs = Math.min(policyExpiryMs, evidenceExpiryMs);
    if (!Number.isFinite(evidenceExpiryMs) || expiresAtMs <= issuedAtMs) {
      throw new Error('resolved read admission evidence is expired');
    }
    reservationRefIssuedAt = now.toISOString();
    reservationRefExpiresAt = new Date(expiresAtMs).toISOString();
    reservationRef = readReservationRef({
      transportId: source.transportId,
      threadId: source.threadId,
      triggerMessageId: source.triggerMessageId,
      candidateId,
      reservationRefExpiresAt,
    });
  }

  let closedRequest: Record<string, unknown>;
  if (input.toolId === 'documents_list_existing' || input.toolId === 'documents_read_existing') {
    if ('admission' in input.request) {
      throw new Error('document admission request must not carry a caller-authored admission');
    }
    const candidateRequest = { toolId: input.toolId, ...input.request };
    const parsedRequest =
      input.toolId === 'documents_list_existing'
        ? documentsListReadRequestSchema.omit({ admission: true }).parse(candidateRequest)
        : documentsReadReadRequestSchema.omit({ admission: true }).parse(candidateRequest);
    closedRequest = parsedRequest;
  } else if (input.toolId === 'hms_quote_stay') {
    const parsedRequest = quoteStayReadRequestSchema.parse({
      toolId: input.toolId,
      quoteRequestRef: input.quoteRequest.quoteRequestRef,
      quoteRequest: input.quoteRequest,
      detail: input.detail ?? 'summary',
    });
    closedRequest = parsedRequest;
  } else {
    const reservationInput = input as ReservationIssueReadAdmissionInput;
    closedRequest =
      input.toolId === 'hms_find_reservation'
        ? { toolId: input.toolId, candidateId: candidateId! }
        : input.toolId === 'hms_read_folio'
          ? {
              toolId: input.toolId,
              reservationRef,
              candidateId: candidateId!,
              sections: [...(reservationInput.sections ?? ['balance', 'deposits'])],
            }
          : {
              toolId: input.toolId,
              reservationRef,
              candidateId: candidateId!,
              sections: [...(reservationInput.sections ?? ['core', 'stay'])],
              detail: reservationInput.detail ?? 'summary',
            };
  }
  const inputDigest = readInputDigest(closedRequest);
  const admission = readAdmissionSchema.parse({
    releaseId: source.releaseId,
    requestBranchId: source.requestBranchId,
    requesterAuthorizationId: source.mailboxAccessId,
    inputDigest,
    captureRequired,
    captureBindingRef,
    reservationRef,
    reservationRefIssuedAt,
    reservationRefExpiresAt,
  });
  const issuer = createIssuerTicket({
    source,
    inputDigest,
    parentReadResultRef,
    evidenceExpiresAt,
    reservationRef,
    reservationRefIssuedAt,
    reservationRefExpiresAt,
  });
  return {
    admission,
    readRequest: { ...closedRequest, admission },
    issuer,
  };
}

/** Strip the private marker before writing issuer provenance into JSON metrics. */
export function persistReadAdmissionIssuer(
  issuer: ReadAdmissionIssuer,
): PersistedReadAdmissionIssuer {
  return persistedReadAdmissionIssuerSchema.parse({
    schemaVersion: issuer.schemaVersion,
    issuerId: issuer.issuerId,
    userId: issuer.userId,
    mailboxAccessId: issuer.mailboxAccessId,
    transportId: issuer.transportId,
    threadId: issuer.threadId,
    triggerMessageId: issuer.triggerMessageId,
    parentReadResultRef: issuer.parentReadResultRef,
    evidenceExpiresAt: issuer.evidenceExpiresAt,
    reservationRef: issuer.reservationRef,
    reservationRefIssuedAt: issuer.reservationRefIssuedAt,
    reservationRefExpiresAt: issuer.reservationRefExpiresAt,
    inputDigest: issuer.inputDigest,
  });
}

/**
 * Validate persisted issuer provenance against the exact queued request and
 * its durable run scope. Persisted JSON is evidence only; callers must still
 * supply the current expected user/access when crossing an issuer boundary.
 */
export function assertPersistedReadAdmissionIssuer(input: {
  issuer: unknown;
  request: Record<string, unknown>;
  run: { transportId: string; threadId: string; triggerMessageId: string };
  expectedUserId?: string;
  expectedMailboxAccessId: string;
  expectedToolId:
    | 'hms_find_reservation'
    | 'hms_read_reservation'
    | 'hms_read_folio'
    | 'hms_quote_stay'
    | 'documents_list_existing'
    | 'documents_read_existing';
}): PersistedReadAdmissionIssuer {
  const issuer = persistedReadAdmissionIssuerSchema.safeParse(input.issuer);
  if (!issuer.success) {
    throw new Error('read admission issuer provenance is missing or malformed');
  }
  const admission = readAdmissionSchema.safeParse(input.request.admission);
  if (!admission.success || input.request.toolId !== input.expectedToolId) {
    throw new Error('read admission issuer request is missing a valid expected admission');
  }
  const closedRequest = { ...input.request };
  delete closedRequest.admission;
  const data = issuer.data;
  if (
    data.transportId !== input.run.transportId ||
    data.threadId !== input.run.threadId ||
    data.triggerMessageId !== input.run.triggerMessageId ||
    (input.expectedUserId !== undefined && data.userId !== input.expectedUserId) ||
    data.mailboxAccessId !== input.expectedMailboxAccessId ||
    admission.data.requesterAuthorizationId !== input.expectedMailboxAccessId ||
    data.inputDigest !== admission.data.inputDigest ||
    data.inputDigest !== readInputDigest(closedRequest)
  ) {
    throw new Error('read admission issuer provenance does not bind the exact request scope');
  }
  if (
    input.expectedToolId === 'hms_find_reservation' ||
    input.expectedToolId === 'hms_quote_stay' ||
    input.expectedToolId === 'documents_list_existing' ||
    input.expectedToolId === 'documents_read_existing'
  ) {
    if (
      data.parentReadResultRef !== null ||
      data.evidenceExpiresAt !== null ||
      data.reservationRef !== null ||
      data.reservationRefIssuedAt !== null ||
      data.reservationRefExpiresAt !== null
    ) {
      throw new Error('find admission issuer provenance is not find-only');
    }
  } else if (!data.parentReadResultRef || !data.evidenceExpiresAt) {
    throw new Error('resolved admission issuer provenance has no parent receipt');
  }
  return data;
}

/**
 * Queue-side provenance gate. A serialized ticket has no private marker and
 * is rejected even when every visible admission field is internally valid.
 */
export function assertReadAdmissionIssuer(input: {
  issuer: unknown;
  admission: unknown;
  request: Record<string, unknown>;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
}): PersistedReadAdmissionIssuer {
  const issuer = input.issuer as Partial<ReadAdmissionIssuer> | null;
  if (!issuer || issuer[READ_ADMISSION_ISSUER_MARKER] !== true) {
    throw new Error('read_tool admission must come from the server-owned issuer');
  }
  const admission = readAdmissionSchema.parse(input.admission);
  const persisted = persistReadAdmissionIssuer(issuer as ReadAdmissionIssuer);
  const closedRequest = { ...input.request };
  delete closedRequest.admission;
  if (
    persisted.transportId !== input.transportId ||
    persisted.threadId !== input.threadId ||
    persisted.triggerMessageId !== input.triggerMessageId ||
    persisted.mailboxAccessId !== admission.requesterAuthorizationId ||
    persisted.inputDigest !== admission.inputDigest ||
    persisted.inputDigest !== readInputDigest(closedRequest)
  ) {
    throw new Error('read_tool admission issuer does not bind the exact mail request');
  }
  if (
    persisted.reservationRef !== admission.reservationRef ||
    persisted.reservationRefIssuedAt !== admission.reservationRefIssuedAt ||
    persisted.reservationRefExpiresAt !== admission.reservationRefExpiresAt
  ) {
    throw new Error('read_tool admission issuer window is not bound to the request');
  }
  if (
    (input.request.toolId === 'hms_read_reservation' ||
      input.request.toolId === 'hms_read_folio') &&
    !persisted.parentReadResultRef
  ) {
    throw new Error('resolved read_tool admission requires a parent typed receipt');
  }
  return persisted;
}

export function isReadAdmissionIssuer(value: unknown): value is ReadAdmissionIssuer {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as Partial<ReadAdmissionIssuer>)[READ_ADMISSION_ISSUER_MARKER] === true,
  );
}
