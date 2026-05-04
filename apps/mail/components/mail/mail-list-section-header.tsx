import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
export type MailListSectionHeaderProps = {
  label: string;
  expanded: boolean;
  onToggle: () => void;
};

export function MailListSectionHeader({ label, expanded, onToggle }: MailListSectionHeaderProps) {
  return (
    <div className="border-border/60 shrink-0 border-b">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'hover:bg-offsetLight dark:hover:bg-primary/5 text-muted-foreground focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium outline-none focus-visible:ring-2',
        )}
      >
        <ChevronRight
          className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-90')}
          aria-hidden
        />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
