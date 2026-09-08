import { z } from 'zod';
import {
  reservationContextRequestSchema,
  reservationFindRequestSchema,
  type ReservationContextRequest,
  type ReservationFindRequest,
} from './reservation-context-contract.js';
import {
  createReservationContextFacade,
  type ReservationContextLookup,
  type ReservationLookupResult,
  type ReservationRow,
} from './reservation-context-facade.js';
import {
  readAdmissionSchema,
  readInputDigest,
  readRefSchema,
  readResultSchema,
  type ReadResult,
} from './read-service-contracts.js';
import type { PropertyReadLock } from './property-read-lock.js';
import { assertReadRequesterScope } from './requester-authorization.js';

export const readRequestSchema = z.union([
  reservationFindRequestSchema,
  reservationContextRequestSchema,
]);
export type ReadRequest = ReservationFindRequest | ReservationContextRequest;

export type ReadHandlerResult =
  | ReservationLookupResult
  | {
      status: 'ok' | 'not_found' | 'unverified_negative' | 'ambiguous';
      data: {
        confirmation: string | null;
        label: string | null;
        referenceKind: 'confirmation' | 'external' | 'surname_dates' | null;
        status: string | null;
        arrival: string | null;
        departure: string | null;
        roomType: string | null;
        [key: string]: unknown;
      } | null;
      evidenceRef: string;
      observedAt: string;
      expiresAt: string;
    };

export interface ReadHandlers {
  findReservation?: (input: ReservationContextLookup) => Promise<ReadHandlerResult>;
  readReservation?: (
    input: ReservationContextLookup & { reservationRef: string; sections: readonly string[]; detail?: 'summary' | 'detail' },
  ) => Promise<unknown>;
}

export interface ReadExecutionContext {
  transportId: string;
  mailboxId: string;
  threadId: string;
  triggerMessageId: string;
  propertyCode: string;
  parentRef: string;
  branchId: string;
  releaseId: string;
  requester: {
    authorizationId: string;
    transportId: string;
    threadId: string;
    triggerMessageId: string;
    allowedClaimKinds: readonly string[];
    expiresAt: string;
  };
  signal: AbortSignal;
  budget: { total: number; limit: number };
  now: () => Date;
  handlers?: ReadHandlers;
  reservationFacade?: ReturnType<typeof createReservationContextFacade>;
  /** Optional property lock; live worker/proof callers must provide it. */
  propertyReadLock?: PropertyReadLock;
  /** Production worker paths must carry a trusted release/input/capture bind. */
  requireAdmissionBinding?: boolean;
  /** Internal marker when the caller already owns the dedicated lock. */
  propertyReadLockHeld?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

const executionKeys = new Set([
  'transportId',
  'mailboxId',
  'threadId',
  'triggerMessageId',
  'propertyCode',
  'parentRef',
  'branchId',
  'releaseId',
  'requester',
  'signal',
  'budget',
  'now',
  'handlers',
  'reservationFacade',
  'propertyReadLock',
  'requireAdmissionBinding',
  'propertyReadLockHeld',
]);

function validExecutionContext(value: unknown): value is ReadExecutionContext {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) if (!executionKeys.has(key)) return false;
  return ['transportId', 'mailboxId', 'threadId', 'triggerMessageId', 'propertyCode', 'parentRef', 'branchId', 'releaseId']
    .every((key) => typeof value[key] === 'string' && value[key] !== '') &&
    isRecord(value.requester) &&
    typeof value.requester.authorizationId === 'string' &&
    typeof value.requester.transportId === 'string' &&
    typeof value.requester.threadId === 'string' &&
    typeof value.requester.triggerMessageId === 'string' &&
    Array.isArray(value.requester.allowedClaimKinds) &&
    typeof value.requester.expiresAt === 'string' &&
    isRecord(value.budget) && typeof value.budget.total === 'number' && typeof value.budget.limit === 'number' &&
    !!value.signal && typeof (value.signal as AbortSignal).aborted === 'boolean' &&
    typeof value.now === 'function' &&
    (value.requireAdmissionBinding === undefined || typeof value.requireAdmissionBinding === 'boolean') &&
    (value.propertyReadLockHeld === undefined || typeof value.propertyReadLockHeld === 'boolean');
}

