export type ReplyComposeMode = 'reply' | 'replyAll' | 'forward';

type QueryStateSetter = (value: string | null) => void | Promise<unknown>;

type ReplyComposeSetters = {
  setMode: QueryStateSetter;
  setActiveReplyId: QueryStateSetter;
  setDraftId?: QueryStateSetter;
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
}: OpenReplyComposeContextInput) {
  // A reply mode switch should always reset draft affinity to avoid stale recipients.
  if (setDraftId) {
    await setDraftId(null);
  }
  await setMode(mode);
  await setActiveReplyId(messageId?.trim() ? messageId : null);
}

export async function clearReplyComposeContext({
  setMode,
  setActiveReplyId,
  setDraftId,
}: ReplyComposeSetters) {
  await setMode(null);
  await setActiveReplyId(null);
  if (setDraftId) {
    await setDraftId(null);
  }
}
