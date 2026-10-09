import { AmendLookupPanel } from '@/components/quote-workflow/amend-lookup-panel';
import { VoucherFindCard } from '@/components/quote-workflow/voucher-find-card';
import type { QuoteSession } from '@/lib/quote-workflow/types';
import { trpcClient } from '@/providers/query-provider';

/**
 * Booking and voucher block: the change or cancellation card for an existing booking, then the Find the booking
 * card for a voucher email. The card is keyed by the email, so it resets on a selection change.
 */
export function BookingVoucherCard({
  session,
  internetMessageId,
  syncCommitted,
  syncPending,
}: {
  session: QuoteSession;
  internetMessageId: string | null;
  syncCommitted: number | null;
  syncPending: boolean;
}) {
  return (
    <>
      <AmendLookupPanel session={session} trpc={trpcClient} />
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
