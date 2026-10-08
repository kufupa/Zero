import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AMEND_CANCEL_COPY,
  amendCancelClientFromTrpc,
  amendCapabilitiesFromTrpc,
  cancelConfirmLine,
  cancelFeeSentence,
  cancelManualSteps,
  cancelSwitchedOffNote,
  isCancelConfirmation,
  isoDayOf,
  viewAfterCommit,
  viewAfterPreview,
  type AmendCancelClient,
  type CancelRun,
  type CancelView,
} from '@/lib/quote-workflow/amend-cancel';
import {
  AMEND_FIND_COPY,
  AMEND_FIND_INTERVAL_MS,
  AMEND_FIND_TIMEOUT_MS,
  amendDiffs,
  amendFindClientFromTrpc,
  amendFindOutcome,
  enqueueFailureCopy,
  formatStayDate,
  knownFactValue,
  matchedOnLabel,
  outcomeNote,
  pollHmsFindReceipt,
  type AmendDiff,
  type AmendFindClient,
  type AmendFindOutcome,
} from '@/lib/quote-workflow/amend-find';
import type { QuoteSession } from '@/lib/quote-workflow/types';

export type AmendLookupTiming = { intervalMs: number; timeoutMs: number };

type LookupStatus =
  | { phase: 'running' }
  | { phase: 'done'; outcome: AmendFindOutcome }
  | { phase: 'error'; message: string };

type LookupState = { key: string; status: LookupStatus };

const panelClass =
  'flex flex-col gap-3 rounded-sm border border-[#e2e8f0] bg-white px-3 py-3 text-[#1e293b]';
const headingClass = 'text-[10px] font-semibold uppercase tracking-wide text-[#64748b]';
const captionClass = 'text-[10px] text-[#94a3b8]';
const valueClass = 'text-[12.5px] text-[#1e293b]';
const differClass = 'rounded-xs border border-amber-300 bg-amber-50 px-1.5 py-1';
const buttonClass =
  'rounded-sm border border-[#0066cc] bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-[#0066cc] disabled:cursor-not-allowed disabled:border-[#cbd5e1] disabled:text-[#94a3b8]';
const infoNoteClass =
  'rounded-xs border border-[#e2e8f0] bg-[#f8fafc] px-2.5 py-2 text-[11.5px] text-[#334155]';
const warnNoteClass = 'rounded-xs border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11.5px] text-amber-900';
const penaltyClass =
  'rounded-xs border border-amber-400 bg-amber-50 px-2.5 py-2 text-[12.5px] font-semibold text-amber-900';
const selectClass =
  'rounded-sm border border-[#cbd5e1] bg-white px-2 py-1.5 text-[12px] text-[#1e293b] disabled:text-[#94a3b8]';

/**
 * Amend and cancel mail: shows what the guest asked beside the booking HMS returns for the
 * exact confirmation number. Renders nothing unless the analysis carries an amendment.
 */
