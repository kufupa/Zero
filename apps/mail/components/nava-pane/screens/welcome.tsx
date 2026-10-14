import { ArrowRight, Building2, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** First-run step 1: the detected Outlook account, and the button that starts the connection check. */
export function WelcomeScreen({
  detectedEmail,
  onConfirm,
}: {
  detectedEmail: string;
  onConfirm: () => void;
}) {
  return (
    <div className="animate-in fade-in nava-pane-scroll flex flex-1 flex-col overflow-y-auto p-4 duration-150">
      <div className="my-auto flex flex-col items-center text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#eaf4ee] text-[#1a4332]">
          <Building2 className="h-6 w-6" />
        </div>
        <h1 className="text-base font-bold text-[#1e293b]">Welcome to Nava</h1>
        <p className="mt-1 text-xs leading-relaxed text-[#64748b]">
          Your intelligent assistant for Infor HMS quoting and reservations, built directly
          into Outlook.
        </p>

        <div className="my-5 w-full rounded-sm border border-[#e2e8f0] bg-[#f8fafc] p-3 text-left">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748b]">
            Detected Outlook Account
          </span>
          <div className="mt-1.5 flex items-center gap-2 text-xs font-semibold text-[#1e293b]">
            <Mail className="h-4 w-4 text-[#64748b]" />
            <span>{detectedEmail}</span>
          </div>
        </div>

        <Button
          type="button"
          onClick={onConfirm}
          className="flex w-full items-center justify-center gap-2 bg-[#1a4332] text-xs font-semibold text-white hover:bg-[#123023]"
        >
          <span>Confirm Account & Connect</span>
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
