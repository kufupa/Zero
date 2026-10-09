import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const FEEDBACK_EMAIL = 'aroransh17@gmail.com';
const FEEDBACK_WHATSAPP_URL = 'https://wa.me/447505014078';

/**
 * The pane's ⋯ menu, on the shared dropdown. Radix handles the keyboard: Enter or Space opens it with
 * focus on the first item, the arrows move between items, and Escape closes it and returns focus to ⋯.
 * It holds what the footer used to show: connection check, tour replay, feedback and the build id.
 */
export function PaneMenu({
  buildRelease,
  onCheckConnection,
  onReplayTour,
}: {
  buildRelease: string | null;
  onCheckConnection: () => void;
  onReplayTour: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More"
          className="flex h-8 w-8 items-center justify-center rounded-xs text-[#64748b] hover:bg-[#f1f5f9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0066cc]"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-60 text-xs text-[#1e293b]">
        <DropdownMenuItem onSelect={() => onCheckConnection()}>Check connection</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onReplayTour()}>Replay tour</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={`mailto:${FEEDBACK_EMAIL}`}>Feedback by email</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={FEEDBACK_WHATSAPP_URL} target="_blank" rel="noreferrer">
            Feedback on WhatsApp
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-[#64748b]">
          About Nava Reservationist
          {buildRelease ? ` · Build ${buildRelease.slice(0, 7)}` : ''}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
