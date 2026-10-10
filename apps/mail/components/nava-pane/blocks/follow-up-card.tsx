import { useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryStates } from 'nuqs';
import { sanitizeMailBodyHtml } from '@/lib/mail/sanitize-mail-body-html';
import { FOLLOW_UP_COPY, followUpClientFromTrpc, type FollowUp } from '@/lib/quote-workflow/follow-up';
import { createOperationId, type MailLocation } from '@/lib/workstation/bridge-protocol';
import { beginMutation, endMutation } from '@/lib/workstation/mutations-in-flight';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { Notice, PrimaryButton, SecondaryButton, Section } from '../pane-ui';

type Busy = 'using' | 'dismissing' | 'inserting' | null;

type ReplyPayload = {
  operationId: string;
  entryId: string;
  storeId: string;
  folderEntryId: string;
  htmlBody: string;
  replyAll: false;
  openInComposer: false;
};

// Outlook accepts an operation ID for 15 minutes. A retry inside that window replays the same ID and body, so a draft
// that Outlook made but did not confirm is not made twice (as in use-insert-ai-draft).
const REPLAY_WINDOW_MS = 14 * 60 * 1000;

/**
 * Inserts Outlook did not confirm, by follow-up draft id. Kept outside the card, which is keyed by the selected email
 * and remounts when staff switch away and back, so a retry still replays the same operation.
 */
const unconfirmedInserts = new Map<string, { payload: ReplyPayload; startedAt: number }>();

const sanitiseFollowUpHtml = (html: string) =>
  html ? sanitizeMailBodyHtml(html, { shouldLoadImages: true, inlineStyles: true }).html : '';

/**
 * Webmail only: opens the used draft in the reply box, the same compose state the thread's Edit draft sets. Any open
 * reply is closed first, so the composer remounts with this draft; left open it would keep the replaced reply's body
 * and only switch where it saves, and the next save would overwrite the follow-up.
 */
function OpenInReplyBox({ activeReplyId, draftId }: { activeReplyId: string; draftId: string }) {
  const [, setCompose] = useQueryStates({
    mode: parseAsString,
    activeReplyId: parseAsString,
    draftId: parseAsString,
  });
  async function open() {
    await setCompose({ mode: null, activeReplyId: null, draftId: null });
    await setCompose({ mode: 'reply', activeReplyId, draftId });
  }
  return (
    <PrimaryButton tone="green" onClick={() => void open()}>
      {FOLLOW_UP_COPY.openReply}
    </PrimaryButton>
  );
}

/**
 * The quote follow-up on the selected guest email's thread. Shows only when the server holds one: suggested (not yet
 * used) with Use and Dismiss, or in reply (used, not sent) with the insert or open action. Keyed by the email by the
 * caller, so it resets on a selection change.
 */