export function AmendLookupPanel({
  session,
  trpc,
  timing,
}: {
  session: QuoteSession;
  trpc: unknown;
  timing?: AmendLookupTiming;
}) {
  const amendment = session.analysis?.amendment ?? null;
  const client = useMemo(() => amendFindClientFromTrpc(trpc), [trpc]);
  const intervalMs = timing?.intervalMs ?? AMEND_FIND_INTERVAL_MS;
  const timeoutMs = timing?.timeoutMs ?? AMEND_FIND_TIMEOUT_MS;
  const threadId = session.staffSource?.threadId.trim() || null;
  const epoch = session.binding?.selectionEpoch ?? null;
  const key = threadId && epoch !== null ? `${threadId}:${epoch}` : null;
  const confirmationNumber = amendment?.confirmationNumber?.trim() || null;

  const [lookup, setLookup] = useState<LookupState | null>(null);
  const mounted = useRef(false);
  const runToken = useRef(0);
  const autoRunKey = useRef<string | null>(null);
  const [paneSave, setPaneSave] = useState(false);
  const cancelClient = useMemo(() => amendCancelClientFromTrpc(trpc), [trpc]);
  const [cancelState, setCancelState] = useState<{ key: string; view: CancelView } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Cancelling stays off until the server says the pane save flag is on.
  useEffect(() => {
    const readCapabilities = amendCapabilitiesFromTrpc(trpc);
    if (!readCapabilities) return;
    let live = true;
    readCapabilities()
      .then((reply) => {
        if (live) setPaneSave(reply.paneSave === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [trpc]);

  const runLookup = useCallback(
    async (activeClient: AmendFindClient | null, activeThread: string, activeKey: string) => {
      const token = ++runToken.current;
      const isCurrent = () => mounted.current && runToken.current === token;
      const finish = (status: LookupStatus) => {
        if (isCurrent()) setLookup({ key: activeKey, status });
      };
      setLookup({ key: activeKey, status: { phase: 'running' } });
      if (!activeClient) {
        finish({ phase: 'error', message: AMEND_FIND_COPY.unavailable });
        return;
      }
      let started: { readResultRef: string };
      try {
        started = await activeClient.enqueueHmsRead({
          threadId: activeThread,
          toolId: 'hms_find_reservation',
        });
      } catch (error) {
        finish({ phase: 'error', message: enqueueFailureCopy(error) });
        return;
      }
      const poll = await pollHmsFindReceipt({
        readHmsReceipt: activeClient.readHmsReceipt,
        threadId: activeThread,
        readResultRef: started.readResultRef,
        intervalMs,
        timeoutMs,
        isCurrent,
      });
      if (poll.kind === 'receipt') finish({ phase: 'done', outcome: amendFindOutcome(poll.receipt) });
      else if (poll.kind === 'timeout') finish({ phase: 'error', message: AMEND_FIND_COPY.busy });
      else if (poll.kind === 'error') finish({ phase: 'error', message: AMEND_FIND_COPY.readFailed });
    },
    [intervalMs, timeoutMs],
  );

  // Once per email (thread plus selection epoch), and only when Luna found a booking number.
  useEffect(() => {
    if (!key || !threadId || !confirmationNumber) return;
    if (autoRunKey.current === key) return;
    autoRunKey.current = key;
    void runLookup(client, threadId, key);
  }, [client, confirmationNumber, key, runLookup, threadId]);

  if (!amendment) return null;

  const status = lookup && key && lookup.key === key ? lookup.status : null;
  const running = status?.phase === 'running';
  const match = status?.phase === 'done' && status.outcome.kind === 'found' ? status.outcome.match : null;
  const diff: AmendDiff = match ? amendDiffs(amendment, match) : {};
  const outcomeText = status?.phase === 'done' ? outcomeNote(status.outcome) : null;
  const canLookUp = Boolean(key && threadId && confirmationNumber);

  let note: { tone: 'info' | 'warn'; text: string } | null = null;
  if (running) note = { tone: 'info', text: AMEND_FIND_COPY.looking };
  else if (status?.phase === 'error') note = { tone: 'warn', text: status.message };
  else if (outcomeText) note = { tone: 'warn', text: outcomeText };
  else if (!confirmationNumber) note = { tone: 'info', text: AMEND_FIND_COPY.noNumber };
  else if (!threadId) note = { tone: 'info', text: AMEND_FIND_COPY.waitingThread };

  const knownArrival = match ? knownFactValue(match.arrival) : null;
  const knownDeparture = match ? knownFactValue(match.departure) : null;

  // The HMS arrival is the stay the cancel must match; the email's date is only a fallback.
  const cancelView = cancelState && key && cancelState.key === key ? cancelState.view : null;
  const cancelArrival = isoDayOf(knownArrival) ?? isoDayOf(amendment.arrival);
  const cancelInput =
    confirmationNumber && cancelArrival && isCancelConfirmation(confirmationNumber)
      ? { confirmation: confirmationNumber, arrival: cancelArrival }
      : null;
  const canPreviewCancel = Boolean(paneSave && cancelClient && cancelInput && key);

  const previewCancel = async () => {
    if (!key || !cancelClient || !cancelInput) return;
    setCancelState({ key, view: { kind: 'previewing' } });
    try {
      const run = await cancelClient.previewCancel(cancelInput);
      setCancelState({ key, view: viewAfterPreview(run, cancelInput.confirmation) });
    } catch {
      setCancelState({ key, view: { kind: 'idle', note: AMEND_CANCEL_COPY.failed } });
    }
  };

  const commitCancel = async (ready: Extract<CancelView, { kind: 'ready' }>) => {
    if (!key || !cancelClient || !cancelInput || !ready.reason) return;
    setCancelState({ key, view: { kind: 'committing', run: ready.run, reason: ready.reason } });
    try {
      const run = await cancelClient.commitCancel({ ...cancelInput, reason: ready.reason });
      setCancelState({ key, view: viewAfterCommit(run, ready.run, cancelInput.confirmation) });
    } catch {
      setCancelState({ key, view: { kind: 'idle', note: AMEND_CANCEL_COPY.failed } });
    }
  };

  const chooseReason = (reason: string) => {
    if (!key) return;
    setCancelState((prev) => {
      if (!prev || prev.key !== key || prev.view.kind !== 'ready') return prev;
      const view = prev.view;
      return { key, view: { ...view, reason } };
    });
  };

  return (
    <section aria-labelledby="amend-lookup-title" data-testid="amend-lookup-panel" className={panelClass}>
      <h3 id="amend-lookup-title" className="text-[13px] font-semibold text-[#1e293b]">
        {amendment.kind === 'cancel' ? 'Cancellation request' : 'Change to an existing booking'}
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <p className={headingClass}>What the guest asked</p>
          <AskRow label="Request" value={amendment.requestedChange ?? 'Not stated'} />
          <AskRow label="Confirmation" value={amendment.confirmationNumber ?? 'Not in the email'} />
          <AskRow label="Guest last name" value={amendment.guestLastName ?? 'Not in the email'} />
          <AskRow label="Arrival" value={amendment.arrival ? formatStayDate(amendment.arrival) : 'Not stated'} />
          <AskRow label="Departure" value={amendment.departure ? formatStayDate(amendment.departure) : 'Not stated'} />
        </div>
        <div className="flex flex-col gap-2">
          <p className={headingClass}>Booking in HMS now</p>
          {match ? (
            <>
              <HmsRow
                field="matched"
                label="Matched on"
                value={`${matchedOnLabel(match)} ${confirmationNumber ?? ''}`.trim()}
              />
              <HmsRow field="guest" label="Guest" value={knownFactValue(match.label) ?? 'Not shown'} wants={diff.guest} />
              <HmsRow
                field="arrival"
                label="Arrival"
                value={knownArrival ? formatStayDate(knownArrival) : 'Not shown'}
                wants={diff.arrival}
              />
              <HmsRow
                field="departure"
                label="Departure"
                value={knownDeparture ? formatStayDate(knownDeparture) : 'Not shown'}
                wants={diff.departure}
              />
              <HmsRow field="status" label="Status" value={knownFactValue(match.status) ?? 'Not shown'} />
              <HmsRow field="room" label="Room" value={knownFactValue(match.roomType) ?? 'Not shown'} />
            </>
          ) : (
            <p className="text-[11.5px] text-[#64748b]">{running ? 'Looking up…' : 'Nothing shown yet.'}</p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!canLookUp || running}
          onClick={() => {
            if (key && threadId) void runLookup(client, threadId, key);
          }}
        >
          Find this booking in HMS
        </button>
        <div aria-live="polite">
          {note ? <p className={note.tone === 'warn' ? warnNoteClass : infoNoteClass}>{note.text}</p> : null}
        </div>
      </div>
      {amendment.kind === 'cancel' && match && confirmationNumber ? (
        <CancelSection
          view={cancelView}
          canPreview={canPreviewCancel}
          offNote={paneSave ? cancelManualSteps(confirmationNumber) : cancelSwitchedOffNote(confirmationNumber)}
          confirmation={confirmationNumber}
          guestName={knownFactValue(match.label) ?? amendment.guestLastName ?? 'this guest'}
          client={cancelClient}
          onPreview={() => void previewCancel()}
          onReason={chooseReason}
          onCommit={() => {
            if (cancelView?.kind === 'ready') void commitCancel(cancelView);
          }}
        />
      ) : null}
      <p className={captionClass}>{AMEND_FIND_COPY.footer}</p>
    </section>
  );
}

function AskRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className={headingClass}>{label}</p>
      <p className={valueClass}>{value}</p>
      <p className={captionClass}>From the email</p>
    </div>
  );
}

function HmsRow({
  field,
  label,
  value,
  wants,
}: {
  field: string;
  label: string;
  value: string;
  wants?: string;
}) {
  return (
    <div
      data-field={field}
      data-differs={wants ? 'true' : 'false'}
      className={`flex flex-col gap-0.5 ${wants ? differClass : ''}`}
    >
      <p className={headingClass}>{label}</p>
      <p className={valueClass}>{value}</p>
      {wants ? <p className="text-[11px] font-semibold text-amber-900">{`Guest wants: ${wants}`}</p> : null}
    </div>
  );
}

function CancelSection({
  view,
  canPreview,
  offNote,
  confirmation,
  guestName,
  client,
  onPreview,
  onReason,
  onCommit,
}: {
  view: CancelView | null;
  canPreview: boolean;
  offNote: string;
  confirmation: string;
  guestName: string;
  client: AmendCancelClient | null;
  onPreview: () => void;
  onReason: (reason: string) => void;
  onCommit: () => void;
}) {
  const reasonId = useId();
  const current: CancelView = view ?? { kind: 'idle', note: null };

  if (current.kind === 'done') {
    return (
      <div aria-live="polite" className="flex flex-col gap-2">
        <p className={headingClass}>Cancel in HMS</p>
        <p className={infoNoteClass}>{current.text}</p>
        <CancelScreenshot client={client} run={current.run} />
      </div>
    );
  }

  if (current.kind === 'ready' || current.kind === 'committing') {
    const { run, reason } = current;
    const committing = current.kind === 'committing';
    return (
      <div aria-live="polite" className="flex flex-col gap-2">
        <p className={headingClass}>Cancel in HMS</p>
        <p className={valueClass}>{`Status in HMS: ${run.statusBefore ?? 'not shown'}`}</p>
        <p className={run.penaltyText ? penaltyClass : captionClass}>{cancelFeeSentence(run.penaltyText)}</p>
        <CancelScreenshot client={client} run={run} />
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className={headingClass}>
            {AMEND_CANCEL_COPY.reasonLabel}
          </label>
          <select
            id={reasonId}
            className={selectClass}
            value={reason}
            disabled={committing}
            onChange={(event) => onReason(event.target.value)}
          >
            <option value="">{AMEND_CANCEL_COPY.reasonPlaceholder}</option>
            {run.reasons.map((text) => (
              <option key={text} value={text}>
                {text}
              </option>
            ))}
          </select>
        </div>
        <p className={warnNoteClass}>
          {cancelConfirmLine({ confirmation, guest: guestName, penaltyText: run.penaltyText })}
        </p>
        <button type="button" className={buttonClass} disabled={!reason || committing} onClick={onCommit}>
          {AMEND_CANCEL_COPY.commit}
        </button>
        {committing ? <p className={infoNoteClass}>{AMEND_CANCEL_COPY.committing}</p> : null}
        {current.kind === 'ready' && current.note ? <p className={warnNoteClass}>{current.note}</p> : null}
      </div>
    );
  }

  const previewing = current.kind === 'previewing';
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <p className={headingClass}>Cancel in HMS</p>
      {canPreview ? (
        <>
          <button type="button" className={buttonClass} disabled={previewing} onClick={onPreview}>
            {AMEND_CANCEL_COPY.preview}
          </button>
          <p className={captionClass}>{AMEND_CANCEL_COPY.previewHint}</p>
        </>
      ) : (
        <p className={infoNoteClass}>{offNote}</p>
      )}
      {previewing ? <p className={infoNoteClass}>{AMEND_CANCEL_COPY.previewing}</p> : null}
      {current.kind === 'idle' && current.note ? <p className={warnNoteClass}>{current.note}</p> : null}
    </div>
  );
}

function CancelScreenshot({ client, run }: { client: AmendCancelClient | null; run: CancelRun }) {
  const runId = run.runId ?? null;
  const name = run.screenshots.at(-1) ?? null;
  const [image, setImage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setImage(null);
    if (!client || !runId || !name) return;
    let live = true;
    client
      .paneStayScreenshot({ runId, name })
      .then((reply) => {
        if (live && reply.status === 'ok') setImage(reply.dataUrl);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, name, runId]);

  if (!image) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 self-start text-left">
        <img src={image} alt="" className="h-16 w-auto rounded-xs border border-[#e2e8f0]" />
        <span className="text-[11.5px] font-medium text-[#0066cc]">{AMEND_CANCEL_COPY.seeScreenshot}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={AMEND_CANCEL_COPY.seeScreenshot}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
        >
          <img
            src={image}
            alt="What Luna saw on the HMS cancel screen"
            className="max-h-[85vh] max-w-full rounded-sm bg-white"
          />
          <button type="button" className={buttonClass} onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : null}
    </>
  );
}
