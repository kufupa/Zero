import {
  HMS_NOTE_MAX,
  HMS_NOTE_MIN,
  HMS_WRITE_COPY,
  HMS_WRITE_POLL_MS,
  refusalCopy,
  writeRowsOf,
  writeStatusOf,
  type HmsApprovalClient,
  type HmsWriteView,
  type WriteRow,
  type WriteStatus,
} from '@/lib/quote-workflow/hms-write';
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { PANE_SAVE_LAB_GUARD_COPY } from '@/lib/quote-workflow/pane-stay-bind';
import { ReviewCard, writeClasses } from './review-card';
import { HmsLinkActions } from './hms-link-actions';
import { toast } from 'sonner';

const panelClass =
  'flex flex-col gap-3 rounded-sm border border-[#e2e8f0] bg-white px-3 py-3 text-[#1e293b]';
const divider = 'flex flex-col gap-2 border-t border-[#e2e8f0] pt-3';

/**
 * The approve and review card for the HMS write on this mail's stored work item (U18). It shows each value as before →
 * after, the write's state in words, and only the actions that state allows. With writesEnabled off (the pane save flag)
 * it shows the handoff alone. The server refuses a write in every case the card hides.
 */
export function ApproveCard({
  client,
  workItemId,
  writesEnabled,
  confirmation,
}: {
  client: HmsApprovalClient | null;
  workItemId: string;
  writesEnabled: boolean;
  /** The HMS confirmation number, for the Copy link and Copy confirmation handoff. */
  confirmation: string | null;
}) {
  if (!client) return null;
  if (!writesEnabled) {
    return (
      <WriteFrame confirmation={confirmation}>
        <p className={writeClasses.note}>{PANE_SAVE_LAB_GUARD_COPY}</p>
      </WriteFrame>
    );
  }
  return <LiveWriteCard client={client} workItemId={workItemId} confirmation={confirmation} />;
}

/** The write's state for one work item. Re-read after each action, and every few seconds while a run is moving. */
function useHmsWriteState(client: HmsApprovalClient, workItemId: string) {
  const [loaded, setLoaded] = useState<{ workItemId: string; view: HmsWriteView } | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((count) => count + 1), []);
  const moving = loaded !== null && writeStatusOf(loaded.view).phase === 'running';

  useEffect(() => {
    let live = true;
    client.writeState({ workItemId }).then(
      (view) => {
        if (!live) return;
        setLoaded({ workItemId, view });
        setFailed(false);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, workItemId, tick]);

  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(refresh, HMS_WRITE_POLL_MS);
    return () => clearTimeout(timer);
  }, [moving, loaded, refresh]);

  return { view: loaded?.workItemId === workItemId ? loaded.view : null, failed, refresh };
}

function LiveWriteCard({
  client,
  workItemId,
  confirmation,
}: {
  client: HmsApprovalClient;
  workItemId: string;
  confirmation: string | null;
}) {
  const { view, failed, refresh } = useHmsWriteState(client, workItemId);
  return (
    <WriteFrame confirmation={confirmation}>
      {view ? (
        <WriteBody client={client} workItemId={workItemId} view={view} onChanged={refresh} />
      ) : failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[12px] text-[#334155]">
          <span>{HMS_WRITE_COPY.loadFailed}</span>
          <button type="button" className={writeClasses.secondary} onClick={refresh}>
            {HMS_WRITE_COPY.retry}
          </button>
        </div>
      ) : (
        <p role="status" className={writeClasses.note}>
          {HMS_WRITE_COPY.loading}
        </p>
      )}
    </WriteFrame>
  );
}

