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
  attachments: unknown[];
};

type PersistDecisionInput = {
  hasUnsavedChanges: boolean;
  initialHtml: string;
  html: string;
  text: string;
  to: string[];
  subject: string;
  aiBlocked: boolean;
};

type DraftEditorStateInput = {
  isDirty: boolean;
  localHtml: string;
  localSubject: string;
  serverDraft?: {
    content?: string | null;
    subject?: string | null;
    updatedAt?: string | null;
  } | null;
};

type EnsureEditableDraftInput = {
  demoMode: boolean;
  threadId: string | null;
  replyToMessageId: string | null;
  activeDraftId: string | null;
  aiCandidateCount: number;
};

export function shouldPersistDraft(input: PersistDecisionInput): boolean {
  if (!input.hasUnsavedChanges || input.aiBlocked) return false;
  if (input.html.trim() === input.initialHtml.trim()) return false;
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
  if (input.isDirty) {
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
