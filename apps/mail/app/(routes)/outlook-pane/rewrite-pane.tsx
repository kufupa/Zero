import { useEffect, useState } from 'react';
import { NavaRewriteHost } from '@/components/nava-rewrite/host';
import { useRewriteEligibility } from '@/components/nava-rewrite/eligibility';
import { webThreadInput } from '@/components/nava-rewrite/web-input';
import type { ThreadInput } from '@/components/nava-rewrite/wire';
import { useActiveConnection } from '@/hooks/use-connections';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import type { WorkstationEmailPayload } from '@/lib/workstation/bridge-protocol';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import type { ReservationSourceContext } from '@/components/nava-rewrite/source-types';
import { trpcClient } from '@/providers/query-provider';
import { htmlToPlainText } from '../../../../server-pilot/src/mail/inbound-reaction-parser';

type Source =
  | { status: 'ready'; input: ThreadInput; draftSource: ReservationSourceContext }
  | { status: 'loading'; reason: string }
  | { status: 'unavailable'; reason: string };

// Corroborate the synced copy with native content when the sender is resolvable.
async function selectedContentHash(email: WorkstationEmailPayload): Promise<string | undefined> {
  const body = ((email.bodyHtml && htmlToPlainText(email.bodyHtml)) || email.bodyText).replace(/\s+/g, ' ').trim();
  const headers = email.transportHeaders?.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/) ?? [];
  const senderHeader = (headers.find(line => /^Sender:/i.test(line)) ?? headers.find(line => /^From:/i.test(line)))
    ?.replace(/^[^:]+:\s*/, '').trim() ?? '';
  const senderValue = email.senderEmail.includes('@') ? email.senderEmail : senderHeader;
  const sender = (/<([^<>]+)>/.exec(senderValue)?.[1] ?? senderValue).trim().toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(sender)) return undefined;
  const value = JSON.stringify([email.subject.replace(/\s+/g, ' ').trim(), sender, body]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function OutlookRewritePane({ bridge }: { bridge: PaneBridge }) {
  const { data: session } = useSession();
  const { data: connection } = useActiveConnection();
  const eligibility = useRewriteEligibility(connection?.id);
  const email = bridge.activeEmail;
  const owner = session?.user?.id && connection?.id && email?.entryId && email.storeId
    ? JSON.stringify([session.user.id, session.session?.id, connection.id, email]) : null;
  if (eligibility === 'ineligible' || !owner || !email || !email.storeId || !connection?.id || !bridge.isConnected ||
      bridge.requiresRelogin || bridge.updateRequired || bridge.authorizationUnavailable ||
      bridge.selectionOutsideMailbox || !bridge.workstationInfo?.paired) return <NavaRewriteHost bridge={bridge} source={{ status: 'unavailable', reason: 'Select an email in an authorized mailbox to use Nava.' }} />;
  if (eligibility === 'checking') return <NavaRewriteHost bridge={bridge} source={{ status: 'loading', reason: 'Opening selected email…' }} />;
  return <OutlookRewriteSelection key={owner} bridge={bridge} owner={owner}
    email={email} storeId={email.storeId} mailboxId={connection.id} />;
}

function OutlookRewriteSelection({ bridge, owner, email, storeId, mailboxId }: {
  bridge: PaneBridge; owner: string; email: WorkstationEmailPayload; storeId: string; mailboxId: string;
}) {
  const [source, setSource] = useState<Source>({ status: 'loading', reason: 'Opening selected email…' });

  useEffect(() => {
    let live = true;
    const selected = email;
    const options = inMailbox(mailboxId);
    const load = async () => {
      if (isFrontendOnlyDemo()) {
        if (live) setSource({ status: 'unavailable', reason: 'Open a live mailbox to use Nava.' });
        return;
      }
      try {
        const contentHash = await selectedContentHash(selected);
        if (!live) return;
        const match = await trpcClient.paneSource.resolveSource.query({
          ...(selected.internetMessageId?.trim() ? { internetMessageId: selected.internetMessageId } : {}),
          selection: { kind: 'outlook', entryId: selected.entryId, storeId,
            ...(selected.folderEntryId ? { folderEntryId: selected.folderEntryId } : {}) },
          ...(contentHash ? { contentHash } : {}),
        }, options);
        if (!live) return;
        if (match.status !== 'ok' || match.propertyCode !== 'HRCEN' || match.source.propertyId !== match.propertyCode) {
          setSource({ status: 'unavailable', reason: 'Could not open this email in Nava. Select it again after mailbox sync.' });
          return;
        }
        const thread = await trpcClient.mail.get.query({ id: match.source.threadId, mergeLinked: true }, options);
        if (!live) return;
        const mapped = webThreadInput({ thread, requestedThreadId: match.source.threadId,
          selectedMessageId: match.source.messageId, connectionId: mailboxId, isDemo: false });
        setSource(mapped.status === 'ready'
          ? { status: 'ready', input: { ...mapped.input, source: 'outlook', property_code: match.propertyCode }, draftSource: {
            mailboxId, propertyId: match.propertyCode, messageId: match.source.messageId, threadId: match.source.threadId,
            sourceHash: match.source.sourceHash, arrivedAt: match.source.arrivedAt, internetMessageId: match.internetMessageId,
            selectionEpoch: 0, subject: match.sourceSubject, sender: match.sourceSender, attachments: match.attachments.filter(item => !item.isInline).map(item => ({
              sourceRef: item.id, name: item.filename, mimeType: item.mimeType, size: item.sizeBytes, uploadability: 'unknown' as const,
            })),
          } }
          : { status: 'unavailable', reason: mapped.reason });
      } catch {
        if (live) setSource({ status: 'unavailable', reason: 'Could not open this email in Nava. Try again after mailbox sync.' });
      }
    };
    void load();
    return () => { live = false; };
  }, [owner, email, storeId, mailboxId]);

  return <NavaRewriteHost bridge={bridge} source={source} />;
}
