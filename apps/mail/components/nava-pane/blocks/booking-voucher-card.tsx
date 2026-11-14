import { AmendLookupPanel, type AmendReadOnlyContext } from '@/components/quote-workflow/amend-lookup-panel';
import { VoucherFindCard } from '@/components/quote-workflow/voucher-find-card';
import { ApproveCard } from '@/components/quote-workflow/approve-card';
import { hmsApprovalFromTrpc } from '@/lib/quote-workflow/hms-write';
import type { MailSourceSelection } from '@/lib/quote-workflow/backend-bind';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { amendmentOf } from '@/lib/quote-workflow/session';
import type { NavaReadAs } from '@/lib/quote-workflow/workflow-vocabulary';
import { otaBookingChannel } from '@/lib/quote-workflow/ota-channel';
import { trpcClient } from '@/providers/query-provider';
import { useMemo, useState } from 'react';
import { OtaBookingChannelChip } from './ota-booking-channel-chip';

/**
 * Booking and voucher block: the read-only change or cancellation lookup, approval and review for non-amend work items
 * that hold an HMS write, then the Find the booking card for voucher email. Each card resets on a selection change.
 */
export function BookingVoucherCard({
  session,
  internetMessageId,
  lookupSelection,
  syncCommitted,
  syncPending,
  readAs = null,
  workItemId = null,
  writesEnabled = false,
  propertyCode = null,
  filingCapability,
  transportId = null,
  mailboxScope = null,
  senderEmail = null,
  subject = null,
  bodyText = null,
  amendPropertyResolved = true,
  readOnlyAmend = null,
}: {
  session: QuoteSession;
  internetMessageId: string | null;
  lookupSelection?: MailSourceSelection;
  syncCommitted: number | null;
  syncPending: boolean;
  /** Shared selected-email classification; payment mails need voucher lookup even when the older workflow is `other`. */
  readAs?: NavaReadAs | null;
  /** The stored work item for the selected mail. The write attaches to it. */
  workItemId?: string | null;
  /** Attach/approve writes. Labtest-only; create mode never turns this on. Lookup stays available when off. */
  writesEnabled?: boolean;
  /** Registry-backed property for the active mailbox. */
  propertyCode?: string | null;
  filingCapability?: import('@/lib/reservation-workflow/types').PropertyConfiguration['capabilities']['attach'] | null;
  transportId?: string | null;
  mailboxScope?: string | null;
  senderEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  amendPropertyResolved?: boolean;
  readOnlyAmend?: AmendReadOnlyContext | null;
}) {
  const selectedSource = session.staffSource;
  const approvalClient = useMemo(
    () => hmsApprovalFromTrpc(trpcClient, transportId, internetMessageId, selectedSource),
    [transportId, internetMessageId, selectedSource?.threadId, selectedSource?.messageId, selectedSource?.sourceHash],
  );
  const amendment = amendmentOf(session);
  const [approvalRevision, setApprovalRevision] = useState(0);
  const [preparedFiling, setPreparedFiling] = useState<{ scope: string; digest: string | null } | null>(null);
  const filingScope = JSON.stringify([mailboxScope, propertyCode, filingCapability?.status ?? null, transportId, internetMessageId, lookupSelection, workItemId,
    session.binding?.selectionEpoch, selectedSource?.threadId, selectedSource?.messageId, selectedSource?.sourceHash,
    readOnlyAmend?.historyEpoch, readOnlyAmend?.historyBusy]);
  const filingSourceCurrent = Boolean(selectedSource && readOnlyAmend?.selectionCurrent !== false &&
    !readOnlyAmend?.sourceContentChanged && !readOnlyAmend?.historyBusy);
  const intent = session.treatAs ?? session.analysis?.luna?.workflow;
  const hasBookingWorkflow = intent === 'create_booking';
  const showVoucherFindCard = readAs === 'payment' || hasBookingWorkflow || amendment !== null;
  const ota = amendment || hasBookingWorkflow ? otaBookingChannel({ senderEmail, subject, bodyText }) : null;
  const lunaGroups = session.analysis?.luna?.groups ?? [];
  const guestName = lunaGroups.flatMap((group) => group.guestNames).find((name) => name.trim());
  const guestNameParts = guestName?.trim().split(/\s+/).filter(Boolean) ?? [];
  const guestSurname =
    amendment?.guestLastName ?? (guestNameParts.length > 1 ? guestNameParts.at(-1) : null);
  // On an amendment the luna groups hold the requested dates, so only the booked arrival (null when the mail does not
  // state it) goes to HMS. The requested arrival never stands in for it.
  const arrival = amendment ? amendment.arrival : lunaGroups.find((group) => group.arrival)?.arrival;
  return (
    <>
      {ota ? (
        <OtaBookingChannelChip source={ota} />
      ) : null}
      {!amendPropertyResolved && amendment ? (
        <p role="status" className="text-[11.5px] text-[#64748b]">Nava cannot confirm the property yet. Open the booking in HMS.</p>
      ) : null}
      {readOnlyAmend?.sourceContentChanged && amendment ? (
        <p role="status" className="text-[11.5px] text-[#64748b]">This email changed. Reopen it before reviewing the booking.</p>
      ) : null}
      {!readOnlyAmend?.sourceContentChanged && readOnlyAmend?.sourceSelectionUnavailable && amendment ? (
        <p role="status" className="text-[11.5px] text-[#64748b]">Select this guest email in webmail before reviewing the booking.</p>
      ) : null}
      {!amendPropertyResolved || readOnlyAmend?.selectionCurrent === false ? null : (
        <AmendLookupPanel
          key={readOnlyAmend ? JSON.stringify([session.binding?.transportId, session.binding?.selectionEpoch,
            session.staffSource?.threadId, session.staffSource?.messageId, session.staffSource?.sourceHash]) : undefined}
          session={session} trpc={trpcClient} readOnlyAmend={readOnlyAmend} workItemId={workItemId}
        />
      )}
      {/* An amendment email can also contain a voucher; its filing card must only show a filing form. */}
      {workItemId && mailboxScope && transportId && internetMessageId ? (
        <ApproveCard
          key={JSON.stringify([mailboxScope, transportId, internetMessageId, lookupSelection, workItemId, approvalRevision,
            session.binding?.selectionEpoch, session.staffSource?.threadId, session.staffSource?.messageId, session.staffSource?.sourceHash])}
          client={approvalClient}
          workItemId={workItemId}
          writesEnabled={writesEnabled && ((propertyCode === 'HRCEN' && filingCapability === undefined) || filingCapability?.status === 'lab' || filingCapability?.status === 'staff-enabled')}
          confirmation={null}
          guestSurname={guestSurname}
          arrival={arrival}
          requireStoredWrite
          requiredAction={amendment ? 'attach_document' : undefined}
          filingApprovalAllowed={filingSourceCurrent && preparedFiling?.scope === filingScope}
          filingReviewAllowed={filingSourceCurrent}
          filingApprovalDigest={preparedFiling?.scope === filingScope ? preparedFiling.digest : null}
        />
      ) : null}
      {showVoucherFindCard ? (
        <VoucherFindCard
          key={JSON.stringify([mailboxScope, transportId, internetMessageId, lookupSelection, session.binding?.selectionEpoch,
            selectedSource?.threadId, selectedSource?.messageId, selectedSource?.sourceHash,
            readOnlyAmend?.historyEpoch, readOnlyAmend?.historyBusy])}
          internetMessageId={internetMessageId}
          lookupSelection={lookupSelection}
          transportId={transportId}
          mailboxScope={mailboxScope}
          trpc={trpcClient}
          syncCommitted={syncCommitted}
          syncPending={syncPending}
          workItemId={workItemId}
          writesEnabled={writesEnabled}
          approvalAvailable={Boolean(filingSourceCurrent && approvalClient && workItemId && mailboxScope && transportId && internetMessageId)}
          selectionEpoch={session.binding?.selectionEpoch}
          selectedSource={selectedSource ?? null}
          reviewSource={selectedSource}
          selectionCurrent={filingSourceCurrent}
          onTargetChanged={() => setPreparedFiling(null)}
          onPrepared={(digest) => { setPreparedFiling({ scope: filingScope, digest: digest ?? null }); setApprovalRevision((revision) => revision + 1); }}
          propertyCode={propertyCode}
          filingCapability={filingCapability}
        />
      ) : null}
    </>
  );
}
