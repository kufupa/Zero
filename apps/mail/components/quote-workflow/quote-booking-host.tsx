import { Fragment, useState } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { isMultiStay, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import type { BookingDraftReady, QuoteSession } from '@/lib/quote-workflow/types';
import { appliedSavedStayIds, BookingCards, SavedStayReceipt, type SavedStayCommit } from './booking-card';
import { saveConfirmationDefault, useConfirmationSources, type ConfirmationSetting } from './confirmation-recipient';
import { guestEditorKeyFor, stayingGuestName } from './quote-people-step';

export function QuoteBookingHost({
  session,
  paneSave,
  contact,
  workItemId,
  savedStays,
  screenshot,
  propertyCode,
  onSaveDefault,
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
  const prepared = (session.preparedStaffTasks ?? []).flatMap(task => {
    const suggestion = task.bookingSuggestion;
    if (!suggestion || task.earlier || task.handled || !task.runId || !workItemId ||
        task.workItemId !== workItemId || !session.binding || !session.staffSource ||
        suggestion.selectedMessageId !== session.staffSource.messageId ||
        (suggestion.source.sourceRef === `message:${suggestion.selectedMessageId}` &&
          suggestion.source.sourceHash !== session.staffSource.sourceHash)) return [];
    const draft: BookingDraftReady = {
      draft: suggestion.draft, options: suggestion.options,
      messageId: suggestion.selectedMessageId, selectionEpoch: session.binding.selectionEpoch,
      inputRevision: session.inputRevision, revisionRef: 'unquoted',
    };
    // A changed source prefill must invalidate old form edits and preview receipts.
    const key = `${requestKey}:${suggestion.groupId}:${JSON.stringify([suggestion.draft, suggestion.options])}`;
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
          {open ? <>
            <p className="text-xs text-muted-foreground">Check the request and current HMS availability before booking.</p>
            {suggestion.missing.map((missing, index) => <p key={`${index}:${missing}`} className="text-xs">{missing}</p>)}
            <BookingCards draft={draft} groups={[]} paneSave={paneSave} workItemId={workItemId}
              savedStays={savedStays} screenshot={screenshot ?? paneSave?.screenshot}
              propertyCode={propertyCode} confirmation={confirmation}
              onSaveDefault={onSaveDefault ?? saveConfirmationDefault} />
          </> : null}
        </div>
      ))}
      {uncoveredStays.map(([stayId, saved]) => (
        <SavedStayReceipt key={stayId} saved={saved} screenshot={screenshot ?? paneSave?.screenshot} />
      ))}
    </>
  );
}
