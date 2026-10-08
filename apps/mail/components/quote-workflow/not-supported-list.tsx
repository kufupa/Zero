import type { LunaAnalysisWire, QuoteAmendment } from '@/lib/quote-workflow/types';

/** Shown in place of the "not supported" copy while the change or cancel panel is on screen. */
export const AMENDMENT_PANEL_COPY = 'Luna can find the booking; make the change in HMS yourself.';

const FLAG_COPY: Record<LunaAnalysisWire['flags'][number], string> = {
  conference_or_group: 'Conference or group request (venue, day delegates, packages): handle it by hand.',
  rooms_only_group: 'Rooms-only group: quoting the number of rooms stated.',
  amendment_or_cancel: 'Changing or cancelling a booking is not supported yet. Handle it by hand in HMS.',
  long_stay: 'Stay over 30 nights: split it into shorter stays by hand.',
  discount_or_negotiation: 'Discount asked for: your decision is needed.',
  multi_date: "Several date options: run each one. Build each option's PDF before running the next.",
  extras: 'Extras asked for (shuttle or dinner): set them in the Quote header before you make the PDF.',
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
  // The change or cancel panel answers the amendment flag, so the note points at it instead.
  if (flag === 'amendment_or_cancel' && amendment) return AMENDMENT_PANEL_COPY;
  return FLAG_COPY[flag];
}

function tasksLine(tasks: LunaAnalysisWire['tasks']): string | null {
  if (tasks.length <= 1) return null;
  const words = tasks.map((task) => TASK_KIND_WORDS[task.kind] ?? task.kind).join(', ');
  return `This email asks for ${tasks.length} things: ${words}. This pane handles the first. Do the rest by hand.`;
}

export function NotSupportedList({
  flags,
  tasks,
  amendment,
}: {
  flags?: LunaAnalysisWire['flags'];
  tasks?: LunaAnalysisWire['tasks'];
  /** The analysis amendment. When it is set, the change or cancel panel is shown. */
  amendment?: QuoteAmendment | null;
}) {
  const copies = (flags ?? []).map((flag) => flagCopy(flag, amendment)).filter(Boolean);
  const extra = tasks ? tasksLine(tasks) : null;
  if (!copies.length && !extra) return null;
  return (
    <section
      role="alert"
      className="flex flex-col gap-1 rounded-sm border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800"
      aria-label="Not supported"
    >
      {copies.map((copy) => (
        <p key={copy}>{copy}</p>
      ))}
      {extra ? <p>{extra}</p> : null}
    </section>
  );
}
