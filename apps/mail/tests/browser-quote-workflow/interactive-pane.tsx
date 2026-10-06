/**
 * Verification harness only. Mounts production QuoteWorkflowPanel with a labelled
 * mock adapter/bridge. Not Outlook. Not live HMS. Not a product surface.
 */
import { QuoteWorkflowPanel } from '../../components/quote-workflow/quote-workflow-panel';
import { bindRunStep } from '../../lib/quote-workflow/backend-bind';
import { fixtureResultsReady, loadQuoteFixture } from '../../lib/quote-workflow/fixtures';
import {
  buildQuoteStepInputs,
  canCreatePdf,
  canCreateNativeDraft,
  canRunQuoteStep,
  formatQuoteStepInputs,
  initialQuoteSession,
  nextSelectedOfferIds,
  pickNextRunnableStep,
  reduceQuoteSession,
} from '../../lib/quote-workflow/session';
import type { QuoteSession, QuoteSessionAction } from '../../lib/quote-workflow/types';
import { createRoot } from 'react-dom/client';
import { useMemo, useReducer } from 'react';

const MOCK_REASON =
  'MOCK adapter: integration_unavailable — labelled mock, not HMS, not Outlook, no native call';

const mockBridge = {
  adapterCalls: [] as string[],
  pdfClicks: 0,
  nativeCalls: [] as string[],
};

declare global {
  interface Window {
    __quoteProof: Record<string, unknown>;
  }
}

function mockBinding() {
  return {
    transportId: 'mock-transport',
    mailboxEmail: 'mock@example.test',
    storeId: 'mock-store',
    folderEntryId: 'mock-inbox',
    entryId: 'mock-entry',
    selectionEpoch: 1,
    scopeEpoch: 1,
  };
}

function seedSession(scenario: string): QuoteSession {
  const fixture = loadQuoteFixture('mixed-same-dates');
  let session = reduceQuoteSession(initialQuoteSession(), {
    type: 'selection',
    binding: mockBinding(),
  });
  session = reduceQuoteSession(session, { type: 'mailbox_status', status: 'unavailable' });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: {
      intent: 'quote',
      groups: fixture.groups,
      secondaryAsks: fixture.secondaryAsks,
      alternatives: fixture.alternatives,
    },
  });
  if (scenario === 'select') {
    session = reduceQuoteSession(session, fixtureResultsReady(fixture.offers));
  }
  return session;
}

function snapshot(session: QuoteSession, scenario: string) {
  return {
    reactHydrated: true,
    mockedIntegrations: true,
    notOutlook: true,
    adapterLabel: 'MOCK adapter/bridge',
    scenario,
    phase: session.phase,
    inputRevision: session.inputRevision,
    groupIds: session.groups.map((group) => group.id),
    groups: session.groups.map((group) => ({
      id: group.id,
      arrivalDate: group.arrivalDate ?? null,
      departureDate: group.departureDate ?? null,
      adults: group.adults ?? null,
      quantity: group.quantity ?? null,
    })),
    steps: session.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      displayedInputs: formatQuoteStepInputs(step.inputs),
      wouldSend: buildQuoteStepInputs(session, step),
      retryGuidance: step.retryGuidance ?? null,
    })),
    offerIds: session.offers.map((offer) => offer.id),
    selectedOfferIds: session.selectedOfferIds,
    offerCount: session.offers.length,
    errorMessage: session.errorMessage,
    pdf: session.pdf,
    canCreatePdf: canCreatePdf(session),
    canCreateNativeDraft: canCreateNativeDraft(session),
    hasAllocationCopy: session.offers.some((offer) => offer.kind === 'allocation'),
    adapterCalls: [...mockBridge.adapterCalls],
    pdfClicks: mockBridge.pdfClicks,
    nativeCalls: [...mockBridge.nativeCalls],
  };
}

function InteractiveQuotePane() {
  const scenario = useMemo(
    () => new URLSearchParams(window.location.search).get('scenario') ?? 'unavailable',
    [],
  );
  const [session, dispatch] = useReducer(reduceQuoteSession, scenario, seedSession);
  window.__quoteProof = snapshot(session, scenario);

  const runStep = (stepId: string) => {
    const step = session.steps.find((item) => item.id === stepId);
    if (!step || !canRunQuoteStep(step, session.steps, session.runningStepId)) return;
    dispatch({ type: 'step_running', stepId: step.id });
    const selectionEpoch = session.binding?.selectionEpoch ?? 0;
    const inputRevision = session.inputRevision;
    const inputs = buildQuoteStepInputs(session, step);
    mockBridge.adapterCalls.push(`runStep:${step.id}`);
    void bindRunStep({
      mutate: async () => ({
        status: 'integration_unavailable',
        reason: MOCK_REASON,
      }),
      stepId: step.id,
      selectionEpoch,
      inputRevision,
      inputs,
    }).then((remote) => {
      if (remote.status !== 'ok') {
        const action: QuoteSessionAction = {
          type: 'results_unavailable',
          stepId: step.id,
          reason: remote.reason,
          selectionEpoch,
          inputRevision,
        };
        dispatch(action);
        return;
      }
      mockBridge.nativeCalls.push('unexpected-ok-from-mock');
    });
  };

  return (
    <div id="interactive-quote-root" data-hydrated="true" data-scenario={scenario} className="mx-auto w-[380px] p-3">
      <p
        id="mock-banner"
        className="mb-3 rounded-sm border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] font-semibold text-amber-950"
      >
        MOCKED adapter/bridge — browser UI with mocked integrations, not Outlook, not live HMS, no native
        draft.
      </p>
      <QuoteWorkflowPanel
        session={session}
        onPatchGroup={(groupId, patch) => dispatch({ type: 'patch_group', groupId, patch })}
        onRunStep={runStep}
        onRunNext={() => {
          const next = pickNextRunnableStep(session.steps, session.runningStepId);
          if (next) runStep(next.id);
        }}
        onSelectOffer={(offerId) =>
          dispatch({ type: 'select_offers', offerIds: nextSelectedOfferIds(session, offerId) })
        }
        onReplyChange={(html) => dispatch({ type: 'set_reviewed_reply', html })}
        onPreparePdf={() => {
          mockBridge.pdfClicks += 1;
          window.__quoteProof = snapshot(session, scenario);
        }}
      />
      <pre id="mock-readout" className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-[#334155]">
        {JSON.stringify(window.__quoteProof, null, 2)}
      </pre>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
window.__quoteProof = {
  reactHydrated: false,
  adapterCalls: [],
  pdfClicks: 0,
  nativeCalls: [],
};
createRoot(root).render(<InteractiveQuotePane />);
