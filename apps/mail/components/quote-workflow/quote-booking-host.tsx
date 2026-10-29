import { Fragment, useRef, useState } from 'react';
import type { StoredContact } from '@/lib/quote-workflow/backend-bind';
import type { PaneStayClient } from '@/lib/quote-workflow/pane-stay-bind';
import { isMultiStay, requestedQuoteKeys } from '@/lib/quote-workflow/session';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { BookingCards, rememberSavedStays, SavedStayReceipt, type SavedStayCommit } from './booking-card';
import { saveConfirmationDefault, useConfirmationSources, type ConfirmationSetting } from './confirmation-recipient';
import { guestEditorKeyFor, stayingGuestName } from './quote-people-step';

type ReceiptUpdate = { receipt: SavedStayCommit | null; snapshot?: SavedStayCommit };

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
  // Receipts belong to the work item, not a date heading or a mutable guest card.
  const receiptScope = workItemId ? JSON.stringify([session.binding?.transportId, workItemId]) : requestKey;
  const savedCache = useRef<Record<string, Record<string, SavedStayCommit>>>(Object.create(null));
  const cachedStays = savedCache.current[receiptScope] ??= Object.create(null) as Record<string, SavedStayCommit>;
  rememberSavedStays(cachedStays, savedStays);
  const [updatesByScope, setUpdatesByScope] = useState<Record<string, Record<string, ReceiptUpdate>>>({});
  const updates = updatesByScope[receiptScope] ?? {};
  const superseded = (id: string, saved: SavedStayCommit): boolean => {
    const update = updates[id];
    if (!update || saved.status !== 'unknown' || update.snapshot !== saved) return false;
    if (!update.receipt) return !saved.confirmationNumber;
    if (saved.confirmationNumber && saved.confirmationNumber !== update.receipt.confirmationNumber) return false;
    return update.receipt.status === 'booked' ||
      Boolean((update.receipt.confirmationNumber && !saved.confirmationNumber) || (update.receipt.cmsReason && !saved.cmsReason));
  };
  const visibleStays = Object.fromEntries(Object.entries(cachedStays).filter(([id, saved]) => !superseded(id, saved)));
  const recent = Object.entries(updates).filter(([id, update]) => {
    const saved = visibleStays[id];
    if (saved?.status === 'booked' && saved.confirmationNumber && update.receipt?.status === 'unknown' &&
      saved.confirmationNumber === update.receipt.confirmationNumber) return false;
    return update.receipt && !(saved && saved.status === update.receipt.status &&
      saved.confirmationNumber === update.receipt.confirmationNumber &&
      (!update.receipt.cmsReason || saved.cmsReason === update.receipt.cmsReason));
  });
  const guardStays = { ...visibleStays };
  for (const [id, update] of Object.entries(updates)) {
    if (update.receipt && !guardStays[id]) guardStays[id] = update.receipt;
  }

  const shownDrafts = requestedQuoteKeys(session.groups).filter((key) => session.bookingDrafts[key]);

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
              savedStays={guardStays}
              screenshot={screenshot ?? paneSave?.screenshot}
              parties={session.staffHeader.parties}
              guestName={stayingGuestName(session, contact ?? null)}
              guestEditorKey={guestEditorKeyFor(session)}
              session={session}
              propertyCode={propertyCode}
              confirmation={confirmation}
              onSaveDefault={onSaveDefault ?? saveConfirmationDefault}
              onReceipt={(stayId, receipt, snapshot) => setUpdatesByScope((current) => ({
                ...current, [receiptScope]: { ...current[receiptScope], [stayId]: { receipt, snapshot } },
              }))}
            />
          </Fragment>
        ))}
      {Object.keys(visibleStays).length || recent.length ? (
        <section aria-label="Booking outcomes">
          <p>Check the guest in HMS before using a confirmation.</p>
          {Object.entries(visibleStays).map(([stayId, saved]) => (
            <SavedStayReceipt key={stayId} saved={saved} screenshot={screenshot ?? paneSave?.screenshot} />
          ))}
          {recent.map(([stayId, update]) => update.receipt && (
            <SavedStayReceipt key={`recent:${stayId}`} saved={update.receipt} screenshot={screenshot ?? paneSave?.screenshot} />
          ))}
        </section>
      ) : null}
    </>
  );
}
