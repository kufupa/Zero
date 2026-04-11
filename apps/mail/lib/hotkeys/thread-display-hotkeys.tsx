import { mailNavigationCommandAtom } from '@/hooks/use-mail-navigation';
import { enhancedKeyboardShortcuts } from '@/config/shortcuts';
import useMoveTo from '@/hooks/driver/use-move-to';
import useDelete from '@/hooks/driver/use-delete';
import { useShortcuts } from './use-hotkey-utils';
import { useThread } from '@/hooks/use-threads';
import { useParams } from 'react-router';
import { useQueryState } from 'nuqs';
import { useSetAtom } from 'jotai';
import { openReplyComposeContext } from '@/lib/mail/reply-compose-context';

const closeView = (event: KeyboardEvent) => {
  event.preventDefault();
};

export function ThreadDisplayHotkeys() {
  const scope = 'thread-display';
  const [, setMode] = useQueryState('mode');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const [, setDraftId] = useQueryState('draftId');
  const [openThreadId] = useQueryState('threadId');
  const { data: thread } = useThread(openThreadId);
  const params = useParams<{
    folder: string;
  }>();
  const { mutate: deleteThread } = useDelete();
  const { mutate: moveTo } = useMoveTo();
  const setMailNavigationCommand = useSetAtom(mailNavigationCommandAtom);

  const handlers = {
    closeView: () => closeView(new KeyboardEvent('keydown', { key: 'Escape' })),
    reply: () => {
      void openReplyComposeContext({
        mode: 'reply',
        messageId: thread?.latest?.id ?? null,
        setMode,
        setActiveReplyId,
        setDraftId,
      });
    },
    forward: () => {
      void openReplyComposeContext({
        mode: 'forward',
        messageId: thread?.latest?.id ?? null,
        setMode,
        setActiveReplyId,
        setDraftId,
      });
    },
    replyAll: () => {
      void openReplyComposeContext({
        mode: 'replyAll',
        messageId: thread?.latest?.id ?? null,
        setMode,
        setActiveReplyId,
        setDraftId,
      });
    },
    delete: () => {
      if (!openThreadId) return;
      if (params.folder === 'bin') {
        deleteThread(openThreadId);
        setMailNavigationCommand('next');
      } else {
        moveTo({
          threadIds: [openThreadId],
          currentFolder: params.folder ?? 'inbox',
          destination: 'bin',
        });
        setMailNavigationCommand('next');
      }
    },
  };

  const threadDisplayShortcuts = enhancedKeyboardShortcuts.filter(
    (shortcut) => shortcut.scope === scope,
  );

  useShortcuts(threadDisplayShortcuts, handlers, { scope });

  return null;
}
