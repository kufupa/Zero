import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { cleanHtml } from '@/lib/email-utils';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages';

export function AiDraftPreviewPanel({
  llmIssueMessage,
  draftHtml,
  onBeginReview,
  className,
}: {
  llmIssueMessage?: string;
  draftHtml: string;
  onBeginReview: () => void;
  className?: string;
}) {
  const safe = cleanHtml(draftHtml);

  return (
    <div
      className={cn(
        'border-border bg-panelLight dark:bg-panelDark shrink-0 border-t px-4 py-3',
        className,
      )}
    >
      {llmIssueMessage ? (
        <div
          className="mb-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-100"
          role="status"
        >
          {llmIssueMessage}
        </div>
      ) : null}
      <p className="mb-2 text-sm font-medium">{m['navigation.sidebar.aiDraftPreviewLabel']()}</p>
      <div
        role="region"
        aria-readonly="true"
        aria-label={m['navigation.sidebar.aiDraftPreviewLabel']()}
        className="border-destructive/70 mb-3 cursor-pointer rounded-md border-2 p-3 opacity-80 focus-visible:ring-2 focus-visible:ring-red-500/40 focus-visible:outline-none"
        onClick={() => onBeginReview()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onBeginReview();
          }
        }}
        tabIndex={0}
      >
        <ScrollArea className="max-h-[40vh]" type="auto">
          <div
            className="text-muted-foreground prose prose-sm dark:prose-invert max-w-none select-none text-sm"
            dangerouslySetInnerHTML={{ __html: safe }}
          />
        </ScrollArea>
      </div>
      <Button type="button" onClick={() => onBeginReview()}>
        {m['navigation.sidebar.aiDraftReviewEdit']()}
      </Button>
    </div>
  );
}