function WriteFrame({
  confirmation,
  children,
}: {
  confirmation: string | null;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={panelClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="text-[13px] font-semibold text-[#1e293b]">
          {HMS_WRITE_COPY.heading}
        </h3>
        {confirmation ? <HmsLinkActions confirmation={confirmation} /> : null}
      </div>
      {children}
    </section>
  );
}

function WriteBody({
  client,
  workItemId,
  view,
  onChanged,
}: {
  client: HmsApprovalClient;
  workItemId: string;
  view: HmsWriteView;
  onChanged: () => void;
}) {
  const status = writeStatusOf(view);
  const rows = writeRowsOf(view);
  return (
    <>
      <div role="status" aria-live="polite" className="text-[12px] text-[#334155]">
        {status.message}
      </div>
      <WriteRows rows={rows} />
      {status.approve ? (
        <ApproveSection
          client={client}
          workItemId={workItemId}
          status={status}
          canApprove={rows.length > 0}
          onChanged={onChanged}
        />
      ) : null}
      {status.phase === 'needs_check' ? (
        <NeedsCheckSection client={client} workItemId={workItemId} onChanged={onChanged} />
      ) : null}
      {status.review && view.run ? (
        <ReviewCard client={client} workItemId={workItemId} run={view.run} onChanged={onChanged} />
      ) : null}
    </>
  );
}

function WriteRows({ rows }: { rows: WriteRow[] }) {
  if (rows.length === 0) return <p className={writeClasses.note}>{HMS_WRITE_COPY.noChange}</p>;
  return (
    <ul aria-label="Values to write" className="flex flex-col gap-1.5 text-[12px]">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-[#334155]">{row.label}</span>
          <span className="text-[#64748b] line-through">{row.before}</span>
          <span>→</span>
          <span className="font-semibold text-[#1e293b]">{row.after}</span>
        </li>
      ))}
    </ul>
  );
}

function ApproveSection({
  client,
  workItemId,
  status,
  canApprove,
  onChanged,
}: {
  client: HmsApprovalClient;
  workItemId: string;
  status: WriteStatus;
  canApprove: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = status.reread !== null || !canApprove;
  const again = status.changed || status.reviewed === 'flag' || status.phase === 'stopped';

  const approve = () => {
    setBusy(true);
    setError(null);
    client
      .approve({ workItemId })
      .then(() => {
        toast.success(HMS_WRITE_COPY.approved);
        onChanged();
      })
      .catch((err: unknown) => setError(refusalCopy(err)))
      .finally(() => setBusy(false));
  };

  // A fresh HMS read stored as the snapshot (KTD11). The server reads the booking the form names.
  const reread = () => {
    setBusy(true);
    setError(null);
    client
      .reread({ workItemId })
      .then(
        (reply) =>
          reply.status === 'stored' ? onChanged() : setError(HMS_WRITE_COPY.rereadFailed),
        () => setError(HMS_WRITE_COPY.rereadFailed),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className={divider}>
      {status.changed ? (
        <p className="text-[12px] font-semibold text-amber-900">{HMS_WRITE_COPY.changed}</p>
      ) : null}
      {status.reread ? (
        <p className="text-[12px] text-amber-900">{HMS_WRITE_COPY.rereadFirst}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {status.reread ? (
          <button type="button" className={writeClasses.secondary} disabled={busy} onClick={reread}>
            {HMS_WRITE_COPY.reread}
          </button>
        ) : null}
        <button
          type="button"
          className={writeClasses.primary}
          disabled={busy || blocked}
          onClick={approve}
        >
          {again ? HMS_WRITE_COPY.approveAgain : HMS_WRITE_COPY.approve}
        </button>
      </div>
      {error ? (
        <p role="alert" className={writeClasses.alert}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function NeedsCheckSection({
  client,
  workItemId,
  onChanged,
}: {
  client: HmsApprovalClient;
  workItemId: string;
  onChanged: () => void;
}) {
  const fieldId = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = note.trim();
    if (text.length < HMS_NOTE_MIN) {
      setError(HMS_WRITE_COPY.noteNeeded);
      return;
    }
    setBusy(true);
    setError(null);
    client
      .resolveNeedsCheck({ workItemId, note: text })
      .then(() => {
        toast.success(HMS_WRITE_COPY.checkSaved);
        setNote('');
        onChanged();
      })
      .catch((err: unknown) => setError(refusalCopy(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit} className={divider}>
      <p className={writeClasses.note}>{HMS_WRITE_COPY.needsCheckIntro}</p>
      <label htmlFor={fieldId} className="text-[12px] font-semibold text-[#1e293b]">
        {HMS_WRITE_COPY.checkLabel}
      </label>
      <textarea
        id={fieldId}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={HMS_NOTE_MAX}
        rows={2}
        aria-required="true"
        className={writeClasses.textarea}
      />
      <div>
        <button type="submit" className={writeClasses.primary} disabled={busy}>
          {HMS_WRITE_COPY.checkButton}
        </button>
      </div>
      {error ? (
        <p role="alert" className={writeClasses.alert}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
