import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { getDemoDraft, type DemoDraft } from '@/lib/demo/local-store';
import { parseRecipientToken, splitRecipientField } from '../lib/demo/recipient-parsing';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import { draftsGetQueryKey, type ApiQueryContext } from '@/lib/api/query-options';

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
  const demoMode = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  return useQuery({
    queryKey: demoMode ? (['demo', 'drafts', 'get', id] as const) : draftsGetQueryKey(queryCtx, { id: id ?? '' }),
    queryFn: () =>
      demoMode
        ? Promise.resolve(toDemoDraftPayload(getDemoDraft(id ?? '')))
        : getFrontendApi().drafts.get({ id: id! }),
    enabled: demoMode ? Boolean(id) : Boolean(session?.user?.id) && Boolean(id) && queryCtx.mode === 'legacy',
    staleTime: 1000 * 60 * 60,
  });
};
