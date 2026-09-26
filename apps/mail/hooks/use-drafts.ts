import { parseRecipientToken, splitRecipientField } from '../lib/demo/recipient-parsing';
import { getDemoDraft, type DemoDraft } from '@/lib/demo/local-store';
import { useMutation, useQuery } from '@tanstack/react-query';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';
import { useSession } from '@/lib/auth-client';

export type DraftLike = {
  id: string;
  threadId?: string | null;
  replyToMessageId?: string | null;
  content?: string | null;
  subject?: string | null;
  updatedAt?: string;
  status?: 'active' | 'candidate' | 'discarded' | 'sent';
  origin?: 'manual' | 'ai';
  generationId?: string | null;
  isStale?: boolean;
  rawMessage?: {
    internalDate?: string | null;
  };
  to?: string[];
  cc?: string[];
  bcc?: string[];
};

/** AI drafts always take the explicit review/approval path before send. */
export function isAssistedDraft(draft?: DraftLike | null): boolean {
  return draft?.origin === 'ai';
}

const normalizeEmailList = (value: string): string[] => {
  const recipients = splitRecipientField(value)
    .map((entry) => parseRecipientToken(entry)?.email)
    .filter((email): email is string => !!email);

  return [...new Set(recipients)];
};

const toDemoDraftPayload = (draft?: DemoDraft | null): DraftLike | undefined => {
  if (!draft) return undefined;
  const internalDate = Number(new Date(draft.updatedAt).getTime());

  const normalized: DraftLike = {
    id: draft.id,
    threadId: draft.threadId ?? null,
    replyToMessageId: null,
    content: draft.body,
    subject: draft.subject?.trim() || undefined,
    updatedAt: draft.updatedAt,
    status: 'active',
    origin: 'manual',
    generationId: null,
    isStale: false,
    to: normalizeEmailList(draft.to),
    cc: normalizeEmailList(draft.cc),
    bcc: normalizeEmailList(draft.bcc),
  };

  if (Number.isFinite(internalDate)) {
    normalized.rawMessage = { internalDate: String(internalDate) };
  }

  return normalized;
};

export const useDraft = (id: string | null) => {
  const { data: session } = useSession();
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();

  if (demoMode) {
    return useQuery({
      queryKey: ['demo', 'drafts', 'get', id],
      queryFn: async () => toDemoDraftPayload(getDemoDraft(id ?? '')),
      enabled: !!id,
      staleTime: 1000 * 60 * 60, // 1 hour
    });
  }

  const draftQuery = useQuery(
    trpc.drafts.get.queryOptions(
      { id: id! },
      { enabled: !!session?.user?.id && !!id, staleTime: 1000 * 60 * 60 },
    ),
  );
  return draftQuery;
};

export const useEnsureEditableDraftForReply = () => {
  const trpc = useTRPC();
  return useMutation(trpc.drafts.ensureEditableForReply.mutationOptions());
};
