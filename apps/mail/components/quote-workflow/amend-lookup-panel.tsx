import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AMEND_CANCEL_COPY,
  amendCancelClientFromTrpc,
  amendCapabilitiesFromTrpc,
  cancelConfirmLine,
  cancelFeeSentence,
  cancelManualSteps,
  cancelSwitchedOffNote,
  isoDayOf,
  viewAfterCommit,
  viewAfterPreview,
  type AmendCancelClient,
  type CancelRun,
  type CancelView,
} from '@/lib/quote-workflow/amend-cancel';
import {
  AMEND_FIND_COPY,
  amendDiffs,
  amendFindClientFromTrpc,
  amendSearchClientFromTrpc,
  arrivalMismatchNote,
  formatStayDate,
  hmsNumberFor,
  noSearchMatchCopy,
  notHmsNumberNote,
  runHmsFind,
  runHmsSearch,
  stayGuest,
  stayText,
  type AmendDiff,
  type AmendFindClient,
  type AmendSearchClient,
  type GuestSearchRow,
  type HmsFindRun,
  type HmsSearchRun,
  type ScreenshotInput,
  type ScreenshotReply,
  type StayRecordWire,
} from '@/lib/quote-workflow/amend-find';
import { amendmentOf } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { HmsLinkActions } from './hms-link-actions';

type LookupStatus = { phase: 'running' } | { phase: 'done'; run: HmsFindRun };

/** The HMS number a find ran for, so the cancel section acts on the stay that is on screen. */
type LookupState = { key: string; confirmation: string; status: LookupStatus };

type SearchStatus = { phase: 'running' } | { phase: 'done'; run: HmsSearchRun };

type SearchState = { key: string; status: SearchStatus };

type SearchForm = { lastName: string; arrival: string; departure: string };

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
  'h-8 rounded-sm border border-[#cbd5e1] bg-white px-2 py-1.5 text-[12px] text-[#1e293b] disabled:text-[#94a3b8]';

/**
 * Amend and cancel mail: shows what the guest asked beside the booking HMS returns for the email's booking number.
 * With no usable number, staff find the booking by surname and arrival instead. Renders nothing unless the analysis
 * carries an amendment.
 */
