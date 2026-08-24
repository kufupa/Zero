import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { trpcClient } from '@/providers/query-provider';
import { useMail } from '@/components/mail/use-mail';
import { Checkbox } from '@/components/ui/checkbox';
import { useThreads } from '@/hooks/use-threads';
import { Check } from '../icons/icons';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

export default function SelectAllCheckbox({ className }: { className?: string }) {
  const [mail, setMail] = useMail();
  const [, loadedThreads, , , searchList] = useThreads();
  const demoMode = isFrontendOnlyDemo();

  const [isFetchingIds, setIsFetchingIds] = useState(false);
  const allIdsCache = useRef<string[] | null>(null);

  const checkboxRef = useRef<HTMLButtonElement>(null);

  const loadedIds = useMemo(() => loadedThreads.map((t) => t.id), [loadedThreads]);
  const listRequestKey = searchList.isValid
    ? JSON.stringify({
        folder: searchList.folder,
        q: searchList.q,
        filters: searchList.filters,
        useDraftsList: searchList.useDraftsList,
      })
    : `invalid:${searchList.effectiveQuery}`;

  const isAllLoadedSelected = useMemo(() => {
    if (loadedIds.length === 0) return false;
    return loadedIds.every((id) => mail.bulkSelected.includes(id));
  }, [loadedIds, mail.bulkSelected]);

  const isIndeterminate = useMemo(() => {
    return mail.bulkSelected.length > 0 && !isAllLoadedSelected;
  }, [mail.bulkSelected.length, isAllLoadedSelected]);

  const fetchAllMatchingThreadIds = useCallback(async (): Promise<string[]> => {
    if (!searchList.isValid || demoMode) return loadedIds;

    const ids: string[] = [];
    let cursor = '';
    const MAX_PER_PAGE = 100;

    try {
      while (true) {
        const page = searchList.useDraftsList
          ? await trpcClient.drafts.list.query({
              q: searchList.q ?? '',
              limit: MAX_PER_PAGE,
              cursor,
            })
          : await trpcClient.mail.listThreads.query({
              folder: searchList.folder,
              q: searchList.q,
              filters: searchList.filters,
              limit: MAX_PER_PAGE,
              cursor,
            });
        if (page?.threads?.length) {
          ids.push(...page.threads.map((t: { id: string }) => t.id));
        }
        if (!page?.nextPageToken) break;
        cursor = page.nextPageToken;
      }
    } catch (err: unknown) {
      console.error('Failed to fetch all thread IDs', err);
      toast.error(err instanceof Error ? err.message : 'Failed to select all emails');
    }

    return ids;
  }, [demoMode, loadedIds, searchList]);

  const handleToggle = useCallback(() => {
    if (isFetchingIds) return;

    if (mail.bulkSelected.length) {
      setMail((prev) => ({ ...prev, bulkSelected: [] }));
      return;
    }

    setMail((prev) => ({ ...prev, bulkSelected: loadedIds }));

    toast(
      `${loadedIds.length} conversation${loadedIds.length !== 1 ? 's' : ''} on this page selected.`,
      {
        action: {
          label: 'Select all conversations',
          onClick: async () => {
            try {
              if (!allIdsCache.current) {
                setIsFetchingIds(true);
                allIdsCache.current = await fetchAllMatchingThreadIds();
                setIsFetchingIds(false);
              }
              const allIds = allIdsCache.current ?? [];
              setMail((prev) => ({ ...prev, bulkSelected: allIds }));
            } catch (err) {
              console.error(err);
              setIsFetchingIds(false);
              toast.error('Failed to select all conversations');
            }
          },
        },
        className: 'w-auto! whitespace-nowrap',
      },
    );
  }, [isFetchingIds, mail.bulkSelected.length, loadedIds, fetchAllMatchingThreadIds, setMail]);

  useEffect(() => {
    allIdsCache.current = null;
  }, [listRequestKey]);

  return (
    <div className="flex items-center gap-2">
      <Checkbox
        ref={checkboxRef}
        disabled={isFetchingIds}
        checked={isIndeterminate ? 'indeterminate' : isAllLoadedSelected}
        onCheckedChange={handleToggle}
        className={cn('hidden', className)}
        id="select-all"
      />
      <label
        htmlFor="select-all"
        className={cn(
          'text-muted-foreground flex items-center gap-1 text-xs font-medium transition-colors',
          isIndeterminate && 'text-primary',
        )}
      >
        <span
          className={cn(
            'border-muted-foreground flex items-center justify-center rounded border p-0.5 transition-colors',
            {
              'border-primary bg-primary': isAllLoadedSelected,
            },
          )}
        >
          <Check
            className={cn('text-muted-foreground/30 h-2 w-2 transition-colors', {
              'text-black': isAllLoadedSelected,
            })}
          />
        </span>
        Select all
      </label>
    </div>
  );
}
