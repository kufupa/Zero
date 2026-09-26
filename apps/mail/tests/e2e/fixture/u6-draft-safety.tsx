import type { U6DraftSafetyState } from '../reservation-tools-pilot-transport';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import ReplyCompose from '../../../components/mail/reply-composer';
import { useTRPC } from '../../../providers/query-provider';
import { useEffect, useState } from 'react';
import { useQueryState } from 'nuqs';

const THREAD_ID = 'u6-thread-1';

function initialState(): U6DraftSafetyState {
  return {
    mode: 'ai',
    aiDraftActive: false,
    stale: false,
    draftBody:
      '<p>Hello guest,</p><p>We can confirm the requested synthetic stay details for review.</p>',
    approvalCalls: 0,
    sendCalls: 0,
    blockedSends: 0,
    smtpAttempts: 0,
    acceptedSends: 0,
    lastEvent: 'candidate-ready',
    lastSentBody: null,
  };
}

function getState(): U6DraftSafetyState {
  if (!window.__u6DraftSafetyState) window.__u6DraftSafetyState = initialState();
  return window.__u6DraftSafetyState;
}

function emit(event: string): void {
  const state = getState();
  state.lastEvent = event;
  window.dispatchEvent(new CustomEvent('u6-draft-safety-update', { detail: { event } }));
}

export default function U6DraftSafetyPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [, setDraftId] = useQueryState('draftId');
  const { mutateAsync: refreshCandidate, isPending: isRefreshing } = useMutation(
    trpc.ai.refreshHmsCandidate.mutationOptions(),
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [status, setStatus] = useState('Synthetic assisted candidate is ready for review.');
  const [audit, setAudit] = useState(() => getState());

  useEffect(() => {
    const update = () => {
      const current = { ...getState() };
      setAudit(current);
      if (current.lastEvent === 'fake-smtp-accepted') {
        setStatus('Fake SMTP accepted the reviewed message.');
      } else if (current.lastEvent === 'approval-blocked') {
        setStatus('Approval blocked before SMTP; the edited draft remains available.');
      }
    };
    window.addEventListener('u6-draft-safety-update', update);
    update();
    return () => window.removeEventListener('u6-draft-safety-update', update);
  }, []);

  const adoptCandidate = () => {
    const state = getState();
    state.mode = 'ai';
    state.aiDraftActive = false;
    state.stale = false;
    setManualMode(false);
    setEditorOpen(true);
    setStatus('Opening the assisted candidate in the existing reply editor.');
    emit('candidate-opened');
  };

  const simulateNewInbound = () => {
    const state = getState();
    state.stale = true;
    setStatus('A newer inbound message is present; approval must be rechecked.');
    emit('newer-inbound');
  };

  const refresh = async () => {
    try {
      await refreshCandidate({ threadId: THREAD_ID });
      setStatus('Candidate refreshed; the edited editor body remains in place.');
    } catch {
      setStatus('Candidate refresh is unavailable in this bounded fixture.');
    }
  };

  const switchToManual = async () => {
    const state = getState();
    state.mode = 'manual';
    state.aiDraftActive = false;
    state.stale = false;
    state.draftBody = '<p>Manual fixture reply — confirm the stay details.</p>';
    await setDraftId(null);
    queryClient.removeQueries({
      queryKey: trpc.mail.get.queryKey({ id: THREAD_ID, mergeLinked: true }),
    });
    queryClient.removeQueries({ queryKey: trpc.drafts.get.queryKey({ id: 'u6-ai-draft' }) });
    setManualMode(true);
    setEditorOpen(true);
    setStatus('Manual fallback is active; this path uses the ordinary Send control.');
    emit('manual-fallback');
  };

  return (
    <main className="bg-background text-foreground min-h-screen p-4 sm:p-6">
      <div className="mx-auto grid max-w-3xl gap-5">
        <header className="grid gap-2">
          <h1 className="text-2xl font-semibold">U6 draft safety fixture</h1>
          <p className="text-muted-foreground text-sm">
            Synthetic loopback transport for the existing reply editor, approval route and fake SMTP
            boundary. No live mailbox or model is used.
          </p>
        </header>

        {!editorOpen ? (
          <section
            aria-labelledby="u6-candidate-heading"
            className="grid gap-3 rounded-lg border p-4"
          >
            <h2 id="u6-candidate-heading" className="text-lg font-medium">
              Assisted candidate
            </h2>
            <p>This candidate is read-only until a person adopts it in the reply editor.</p>
            <button
              className="min-h-[44px] rounded-md border px-4 text-left"
              data-u6-action="adopt"
              type="button"
              onClick={adoptCandidate}
            >
              Adopt candidate
            </button>
          </section>
        ) : (
          <section aria-label="U6 reply review" className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {!manualMode ? (
                <>
                  <button
                    className="min-h-[44px] rounded-md border px-3"
                    data-u6-action="refresh"
                    type="button"
                    onClick={() => void refresh()}
                    disabled={isRefreshing}
                  >
                    {isRefreshing ? 'Refreshing…' : 'Refresh candidate'}
                  </button>
                  <button
                    className="min-h-[44px] rounded-md border px-3"
                    data-u6-action="stale"
                    type="button"
                    onClick={simulateNewInbound}
                  >
                    Simulate newer inbound
                  </button>
                  <button
                    className="min-h-[44px] rounded-md border px-3"
                    data-u6-action="manual"
                    type="button"
                    onClick={() => void switchToManual()}
                  >
                    Use manual fallback
                  </button>
                </>
              ) : null}
            </div>
            <ReplyCompose key={manualMode ? 'u6-manual' : 'u6-ai'} messageId="u6-message-1" />
          </section>
        )}

        <p
          role="status"
          aria-live="polite"
          data-testid="u6-status"
          className="rounded-md border p-3 text-sm"
        >
          {status}
        </p>
        <dl
          data-testid="u6-audit"
          className="grid gap-1 rounded-md border p-3 text-sm sm:grid-cols-2"
        >
          <div>Approval calls: {audit.approvalCalls}</div>
          <div>Send calls: {audit.sendCalls}</div>
          <div>Blocked sends: {audit.blockedSends}</div>
          <div>Fake SMTP attempts: {audit.smtpAttempts}</div>
          <div>Accepted sends: {audit.acceptedSends}</div>
          <div data-testid="u6-last-sent-body">Last body: {audit.lastSentBody ?? 'none'}</div>
        </dl>
      </div>
    </main>
  );
}
