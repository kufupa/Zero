import type { SerializedFile } from '@/lib/schemas';

type DraftMutationInput = {
  draftId: string | null;
  threadId: string | null;
  replyToMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  fromEmail?: string;
  attachments: SerializedFile[];
};

export type PersistDecisionInput = {
  hasUnsavedChanges: boolean;
  existingDraftId?: string | null;
  initialHtml: string;
  html: string;
  text: string;
  to: string[];
  subject: string;
  aiBlocked: boolean;
};

export type DraftRevisionState = {
  localRevision: number;
  savedRevision: number;
};

export type DraftRevisionEvent =
  | { type: 'edited' }
  | { type: 'saved'; capturedRevision: number };

type DraftEditorStateInput = {
  hasLocalEdits: boolean;
  localHtml: string;
  localSubject: string;
  serverDraft?: {
    content?: string | null;
    subject?: string | null;
    updatedAt?: string | null;
  } | null;
};

export function reduceDraftRevision(
  state: DraftRevisionState,
  event: DraftRevisionEvent,
): DraftRevisionState {
  if (event.type === 'edited') {
    return { ...state, localRevision: state.localRevision + 1 };
  }
  return {
    ...state,
    savedRevision: Math.max(state.savedRevision, event.capturedRevision),
  };
}

type EnsureEditableDraftInput = {
  demoMode: boolean;
  threadId: string | null;
  replyToMessageId: string | null;
  activeDraftId: string | null;
  aiCandidateCount: number;
};

export function shouldPersistDraft(input: PersistDecisionInput): boolean {
  if (!input.hasUnsavedChanges || input.aiBlocked) return false;
  // A saved draft can change attachments or headers without changing its body.
  if (!input.existingDraftId && input.html.trim() === input.initialHtml.trim()) return false;
  return (
    input.text.trim().length > 0 ||
    input.subject.trim().length > 0 ||
    input.to.length > 0
  );
}

export function buildDraftMutationInput(input: DraftMutationInput) {
  return {
    id: input.draftId ?? undefined,
    threadId: input.threadId ?? undefined,
    replyToMessageId: input.replyToMessageId ?? undefined,
    to: input.to.join(', '),
    cc: input.cc.join(', '),
    bcc: input.bcc.join(', '),
    subject: input.subject,
    body: input.html,
    message: input.html,
    attachments: input.attachments,
    fromEmail: input.fromEmail,
  };
}

export function chooseDraftEditorState(input: DraftEditorStateInput) {
  if (input.hasLocalEdits) {
    return {
      html: input.localHtml,
      subject: input.localSubject,
      source: 'local-dirty' as const,
    };
  }
  return {
    html: input.serverDraft?.content ?? input.localHtml,
    subject: input.serverDraft?.subject ?? input.localSubject,
    source: 'server' as const,
  };
}

export function shouldEnsureEditableDraftForReply(input: EnsureEditableDraftInput):
  | { shouldEnsure: true; threadId: string; replyToMessageId: string }
  | { shouldEnsure: false } {
  if (
    input.demoMode ||
    !input.threadId ||
    !input.replyToMessageId ||
    input.activeDraftId ||
    input.aiCandidateCount === 0
  ) {
    return { shouldEnsure: false };
  }
  return {
    shouldEnsure: true,
    threadId: input.threadId,
    replyToMessageId: input.replyToMessageId,
  };
}

export function isStaleDraftConflict(error: unknown): boolean {
  const maybe = error as { data?: { code?: string }; message?: string };
  return maybe.data?.code === 'CONFLICT' && maybe.message === 'STALE_DRAFT';
}

export function getStaleDraftRetryInput<T extends object>(input: T): T & { confirmStaleDraft: true } {
  return { ...input, confirmStaleDraft: true };
}

export class StaleDraftSendCancelled extends Error {
  constructor() {
    super('STALE_DRAFT_SEND_CANCELLED');
    this.name = 'StaleDraftSendCancelled';
  }
}

export function isStaleDraftSendCancelled(error: unknown): boolean {
  return error instanceof StaleDraftSendCancelled;
}

export type ComposeCloseIntent = 'userClose' | 'threadSwitch';
export type ComposeCloseAction = 'closeSilent' | 'prompt' | 'flushAndLeave';
export type ComposeDialogChoice = 'keepEditing' | 'saveDraft' | 'discard';

export function resolveComposeCloseAction(
  input: PersistDecisionInput & { intent: ComposeCloseIntent },
): ComposeCloseAction {
  const { intent, ...persistInput } = input;
  if (!shouldPersistDraft(persistInput)) return 'closeSilent';
  if (intent === 'threadSwitch') return 'flushAndLeave';
  return 'prompt';
}

export function nextAfterDialogChoice(
  choice: ComposeDialogChoice,
): 'dismiss' | 'saveThenClose' | 'discardThenClose' {
  if (choice === 'keepEditing') return 'dismiss';
  if (choice === 'saveDraft') return 'saveThenClose';
  return 'discardThenClose';
}

export async function runComposeLeaveFlush(
  flush: (() => Promise<void>) | null | undefined,
  clear: () => void | Promise<void>,
): Promise<void> {
  try {
    await flush?.();
  } catch {
    // Caller/saveDraft owns user-visible error toast; never block leave.
  } finally {
    await clear();
  }
}
