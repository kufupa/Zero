import type { TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import type { AppRouter } from '@zero/server/trpc';
import {
  PANE_ERROR_CLASSES,
  PANE_ERROR_CODES,
  RESERVATION_WORKFLOW_V2_ERROR_PROCEDURES,
} from '../../../server-pilot/src/ai/reservation-workflow-v2-contract.js';
import { transportForCall } from '@/lib/mail/mail-cache-scope';
import { NAVA_FAILURE_REPORT_CONTEXT_KEY } from '../workstation/mutations-in-flight';

export const NAVA_ACTION_ID_CONTEXT_KEY = 'navaActionId';
export const NAVA_BACKGROUND_POLL_CONTEXT_KEY = 'navaBackgroundPoll';

const RESERVATION_WORKFLOW_V2_PREFIX = 'reservationWorkflowV2.';
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,160}$/;
const recordSchema = z.record(z.string(), z.unknown());
const safeIdentifier = z.string().min(1).max(160).regex(SAFE_IDENTIFIER);
const trpcFailureSchema = z.object({ data: z.object({ code: z.string() }) });
const actionIdsByInput = new WeakMap<object, string>();
const backgroundPollFailures = new Set<string>();

type ReservationErrorProcedure = (typeof RESERVATION_WORKFLOW_V2_ERROR_PROCEDURES)[number];
type PaneErrorClass = (typeof PANE_ERROR_CLASSES)[number];
type PaneErrorCode = (typeof PANE_ERROR_CODES)[number];

export type PaneFailureEvent = {
  type: 'pane.error';
  procedure: ReservationErrorProcedure;
  actionId: string;
  errorClass: PaneErrorClass;
  errorCode?: PaneErrorCode;
  metadataParseFailed: boolean;
  surface?: 'outlook' | 'web';
  sourceMessageId?: string;
  requestId?: string;
  allocationId?: string;
};

export type PaneFailureReport = {
  workItemId: string;
  transportId: string;
  event: PaneFailureEvent;
};
export type PaneFailureReporter = (report: PaneFailureReport) => void;

type IdentifierRead = { value: string | undefined; failed: boolean };

function procedureFor(path: string): ReservationErrorProcedure | null {
  if (!path.startsWith(RESERVATION_WORKFLOW_V2_PREFIX)) return null;
  return RESERVATION_WORKFLOW_V2_ERROR_PROCEDURES.find(
    (procedure) => procedure === path.slice(RESERVATION_WORKFLOW_V2_PREFIX.length),
  ) ?? null;
}

function newActionId(): string | null {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return null;
  }
}

function hasErrorName(error: unknown, name: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const wrapped = current as { name?: unknown; cause?: unknown };
    if (wrapped.name === name) return true;
    current = wrapped.cause;
  }
  return false;
}

function errorMetadata(error: unknown): { errorClass: PaneErrorClass; errorCode?: PaneErrorCode } | null {
  if (hasErrorName(error, 'TimeoutError')) return { errorClass: 'timeout' };
  if (hasErrorName(error, 'AbortError')) return null;
  const parsed = trpcFailureSchema.safeParse(error);
  if (parsed.success) {
    const rawCode = parsed.data.data.code;
    return {
      errorClass: 'trpc',
      errorCode: PANE_ERROR_CODES.find((code) => code === rawCode) ?? 'UNKNOWN',
    };
  }
  if (hasErrorName(error, 'TypeError')) return { errorClass: 'network' };
  return { errorClass: 'unknown' };
}

function readIdentifier(source: Record<string, unknown>, key: string, maxLength: number): IdentifierRead {
  const raw = source[key];
  if (raw === undefined) return { value: undefined, failed: false };
  const parsed = safeIdentifier.max(maxLength).safeParse(raw);
  return parsed.success
    ? { value: parsed.data, failed: false }
    : { value: undefined, failed: true };
}

function readRecord(source: Record<string, unknown>, key: string): { value: Record<string, unknown> | null; failed: boolean } {
  const raw = source[key];
  if (raw === undefined) return { value: null, failed: false };
  const parsed = recordSchema.safeParse(raw);
  return parsed.success
    ? { value: parsed.data, failed: false }
    : { value: null, failed: true };
}

