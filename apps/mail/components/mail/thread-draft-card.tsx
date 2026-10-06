import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { MoreHorizontal, RefreshCcw } from 'lucide-react';
import { PencilCompose, Trash } from '../icons/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type DraftAttachmentState =
  | 'loading'
  | 'available'
  | 'missing'
  | 'changed'
  | 'permission_denied'
  | 'fetch_error';
export type DraftCardAttachment = {
  artifactRef: string;
  filename: string;
  state: DraftAttachmentState;
};
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
  onEdit?: () => void;
  onDelete?: () => void;
  isReadOnly?: boolean;
  refreshLabel?: string;
  onRefresh?: () => void;
  canRefresh?: boolean;
  refreshPending?: boolean;
  /** Read-only AI candidates must be adopted into the existing editor for review. */
  reviewRequired?: boolean;
  readinessLabel?: string;
  readinessReason?: string;
  tasks?: { label: string; state: string; details?: string[] }[];
  pricingProof?: string[];
  attachments?: DraftCardAttachment[];
  onRetryAttachment?: (ref: string) => void;
  onPreviewAttachment?: (ref: string) => void;
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
  isReadOnly = false,
  refreshLabel,
  onRefresh,
  canRefresh = false,
  refreshPending = false,
  reviewRequired = false,
  readinessLabel,
  readinessReason,
  tasks = [],
  pricingProof = [],
  attachments = [],
  onRetryAttachment,
  onPreviewAttachment,
}: ThreadDraftCardProps) {
  const previewText = bodyPreview.trim() ? bodyPreview : emptyPreviewLabel;
  const showRefresh = Boolean(refreshLabel && onRefresh);

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'border-border bg-panelLight/90 dark:bg-panelDark/90 relative rounded-xl border px-4 py-3 shadow-sm',
        )}
      >
        <div className="absolute right-2 top-2 flex items-center gap-0.5">
          {showRefresh ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground h-8 w-8"
                  onClick={onRefresh}
                  disabled={!canRefresh || refreshPending}
                  aria-label={refreshLabel}
                >
                  <RefreshCcw className={cn('h-4 w-4', refreshPending && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {refreshLabel}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {!isReadOnly ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
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
                      onDelete?.();
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
            </>
          ) : null}
        </div>

        <div className={cn(isReadOnly || showRefresh ? 'pr-20' : 'pr-20')}>
          <p
            className="text-sm font-semibold text-rose-500 dark:text-rose-400"
            data-review-required={reviewRequired || undefined}
          >
            {draftBadge}
            {readinessLabel ? ` · ${readinessLabel}` : ''}
          </p>
          <p
            role="status"
            aria-live="polite"
            className="mt-0.5 text-sm text-rose-500/95 dark:text-rose-400/95"
          >
            {unsentNotice}
          </p>
          {readinessReason ? (
            <p role="status" className="mt-1 text-sm">
              {readinessReason}
            </p>
          ) : null}
          <div className="text-muted-foreground mt-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
            {subject ? (
              <span className="text-foreground line-clamp-1 min-w-0 font-medium">{subject}</span>
            ) : null}
            <span className="shrink-0 whitespace-nowrap">{savedAtLabel}</span>
          </div>
          <p className="text-foreground/90 dark:text-foreground/95 mt-2 line-clamp-3 text-sm">
            {previewText}
          </p>
        </div>

        {attachments.length ? (
          <ul aria-label="Draft attachments" className="mt-3 space-y-2">
            {attachments.map((a) => (
              <li key={a.artifactRef} className="text-sm">
                <span>{a.filename}</span>
                {' · '}
                <span role="status">
                  {
                    {
                      loading: 'Loading',
                      available: 'Available',
                      missing: 'Missing',
                      changed: 'Changed',
                      permission_denied: 'Permission denied',
                      fetch_error: 'Unable to load',
                    }[a.state]
                  }
                </span>
                {a.state === 'available' && onPreviewAttachment ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onPreviewAttachment(a.artifactRef)}
                    aria-label={`Preview ${a.filename}`}
                  >
                    Preview
                  </Button>
                ) : null}
                {a.state === 'fetch_error' && onRetryAttachment ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onRetryAttachment(a.artifactRef)}
                    aria-label={`Retry ${a.filename}`}
                  >
                    Retry
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {tasks.length ? (
          <ul aria-label="Draft tasks" className="mt-3 text-sm">
            {tasks.map((task, index) => (
              <li key={`${task.label}:${index}`} className="mb-2">
                {task.label} · {task.state}
                {task.details?.length ? (
                  <ul aria-label={`${task.label} review details`} className="text-muted-foreground mt-1 space-y-1">
                    {task.details.map((detail) => <li key={detail}>{detail}</li>)}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {pricingProof.length ? (
          <details className="mt-3 text-sm">
            <summary>Pricing proof</summary>
            <ul>
              {pricingProof.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="mt-3 flex">
          {(reviewRequired || isReadOnly) && onEdit ? (
            <Button type="button" variant="ghost" onClick={onEdit}>
              {editLabel}
            </Button>
          ) : null}
          {!isReadOnly ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground h-8 w-8"
              aria-label={moreLabel}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
