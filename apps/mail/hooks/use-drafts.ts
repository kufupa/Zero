import { parseRecipientToken, splitRecipientField } from '../lib/demo/recipient-parsing';
import type { DraftAttachmentState } from '@/components/mail/thread-draft-card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDemoDraft, type DemoDraft } from '@/lib/demo/local-store';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useTRPC } from '@/providers/query-provider';
import { useEffect, useRef, useState } from 'react';
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
  revisionKey?: string;
  attachments?: {
    artifactRef: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sourceHash: string | null;
    state: string;
  }[];
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

export function draftArtifactSnapshotKey(draft: DraftLike): string {
  return JSON.stringify({
    id: draft.id,
    revisionKey: draft.revisionKey ?? null,
    artifacts: (draft.attachments ?? []).map((a) => ({
      ref: a.artifactRef,
      hash: a.sourceHash,
      size: a.sizeBytes,
      mime: a.mimeType,
      name: a.filename,
    })),
  });
}
export type DraftHydratedAttachment = {
  artifactRef: string;
  filename: string;
  state: DraftAttachmentState;
  file?: File;
};
/** Capture a draft once per editor identity; later refetch cannot swap its attachment revision. */
export function useDraftArtifactHydration(draft?: DraftLike | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useRef<DraftLike | null>(null);
  const [entryState, setEntryState] = useState<{ key: string; entries: DraftHydratedAttachment[] }>(
    { key: '', entries: [] },
  );
  const [attempt, setAttempt] = useState(0);
  const draftKey = draft ? draftArtifactSnapshotKey(draft) : '';
  if (draft && (!snapshot.current || draftArtifactSnapshotKey(snapshot.current) !== draftKey))
    snapshot.current = { ...draft, attachments: draft.attachments?.map((a) => ({ ...a })) };
  const entries = entryState.key === draftKey ? entryState.entries : [];
  useEffect(() => {
    const selected = snapshot.current;
    if (!selected || draftArtifactSnapshotKey(selected) !== draftKey) return;
    let cancelled = false;
    const wanted = selected.attachments ?? [];
    setEntryState({
      key: draftKey,
      entries: wanted.map((a) => ({
        artifactRef: a.artifactRef ?? '',
        filename: a.filename,
        state: 'loading',
      })),
    });
    void Promise.all(
      wanted.map(async (a) => {
        if (!a.artifactRef || !a.sourceHash)
          return {
            artifactRef: a.artifactRef ?? '',
            filename: a.filename,
            state: 'missing' as const,
          };
        try {
          const options = trpc.drafts.getArtifact.queryOptions({
            draftId: selected.id,
            artifactRef: a.artifactRef,
          });
          const result = await queryClient.fetchQuery({ ...options, staleTime: 0 });
          const raw = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
          const digest = await crypto.subtle.digest('SHA-256', raw);
          const hash = Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, '0'),
          ).join('');
          if (hash !== a.sourceHash || raw.length !== a.sizeBytes)
            return { artifactRef: a.artifactRef, filename: a.filename, state: 'changed' as const };
          return {
            artifactRef: a.artifactRef,
            filename: a.filename,
            state: 'available' as const,
            file: new File([raw], a.filename, { type: a.mimeType }),
          };
        } catch (error) {
          const code = (error as { data?: { code?: string } })?.data?.code;
          return {
            artifactRef: a.artifactRef,
            filename: a.filename,
            state: (code === 'FORBIDDEN' || code === 'UNAUTHORIZED'
              ? 'permission_denied'
              : code === 'NOT_FOUND'
                ? 'missing'
                : code === 'CONFLICT'
                  ? 'changed'
                  : 'fetch_error') as DraftAttachmentState,
          };
        }
      }),
    ).then((values) => {
      if (!cancelled) setEntryState({ key: draftKey, entries: values });
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey, attempt, trpc, queryClient]);
  return {
    entries,
    files: entries.flatMap((a) => (a.file ? [a.file] : [])),
    snapshotKey: draftKey,
    retry: () => {
      queryClient.removeQueries({ queryKey: trpc.drafts.getArtifact.queryKey() });
      setAttempt((a) => a + 1);
    },
  };
}