function parseFailureInput(input: unknown) {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) {
    return { workItemId: undefined, sourceMessageId: undefined, requestId: undefined, allocationId: undefined, failed: true };
  }
  const value = parsed.data;
  const workItemId = readIdentifier(value, 'workItemId', 80);
  const requestId = readIdentifier(value, 'requestId', 80);
  const allocationId = readIdentifier(value, 'allocationId', 80);
  const source = readRecord(value, 'source');
  const selection = readRecord(value, 'selection');
  const sourceMessageId = source.value
    ? readIdentifier(source.value, 'messageId', 160)
    : { value: undefined, failed: false };
  const selectedMessageId = selection.value
    ? readIdentifier(selection.value, 'messageId', 160)
    : { value: undefined, failed: false };

  return {
    workItemId: workItemId.value,
    sourceMessageId: sourceMessageId.value ?? selectedMessageId.value,
    requestId: requestId.value,
    allocationId: allocationId.value,
    failed: workItemId.failed || requestId.failed || allocationId.failed || source.failed || selection.failed ||
      sourceMessageId.failed || selectedMessageId.failed,
  };
}

function paneSurface(): 'outlook' | 'web' | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.location.pathname.startsWith('/outlook-pane') ? 'outlook' : 'web';
  } catch {
    return undefined;
  }
}

export function reservationActionIdForInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  return actionIdsByInput.get(input);
}

export function paneSurfaceForFailureEvent(): PaneFailureEvent['surface'] {
  return paneSurface();
}

/** Correlates every V2 request and reports terminal client errors through the caller's best-effort sink. */
export function reservationFailureReportingLink(reportFailure: PaneFailureReporter): TRPCLink<AppRouter> {
  return () => ({ op, next }) => {
    let isReservationWorkflow = false;
    try {
      isReservationWorkflow = op.path.startsWith(RESERVATION_WORKFLOW_V2_PREFIX);
    } catch {
      // Keep ordinary transport behavior if path inspection fails.
    }
    if (!isReservationWorkflow) return next(op);

    let procedure: ReservationErrorProcedure | null = null;
    try {
      procedure = procedureFor(op.path);
    } catch {
      // Still attach correlation to a new V2 procedure; only known names may be reported.
    }

    const actionId = newActionId();
    if (actionId && op.input && typeof op.input === 'object') {
      try {
        actionIdsByInput.set(op.input, actionId);
      } catch {
        // The request still runs without client-decoding correlation.
      }
    }
    let correlatedOp = op;
    try {
      if (actionId) correlatedOp = { ...op, context: { ...op.context, [NAVA_ACTION_ID_CONTEXT_KEY]: actionId } };
    } catch {
      correlatedOp = op;
    }

    let metadata: ReturnType<typeof parseFailureInput> | null = null;
    let transportId: string | null = null;
    let surface: PaneFailureEvent['surface'];
    let backgroundPoll = false;
    try {
      metadata = parseFailureInput(op.input);
      transportId = transportForCall(op.context);
      surface = paneSurface();
      backgroundPoll = op.context[NAVA_BACKGROUND_POLL_CONTEXT_KEY] === true;
    } catch {
      // Correlation remains available even when optional client metadata is malformed.
    }

    const backgroundPollKey = backgroundPoll && metadata?.workItemId && procedure
      ? JSON.stringify([metadata.workItemId, procedure])
      : null;
    let reported = false;
    function report(error: unknown): void {
      if (reported || !procedure || !actionId || !metadata?.workItemId || !transportId ||
          (backgroundPollKey && backgroundPollFailures.has(backgroundPollKey))) return;
      try {
        const failure = errorMetadata(error);
        if (!failure) return;
        reported = true;
        if (backgroundPollKey) {
          if (backgroundPollFailures.size >= 500) {
            const oldest = backgroundPollFailures.values().next().value;
            if (oldest) backgroundPollFailures.delete(oldest);
          }
          backgroundPollFailures.add(backgroundPollKey);
        }
        reportFailure({
          workItemId: metadata.workItemId,
          transportId,
          event: {
            type: 'pane.error',
            procedure,
            actionId,
            ...failure,
            metadataParseFailed: metadata.failed,
            ...(surface ? { surface } : {}),
            ...(metadata.sourceMessageId ? { sourceMessageId: metadata.sourceMessageId } : {}),
            ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
            ...(metadata.allocationId ? { allocationId: metadata.allocationId } : {}),
          },
        });
      } catch {
        // Telemetry errors never change the original RPC error or response.
      }
    }

    return observable((observer) => {
      const subscription = next(correlatedOp).subscribe({
        next: (result) => {
          if ('error' in result.result) report(result.result.error);
          else if (backgroundPollKey) backgroundPollFailures.delete(backgroundPollKey);
          observer.next(result);
        },
        error: (error) => {
          report(error);
          observer.error(error);
        },
        complete: () => observer.complete(),
      });
      return () => subscription.unsubscribe();
    });
  };
}
