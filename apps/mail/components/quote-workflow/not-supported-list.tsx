import type { LunaAnalysisWire } from '@/lib/quote-workflow/types';

const FLAG_COPY: Record<LunaAnalysisWire['flags'][number], string> = {
  conference_or_group: 'Venue / DDR / delegates / packages: handle manually',
  rooms_only_group: 'Rooms-only group: quoting with stated quantity',
  amendment_or_cancel: 'Amendment/cancellation: not supported yet',
  long_stay: 'Over 30 nights: split manually',
  discount_or_negotiation: 'Discount asked: needs your decision',
  multi_date: 'Several date options: quote the first, add the rest manually',
  extras: 'Extras requested (shuttle/dinner): add manually',
  mixed_request: 'Several requests in one email: check each',
  attachment_unread: "An attachment couldn't be read: open it",
};

const TASK_KIND_WORDS: Record<LunaAnalysisWire['tasks'][number]['kind'], string> = {
  quote: 'quote',
  create_booking: 'create booking',
  amend: 'amend',
  cancel: 'cancel',
  availability: 'availability',
  other: 'other',
};

function tasksLine(tasks: LunaAnalysisWire['tasks']): string | null {
  if (tasks.length <= 1) return null;
  const words = tasks.map((task) => TASK_KIND_WORDS[task.kind] ?? task.kind).join(', ');
  return `This email needs ${tasks.length} steps: ${words}. The pane handles the first; do the rest manually.`;
}

export function NotSupportedList({
  flags,
  tasks,
}: {
  flags?: LunaAnalysisWire['flags'];
  tasks?: LunaAnalysisWire['tasks'];
}) {
  const copies = (flags ?? []).map((flag) => FLAG_COPY[flag]).filter(Boolean);
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
