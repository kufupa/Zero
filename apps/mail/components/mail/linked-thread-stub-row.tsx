import { Link2 } from 'lucide-react';
import { memo } from 'react';
import { cn, formatDateWithWeekdayAndTime } from '@/lib/utils';
import type { MailListThreadRow } from '@/types';

type LinkedStub = NonNullable<MailListThreadRow['linkedStubs']>[number];

export type LinkedThreadStubRowProps = {
  stub: LinkedStub;
  onNavigate: (threadId: string) => void;
  isKeyboardFocused?: boolean;
  isKeyboardNavigationActive?: boolean;
};

export const LinkedThreadStubRow = memo(function LinkedThreadStubRow({
  stub,
  onNavigate,
  isKeyboardFocused,
  isKeyboardNavigationActive,
}: LinkedThreadStubRowProps) {
  const dateLabel =
    stub.latestMessageAt != null
      ? formatDateWithWeekdayAndTime(
          typeof stub.latestMessageAt === 'string'
            ? stub.latestMessageAt.split('.')[0] || stub.latestMessageAt
            : stub.latestMessageAt,
        )
      : null;

  return (
    <button
      type="button"
      data-thread-id={stub.threadId}
      onClick={() => onNavigate(stub.threadId)}
      className={cn(
        'hover:bg-offsetLight dark:hover:bg-primary/5 mx-1 mb-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg border border-dashed border-border/70 px-4 py-2 text-left text-xs text-muted-foreground transition-colors',
        isKeyboardFocused &&
          isKeyboardNavigationActive &&
          'ring-2 ring-inset ring-primary/60 outline-none',
      )}
    >
      <Link2 className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="line-clamp-1 min-w-0 flex-1 font-medium text-foreground/80">{stub.label}</span>
      {dateLabel ? <span className="shrink-0 opacity-70">{dateLabel}</span> : null}
    </button>
  );
});
