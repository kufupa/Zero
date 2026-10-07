import type { BookingDraftReady, LunaAnalysisWire, StaffQuoteSource } from './types';

export type PrepareBookingDraftInput = {
  workflowRunId: string;
  revisionRef: string;
  messageId: string;
  selectionEpoch: number;
  inputRevision: number;
  analysis: LunaAnalysisWire;
};

export type PrepareBookingDraftResult =
  | { status: 'unavailable'; reason?: string }
  | ({ status: 'ready' } & BookingDraftReady);

export type BoundPrepareBookingDraft =
  | { status: 'unavailable'; reason: string }
  | { status: 'ok'; payload: BookingDraftReady };

function rejectionReason(error: unknown, label: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : `${label} failed.`;
}

export async function bindPrepareBookingDraft(args: {
  mutate?: (input: PrepareBookingDraftInput) => Promise<PrepareBookingDraftResult | { status?: string }>;
  source: StaffQuoteSource;
  workflowRunId: string;
  revisionRef: string;
  messageId: string;
  selectionEpoch: number;
  inputRevision: number;
  analysis: LunaAnalysisWire;
}): Promise<BoundPrepareBookingDraft> {
  if (!args.mutate) {
    return {
      status: 'unavailable',
      reason: 'Client has no workstation.prepareBookingDraft.',
    };
  }
  try {
    const result = await args.mutate({
      workflowRunId: args.workflowRunId,
      revisionRef: args.revisionRef,
      messageId: args.messageId,
      selectionEpoch: args.selectionEpoch,
      inputRevision: args.inputRevision,
      analysis: args.analysis,
    });
    if (!result || typeof result !== 'object' || result.status !== 'ready') {
      const reason =
        result && typeof result === 'object' && 'reason' in result && typeof result.reason === 'string'
          ? result.reason
          : 'prepareBookingDraft did not return a ready draft.';
      return { status: 'unavailable', reason };
    }
    const ready = result as { status: 'ready' } & BookingDraftReady;
    if (
      ready.selectionEpoch !== args.selectionEpoch ||
      ready.inputRevision !== args.inputRevision ||
      ready.messageId !== args.source.messageId ||
      ready.revisionRef !== args.revisionRef
    ) {
      return {
        status: 'unavailable',
        reason: 'prepareBookingDraft result is stale against the current selection.',
      };
    }
    if (!ready.draft || !Array.isArray(ready.draft.rooms) || !ready.options) {
      return { status: 'unavailable', reason: 'prepareBookingDraft omitted draft rooms or options.' };
    }
    return {
      status: 'ok',
      payload: {
        draft: ready.draft,
        options: ready.options,
        messageId: ready.messageId,
        selectionEpoch: ready.selectionEpoch,
        inputRevision: ready.inputRevision,
        revisionRef: ready.revisionRef,
      },
    };
  } catch (error) {
    return { status: 'unavailable', reason: rejectionReason(error, 'prepareBookingDraft') };
  }
}
