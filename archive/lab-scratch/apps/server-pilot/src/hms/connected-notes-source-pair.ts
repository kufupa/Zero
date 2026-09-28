/**
 * One-invocation notes source pair for the connected runner.
 *
 * Both providers must use the same fresh authenticated Guest Stay context.
 * The JSON inquiry is read first, then the exact bound TRC form; this helper
 * owns no cache beyond the current pair instance.
 */
import {
  createNotesInquiryReadFacade,
  type NotesInquiryAudience,
  type NotesInquiryReadResult,
} from './notes-inquiry-read-facade.js';
import {
  createNotesTracesReadFacade,
  type NotesTracesReadResult,
} from './notes-traces-read-facade.js';
import type { ValidatedFolioDetailValues } from '../../../../../../apps/server-pilot/src/hms/folio-read-facade.js';
import type { HmsReadSession } from '../../../../../../apps/server-pilot/src/hms/runtime.js';

export type ConnectedNotesSourceParent = {
  propertyCode: 'HRCEN';
  confirmationNumber: string;
  reservationStayId: string;
  resourceRef: string;
};

export type ConnectedNotesSourcePair = {
  notes: NotesInquiryReadResult;
  traces: NotesTracesReadResult;
};

type ConnectedNotesSourceSession = Pick<HmsReadSession, 'origin' | 'page' | 'close'>;

export type ConnectedNotesSourcePairReader = {
  notesInquiryFor(
    input: { resourceRef: string; audience: NotesInquiryAudience },
    signal: AbortSignal,
  ): Promise<NotesInquiryReadResult>;
  notesTracesFor(
    input: { resourceRef: string },
    signal: AbortSignal,
  ): Promise<NotesTracesReadResult>;
};

export function createConnectedNotesSourcePair(input: {
  parentBinding: ConnectedNotesSourceParent;
  detailValues: ValidatedFolioDetailValues;
  audience: NotesInquiryAudience;
  openSession(signal: AbortSignal): Promise<ConnectedNotesSourceSession>;
}): ConnectedNotesSourcePairReader {
  let pairPromise: Promise<ConnectedNotesSourcePair> | null = null;
  let pairSignal: AbortSignal | null = null;

  const readPair = async (signal: AbortSignal): Promise<ConnectedNotesSourcePair> => {
    let session: ConnectedNotesSourceSession | null = null;
    let sourceFailed = false;
    let providerError: unknown;
    try {
      session = await input.openSession(signal);
      const parentBinding = input.parentBinding;
      const notes = await createNotesInquiryReadFacade(session).read({
        parentBinding,
        audience: input.audience,
        limit: 50,
      });
      const traces = await createNotesTracesReadFacade(session).read({
        parentBinding,
        detailValues: input.detailValues,
        limit: 50,
      });
      return { notes, traces };
    } catch (error) {
      sourceFailed = true;
      providerError = error;
      throw error;
    } finally {
      if (session) {
        try {
          await session.close(
            sourceFailed
              ? { outcome: 'failed', terminalCode: 'TOOL_ERROR', complete: false }
              : undefined,
          );
        } catch (closeError) {
          if (sourceFailed) {
            throw new AggregateError(
              [providerError, closeError],
              'connected notes source pair and session close failed',
            );
          }
          throw closeError;
        }
      }
    }
  };

  const getPair = (signal: AbortSignal): Promise<ConnectedNotesSourcePair> => {
    if (signal.aborted) {
      return Promise.reject(new Error('connected notes source pair signal already aborted'));
    }
    if (pairSignal && pairSignal !== signal) {
      return Promise.reject(new Error('connected notes source pair requires one invocation abort signal'));
    }
    pairSignal ??= signal;
    if (!pairPromise) pairPromise = readPair(signal);
    return pairPromise;
  };

  return {
    async notesInquiryFor({ resourceRef, audience }, signal) {
      if (resourceRef !== input.parentBinding.resourceRef) {
        throw new Error('notes inquiry resource scope mismatch');
      }
      if (audience !== input.audience) {
        throw new Error('notes inquiry audience mismatch');
      }
      return (await getPair(signal)).notes;
    },
    async notesTracesFor({ resourceRef }, signal) {
      if (resourceRef !== input.parentBinding.resourceRef) {
        throw new Error('trace resource scope mismatch');
      }
      return (await getPair(signal)).traces;
    },
  };
}