export function FollowUpCard({
  bridge,
  preview = false,
  trpc,
}: {
  bridge: Pick<PaneBridge, 'activeEmail' | 'sendCommand' | 'supportsAction'>;
  /** The webmail preview. It opens the draft in the reply box instead of inserting it into Outlook. */
  preview?: boolean;
  trpc: unknown;
}) {
  const { activeEmail, sendCommand, supportsAction } = bridge;
  const client = useMemo(() => followUpClientFromTrpc(trpc), [trpc]);
  const internetMessageId = activeEmail?.internetMessageId ?? null;
  const [loaded, setLoaded] = useState(false);
  const [followUp, setFollowUp] = useState<FollowUp | null>(null);
  const [conflict, setConflict] = useState(false);
  const [inserted, setInserted] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const previewHtml = useMemo(() => sanitiseFollowUpHtml(followUp?.htmlBody ?? ''), [followUp?.htmlBody]);

  useEffect(() => {
    if (!client || !internetMessageId) return;
    let live = true;
    client.find({ internetMessageId }).then(
      (found) => {
        if (!live) return;
        setFollowUp(found);
        setLoaded(true);
      },
      // ponytail: a failed lookup shows no card. The quote work item still says needs you.
      () => {
        if (live) setLoaded(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, internetMessageId]);

  async function use(replaceActive: boolean) {
    if (!client || !followUp) return;
    setBusy('using');
    setNotice(null);
    try {
      const result = await client.use({ draftId: followUp.id, replaceActive });
      if (result.status === 'used') {
        setFollowUp(result.followUp);
        setConflict(false);
      } else if (result.status === 'active_exists') {
        setConflict(true);
      } else {
        setFollowUp(null);
        setNotice(FOLLOW_UP_COPY.gone);
      }
    } catch {
      setNotice(FOLLOW_UP_COPY.failed);
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    if (!client || !followUp) return;
    setBusy('dismissing');
    setNotice(null);
    try {
      const result = await client.dismiss({ draftId: followUp.id });
      setFollowUp(null);
      if (result === 'gone') setNotice(FOLLOW_UP_COPY.gone);
    } catch {
      setNotice(FOLLOW_UP_COPY.failed);
    } finally {
      setBusy(null);
    }
  }

  // If Outlook gives no confirmation the draft may still exist, so the notice says to check Drafts. A retry replays the
  // same operation; once its window has closed, staff confirm they checked Drafts before a new one starts.
  async function insertInOutlook() {
    if (!activeEmail || !followUp) return;
    if (!activeEmail.storeId || !activeEmail.folderEntryId) {
      setNotice(FOLLOW_UP_COPY.reselect);
      return;
    }
    let pending = unconfirmedInserts.get(followUp.id) ?? null;
    if (pending && Date.now() - pending.startedAt >= REPLAY_WINDOW_MS) {
      // oxlint-disable-next-line no-alert
      if (!window.confirm(FOLLOW_UP_COPY.confirmNew)) return;
      pending = null;
    }
    pending ??= {
      startedAt: Date.now(),
      payload: {
        operationId: createOperationId(),
        entryId: activeEmail.entryId,
        storeId: activeEmail.storeId,
        folderEntryId: activeEmail.folderEntryId,
        htmlBody: previewHtml,
        replyAll: false,
        openInComposer: false,
      },
    };
    unconfirmedInserts.set(followUp.id, pending);
    setBusy('inserting');
    setNotice(null);
    beginMutation();
    try {
      const location = await sendCommand<ReplyPayload, MailLocation>('CREATE_REPLY_DRAFT', pending.payload);
      if (!location?.entryId || !location.storeId || !location.folderEntryId) {
        setNotice(FOLLOW_UP_COPY.insertFailed);
        return;
      }
      unconfirmedInserts.delete(followUp.id);
      setInserted(true);
    } catch {
      setNotice(FOLLOW_UP_COPY.insertFailed);
    } finally {
      endMutation();
      setBusy(null);
    }
  }

  if (!loaded || (!followUp && !notice)) return null;
  const canInsert = supportsAction('CREATE_REPLY_DRAFT');

  return (
    <Section title={FOLLOW_UP_COPY.heading}>
      {followUp ? (
        <>
          <p className="text-[11px] text-[#64748b]">
            {followUp.state === 'in_reply' ? FOLLOW_UP_COPY.inReply : FOLLOW_UP_COPY.caption}
          </p>
          {previewHtml ? (
            <div
              className="rounded-sm border border-[#cbd5e1] bg-white p-3 text-xs leading-relaxed text-[#1e293b]"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : null}
          {followUp.state === 'suggested' && conflict ? (
            <>
              <Notice tone="warn" role="alert">
                <strong>{FOLLOW_UP_COPY.replaceQuestion}</strong> {FOLLOW_UP_COPY.replaceDetail}
              </Notice>
              <PrimaryButton
                loading={busy === 'using'}
                loadingText={FOLLOW_UP_COPY.using}
                onClick={() => void use(true)}
              >
                {FOLLOW_UP_COPY.replace}
              </PrimaryButton>
              <SecondaryButton disabled={busy !== null} onClick={() => setConflict(false)}>
                {FOLLOW_UP_COPY.keep}
              </SecondaryButton>
            </>
          ) : followUp.state === 'suggested' ? (
            <>
              <PrimaryButton
                loading={busy === 'using'}
                loadingText={FOLLOW_UP_COPY.using}
                disabled={busy !== null}
                onClick={() => void use(false)}
              >
                {FOLLOW_UP_COPY.use}
              </PrimaryButton>
              <SecondaryButton disabled={busy !== null} onClick={() => void dismiss()}>
                {FOLLOW_UP_COPY.dismiss}
              </SecondaryButton>
            </>
          ) : inserted ? (
            <Notice tone="success" role="status">
              {FOLLOW_UP_COPY.inserted}
            </Notice>
          ) : preview ? (
            <OpenInReplyBox activeReplyId={activeEmail?.entryId ?? ''} draftId={followUp.id} />
          ) : (
            <PrimaryButton
              tone="green"
              loading={busy === 'inserting'}
              loadingText={FOLLOW_UP_COPY.inserting}
              disabled={busy !== null || !canInsert}
              disabledReason={canInsert ? null : FOLLOW_UP_COPY.noInsert}
              onClick={() => void insertInOutlook()}
            >
              {FOLLOW_UP_COPY.insert}
            </PrimaryButton>
          )}
        </>
      ) : null}
      {notice ? (
        <Notice tone="error" role="alert">
          {notice}
        </Notice>
      ) : null}
    </Section>
  );
}
