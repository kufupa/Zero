import { Mail } from 'lucide-react';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';

function receivedAt(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The selected email, immediately below the mailbox header, or a clear prompt until one is selected. */
export function SelectedEmailBlock({ activeEmail }: { activeEmail: PaneBridge['activeEmail'] }) {
  if (!activeEmail) {
    return (
      <div
        id="quote-selected-message"
        className="mx-3 mt-2 flex shrink-0 items-center gap-2 rounded-[4px] border border-dashed border-[#cbd5e1] bg-white px-2.5 py-2 text-[12px] text-[#64748b]"
      >
        <Mail className="h-3.5 w-3.5 shrink-0" />
        Select an email to start
      </div>
    );
  }

  const when = receivedAt(activeEmail.receivedTime);
  return (
    <section
      id="quote-selected-message"
      aria-label="Selected email"
      className="mx-3 mt-2 flex shrink-0 items-start gap-2 rounded-[4px] border border-[#e2e8f0] bg-white px-2.5 py-2"
    >
      <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#64748b]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span data-pii className="truncate text-[11.5px] font-semibold text-[#475569]">
          {`${activeEmail.senderName || 'Unknown sender'}${activeEmail.senderEmail ? ` <${activeEmail.senderEmail}>` : ''}`}
        </span>
        <span data-pii className="truncate text-[13px] font-bold text-[#1e293b]">
          {activeEmail.subject || '(no subject)'}
        </span>
      </div>
      {when ? (
        <time
          dateTime={when.toISOString()}
          className="shrink-0 pt-0.5 text-right text-[10.5px] text-[#64748b]"
        >
          {when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      ) : null}
    </section>
  );
}
