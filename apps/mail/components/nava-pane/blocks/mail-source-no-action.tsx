import { OtaBookingChannelChip } from './ota-booking-channel-chip';

/** Plain, accurate no-action copy per source; never claims whether a payment or booking exists. */
const NO_ACTION_COPY: Record<string, string> = {
  'Nedbank e-pay':
    'automated bank payment notice. There is nothing for Nava to book, change or file. Check the bank account or HMS if you need the payment itself.',
};

export function MailSourceNoActionCard({
  kind,
  source,
  voucherLookupOnly = false,
}: {
  kind: 'channel' | 'system';
  source: string;
  /** An already-classified payment email may still use the read-only voucher lookup. */
  voucherLookupOnly?: boolean;
}) {
  const copy =
    NO_ACTION_COPY[source] ??
    `managed in the channel/extranet. ${voucherLookupOnly
      ? 'Nava will not create or change a booking from this message. Payment lookup below only reads HMS.'
      : 'Nava takes no action.'}`;
  return (
    <section
      role="status"
      aria-label={`${source} message — no Nava action`}
      data-testid="mail-source-no-action"
      className="flex flex-col gap-2 rounded-[4px] border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2.5"
    >
      <p className="text-[13px] leading-5 text-[#475569]">
        <span className="font-semibold text-[#1e293b]">{source} message</span> — {copy}
      </p>
      {kind === 'channel' ? <OtaBookingChannelChip source={source} /> : null}
    </section>
  );
}
