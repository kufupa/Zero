import { PencilCompose, Trash } from '../icons/icons';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { MoreHorizontal } from 'lucide-react';

export type ThreadDraftCardProps = {
  subject: string;
  bodyPreview: string;
  savedAtLabel: string;
  draftBadge: string;
  unsentNotice: string;
  emptyPreviewLabel: string;
  editLabel: string;
  deleteLabel: string;
  moreLabel: string;
  onEdit: () => void;
  onDelete: () => void;
};

export function ThreadDraftCard({
  subject,
  bodyPreview,
  savedAtLabel,
  draftBadge,
  unsentNotice,
  emptyPreviewLabel,
  editLabel,
  deleteLabel,
  moreLabel,
  onEdit,
  onDelete,
}: ThreadDraftCardProps) {
  const previewText = bodyPreview.trim() ? bodyPreview : emptyPreviewLabel;

  return (
    <TooltipProvider delayDuration={0}>
    <div
      className={cn(
        'border-border bg-panelLight/90 dark:bg-panelDark/90 relative rounded-xl border px-4 py-3 shadow-sm',
      )}
    >
      <div className="absolute right-2 top-2 flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300 h-8 w-8"
              onClick={onEdit}
              aria-label={editLabel}
            >
              <PencilCompose className="h-4 w-4 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {editLabel}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-rose-500 hover:text-rose-600 dark:text-rose-400"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              aria-label={deleteLabel}
            >
              <Trash className="h-4 w-4 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {deleteLabel}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="pr-20">
        <p className="text-rose-500 dark:text-rose-400 text-sm font-semibold">{draftBadge}</p>
        <p className="text-rose-500/95 dark:text-rose-400/95 mt-0.5 text-sm">{unsentNotice}</p>
        <div className="text-muted-foreground mt-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
          {subject ? <span className="line-clamp-1 min-w-0 font-medium text-foreground">{subject}</span> : null}
          <span className="shrink-0 whitespace-nowrap">{savedAtLabel}</span>
        </div>
        <p className="text-foreground/90 dark:text-foreground/95 mt-2 line-clamp-3 text-sm">{previewText}</p>
      </div>

      <div className="mt-3 flex">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground h-8 w-8"
          aria-label={moreLabel}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </div>
    </div>
    </TooltipProvider>
  );
}
