import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { getDemoDraft, type DemoDraft } from '@/lib/demo/local-store';
import { parseRecipientToken, splitRecipientField } from '../lib/demo/recipient-parsing';

type DraftLike = {
  id: string;
  content?: string;
  subject?: string;
  rawMessage?: {
    internalDate?: string | null;
  };
  to?: string[];
  cc?: string[];
  bcc?: string[];
};

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
    content: draft.body,
    subject: draft.subject?.trim() || undefined,
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
      { enabled: !!session?.user.id && !!id, staleTime: 1000 * 60 * 60 },
    ),
  );
  return draftQuery;
};
