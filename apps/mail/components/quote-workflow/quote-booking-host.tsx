import { Fragment, useCallback, useRef, useState } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import type { HmsJobTransport } from '@/lib/quote-workflow/amend-find';
import type { PartyFinder, PartyIndexSearcher } from '@/lib/quote-workflow/party-lookup';
import { isMultiStay, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import type { BookingDraftReady, QuoteSession, ReservationistBookingSuggestion, StaffQuoteParties } from '@/lib/quote-workflow/types';
import { paneFieldClass } from '@/components/nava-pane/pane-ui';
import { appliedSavedStayIds, BookingCards, SavedStayReceipt, type SavedStayCommit } from './booking-card';
import { saveConfirmationDefault, useConfirmationSources, type ConfirmationSetting } from './confirmation-recipient';
import { guestEditorKeyFor, stayingGuestName } from './quote-people-step';
import { PartyPicker } from './party-picker';

function PreparedBookingForm({ suggestion, draft, paneSave, contact, workItemId, savedStays, screenshot, propertyCode,
  onSaveDefault, findParty, partyIndex, partyJobTransport, threadId, onCommitLockChange }: {
  suggestion: ReservationistBookingSuggestion;
  draft: BookingDraftReady;
  paneSave?: PaneStayClient | null;
  contact?: StoredContact | null;
  workItemId?: string;
  savedStays?: Record<string, SavedStayCommit>;
  screenshot?: PaneStayClient['screenshot'] | null;
  propertyCode?: string | null;
  onSaveDefault?: (setting: ConfirmationSetting) => Promise<void>;
  findParty?: PartyFinder | null;
  partyIndex?: PartyIndexSearcher | null;
  partyJobTransport?: HmsJobTransport | null;
  threadId?: string | null;
  onCommitLockChange?: (locked: boolean) => void;
}) {
  const [kind, setKind] = useState<'' | 'agency' | 'company' | 'none'>(suggestion.partyNames.length ? '' : 'none');
  const [parties, setParties] = useState<StaffQuoteParties>({});
  const [partyLocked, setPartyLocked] = useState(false);
  const partyLockedRef = useRef(false), kindRef = useRef(kind);
  kindRef.current = kind;
  const setPartyLock = useCallback((locked: boolean) => { partyLockedRef.current = locked; setPartyLocked(locked); onCommitLockChange?.(locked); }, [onCommitLockChange]);
  const selected = kind === 'agency' || kind === 'company' ? parties[kind] : undefined;
  const multipleParties = suggestion.partyNames.length > 1;
  const ready = !multipleParties && (kind === 'none' || Boolean(selected?.nativeId));
  const stay = draft.draft.rooms[0]?.request;
  return <>
    {stay?.arrival && stay.departure ? <p className="text-xs">Stay: {String(stay.arrival)} – {String(stay.departure)}</p> : null}
    {multipleParties ? <p className="text-xs">Multiple parties were mentioned. Check which applies in HMS before booking.</p> :
    suggestion.partyNames.length ? <>
      <label className="flex flex-col gap-1 text-xs">Company or agency mentioned: {suggestion.partyNames[0]}
        <select aria-label="Party for this booking" className={paneFieldClass} value={kind} disabled={partyLocked} onChange={event => {
          if (partyLockedRef.current) return;
          setKind(event.target.value as typeof kind); setParties({});
        }}>
          <option value="">Choose how this party applies</option>
          <option value="agency">Booking agency</option>
          <option value="company">Company</option>
          <option value="none">No linked agency or company</option>
        </select>
      </label>
      {kind === 'agency' || kind === 'company' ? findParty ? <fieldset disabled={partyLocked}><PartyPicker key={kind}
        name={suggestion.partyNames[0]!} kind={kind} parties={parties} find={findParty}
        indexSearch={partyIndex} jobTransport={partyJobTransport} threadId={threadId}
        sourceMessageId={suggestion.selectedMessageId} propertyCode={propertyCode}
        onPick={party => { if (!partyLockedRef.current && party.kind === kindRef.current) setParties(current => ({ ...current, [party.kind]: party })); }}
        onClear={cleared => { if (!partyLockedRef.current && cleared === kindRef.current) setParties(current => ({ ...current, [cleared]: undefined })); }} />
      </fieldset>
        : <p className="text-xs">HMS party lookup is unavailable; check the party in HMS.</p> : null}
    </> : null}
    {kind === 'company' && selected ? <p className="text-xs">Check the company in HMS; this booking card is copy-only.</p> : null}
    {ready ? <BookingCards key={`${kind}:${selected?.nativeId ?? ''}`} draft={draft} groups={[]} paneSave={kind === 'company' ? null : paneSave} contact={contact}
      workItemId={workItemId} savedStays={savedStays} screenshot={screenshot ?? paneSave?.screenshot}
      propertyCode={propertyCode} parties={parties} onSaveDefault={onSaveDefault ?? saveConfirmationDefault} onCommitLockChange={setPartyLock} /> :
      appliedSavedStayIds(draft, [], savedStays).map(id => <SavedStayReceipt key={id} saved={savedStays![id]!}
        screenshot={screenshot ?? paneSave?.screenshot} />)}
  </>;
}

export function QuoteBookingHost({
  session,
  paneSave,
  contact,
  workItemId,
  savedStays,
  screenshot,
  propertyCode,
  onSaveDefault,
  findParty,
  partyIndex,
  partyJobTransport,
}: {
  session: QuoteSession;
  paneSave?: PaneStayClient | null;
  contact?: StoredContact | null;
  workItemId?: string;
  savedStays?: Record<string, SavedStayCommit>;
  /** Reads a stored screenshot when Book writes are off. */
  screenshot?: PaneStayClient['screenshot'] | null;
  propertyCode?: string | null;
  onSaveDefault?: (setting: ConfirmationSetting) => Promise<void>;
  findParty?: PartyFinder | null;
  partyIndex?: PartyIndexSearcher | null;
  partyJobTransport?: HmsJobTransport | null;
}) {
  const confirmation = useConfirmationSources();
  const requestKey = JSON.stringify([
    session.binding?.transportId,
    session.binding?.storeId,
    session.binding?.folderEntryId,
    session.binding?.entryId,
    session.binding?.selectionEpoch,
    session.binding?.scopeEpoch,
    workItemId,
  ]);

  const shownDrafts = requestedQuoteKeys(session.groups).filter((key) => session.bookingDrafts[key]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [bookingLocked, setBookingLocked] = useState<Record<string, boolean>>({});
  const setBookingLock = useCallback((key: string, locked: boolean) => {
    setBookingLocked(current => Boolean(current[key]) === locked ? current : { ...current, [key]: locked });
  }, []);
  const prepared = (session.preparedStaffTasks ?? []).flatMap(task => {
    const suggestion = task.bookingSuggestion;
    if (!suggestion || task.earlier || !task.runId || !workItemId ||
        task.workItemId !== workItemId || !session.binding || !session.staffSource ||
        suggestion.selectedMessageId !== session.staffSource.messageId ||
        suggestion.source.sourceRef !== `message:${suggestion.selectedMessageId}` ||
        suggestion.staffSourceHash !== session.staffSource.sourceHash) return [];
    const draft: BookingDraftReady = {
      draft: suggestion.draft, options: suggestion.options,
      messageId: suggestion.selectedMessageId, selectionEpoch: session.binding.selectionEpoch,
      inputRevision: session.inputRevision, revisionRef: 'unquoted',
    };
    // A changed source prefill must invalidate old form edits and preview receipts.
    const key = `${requestKey}:${task.runId}:${task.id}:${suggestion.groupId}:${suggestion.staffSourceHash}:${JSON.stringify([suggestion.draft, suggestion.options, suggestion.partyNames])}`;
    if (task.handled && !bookingLocked[key]) return [];
    return [{ task, suggestion, draft, key, open: expanded[key] ?? (shownDrafts.length === 0) }];
  });
  const coveredStayIds = new Set(
    [
      ...shownDrafts.flatMap((key) => appliedSavedStayIds(session.bookingDrafts[key]!, session.groups, savedStays)),
      ...prepared.filter(row => row.open).flatMap(row => appliedSavedStayIds(row.draft, [], savedStays)),
    ],
  );
  const uncoveredStays = Object.entries(savedStays ?? {}).filter(([stayId]) => !coveredStayIds.has(stayId));

  return (
    <>
      {shownDrafts.map((key) => (
          <Fragment key={`${requestKey}:${key}`}>
            {isMultiStay(session) ? (
              <p className="text-[13px] font-semibold text-[#475569]">Booking for {key.replace(':', ' → ')}</p>
            ) : null}
            <BookingCards
              draft={session.bookingDrafts[key]!}
              groups={session.groups}
              paneSave={paneSave}
              contact={contact}
              workItemId={workItemId}
              savedStays={savedStays}
              screenshot={screenshot ?? paneSave?.screenshot}
              parties={session.staffHeader.parties}
              guestName={stayingGuestName(session, contact ?? null)}
              guestEditorKey={guestEditorKeyFor(session)}
              session={session}
              propertyCode={propertyCode}
              confirmation={confirmation}
              onSaveDefault={onSaveDefault ?? saveConfirmationDefault}
            />
          </Fragment>
        ))}
      {prepared.map(({ task, suggestion, draft, key, open }) => (
        <div key={key} className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
          <button type="button" className="text-left text-sm font-semibold underline" aria-expanded={open}
            onClick={() => setExpanded(current => ({ ...current, [key]: !open }))}>
            {open ? 'Hide' : 'Review'} booking from request
          </button>
          {task.details.find(detail => detail.startsWith('Request: ')) ?
            <p className="text-xs">{task.details.find(detail => detail.startsWith('Request: '))}</p> : null}
          {shownDrafts.length ? <p className="text-xs text-muted-foreground">Another booking card is open. Check it before making another booking.</p> : null}
          <div hidden={!open}>
            <p className="text-xs text-muted-foreground">Check the request and current HMS availability before booking.</p>
            {suggestion.missing.map((missing, index) => <p key={`${index}:${missing}`} className="text-xs">{missing}</p>)}
            <PreparedBookingForm suggestion={suggestion} draft={draft} paneSave={paneSave} contact={contact} workItemId={workItemId}
              savedStays={savedStays} screenshot={screenshot} propertyCode={propertyCode} onSaveDefault={onSaveDefault}
              findParty={findParty} partyIndex={partyIndex} partyJobTransport={partyJobTransport}
              threadId={session.staffSource?.threadId} onCommitLockChange={locked => setBookingLock(key, locked)} />
          </div>
        </div>
      ))}
      {uncoveredStays.map(([stayId, saved]) => (
        <SavedStayReceipt key={stayId} saved={saved} screenshot={screenshot ?? paneSave?.screenshot} />
      ))}
    </>
  );
}
