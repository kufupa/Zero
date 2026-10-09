import { Check, Mail } from 'lucide-react';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';

/** Contact block: the selected email's subject and sender, or an empty state until one is selected. */
export function SelectedEmailBlock({ activeEmail }: { activeEmail: PaneBridge['activeEmail'] }) {
  return activeEmail ? (
    <div id="quote-selected-message" className="flex items-center justify-between gap-2 rounded-[4px] border border-[#e2e8f0] bg-white px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Mail className="h-3.5 w-3.5 shrink-0 text-[#64748b]" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-bold text-[#1e293b]">
            {activeEmail.subject || '(no subject)'}
          </span>
          <span className="truncate text-[11px] text-[#64748b]">
            {`${activeEmail.senderName || 'Unknown sender'}${activeEmail.senderEmail ? ` <${activeEmail.senderEmail}>` : ''}`}
          </span>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1 rounded-[3px] bg-[#eaf4ee] px-1.5 py-0.5 text-[10px] font-semibold text-[#1a4332]">
        <Check className="h-3 w-3" /> Synced
      </span>
    </div>
  ) : (
    <div id="quote-selected-message" className="rounded-sm border border-dashed border-[#cbd5e1] p-3 text-center text-xs text-[#64748b]">
      Click an email to start
    </div>
  );
}
