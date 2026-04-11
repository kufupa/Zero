export type ReplyComposeMode = 'reply' | 'replyAll' | 'forward';

type QueryStateSetter = (value: string | null) => void | Promise<unknown>;
type ReplyComposeStateSetter = (values: {
  mode?: string | null;
  activeReplyId?: string | null;
  draftId?: string | null;
}) => void | Promise<unknown>;

type ReplyComposeSetters = {
  setMode: QueryStateSetter;
  setActiveReplyId: QueryStateSetter;
  setDraftId?: QueryStateSetter;
  setComposeState?: ReplyComposeStateSetter;
};

type OpenReplyComposeContextInput = ReplyComposeSetters & {
  mode: ReplyComposeMode;
  messageId?: string | null;
};

export async function openReplyComposeContext({
  mode,
  messageId,
  setMode,
  setActiveReplyId,
  setDraftId,
  setComposeState,
}: OpenReplyComposeContextInput) {
  const normalizedMessageId = messageId?.trim() ? messageId : null;

  if (setComposeState) {
    await setComposeState({
      mode,
      activeReplyId: normalizedMessageId,
      draftId: null,
    });
    return;
  }

  // A reply mode switch should always reset draft affinity to avoid stale recipients.
  if (setDraftId) {
    await setDraftId(null);
  }
  await setMode(mode);
  await setActiveReplyId(normalizedMessageId);
}

export async function clearReplyComposeContext({
  setMode,
  setActiveReplyId,
  setDraftId,
  setComposeState,
}: ReplyComposeSetters) {
  if (setComposeState) {
    await setComposeState({
      mode: null,
      activeReplyId: null,
      draftId: null,
    });
    return;
  }

  await setMode(null);
  await setActiveReplyId(null);
  if (setDraftId) {
    await setDraftId(null);
  }
}
