import { AmendLookupPanel } from '@/components/quote-workflow/amend-lookup-panel';
import { VoucherFindCard } from '@/components/quote-workflow/voucher-find-card';
import { ApproveCard } from '@/components/quote-workflow/approve-card';
import { hmsApprovalFromTrpc } from '@/lib/quote-workflow/hms-write';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { amendmentOf } from '@/lib/quote-workflow/session';
import type { NavaReadAs } from '@/lib/quote-workflow/workflow-vocabulary';
import { otaBookingChannel } from '@/lib/quote-workflow/ota-channel';
import { trpcClient } from '@/providers/query-provider';
import { OtaBookingChannelChip } from './ota-booking-channel-chip';

const HMS_APPROVAL_CLIENT = hmsApprovalFromTrpc(trpcClient);

/**
 * Booking and voucher block: the read-only change or cancellation lookup, approval and review for non-amend work items
 * that hold an HMS write, then the Find the booking card for voucher email. Each card resets on a selection change.
 */
export function BookingVoucherCard({
  session,
  internetMessageId,
  syncCommitted,
  syncPending,
  readAs = null,
  workItemId = null,
  writesEnabled = false,
  senderEmail = null,
  subject = null,
  bodyText = null,
}: {
  session: QuoteSession;
  internetMessageId: string | null;
  syncCommitted: number | null;
  syncPending: boolean;
  /** Shared selected-email classification; payment mails need voucher lookup even when the older workflow is `other`. */
  readAs?: NavaReadAs | null;
  /** The stored work item for the selected mail. The write attaches to it. */
  workItemId?: string | null;
  /** Attach/approve writes. Labtest-only; create mode never turns this on. Lookup stays available when off. */
  writesEnabled?: boolean;
  senderEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}) {
  const amendment = amendmentOf(session);
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
      <AmendLookupPanel session={session} trpc={trpcClient} />
      {/* Amendments keep their read-only Find panel; this write card is only for non-amend stored work. */}
      {workItemId && !amendment ? (
        <ApproveCard
          key={workItemId}
          client={HMS_APPROVAL_CLIENT}
          workItemId={workItemId}
          writesEnabled={writesEnabled}
          confirmation={null}
          guestSurname={guestSurname}
          arrival={arrival}
          requireStoredWrite
        />
      ) : null}
      {showVoucherFindCard ? (
        <VoucherFindCard
          key={internetMessageId ?? 'no-email'}
          internetMessageId={internetMessageId}
          trpc={trpcClient}
          syncCommitted={syncCommitted}
          syncPending={syncPending}
          workItemId={workItemId}
          writesEnabled={writesEnabled}
        />
      ) : null}
    </>
  );
}
