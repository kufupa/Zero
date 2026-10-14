import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { useQueryState } from 'nuqs';
import { useThread } from '@/hooks/use-threads';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';
import { WORKFLOW_FOLDER_NAV_ITEMS, isWorkflowFolderNavId } from '@/config/workflow-folders';
import { useWorkflowFolderSummary } from '@/hooks/use-workflow-folder-summary';
import { Field, Notice, Section } from '@/components/nava-pane/pane-ui';
import { Button } from '@/components/ui/button';
import { MAIL_ACTIONS, type MailAction } from '../../../server-pilot/src/mail/action-labels.js';

const PAGE_SIZE = 100;

const MAIL_ACTION_LABELS: Record<MailAction, string> = {
  quote_availability: 'Quote',
  new_booking: 'New booking',
  amend: 'Amendment',
  cancel: 'Cancellation',
  payment_proof: 'Payment proof',
  billing: 'Billing',
  group_event: 'Group/event',
  other_actionable: 'Other to do',
  no_action: 'Not for Nava',
};

const REVIEW_BUTTONS = [
  { value: 'right', title: 'Right', className: 'border-emerald-700 bg-emerald-700 hover:bg-emerald-800' },
  { value: 'edited', title: 'Edited', className: 'border-blue-700 bg-blue-700 hover:bg-blue-800' },
  { value: 'wrong', title: 'Wrong', className: 'border-rose-700 bg-rose-700 hover:bg-rose-800' },
] as const;

type ReviewDecision = (typeof REVIEW_BUTTONS)[number]['value'];

