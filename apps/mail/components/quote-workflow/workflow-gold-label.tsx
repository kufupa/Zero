import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { SecondaryButton, paneFieldClass } from '@/components/nava-pane/pane-ui';
import {
  MAIL_ACTIONS,
  MAIL_ACTION_LABELS,
  READ_AS_FOR_GOLD_ACTION,
  type MailAction,
} from '@/lib/workflow-action-labels';
import { useState } from 'react';

export function WorkflowGoldLabel({
  messageId,
  internetMessageId,
  initialAction,
  onIntentChange,
}: {
  messageId?: string | null;
  internetMessageId?: string | null;
  initialAction: MailAction;
  onIntentChange?: (intent: 'quote' | 'create_booking') => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedActionOverride, setSelectedActionOverride] = useState<MailAction | null>(null);
  const [savedAction, setSavedAction] = useState<MailAction | null>(null);
  const sourceQuery = useQuery(
    trpc.workstation.staffQuoteSource.queryOptions(
      { internetMessageId: internetMessageId ?? '' },
      { enabled: !messageId && Boolean(internetMessageId) },
    ),
  );
  const sourceMessageId = messageId ?? (sourceQuery.data?.status === 'ready' ? sourceQuery.data.messageId : null);
  const ownerActionQuery = useQuery(
    trpc.workflowFolders.getOwnerActionLabel.queryOptions(
      { messageId: sourceMessageId ?? '' },
      { enabled: Boolean(sourceMessageId) },
    ),
  );
  const selectedAction =
    selectedActionOverride ?? savedAction ?? ownerActionQuery.data ?? initialAction;
  const displayedSavedAction = savedAction ?? ownerActionQuery.data ?? null;
  const saveMutation = useMutation(
    trpc.workflowFolders.setActionLabel.mutationOptions({
      onSuccess: async ({ action }) => {
        setSavedAction(action);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.summary.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.list.infiniteQueryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.infiniteQueryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.thread.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.getOwnerActionLabel.queryKey() }),
        ]);
      },
    }),
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-[11px] font-semibold text-[#475569]">
          Nava reads this as
          <select
            aria-label="Nava reads this as"
            className={`${paneFieldClass} bg-white`}
            value={selectedAction}
            onChange={(event) => {
              const action = event.target.value as MailAction;
              setSelectedActionOverride(action);
              const readAs = READ_AS_FOR_GOLD_ACTION[action];
              if (readAs === 'quote') onIntentChange?.('quote');
              if (readAs === 'new_booking') onIntentChange?.('create_booking');
            }}
          >
            {MAIL_ACTIONS.map((action) => (
              <option key={action} value={action}>{MAIL_ACTION_LABELS[action]}</option>
            ))}
          </select>
        </label>
        <SecondaryButton
          disabled={!sourceMessageId || !ownerActionQuery.isSuccess || saveMutation.isPending}
          onClick={() => {
            if (sourceMessageId) saveMutation.mutate({ messageId: sourceMessageId, action: selectedAction });
          }}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save as gold'}
        </SecondaryButton>
      </div>
      {displayedSavedAction ? (
        <p role="status" className="text-[11px] font-semibold text-[#1a4332]">
          Saved as gold · {MAIL_ACTION_LABELS[displayedSavedAction]}
        </p>
      ) : null}
      {sourceQuery.data?.status === 'message_not_synced' ? (
        <p className="text-[11px] text-[#64748b]">This message must sync before it can be labeled.</p>
      ) : null}
      {ownerActionQuery.isError ? (
        <p role="alert" className="text-[11px] text-[#c01823]">
          Could not load this email’s saved gold label. Refresh and try again.
        </p>
      ) : null}
      {sourceQuery.isError || saveMutation.isError ? (
        <p role="alert" className="text-[11px] text-[#c01823]">Could not save this gold label. Check access and try again.</p>
      ) : null}
    </div>
  );
}
