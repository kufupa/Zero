import { useCallback, useEffect, useRef, useState } from 'react';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { workItemsFromTrpc, type AmendDraftSnapshot } from './backend-bind';

/** Refresh one selected mail, and only replace its projection while the editor is still unchanged. */
export function useAmendExtractionRefresh(args: {
  trpc: unknown;
  snapshot: AmendDraftSnapshot | null;
  transportId: string | null;
  selectionKey: string | null;
  editVersion: number;
  hasDraft: boolean;
  flush: () => Promise<boolean>;
  reload: (snapshot: AmendDraftSnapshot, transportId: string, extractionId: string, isCurrent: () => boolean) => Promise<boolean>;
}) {
  const latest = useRef(args);
  latest.current = args;
  const hasRoute = Boolean(workItemsFromTrpc(args.trpc).refreshAmendExtraction?.mutate);
  const source = args.snapshot?.source;
  const key = hasRoute && args.snapshot && args.transportId && args.selectionKey
    ? JSON.stringify([args.transportId, args.selectionKey, args.snapshot.workItemId, source?.threadId, source?.messageId, source?.sourceHash])
    : null;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; status: 'checking' | 'ready' | 'blocked'; message?: string } | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    const start = latest.current;
    const mutate = workItemsFromTrpc(start.trpc).refreshAmendExtraction?.mutate;
    if (!key || !mutate || !start.snapshot || !start.transportId) return;
    const snapshot = start.snapshot;
    const transportId = start.transportId;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const current = () => live && currentKey.current === key;
    const stop = (message: string) => { if (current()) setState({ key, status: 'blocked', message }); };
    setState({ key, status: 'checking' });
    void (async () => {
      if ((start.hasDraft && !(await start.flush())) || !current()) {
        if (current()) stop('Save your changes before refreshing the email details.');
        return;
      }
      const version = latest.current.editVersion;
      const stillCurrent = () => current() && latest.current.editVersion === version;
      const input = { workItemId: snapshot.workItemId, source: { threadId: snapshot.source.threadId,
        messageId: snapshot.source.messageId, sourceHash: snapshot.source.sourceHash } };
      const poll = async () => {
        try {
          const mailbox = inMailbox(transportId);
          const result = await (mailbox ? mutate(input, mailbox) : mutate(input));
          if (!current()) return;
          if (!stillCurrent()) { stop('Email refresh paused to keep your edits.'); return; }
          if (result.status === 'queued') {
            if (++polls >= 30) { stop('Email details are still being read. Try again.'); return; }
            timer = setTimeout(() => void poll(), 4000);
            return;
          }
          if (result.status === 'blocked') {
            stop(result.reason === 'source_changed' ? 'The email changed. Select it again.'
              : 'Email details could not be refreshed. Check the requested fields.');
            return;
          }
          const reloaded = await latest.current.reload(snapshot, transportId, result.extractionId, stillCurrent);
          if (!current()) return;
          if (!reloaded || !stillCurrent()) { stop('Email refresh paused to keep your edits.'); return; }
          setState({ key, status: 'ready' });
        } catch {
          stop('Email details could not be refreshed. Check the requested fields.');
        }
      };
      await poll();
    })().catch(() => stop('Email details could not be refreshed. Check the requested fields.'));
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [key, hasRoute, attempt]);
  const pending = Boolean(key && (!state || state.key !== key || state.status === 'checking'));
  return { pending, message: state?.key === key && state.status === 'blocked' ? state.message ?? null : null, retry };
}
