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
  proofItems?: string[];
  teachLabel?: string;
  demoStatusLabel?: string;
  primaryDemoActionLabel?: string;
  primaryDemoActionVariant?: 'default' | 'secondary' | 'outline' | 'ghost';
  onPrimaryDemoAction?: () => void;
  demoEditInsight?: {
    label: string;
    before: string;
    after: string;
    note: string;
  };
  onViewWorkflow?: () => void;
  onTeachBrain?: () => void;
  /** When false, Teach button hidden even if onTeachBrain is set. Default: show when onTeachBrain is set. */
  showTeachWorkflowButton?: boolean;
  /** Shown after Sarah workflow insert is applied (before full insight card). */
  workflowInsertCallout?: { text: string };
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
  proofItems,
  teachLabel = 'Teach Nava',
  demoStatusLabel,
  primaryDemoActionLabel,
  primaryDemoActionVariant = 'default',
  demoEditInsight,
  showTeachWorkflowButton = true,
  workflowInsertCallout,
  onViewWorkflow,
  onTeachBrain,
  onPrimaryDemoAction,
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
        {demoStatusLabel ? (
          <p className="mt-3 rounded-lg border border-emerald-300/45 bg-emerald-50/80 px-3 py-2 text-xs font-semibold text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-50">
            {demoStatusLabel}
          </p>
        ) : null}
        {workflowInsertCallout ? (
          <div className="mt-3 rounded-lg border border-emerald-300/50 bg-emerald-50/90 p-2.5 text-xs leading-5 text-emerald-950 dark:border-emerald-400/35 dark:bg-emerald-400/12 dark:text-emerald-50">
            <span className="font-semibold text-emerald-800 dark:text-emerald-200">Added: </span>
            {workflowInsertCallout.text}
          </div>
        ) : null}
        {demoEditInsight ? (
          <div className="mt-3 rounded-xl border border-fuchsia-200 bg-fuchsia-50/80 p-3 text-sm dark:border-fuchsia-400/25 dark:bg-fuchsia-400/10">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fuchsia-700 dark:text-fuchsia-200">
              {demoEditInsight.label}
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg bg-white/70 p-2 text-xs leading-5 text-slate-700 dark:bg-black/20 dark:text-slate-300">
                <span className="font-semibold">Nava draft: </span>
                {demoEditInsight.before}
              </div>
              <div className="rounded-lg bg-white/90 p-2 text-xs leading-5 text-slate-900 dark:bg-fuchsia-300/10 dark:text-fuchsia-50">
                <span className="font-semibold">Sarah edit: </span>
                {demoEditInsight.after}
              </div>
            </div>
            <p className="mt-2 text-xs leading-5 text-fuchsia-900 dark:text-fuchsia-100/85">{demoEditInsight.note}</p>
          </div>
        ) : null}
        {proofItems?.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {proofItems.map((item, index) => (
              <button
                type="button"
                key={item}
                onClick={(event) => {
                  event.stopPropagation();
                  if (item === 'Edit trains brain') {
                    onTeachBrain?.();
                    return;
                  }
                  if (index === 1 || item.startsWith('Workflow:')) {
                    onViewWorkflow?.();
                  }
                }}
                className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-medium text-sky-700 transition hover:border-sky-300 hover:bg-sky-100 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-100 dark:hover:bg-sky-400/20"
              >
                {item}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex">
        {primaryDemoActionLabel && onPrimaryDemoAction ? (
          <Button
            type="button"
            variant={primaryDemoActionVariant}
            size="xs"
            className="mr-2"
            onClick={(event) => {
              event.stopPropagation();
              onPrimaryDemoAction();
            }}
          >
            {primaryDemoActionLabel}
          </Button>
        ) : null}
        {onTeachBrain && showTeachWorkflowButton ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mr-2 border border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 hover:bg-fuchsia-100 dark:border-fuchsia-400/30 dark:bg-fuchsia-400/10 dark:text-fuchsia-100"
            onClick={(event) => {
              event.stopPropagation();
              onTeachBrain();
            }}
          >
            {teachLabel}
          </Button>
        ) : null}
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
