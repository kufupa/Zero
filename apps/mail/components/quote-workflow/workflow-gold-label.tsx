import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { SecondaryButton, paneFieldClass } from '@/components/nava-pane/pane-ui';
import { MAIL_ACTIONS, MAIL_ACTION_LABELS, type MailAction } from '@/lib/workflow-action-labels';
import { useState } from 'react';

export function WorkflowGoldLabel({
  messageId,
  internetMessageId,
  initialAction,
}: {
  messageId?: string | null;
  internetMessageId?: string | null;
  initialAction: MailAction;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedActionOverride, setSelectedActionOverride] = useState<MailAction | null>(null);
  const selectedAction = selectedActionOverride ?? initialAction;
  const [savedAction, setSavedAction] = useState<MailAction | null>(null);
  const sourceQuery = useQuery(
    trpc.workstation.staffQuoteSource.queryOptions(
      { internetMessageId: internetMessageId ?? '' },
      { enabled: !messageId && Boolean(internetMessageId) },
    ),
  );
  const sourceMessageId = messageId ?? (sourceQuery.data?.status === 'ready' ? sourceQuery.data.messageId : null);
  const saveMutation = useMutation(
    trpc.workflowFolders.setActionLabel.mutationOptions({
      onSuccess: async ({ action }) => {
        setSavedAction(action);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.summary.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.list.infiniteQueryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.workflowFolders.thread.queryKey() }),
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
            onChange={(event) => setSelectedActionOverride(event.target.value as MailAction)}
          >
            {MAIL_ACTIONS.map((action) => (
              <option key={action} value={action}>{MAIL_ACTION_LABELS[action]}</option>
            ))}
          </select>
        </label>
        <SecondaryButton
          disabled={!sourceMessageId || saveMutation.isPending}
          onClick={() => {
            if (sourceMessageId) saveMutation.mutate({ messageId: sourceMessageId, action: selectedAction });
          }}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save as gold'}
        </SecondaryButton>
      </div>
      {savedAction ? <p role="status" className="text-[11px] font-semibold text-[#1a4332]">Saved as gold · {MAIL_ACTION_LABELS[savedAction]}</p> : null}
      {sourceQuery.data?.status === 'message_not_synced' ? (
        <p className="text-[11px] text-[#64748b]">This message must sync before it can be labeled.</p>
      ) : null}
      {sourceQuery.isError || saveMutation.isError ? (
        <p role="alert" className="text-[11px] text-[#c01823]">Could not save this gold label. Check access and try again.</p>
      ) : null}
    </div>
  );
}
