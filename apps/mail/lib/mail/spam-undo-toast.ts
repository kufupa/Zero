import { m } from '@/paraglide/messages';
import { toast } from 'sonner';

export type SenderPreference = { email: string; kind: 'block' | 'allow' };

const SPAM_UNDO_TOAST_DURATION_MS = 5000;

export function buildSpamUndoToastMessage(
  threadCount: number,
  preferences: SenderPreference[] = [],
): string {
  const blockedCount = preferences.filter((preference) => preference.kind === 'block').length;
  const baseMessage =
    blockedCount > 0
      ? m['common.actions.movedToSpamAndBlocked']()
      : m['common.actions.movedToSpam']();

  return threadCount > 1 ? `${baseMessage} (${threadCount} items)` : baseMessage;
}

export function showSpamUndoToast({
  threadIds,
  preferences = [],
  onUndo,
}: {
  threadIds: string[];
  preferences?: SenderPreference[];
  onUndo: () => Promise<void>;
}) {
  if (!threadIds.length) return;

  toast(buildSpamUndoToastMessage(threadIds.length, preferences), {
    duration: SPAM_UNDO_TOAST_DURATION_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        void onUndo().catch(() => {
          toast.error(m['common.actions.failedToMove']());
        });
      },
    },
  });
}