export function AmendLookupPanel({ session, trpc }: { session: QuoteSession; trpc: unknown }) {
  const amendment = amendmentOf(session);
  const findClient = useMemo(() => amendFindClientFromTrpc(trpc), [trpc]);
  const searchClient = useMemo(() => amendSearchClientFromTrpc(trpc), [trpc]);
  const cancelClient = useMemo(() => amendCancelClientFromTrpc(trpc), [trpc]);
  const threadId = session.staffSource?.threadId.trim() || null;
  const epoch = session.binding?.selectionEpoch ?? null;
  const key = threadId && epoch !== null ? `${threadId}:${epoch}` : null;
  const confirmationNumber = amendment?.confirmationNumber?.trim() || null;
  // Only a dash confirmation (57291630-1) is an HMS number. A bare number may be a billing or voucher reference, so it is not one.
  const hmsNumber = hmsNumberFor(confirmationNumber);
  const lookupable = hmsNumber !== null;
  // The email's arrival rides with the find so HMS quick search covers that day. runHmsFind drops a non-date.
  const findArrival = amendment?.arrival ?? null;

  const [lookup, setLookup] = useState<LookupState | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [paneSave, setPaneSave] = useState(false);
  // Cancel views are kept per booking on an email (see cancelScope), so a reply for one booking never shows on another.
  const [cancelViews, setCancelViews] = useState<Record<string, CancelView>>({});
  const mounted = useRef(false);
  const runToken = useRef(0);
  const searchToken = useRef(0);

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
    async (
      activeClient: AmendFindClient | null,
      activeConfirmation: string,
      activeArrival: string | null,
      activeKey: string,
    ) => {
      const token = ++runToken.current;
      const isCurrent = () => mounted.current && runToken.current === token;
      setLookup({ key: activeKey, confirmation: activeConfirmation, status: { phase: 'running' } });
      const run = await runHmsFind({
        client: activeClient,
        confirmation: activeConfirmation,
        arrival: activeArrival,
      });
      if (isCurrent()) {
        setLookup({ key: activeKey, confirmation: activeConfirmation, status: { phase: 'done', run } });
      }
    },
    [],
  );

  const runSearch = useCallback(async (activeClient: AmendSearchClient | null, form: SearchForm, activeKey: string) => {
    const token = ++searchToken.current;
    const isCurrent = () => mounted.current && searchToken.current === token;
    setSearch({ key: activeKey, status: { phase: 'running' } });
    const run = await runHmsSearch({
      client: activeClient,
      lastName: form.lastName,
      arrival: form.arrival,
      departure: form.departure,
    });
    if (isCurrent()) setSearch({ key: activeKey, status: { phase: 'done', run } });
  }, []);

  if (!amendment) return null;

  const status = lookup && key && lookup.key === key ? lookup.status : null;
  const running = status?.phase === 'running';
  const found = status?.phase === 'done' && status.run.kind === 'found' ? status.run : null;
  const stay: StayRecordWire | null = found?.stay ?? null;
  // The number the stay on screen was found under: the email's own, the -1 form, or a row picked from a search.
  const foundNumber = found && lookup ? lookup.confirmation : null;
  // The one HMS handoff row copies the number HMS holds the booking under, else the number in the email.
  const handoffNumber = foundNumber ?? confirmationNumber;
  const diff: AmendDiff = stay ? amendDiffs(amendment, stay) : {};
  const canLookUp = Boolean(key && threadId && lookupable);
  const searchStatus = search && key && search.key === key ? search.status : null;
  const searching = searchStatus?.phase === 'running';
  const busy = running || searching;
  const findNotFound = status?.phase === 'done' && status.run.kind === 'not_found';
  // The name search opens when there is no usable number, when a find came back not found, or once a search has run.
  const searchOpen = !lookupable || findNotFound || searchStatus !== null;

  let note: { tone: 'info' | 'warn'; text: string } | null = null;
  if (running) note = { tone: 'info', text: AMEND_FIND_COPY.looking };
  else if (status?.phase === 'done' && status.run.kind === 'error')
    note = { tone: 'warn', text: status.run.message };
  else if (status?.phase === 'done' && status.run.kind === 'not_found')
    note = { tone: 'warn', text: AMEND_FIND_COPY.notFound };
  else if (status?.phase === 'done' && status.run.kind === 'ambiguous')
    note = { tone: 'warn', text: AMEND_FIND_COPY.ambiguous };
  else if (!confirmationNumber) note = { tone: 'info', text: AMEND_FIND_COPY.noNumber };
  else if (!lookupable) note = { tone: 'warn', text: notHmsNumberNote(confirmationNumber) };
  else if (!threadId) note = { tone: 'info', text: AMEND_FIND_COPY.waitingThread };

  const searchHint = !searchClient ? AMEND_FIND_COPY.unavailable : !key ? AMEND_FIND_COPY.waitingThread : null;

  // The cancel view belongs to the booking it was started for: one email can show several bookings in turn.
  const cancelScope = key && foundNumber ? `${key}|${foundNumber}` : null;
  const cancelView = cancelScope ? (cancelViews[cancelScope] ?? null) : null;
  // The HMS arrival is the stay the cancel must match; the email's date is only a fallback.
  const cancelArrival = isoDayOf(stayText(stay?.arrival)) ?? isoDayOf(amendment.arrival);
  const cancelInput = foundNumber && cancelArrival ? { confirmation: foundNumber, arrival: cancelArrival } : null;
  const canPreviewCancel = Boolean(paneSave && cancelClient && cancelInput && key);

  const previewCancel = async () => {
    if (!cancelScope || !cancelClient || !cancelInput) return;
    const scope = cancelScope;
    setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'previewing' } }));
    try {
      const run = await cancelClient.previewCancel(cancelInput);
      setCancelViews((prev) => ({ ...prev, [scope]: viewAfterPreview(run, cancelInput.confirmation) }));
    } catch {
      setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'idle', note: AMEND_CANCEL_COPY.failed } }));
    }
  };

  // The commit must carry the digest of the preview it follows. Without one there is nothing to commit.
  const commitCancel = async (ready: Extract<CancelView, { kind: 'ready' }>) => {
    const previewDigest = ready.run.previewDigest;
    if (!cancelScope || !cancelClient || !cancelInput || !ready.reason || !previewDigest) return;
    const scope = cancelScope;
    setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'committing', run: ready.run, reason: ready.reason } }));
    try {
      const run = await cancelClient.commitCancel({ ...cancelInput, reason: ready.reason, previewDigest });
      setCancelViews((prev) => ({ ...prev, [scope]: viewAfterCommit(run, ready.run, cancelInput.confirmation) }));
    } catch {
      setCancelViews((prev) => ({ ...prev, [scope]: { kind: 'idle', note: AMEND_CANCEL_COPY.failed } }));
    }
  };

  // Cancel mail the pane can preview says so; otherwise the look-up footer stays.
  const footer =
    amendment.kind === 'cancel' && stay && foundNumber && canPreviewCancel
      ? AMEND_CANCEL_COPY.footerPreview
      : AMEND_FIND_COPY.footer;

  const chooseReason = (reason: string) => {
    if (!cancelScope) return;
    const scope = cancelScope;
    setCancelViews((prev) => {
      const view = prev[scope];
      if (!view || view.kind !== 'ready') return prev;
      return { ...prev, [scope]: { ...view, reason } };
    });
  };

  const ratePlan = stayText(stay?.ratePlan);
  const mealPlan = stayText(stay?.mealPlan);
  const grandTotal = stayText(stay?.grandTotal);

  return (
    <section aria-labelledby="amend-lookup-title" data-testid="amend-lookup-panel" className={panelClass}>
      <h3 id="amend-lookup-title" className="text-[13px] font-semibold text-[#1e293b]">
        {amendment.kind === 'cancel' ? 'Cancellation request' : 'Change to an existing booking'}
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <p className={headingClass}>What the guest asked</p>
          <AskRow label="Request" value={amendment.requestedChange ?? 'Not stated'} />
          <AskRow
            label="Confirmation"
            value={amendment.confirmationNumber ?? 'Not in the email'}
            actions={handoffNumber ? <HmsLinkActions confirmation={handoffNumber} /> : null}
          />
          <AskRow label="Guest last name" value={amendment.guestLastName ?? 'Not in the email'} />
          <AskRow label="Arrival" value={amendment.arrival ? formatStayDate(amendment.arrival) : 'Not stated'} />
          <AskRow label="Departure" value={amendment.departure ? formatStayDate(amendment.departure) : 'Not stated'} />
        </div>
        <div className="flex flex-col gap-2">
          <p className={headingClass}>Booking in HMS now</p>
          {stay ? (
            <>
              <HmsRow field="guest" label="Guest" value={stayGuest(stay) ?? 'Not shown'} wants={diff.guest} />
              <HmsRow field="arrival" label="Arrival" value={shownDate(stay.arrival)} wants={diff.arrival} />
              <HmsRow field="departure" label="Departure" value={shownDate(stay.departure)} wants={diff.departure} />
              {found?.arrivalMismatch ? (
                <p className="text-[11px] font-semibold text-amber-900">
                  {arrivalMismatchNote(found.arrivalMismatch)}
                </p>
              ) : null}
              <HmsRow field="status" label="Status" value={stayText(stay.status) ?? 'Not shown'} />
              <HmsRow field="room" label="Room" value={stayText(stay.roomType) ?? 'Not shown'} />
              {ratePlan ? <HmsRow field="rate-plan" label="Rate plan" value={ratePlan} /> : null}
              {mealPlan ? <HmsRow field="meal-plan" label="Meal plan" value={mealPlan} /> : null}
              {grandTotal ? <HmsRow field="grand-total" label="Grand total" value={grandTotal} /> : null}
              {found ? (
                <RunScreenshot
                  load={findClient?.screenshot ?? null}
                  runId={found.runId}
                  name={found.screenshots.includes('record.png') ? 'record.png' : null}
                  label={AMEND_FIND_COPY.seeBooking}
                  alt="What Nava saw on the HMS booking record"
                />
              ) : null}
            </>
          ) : (
            <p className="text-[11.5px] text-[#64748b]">{running ? 'Looking up…' : 'Nothing shown yet.'}</p>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {found ? null : (
          <>
            <button
              type="button"
              className={buttonClass}
              disabled={!canLookUp || busy}
              onClick={() => {
                if (key && threadId && hmsNumber) {
                  void runLookup(findClient, hmsNumber, findArrival, key);
                }
              }}
            >
              Find this booking in HMS
            </button>
            {lookupable ? null : (
              <p className="text-[10.5px] font-semibold text-amber-900">
                {AMEND_FIND_COPY.noHmsNumber}
              </p>
            )}
            <p className="text-[10.5px] text-[#64748b]">{AMEND_FIND_COPY.lookupWait}</p>
          </>
        )}
        <div aria-live="polite">
          {note ? <p className={note.tone === 'warn' ? warnNoteClass : infoNoteClass}>{note.text}</p> : null}
        </div>
      </div>
      {searchOpen ? (
        <GuestSearchSection
          key={`${key ?? 'none'}|${amendment.guestLastName ?? ''}|${amendment.arrival ?? ''}|${amendment.departure ?? ''}`}
          initial={{
            lastName: amendment.guestLastName?.trim() ?? '',
            arrival: amendment.arrival ?? '',
            departure: amendment.departure ?? '',
          }}
          canSearch={Boolean(key && searchClient)}
          hint={searchHint}
          busy={busy}
          status={searchStatus}
          onSearch={(form) => {
            if (key) void runSearch(searchClient, form, key);
          }}
          onPick={(row) => {
            if (key) void runLookup(findClient, row.confirmation, row.arrival, key);
          }}
        />
      ) : null}
      {amendment.kind === 'cancel' && stay && foundNumber ? (
        <CancelSection
          view={cancelView}
          canPreview={canPreviewCancel}
          offNote={paneSave ? cancelManualSteps(foundNumber) : cancelSwitchedOffNote(foundNumber)}
          confirmation={foundNumber}
          guestName={stayGuest(stay) ?? amendment.guestLastName ?? 'this guest'}
          client={cancelClient}
          onPreview={() => void previewCancel()}
          onReason={chooseReason}
          onCommit={() => {
            if (cancelView?.kind === 'ready') void commitCancel(cancelView);
          }}
        />
      ) : null}
      <p className={captionClass}>{footer}</p>
    </section>
  );
}

/** Find by surname and arrival, for an email with no usable booking number. Prefilled from the email, editable. */
function GuestSearchSection({
  initial,
  canSearch,
  hint,
  busy,
  status,
  onSearch,
  onPick,
}: {
  initial: SearchForm;
  canSearch: boolean;
  hint: string | null;
  busy: boolean;
  status: SearchStatus | null;
  onSearch: (form: SearchForm) => void;
  onPick: (row: GuestSearchRow) => void;
}) {
  const [form, setForm] = useState<SearchForm>(initial);
  const surnameId = useId();
  const arrivalId = useId();
  const departureId = useId();
  const searching = status?.phase === 'running';
  const run = status?.phase === 'done' ? status.run : null;

  return (
    <div data-testid="amend-guest-search" className="flex flex-col gap-2">
      <p className={headingClass}>Find by guest name</p>
      <p className={captionClass}>{AMEND_FIND_COPY.searchIntro}</p>
      <div className="grid grid-cols-3 gap-2">
        <label htmlFor={surnameId} className="flex flex-col gap-1">
          <span className={headingClass}>Guest surname</span>
          <input
            id={surnameId}
            type="text"
            className={selectClass}
            value={form.lastName}
            disabled={searching}
            onChange={(event) => setForm((prev) => ({ ...prev, lastName: event.target.value }))}
          />
        </label>
        <label htmlFor={arrivalId} className="flex flex-col gap-1">
          <span className={headingClass}>Arrival</span>
          <input
            id={arrivalId}
            type="date"
            className={selectClass}
            value={form.arrival}
            disabled={searching}
            onChange={(event) => setForm((prev) => ({ ...prev, arrival: event.target.value }))}
          />
        </label>
        <label htmlFor={departureId} className="flex flex-col gap-1">
          <span className={headingClass}>Departure (optional)</span>
          <input
            id={departureId}
            type="date"
            className={selectClass}
            value={form.departure}
            disabled={searching}
            onChange={(event) => setForm((prev) => ({ ...prev, departure: event.target.value }))}
          />
        </label>
      </div>
      <button
        type="button"
        className={buttonClass}
        disabled={!canSearch || busy}
        onClick={() => onSearch(form)}
      >
        {AMEND_FIND_COPY.searchButton}
      </button>
      {hint ? <p className={captionClass}>{hint}</p> : null}
      <div aria-live="polite" className="flex flex-col gap-2">
        {searching ? <p className={infoNoteClass}>{AMEND_FIND_COPY.searching}</p> : null}
        {run ? <SearchResult run={run} busy={busy} onPick={onPick} /> : null}
      </div>
    </div>
  );
}

function SearchResult({
  run,
  busy,
  onPick,
}: {
  run: HmsSearchRun;
  busy: boolean;
  onPick: (row: GuestSearchRow) => void;
}) {
  if (run.kind === 'rows') {
    return (
      <div className="flex flex-col gap-2">
        <ul aria-label="Bookings found in HMS" className="flex flex-col gap-1.5">
          {run.rows.map((row) => (
            <li key={row.confirmation}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(row)}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-xs border border-[#e2e8f0] bg-white px-2.5 py-2 text-left text-[12px] text-[#1e293b] hover:border-[#0066cc] disabled:cursor-not-allowed disabled:text-[#94a3b8]"
              >
                <span className="font-semibold text-[#0066cc]">{row.confirmation}</span>
                <span>{rowGuest(row)}</span>
                <span className="text-[#64748b]">{stayText(row.status) ?? 'Status not shown'}</span>
                <span className="text-[#64748b]">{rowDates(row)}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className={captionClass}>{AMEND_FIND_COPY.searchPick}</p>
      </div>
    );
  }
  const text =
    run.kind === 'none'
      ? noSearchMatchCopy(run.lastName, run.arrival)
      : run.kind === 'capped'
        ? AMEND_FIND_COPY.searchCapped
        : run.message;
  return <p className={warnNoteClass}>{text}</p>;
}

function rowGuest(row: GuestSearchRow): string {
  return [stayText(row.firstName), stayText(row.lastName)].filter(Boolean).join(' ') || 'Name not shown';
}

function rowDates(row: GuestSearchRow): string {
  const arrival = row.arrival ? formatStayDate(row.arrival) : 'Not shown';
  const departure = row.departure ? formatStayDate(row.departure) : 'Not shown';
  return `${arrival} to ${departure}`;
}

function shownDate(value: string | null): string {
  const text = stayText(value);
  return text ? formatStayDate(text) : 'Not shown';
}

function AskRow({ label, value, actions }: { label: string; value: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className={headingClass}>{label}</p>
      <p className={valueClass}>{value}</p>
      {actions ? <div className="pt-0.5">{actions}</div> : null}
      <p className={captionClass}>From the email</p>
    </div>
  );
}

function HmsRow({
  field,
  label,
  value,
  wants,
  actions,
}: {
  field: string;
  label: string;
  value: string;
  wants?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      data-field={field}
      data-differs={wants ? 'true' : 'false'}
      className={`flex flex-col gap-0.5 ${wants ? differClass : ''}`}
    >
      <p className={headingClass}>{label}</p>
      <p className={valueClass}>{value}</p>
      {actions ? <div className="pt-0.5">{actions}</div> : null}
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
  return (
    <RunScreenshot
      load={client?.paneStayScreenshot ?? null}
      runId={run.runId}
      name={run.screenshots.at(-1) ?? null}
      label={AMEND_CANCEL_COPY.seeScreenshot}
      alt="What Nava saw on the HMS cancel screen"
    />
  );
}

/** One screenshot of a run as a thumbnail, with a full-size overlay. Renders nothing until the bytes load. */
function RunScreenshot({
  load,
  runId,
  name,
  label,
  alt,
}: {
  load: ((input: ScreenshotInput) => Promise<ScreenshotReply>) | null;
  runId: string | null;
  name: string | null;
  label: string;
  alt: string;
}) {
  const [image, setImage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setImage(null);
    if (!load || !runId || !name) return;
    let live = true;
    load({ runId, name })
      .then((reply) => {
        if (live && reply.status === 'ok') setImage(reply.dataUrl);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [load, name, runId]);

  if (!image) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 self-start text-left">
        <img src={image} alt="" className="h-16 w-auto rounded-xs border border-[#e2e8f0]" />
        <span className="text-[11.5px] font-medium text-[#0066cc]">{label}</span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-4"
        >
          <img src={image} alt={alt} className="max-h-[85vh] max-w-full rounded-sm bg-white" />
          <button type="button" className={buttonClass} onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : null}
    </>
  );
}