// A custom schema is used because an execution context intentionally carries
// a live AbortSignal and function callbacks; this still rejects arbitrary
// selector/URL fields before dispatch.
export const readExecutionContextSchema = z.custom<ReadExecutionContext>(validExecutionContext, {
  message: 'invalid closed read execution context',
});

export const READ_CONTRACT_VERSION = 'hms-read/1';
export const NOT_APPLICABLE_MODEL_ID = 'not_applicable';

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function toLookup(context: ReadExecutionContext, candidateId: string): ReservationContextLookup {
  return {
    transportId: context.transportId,
    mailboxId: context.mailboxId,
    threadId: context.threadId,
    triggerMessageId: context.triggerMessageId,
    parentRef: context.parentRef,
    branchId: context.branchId,
    propertyCode: context.propertyCode,
    candidateId,
    referenceKind: 'confirmation',
    value: candidateId,
    observedAt: context.now(),
    expiresAt: new Date(context.now().getTime() + 5 * 60_000),
  };
}

function normalizeHandlerResult(result: ReadHandlerResult): ReservationLookupResult {
  if ('row' in result || 'rows' in result) return result as ReservationLookupResult;
  if (result.status === 'not_found' || result.status === 'unverified_negative' || !result.data) {
    return {
      status: result.status === 'unverified_negative' ? 'unverified_negative' : 'not_found',
      evidenceRef: result.evidenceRef,
      observedAt: result.observedAt,
      expiresAt: result.expiresAt,
    };
  }
  const row: ReservationRow = {
    confirmationNumber: result.data.confirmation,
    externalReference: result.data.referenceKind === 'external' ? result.data.confirmation : null,
    guestName: null,
    arrivalDate: result.data.arrival,
    departureDate: result.data.departure,
    reservationStatus: result.data.status,
    roomType: result.data.roomType,
    ratePlan: null,
  };
  return {
    status: result.status === 'ambiguous' ? 'ambiguous' : 'matched',
    ...(result.status === 'ambiguous' ? { rows: [row, row] } : { row }),
    evidenceRef: result.evidenceRef,
    observedAt: result.observedAt,
    expiresAt: result.expiresAt,
  } as ReservationLookupResult;
}

function assertContext(context: ReadExecutionContext, request: ReadRequest) {
  readExecutionContextSchema.parse(context);
  const now = context.now();
  assertReadRequesterScope({ requester: context.requester, context, now });
  if (context.signal.aborted) throw codedError('READ_ABORTED', 'read was aborted');
  if (context.budget.total >= context.budget.limit) throw codedError('READ_BUDGET_EXCEEDED', 'read budget exhausted');
  if (context.requireAdmissionBinding) {
    if (!context.propertyReadLock) {
      throw codedError('READ_PROPERTY_LOCK_REQUIRED', 'property read lock is required for admitted dispatch');
    }
    const admission = 'admission' in request ? request.admission : undefined;
    if (!admission) throw codedError('READ_ADMISSION_MISSING', 'trusted read admission is required');
    const parsed = readAdmissionSchema.parse(admission);
    const { admission: _ignored, ...closedRequest } = request as typeof request & {
      admission?: unknown;
    };
    if (parsed.releaseId !== context.releaseId) {
      throw codedError('READ_RELEASE_BINDING_MISMATCH', 'read release binding mismatch');
    }
    if (parsed.requesterAuthorizationId !== context.requester.authorizationId) {
      throw codedError('READ_REQUESTER_BINDING_MISMATCH', 'read requester binding mismatch');
    }
    if (parsed.requestBranchId !== context.branchId) {
      throw codedError('READ_BRANCH_BINDING_MISMATCH', 'read branch binding mismatch');
    }
    if (parsed.inputDigest !== readInputDigest(closedRequest)) {
      throw codedError('READ_INPUT_BINDING_MISMATCH', 'read input binding mismatch');
    }
    if (parsed.captureRequired && parsed.captureBindingRef !== context.parentRef) {
      throw codedError('READ_CAPTURE_BINDING_MISMATCH', 'read capture binding mismatch');
    }
  }
  context.budget.total += 1;
}