export function WorkflowFolderDesk() {
  const { folder: rawFolder } = useParams<{ folder: string }>();
  const folder = rawFolder?.toLowerCase();
  const validFolder = isWorkflowFolderNavId(folder) ? folder : undefined;
  const folderTitle = WORKFLOW_FOLDER_NAV_ITEMS.find((item) => item.id === validFolder)?.title ?? 'Workflow';
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [threadId, setThreadId] = useQueryState('threadId');
  const [sourceMessageParam, setSourceMessageParam] = useQueryState('sourceMessageId');
  const [setParam, setSetParam] = useQueryState('set');
  const reviewMode = setParam === 'eval';
  const [reviewNote, setReviewNote] = useState('');
  const [selectedAction, setSelectedAction] = useState<MailAction>('quote_availability');
  const isDemo = isFrontendOnlyDemo();
  const { data: workflowSummary } = useWorkflowFolderSummary(
    Boolean(validFolder) && !isDemo,
    reviewMode ? 'eval' : undefined,
  );

  const listQuery = useInfiniteQuery(
    trpc.workflowFolders.list.infiniteQueryOptions(
      {
        folder: validFolder ?? 'quotes',
        limit: PAGE_SIZE,
        ...(reviewMode ? { set: 'eval' as const } : {}),
      },
      {
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
        enabled: Boolean(validFolder) && !isDemo,
        staleTime: 20_000,
        refetchOnWindowFocus: true,
      },
    ),
  );
  const rows = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.rows) ?? [],
    [listQuery.data?.pages],
  );
  const currentRow = reviewMode
    ? rows.find((row) => row.threadId === threadId && row.sourceMessageId === sourceMessageParam) ??
      rows.find((row) => row.threadId === threadId)
    : rows.find((row) => row.threadId === threadId);
  const activeMessageId = sourceMessageParam ?? currentRow?.sourceMessageId;
  const openThread = useCallback(
    async (id: string, sourceMessageId?: string) => {
      await setSourceMessageParam(reviewMode ? sourceMessageId ?? null : null);
      await setThreadId(id);
    },
    [reviewMode, setSourceMessageParam, setThreadId],
  );

  const detailQuery = useQuery(
    trpc.workflowFolders.thread.queryOptions(
      {
        folder: validFolder ?? 'quotes',
        threadId: threadId ?? '',
        ...(reviewMode
          ? {
              set: 'eval' as const,
              ...(activeMessageId ? { messageId: activeMessageId } : {}),
            }
          : {}),
      },
      { enabled: Boolean(validFolder && threadId) && !isDemo, staleTime: 20_000 },
    ),
  );
  const selectedSourceMessage =
    detailQuery.data?.messages.find((message) => message.messageId === sourceMessageParam) ??
    detailQuery.data?.messages.find((message) => message.messageId === currentRow?.sourceMessageId) ??
    detailQuery.data?.messages.find((message) => message.messageId === detailQuery.data?.defaultMessageId) ??
    detailQuery.data?.messages[0];
  const selectedMessageId = selectedSourceMessage?.messageId ?? null;
  const { data: bodyThread, isLoading: isBodyLoading } = useThread(threadId ?? null);
  const bodyMessage = bodyThread?.messages.find((message) => message.id === selectedMessageId);
  const extraction = selectedSourceMessage?.extraction;
  const payload = extraction?.payload ?? null;
  const runs = detailQuery.data?.runs.filter((run) => run.triggerMessageId === selectedMessageId) ?? [];
  const selectedStats = validFolder ? workflowSummary?.[validFolder] : undefined;
  const liveStats = selectedStats && 'threads' in selectedStats ? selectedStats : undefined;
  const evalStats = selectedStats && 'total' in selectedStats ? selectedStats : undefined;
  const folderCount = reviewMode
    ? evalStats?.total ?? rows.length
    : liveStats?.threads ?? rows.length;

  const reviewMutation = useMutation(
    trpc.workItems.adminReview.mutationOptions({
      onSuccess: async () => {
        setReviewNote('');
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.summary.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.list.infiniteQueryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.thread.queryKey() }),
        ]);
      },
    }),
  );

  const actionMutation = useMutation(
    trpc.workflowFolders.setActionLabel.mutationOptions({
      onSuccess: async (_result, variables) => {
        const findNextUnmarked = (items: typeof rows) => {
          const currentIndex = items.findIndex((row) => row.sourceMessageId === variables.messageId);
          const afterCurrent =
            currentIndex < 0
              ? items
              : [...items.slice(currentIndex + 1), ...items.slice(0, currentIndex)];
          return afterCurrent.find(
            (row) => row.sourceMessageId !== variables.messageId && !row.ownerAction,
          );
        };
        let next = findNextUnmarked(rows);
        let nextPage = listQuery;
        while (!next && nextPage.hasNextPage) {
          nextPage = await nextPage.fetchNextPage();
          const loadedRows = nextPage.data?.pages.flatMap((page) => page.rows) ?? rows;
          next = findNextUnmarked(loadedRows);
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.summary.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.list.infiniteQueryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.thread.queryKey() }),
        ]);
        if (next) await openThread(next.threadId, next.sourceMessageId);
      },
    }),
  );
  const { mutate: mutateActionLabel, isPending: isActionPending } = actionMutation;

  useEffect(() => {
    setReviewNote('');
  }, [selectedMessageId]);

  useEffect(() => {
    if (selectedSourceMessage?.predictedAction) {
      setSelectedAction(selectedSourceMessage.ownerAction ?? selectedSourceMessage.predictedAction);
    }
  }, [selectedMessageId, selectedSourceMessage?.ownerAction, selectedSourceMessage?.predictedAction]);

  useEffect(() => {
    if (listQuery.isLoading) return;
    if (!threadId) {
      const firstThreadId = rows[0]?.threadId;
      if (firstThreadId) void setThreadId(firstThreadId);
      return;
    }
    if (rows.some((row) => row.threadId === threadId)) return;
    // A valid deep link may point beyond the first loaded page. Only discard it after the
    // detail endpoint confirms that the thread is no longer in this workflow folder.
    if (detailQuery.error?.data?.code !== 'NOT_FOUND') return;
    const firstThreadId = rows[0]?.threadId ?? null;
    if (firstThreadId === threadId) return;
    void (async () => {
      await setSourceMessageParam(null);
      await setThreadId(firstThreadId);
    })();
  }, [detailQuery.error, listQuery.isLoading, rows, setSourceMessageParam, setThreadId, threadId]);

  const recordReview = (decision: ReviewDecision) => {
    if (!selectedSourceMessage || !extraction) return;
    reviewMutation.mutate({
      sourceMessageId: selectedSourceMessage.messageId,
      extractionId: extraction.id,
      decision,
      ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}),
    });
  };

  const recordAction = useCallback(
    (action: MailAction = selectedAction) => {
      if (!reviewMode || !selectedSourceMessage?.predictedAction || isActionPending) return;
      mutateActionLabel({ messageId: selectedSourceMessage.messageId, action });
    },
    [
      isActionPending,
      mutateActionLabel,
      reviewMode,
      selectedAction,
      selectedSourceMessage?.messageId,
      selectedSourceMessage?.predictedAction,
    ],
  );

  const toggleReviewSet = async () => {
    await setSourceMessageParam(null);
    await setThreadId(null);
    await setSetParam(reviewMode ? null : 'eval');
  };

  useEffect(() => {
    if (!reviewMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))
      ) {
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        recordAction();
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const action = MAIL_ACTIONS[Number(event.key) - 1];
        if (action) {
          setSelectedAction(action);
          recordAction(action);
        }
        return;
      }
      if (event.key === 'j' || event.key === 'k') {
        const selectedId = selectedMessageId ?? currentRow?.sourceMessageId;
        const currentIndex = rows.findIndex((row) => row.sourceMessageId === selectedId);
        const nextIndex = currentIndex + (event.key === 'j' ? 1 : -1);
        const next = rows[nextIndex];
        if (next) {
          event.preventDefault();
          void openThread(next.threadId, next.sourceMessageId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    currentRow?.sourceMessageId,
    openThread,
    recordAction,
    reviewMode,
    rows,
    selectedMessageId,
  ]);

  if (!validFolder) {
    return <div className="p-8 text-sm text-muted-foreground">Workflow folder not found.</div>;
  }

  return (
    <main className="flex h-[calc(100dvh-1rem)] min-h-0 flex-col overflow-hidden rounded-2xl border bg-background shadow-sm">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">Quote Desk</h1>
          <p className="text-muted-foreground truncate text-xs">{folderTitle} · Nava workflow review</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant={reviewMode ? 'default' : 'outline'}
            aria-pressed={reviewMode}
            onClick={() => void toggleReviewSet()}
          >
            Review set
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {reviewMode
              ? `Marked ${evalStats?.marked ?? 0} / ${evalStats?.total ?? 0}`
              : `${liveStats?.threads ?? rows.length} threads`}
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 divide-y md:grid-cols-[minmax(220px,250px)_minmax(0,1fr)_minmax(270px,320px)] md:divide-x md:divide-y-0 xl:grid-cols-[minmax(245px,290px)_minmax(0,1fr)_minmax(320px,370px)]">
        <section aria-label={`${folderTitle} messages`} className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
            <h2 className="text-sm font-semibold">{folderTitle}</h2>
            <span className="text-muted-foreground text-xs tabular-nums">
              {folderCount}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {listQuery.isLoading ? (
              <p className="text-muted-foreground p-4 text-sm">Loading workflows…</p>
            ) : listQuery.isError ? (
              <Notice tone="error" role="alert">
                Could not load this workflow folder: {folderErrorReason(listQuery.error?.message)}
              </Notice>
            ) : rows.length === 0 ? (
              <p className="text-muted-foreground p-4 text-sm">
                {reviewMode ? 'No messages in this review set yet.' : 'No extracted emails in this folder yet.'}
              </p>
            ) : (
              <div className="divide-y">
                {rows.map((row) => {
                  const active =
                    row.threadId === threadId &&
                    (!reviewMode || row.sourceMessageId === activeMessageId);
                  const chip = row.review?.decision ?? (row.prefilled ? 'To review' : 'Read');
                  return (
                    <button
                      key={`${row.threadId}:${row.sourceMessageId}`}
                      type="button"
                      onClick={() => void openThread(row.threadId, row.sourceMessageId)}
                      aria-current={active ? 'true' : undefined}
                      className={`block w-full px-3 py-3 text-left transition-colors hover:bg-muted/60 ${active ? 'bg-muted' : ''}`}
                    >
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium">{row.sender}</span>
                        <time className="text-muted-foreground shrink-0 text-[10px]">
                          {formatMailTime(row.receivedAt)}
                        </time>
                      </div>
                      <p className="mt-1 truncate text-[13px]">{row.subject}</p>
                      <div className="mt-2 flex items-center gap-1.5">
                        {reviewMode ? (
                          row.ownerAction ? (
                            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
                              Marked: {MAIL_ACTION_LABELS[row.ownerAction]}
                            </span>
                          ) : (
                            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                              Unmarked
                            </span>
                          )
                        ) : (
                          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${reviewChipClass(chip)}`}>
                            {chip}
                          </span>
                        )}
                        {!reviewMode && (row.action || row.kind) ? (
                          <span className="text-muted-foreground truncate text-[10px]">
                            {row.action ?? row.kind}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
                {listQuery.hasNextPage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="my-2 w-[calc(100%-1rem)] mx-2"
                    disabled={listQuery.isFetchingNextPage}
                    onClick={() => void listQuery.fetchNextPage()}
                  >
                    {listQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </section>

        <section aria-label="Email body" className="flex min-h-0 min-w-0 flex-col">
          {selectedSourceMessage ? (
            <>
              <div className="shrink-0 border-b px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words text-base font-semibold">{selectedSourceMessage.subject}</h2>
                    <p className="text-muted-foreground mt-1 truncate text-xs">
                      {selectedSourceMessage.sender} · {formatMailTime(selectedSourceMessage.receivedAt)}
                    </p>
                  </div>
                  <label className="shrink-0 text-[11px] font-medium">
                    <span className="sr-only">Inbound email in thread</span>
                    <select
                      aria-label="Inbound email in thread"
                      value={selectedSourceMessage.messageId}
                      onChange={(event) => void setSourceMessageParam(event.target.value)}
                      className="max-w-40 rounded-md border bg-background px-2 py-1 text-xs"
                    >
                      {detailQuery.data?.messages
                        .filter(
                          (message) =>
                            !reviewMode ||
                            rows.some(
                              (row) =>
                                row.threadId === threadId && row.sourceMessageId === message.messageId,
                            ),
                        )
                        .map((message) => (
                          <option key={message.messageId} value={message.messageId}>
                            {formatMailTime(message.receivedAt)} · {message.subject}
                            {message.extraction ? '' : ' · no read'}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {isBodyLoading ? (
                  <p className="text-muted-foreground text-sm">Loading email body…</p>
                ) : bodyMessage ? (
                  <div className="whitespace-pre-wrap break-words text-sm leading-6">
                    {highlightExtractedText(
                      emailBodyText(bodyMessage.decodedBody || bodyMessage.body || ''),
                      extractionTerms(payload),
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">Email body is not available.</p>
                )}
              </div>
            </>
          ) : (
            <div className="text-muted-foreground flex min-h-64 flex-1 items-center justify-center p-8 text-center text-sm">
              {detailQuery.isError
                ? 'This thread is no longer available in this workflow.'
                : 'Select an email to inspect what Nava read and prefilled.'}
            </div>
          )}
        </section>

        <aside aria-label="Nava result and review" className="flex min-h-0 flex-col bg-slate-50/70">
          <div className="shrink-0 border-b px-4 py-3">
            <h2 className="text-sm font-semibold">{reviewMode ? 'Action review' : 'Nava’s result'}</h2>
            {selectedSourceMessage ? (
              <p className="text-muted-foreground mt-1 truncate text-[11px]">
                {selectedSourceMessage.sender} · {formatMailTime(selectedSourceMessage.receivedAt)}
              </p>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {reviewMode ? (
              selectedSourceMessage?.predictedAction ? (
                <ReviewSetActionSection
                  messageId={selectedSourceMessage.messageId}
                  predictedAction={selectedSourceMessage.predictedAction}
                  selectedAction={selectedAction}
                  isPending={actionMutation.isPending}
                  error={actionMutation.error?.message ?? null}
                  onActionChange={setSelectedAction}
                  onRight={() => recordAction()}
                />
              ) : (
                <Notice>
                  {selectedSourceMessage
                    ? 'No Nava action is available for this message.'
                    : 'Choose a message from the review set.'}
                </Notice>
              )
            ) : selectedSourceMessage ? (
              <>
                <ReadAsSection extraction={extraction ?? null} workItemStatus={selectedSourceMessage.workItemStatus} />
                <ExtractedFieldsSection payload={payload} />
                <LookupSection runs={runs} kind="party" title="Party lookup" />
                <LookupSection runs={runs} kind="quote" title="Rates / quote status" />
                <LookupSection runs={runs} kind="find" title="HMS find result" />
                <ReviewSection
                  extractionId={extraction?.id ?? null}
                  messageId={selectedSourceMessage.messageId}
                  review={selectedSourceMessage.review}
                  note={reviewNote}
                  isPending={reviewMutation.isPending}
                  error={reviewMutation.error?.message ?? null}
                  onNoteChange={setReviewNote}
                  onDecision={recordReview}
                />
              </>
            ) : (
              <p className="text-muted-foreground p-2 text-sm">Choose a thread to inspect its stored read.</p>
            )}
          </div>
        </aside>
      </div>

      <footer className="text-muted-foreground shrink-0 border-t bg-background px-4 py-2 text-xs tabular-nums">
        {reviewMode
          ? 'Enter = Right · 1–9 = choose and save · j/k = previous/next'
          : `${liveStats?.read ?? 0} read · ${liveStats?.prefilled ?? 0} prefilled · ${liveStats?.reviewedRight ?? 0} reviewed right / ${liveStats?.reviewedWrong ?? 0} reviewed wrong · ${liveStats?.reviewedEdited ?? 0} edited`}
      </footer>
    </main>
  );
}

function ReviewSetActionSection({
  messageId,
  predictedAction,
  selectedAction,
  isPending,
  error,
  onActionChange,
  onRight,
}: {
  messageId: string;
  predictedAction: MailAction;
  selectedAction: MailAction;
  isPending: boolean;
  error: string | null;
  onActionChange: (action: MailAction) => void;
  onRight: () => void;
}) {
  return (
    <Section title="Review action">
      <p className="text-sm font-medium">Nava says: {MAIL_ACTION_LABELS[predictedAction]}</p>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-700">
        Correct action
        <select
          aria-label="Correct action"
          value={selectedAction}
          onChange={(event) => onActionChange(event.target.value as MailAction)}
          className="rounded-md border bg-white px-2 py-1.5 text-xs"
        >
          {MAIL_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {MAIL_ACTION_LABELS[action]}
            </option>
          ))}
        </select>
      </label>
      <Button type="button" disabled={isPending} onClick={onRight} className="w-full">
        Right
      </Button>
      {error ? (
        <Notice tone="error" role="alert">
          Could not save review-set action: {error}
        </Notice>
      ) : null}
      <p className="text-muted-foreground text-[10px]">Message {messageId}</p>
    </Section>
  );
}

function ReadAsSection({
  extraction,
  workItemStatus,
}: {
  extraction: {
    id: string;
    kind: string | null;
    action: string | null;
    folder: string;
    extractorVersion: string;
    payload: Record<string, unknown> | null;
  } | null;
  workItemStatus: string | null;
}) {
  const origin = extraction?.payload?.origin;
  const readAs = origin === 'person' ? 'Person-authored' : origin === 'system_notice' ? 'System notice' : 'Source not labelled';
  return (
    <Section title="Read as">
      <Field label="Source">{readAs}</Field>
      <Field label="Workflow">{extraction?.action ?? extraction?.kind ?? 'No succeeded extraction'}</Field>
      <Field label="Routed to">{extraction?.folder ?? '—'}</Field>
      <Field label="Extractor">{extraction?.extractorVersion ?? '—'}</Field>
      <Field label="Pane status">{workItemStatus ?? 'Not opened in Nava pane'}</Field>
    </Section>
  );
}

function ExtractedFieldsSection({ payload }: { payload: Record<string, unknown> | null }) {
  if (!payload) {
    return (
      <Section title="Extracted fields">
        <Notice>No succeeded extraction is stored for this inbound email.</Notice>
      </Section>
    );
  }
  const contact = objectRecord(payload.contact);
  const stays = Array.isArray(payload.stays) ? payload.stays : [];
  const confirmations = Array.isArray(payload.confirmationNumbers) ? payload.confirmationNumbers : [];
  const missing = Array.isArray(payload.missing) ? payload.missing : [];
  const fields: Array<{ label: string; value: unknown }> = [
    { label: 'Contact', value: contact.name },
    { label: 'Email', value: contact.email },
    { label: 'Phone', value: contact.phone },
    { label: 'Agency / company', value: payload.agency },
    { label: 'End client', value: payload.endClient },
    { label: 'Confirmations', value: payload.confirmationNumbers },
  ];
  return (
    <Section title="Extracted fields">
      {fields.map(({ label, value }) =>
        isDisplayable(value) ? (
          <Field key={label} label={label} fromEmail>
            <ReadOnlyText>{displayValue(value)}</ReadOnlyText>
          </Field>
        ) : null,
      )}
      {stays.map((value, index) => {
        const stay = objectRecord(value);
        const requested = objectRecord(stay.requested);
        const booked = objectRecord(stay.booked);
        const roomRows = Array.isArray(stay.rows) ? stay.rows : [];
        const details: string[] = [];
        if (isDisplayable(stay.hotel)) details.push(`Hotel: ${displayValue(stay.hotel)}`);
        const requestedDates = [requested.arrival, requested.departure].map(displayValue).filter((part) => part !== '—');
        if (requestedDates.length) details.push(`Requested: ${requestedDates.join(' → ')}`);
        const bookedDates = [booked.arrival, booked.departure].map(displayValue).filter((part) => part !== '—');
        if (bookedDates.length) details.push(`Booked: ${bookedDates.join(' → ')}`);
        if (isDisplayable(stay.totalRooms)) details.push(`Total: ${displayValue(stay.totalRooms)} rooms`);
        roomRows.forEach((rowValue, rowIndex) => {
          const row = objectRecord(rowValue);
          const roomDetails = [
            isDisplayable(row.roomType) ? displayValue(row.roomType) : null,
            isDisplayable(row.rooms) ? `${displayValue(row.rooms)} room(s)` : null,
            isDisplayable(row.adultsPerRoom) ? `${displayValue(row.adultsPerRoom)} adults/room` : null,
            Array.isArray(row.childAges) && row.childAges.length
              ? `child ages ${row.childAges.map(displayValue).join(', ')}`
              : null,
            isDisplayable(row.board) ? `board ${displayValue(row.board)}` : null,
          ].filter((part): part is string => Boolean(part));
          if (roomDetails.length) details.push(`Room ${rowIndex + 1}: ${roomDetails.join(' · ')}`);
        });
        return details.length ? (
          <Field key={`stay-${index}`} label={`Stay ${index + 1}`} fromEmail>
            <ReadOnlyText>{details.join('\n')}</ReadOnlyText>
          </Field>
        ) : null;
      })}
      {confirmations.length ? (
        <Field label="Confirmation numbers" fromEmail>
          <ReadOnlyText>{confirmations.map(displayValue).join(', ')}</ReadOnlyText>
        </Field>
      ) : null}
      {missing.slice(0, 8).map((value, index) => {
        const item = objectRecord(value);
        const question = stringValue(item.question);
        if (!question) return null;
        const field = stringValue(item.field);
        return (
          <Field key={`missing-${index}`} label={field ? `Nava asked about ${field}` : 'Nava could not resolve'}>
            <ReadOnlyText>{question}</ReadOnlyText>
          </Field>
        );
      })}
      {!fields.some(({ value }) => isDisplayable(value)) &&
      !stays.length &&
      !confirmations.length &&
      !missing.length ? (
        <p className="text-muted-foreground text-xs">No prefilled values were stored.</p>
      ) : null}
    </Section>
  );
}

function LookupSection({
  runs,
  kind,
  title,
}: {
  runs: Array<{
    id: string;
    kind: string;
    state: string;
    request: Record<string, unknown>;
    result: Record<string, unknown> | null;
    lastError: string | null;
    finishedAt: string | null;
    resultExpiresAt: string | null;
  }>;
  kind: 'party' | 'quote' | 'find';
  title: string;
}) {
  const matching = runs.filter((run) => {
    const requestKind = stringValue(run.request.kind);
    const toolId = stringValue(run.request.toolId) ?? stringValue(run.result?.toolId);
    if (kind === 'party') return run.kind === 'party' || requestKind === 'party';
    if (kind === 'find') return run.kind === 'find' || toolId === 'hms_find_reservation';
    return (
      ['availability', 'stay', 'quote'].includes(run.kind) ||
      run.kind === 'staff_quote' ||
      requestKind === 'availability' ||
      requestKind === 'stay' ||
      requestKind === 'staff_quote' ||
      toolId === 'hms_quote_stay'
    );
  });
  const recent = matching.slice(0, 3);
  return (
    <Section title={title}>
      {recent.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No stored {kind === 'party' ? 'lookup' : 'result'} for this email. The console will not start one.
        </p>
      ) : (
        recent.map((run) => {
          const outcome = stringValue(run.result?.outcome) ?? stringValue(run.result?.status);
          const requestName = stringValue(run.request.name) ?? stringValue(run.request.confirmation);
          const resultText = storedRunSummary(run, kind);
          return (
            <div key={run.id} className="space-y-1.5 rounded border border-slate-200 bg-white p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">
                  {requestName ?? run.kind}
                </span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${reviewChipClass(run.state)}`}>
                  {outcome ? `${run.state} · ${outcome}` : run.state}
                </span>
              </div>
              {kind === 'party' ? <PartyCandidates result={run.result} /> : null}
              {resultText ? (
                <details>
                  <summary className="text-muted-foreground cursor-pointer text-[11px]">
                    Stored result{run.resultExpiresAt && Date.parse(run.resultExpiresAt) < Date.now() ? ' (expired snapshot)' : ''}
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-[10px] leading-4">
                    {resultText}
                  </pre>
                </details>
              ) : run.lastError ? (
                <p className="text-muted-foreground text-[11px]">{run.lastError}</p>
              ) : null}
            </div>
          );
        })
      )}
    </Section>
  );
}

function PartyCandidates({ result }: { result: Record<string, unknown> | null }) {
  const best = objectRecord(result?.best);
  const binding = objectRecord(result?.binding ?? result?.bound ?? result?.selectedParty);
  const boundName = stringValue(binding.name);
  const boundId = stringValue(binding.nativeId);
  const suggestions = Array.isArray(result?.results) ? result.results : [];
  return (
    <div className="space-y-1 text-[11px]">
      <p>
        <span className="font-semibold">Bound party:</span>{' '}
        {boundName ? `${boundName}${boundId ? ` (#${boundId})` : ''}` : 'No persisted binding'}
      </p>
      {isDisplayable(best.name) ? (
        <p><span className="font-semibold">Best suggestion:</span> {displayValue(best.name)} (not a recorded binding)</p>
      ) : null}
      {suggestions.length > 0 ? (
        <ul className="text-muted-foreground list-disc space-y-0.5 pl-4">
          {suggestions.slice(0, 5).map((value, index) => {
            const candidate = objectRecord(value);
            return (
              <li key={`${stringValue(candidate.nativeId) ?? index}`}>
                {stringValue(candidate.kind) ? `${stringValue(candidate.kind)} · ` : ''}
                {stringValue(candidate.name) ?? 'Unnamed candidate'}
                {stringValue(candidate.nativeId) ? ` (${stringValue(candidate.nativeId)})` : ''}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!isDisplayable(best.name) && suggestions.length === 0 ? (
        <p className="text-muted-foreground">No party candidates were retained.</p>
      ) : null}
    </div>
  );
}

function ReviewSection({
  extractionId,
  messageId,
  review,
  note,
  isPending,
  error,
  onNoteChange,
  onDecision,
}: {
  extractionId: string | null;
  messageId: string;
  review: { decision: ReviewDecision; note: string | null; at: string } | null;
  note: string;
  isPending: boolean;
  error: string | null;
  onNoteChange: (value: string) => void;
  onDecision: (decision: ReviewDecision) => void;
}) {
  return (
    <Section title="Review Nava">
      {review ? (
        <Notice tone="success" role="status">
          Latest review: {review.decision}{review.note ? ` — ${review.note}` : ''}
        </Notice>
      ) : (
        <p className="text-muted-foreground text-xs">Compare the read and result with the email, then record a decision.</p>
      )}
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-700">
        Note (optional)
        <textarea
          aria-label="Review note"
          value={note}
          maxLength={2000}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="What should Nava have read or done?"
          className="min-h-16 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-normal outline-none focus:border-blue-600"
        />
      </label>
      <div className="grid grid-cols-3 gap-1.5">
        {REVIEW_BUTTONS.map((button) => (
          <button
            key={button.value}
            type="button"
            disabled={!extractionId || isPending}
            onClick={() => onDecision(button.value)}
            className={`rounded border px-2 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${button.className}`}
          >
            {button.title}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-[10px]">
        Saves an append-only <code>work_event</code> with kind <code>admin_review</code> for message {messageId}.
      </p>
      {error ? <Notice tone="error" role="alert">Review was not saved: {error}</Notice> : null}
    </Section>
  );
}

function storedRunSummary(
  run: { result: Record<string, unknown> | null; state: string; lastError: string | null },
  kind: 'party' | 'quote' | 'find',
) {
  if (!run.result) return run.lastError ?? null;
  const value = kind === 'find' || kind === 'quote' ? run.result.data ?? run.result : run.result;
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length > 6000 ? `${serialized.slice(0, 6000)}\n… snapshot truncated` : serialized;
}

function extractionTerms(payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];
  const terms: string[] = [];
  const contact = objectRecord(payload.contact);
  for (const value of [contact.name, contact.email, contact.phone, payload.agency, payload.endClient]) {
    if (typeof value === 'string' && value.trim().length >= 2) terms.push(value.trim());
  }
  if (Array.isArray(payload.confirmationNumbers)) {
    for (const value of payload.confirmationNumbers) {
      if (typeof value === 'string' && value.trim().length >= 2) terms.push(value.trim());
    }
  }
  if (Array.isArray(payload.stays)) {
    for (const value of payload.stays) {
      const stay = objectRecord(value);
      const requested = objectRecord(stay.requested);
      const booked = objectRecord(stay.booked);
      const rowValues = Array.isArray(stay.rows) ? stay.rows : [];
      for (const field of [stay.hotel, requested.arrival, requested.departure, booked.arrival, booked.departure]) {
        if (typeof field === 'string' && field.trim().length >= 2) terms.push(field.trim());
      }
      for (const rowValue of rowValues) {
        const row = objectRecord(rowValue);
        if (typeof row.roomType === 'string' && row.roomType.trim().length >= 2) terms.push(row.roomType.trim());
      }
    }
  }
  return [...new Set(terms)].sort((a, b) => b.length - a.length);
}

function emailBodyText(source: string): string {
  if (!/<(?:html|body|p|div|table|br|li|blockquote)\b/i.test(source)) return source;
  if (typeof DOMParser === 'undefined') {
    return source
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  parsed.querySelectorAll('script, style, noscript').forEach((element) => element.remove());
  return parsed.body.textContent ?? '';
}

function highlightExtractedText(text: string, terms: string[]): ReactNode {
  if (!text || terms.length === 0) return text;
  const expression = new RegExp(terms.map(escapeRegExp).join('|'), 'gi');
  const nodes: ReactNode[] = [];
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text))) {
    if (match.index > offset) nodes.push(text.slice(offset, match.index));
    nodes.push(
      <mark key={`${match.index}-${match[0]}`} className="rounded bg-amber-200 px-0.5 text-inherit">
        {match[0]}
      </mark>,
    );
    offset = expression.lastIndex;
  }
  if (offset < text.length) nodes.push(text.slice(offset));
  return nodes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ReadOnlyText({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-8 rounded-[3px] border border-[#cbd5e1] bg-[#f8fafc] px-2.5 py-1.5 text-[13px] text-[#1e293b]">
      {children}
    </div>
  );
}

function isDisplayable(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayValue).join(', ');
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';
  return String(value);
}

// Owner console: show why the list failed, but keep raw SQL and parameters out of the page.
function folderErrorReason(message: string | undefined): string {
  const firstLine = message?.split('\n')[0]?.trim();
  if (!firstLine) return 'unknown error';
  if (firstLine.startsWith('Failed query')) return 'database query failed (see server logs)';
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

function formatMailTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function reviewChipClass(value: string): string {
  if (value === 'right' || value === 'succeeded' || value === 'done') return 'bg-emerald-100 text-emerald-800';
  if (value === 'wrong' || value === 'dead_letter' || value === 'failed') return 'bg-rose-100 text-rose-800';
  if (value === 'edited' || value === 'running' || value === 'queued') return 'bg-blue-100 text-blue-800';
  return 'bg-slate-100 text-slate-700';
}

