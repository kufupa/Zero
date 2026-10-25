import type { LunaAnalysisWire, QuoteAmendment } from '@/lib/quote-workflow/types';
import { Notice } from '@/components/nava-pane/pane-ui';

const FLAG_COPY: Record<LunaAnalysisWire['flags'][number], string> = {
  conference_or_group: 'Conference or group request (venue, day delegates, packages): handle it by hand.',
  rooms_only_group: 'Rooms-only group: quoting the number of rooms stated.',
  amendment_or_cancel: 'Changing or cancelling a booking is not supported yet. Handle it by hand in HMS.',
  long_stay: 'Stay over 30 nights: split it into shorter stays by hand.',
  discount_or_negotiation: 'Discount asked for: your decision is needed.',
  // Multi-stay (U20): one rate run per stay, then one combined proposal. Never one PDF per option.
  multi_date: 'Several stays: get rates for each one. Prepare quote puts every stay in one proposal.',
  extras: 'Extras were requested. Check each stay\'s extras in Stay before making the PDF.',
  mixed_request: 'Several requests in one email: check each one.',
  attachment_unread: 'An attachment could not be read. Open it in Outlook and check it.',
};

const TASK_KIND_WORDS: Record<LunaAnalysisWire['tasks'][number]['kind'], string> = {
  quote: 'a quote',
  create_booking: 'a booking',
  amend: 'a change to a booking',
  cancel: 'a cancellation',
  availability: 'an availability check',
  other: 'something else',
};

function flagCopy(
  flag: LunaAnalysisWire['flags'][number],
  amendment: QuoteAmendment | null | undefined,
): string {
  // The amendment panel carries its own request, booking and disabled Run state; skip duplicate warning copy.
  if (flag === 'amendment_or_cancel' && amendment) return '';
  return FLAG_COPY[flag];
}

function tasksLine(tasks: LunaAnalysisWire['tasks']): string | null {
  // Luna emits one quote task per date set, and the pane quotes every stay in one proposal, so quotes count once.
  // Other work (two bookings, two cancellations) is not combined, so each one still counts.
  const kinds = tasks.map((task) => task.kind).filter((kind, i, all) => kind !== 'quote' || all.indexOf(kind) === i);
  if (kinds.length <= 1) return null;
  const words = kinds.map((kind) => TASK_KIND_WORDS[kind] ?? kind).join(', ');
  return `This email asks for ${kinds.length} things: ${words}. This pane handles the first. Do the rest by hand.`;
}

export function NotSupportedList({
  flags,
  tasks,
  amendment,
  unreadFiles = false,
}: {
  flags?: LunaAnalysisWire['flags'];
  tasks?: LunaAnalysisWire['tasks'];
  /** The analysis amendment. When it is set, the change or cancel panel is shown. */
  amendment?: QuoteAmendment | null;
  /** Each unread file already has its own notice, so the generic unread-attachment line is left out. */
  unreadFiles?: boolean;
}) {
  const copies = (flags ?? [])
    .filter((flag) => !(unreadFiles && flag === 'attachment_unread'))
    .map((flag) => flagCopy(flag, amendment))
    .filter(Boolean);
  const extra = tasks ? tasksLine(tasks) : null;
  if (!copies.length && !extra) return null;
  return (
    <div role="alert" className="flex flex-col gap-1.5" aria-label="Not supported">
      {copies.map((copy) => (
        <Notice key={copy} tone="warn">
          {copy}
        </Notice>
      ))}
      {extra ? <Notice tone="warn">{extra}</Notice> : null}
    </div>
  );
}