async function dispatchRead(
  context: ReadExecutionContext,
  request: ReadRequest,
): Promise<ReadResult<unknown>> {
  const parsed = readRequestSchema.parse(request);

  if (parsed.toolId === 'hms_find_reservation') {
    const handler = context.handlers?.findReservation;
    if (!handler) throw codedError('READ_HANDLER_UNAVAILABLE', 'typed reservation lookup is unavailable');
    const lookupInput = toLookup(context, parsed.candidateId);
    const facade = createReservationContextFacade({
      now: context.now,
      lookup: async (input) => normalizeHandlerResult(await handler(input)),
      readContext: async (input, row) => {
        if (!context.handlers?.readReservation) return { core: { status: 'available', confirmation: row.confirmationNumber }, stay: { status: 'available', arrival: row.arrivalDate, departure: row.departureDate } };
        const value = await context.handlers.readReservation(input);
        return (isRecord(value) ? value : {}) as Partial<Record<'core' | 'stay' | 'rates' | 'policies' | 'operations', unknown>>;
      },
    });
    return (await facade.findReservation(lookupInput)) as ReadResult<unknown>;
  }

  const facade = context.reservationFacade;
  if (!facade) throw codedError('READ_HANDLER_UNAVAILABLE', 'reservation context is unavailable');
  const lookupInput = toLookup(context, parsed.reservationRef);
  const result = await facade.readReservation({
    ...lookupInput,
    reservationRef: parsed.reservationRef,
    sections: parsed.sections,
    detail: parsed.detail,
  });
  return result as ReadResult<unknown>;
}

export async function executeRead(
  context: ReadExecutionContext,
  request: ReadRequest,
): Promise<ReadResult<unknown>> {
  const parsed = readRequestSchema.parse(request);
  assertContext(context, parsed);
  // A lock is held around the complete typed dispatch, including any driver
  // admission.  PropertyReadLock itself owns a dedicated connection and
  // closes it on both success and failure.
  if (context.propertyReadLock && !context.propertyReadLockHeld) {
    return context.propertyReadLock.withLock(() => dispatchRead(context, parsed));
  }
  return dispatchRead(context, parsed);
}

export interface ReadToolRunInput {
  runKind: string;
  executorLane: string;
  draftingEnabled: boolean;
  modelFactory?: (...args: never[]) => unknown;
  request: ReadRequest;
  context: ReadExecutionContext;
  resultRef: string;
}

export async function executeReadToolRun(input: ReadToolRunInput): Promise<{
  modelId: typeof NOT_APPLICABLE_MODEL_ID;
  promptVersion: typeof READ_CONTRACT_VERSION;
  readResultRef: string;
  result: ReadResult<unknown>;
}> {
  if (input.runKind !== 'read_tool') throw codedError('READ_RUN_KIND_INVALID', 'run is not a read_tool run');
  if (input.executorLane !== 'hms') throw codedError('READ_EXECUTOR_LANE_INVALID', 'read_tool must run on the HMS lane');
  if (input.draftingEnabled) throw codedError('READ_DRAFTING_DEPENDENCY', 'read_tool cannot depend on drafting');
  const result = await executeRead(input.context, input.request);
  return {
    modelId: NOT_APPLICABLE_MODEL_ID,
    promptVersion: READ_CONTRACT_VERSION,
    readResultRef: readRefSchema.parse(input.resultRef),
    result: readResultSchema.parse(result) as ReadResult<unknown>,
  };
}
