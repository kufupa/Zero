import { AmendLookupPanel } from '@/components/quote-workflow/amend-lookup-panel';
import { VoucherFindCard } from '@/components/quote-workflow/voucher-find-card';
import { ApproveCard } from '@/components/quote-workflow/approve-card';
import { hmsApprovalFromTrpc } from '@/lib/quote-workflow/hms-write';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { amendmentOf } from '@/lib/quote-workflow/session';
import { trpcClient } from '@/providers/query-provider';

const HMS_APPROVAL_CLIENT = hmsApprovalFromTrpc(trpcClient);

/**
 * Booking and voucher block: the change or cancellation card for an existing booking, its approve and review card once
 * the stored work item is ready (on any mail whose work item holds an HMS write, such as an attach), then the Find the
 * booking card for a voucher email. The card is keyed by the email, so
 * it resets on a selection change.
 */
export function BookingVoucherCard({
  session,
  internetMessageId,
  syncCommitted,
  syncPending,
  workItemId = null,
  writesEnabled = false,
}: {
  session: QuoteSession;
  internetMessageId: string | null;
  syncCommitted: number | null;
  syncPending: boolean;
  /** The stored work item for the selected mail. The write attaches to it. */
  workItemId?: string | null;
  /** The pane save flag. Off shows the handoff only, with no write controls. */
  writesEnabled?: boolean;
}) {
  const amendment = amendmentOf(session);
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
      <AmendLookupPanel session={session} trpc={trpcClient} />
      {/* Amend and cancel mail always shows the card. Other mail (an attach on a voucher) shows it from the stored write. */}
      {workItemId && (amendment || writesEnabled) ? (
        <ApproveCard
          key={workItemId}
          client={HMS_APPROVAL_CLIENT}
          workItemId={workItemId}
          writesEnabled={writesEnabled}
          confirmation={amendment?.confirmationNumber ?? null}
          guestSurname={guestSurname}
          arrival={arrival}
          requireStoredWrite={!amendment}
        />
      ) : null}
      <VoucherFindCard
        key={internetMessageId ?? 'no-email'}
        internetMessageId={internetMessageId}
        trpc={trpcClient}
        syncCommitted={syncCommitted}
        syncPending={syncPending}
      />
    </>
  );
}
