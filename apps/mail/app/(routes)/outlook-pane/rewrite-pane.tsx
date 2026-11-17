import { useEffect, useState } from 'react';
import { ReservationPaneHost } from '@/components/nava-pane/reservation-pane-host';
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
import { trpcClient } from '@/providers/query-provider';
import { htmlToPlainText } from '../../../../server-pilot/src/mail/inbound-reaction-parser';

type Source =
  | { status: 'ready'; input: ThreadInput }
  | { status: 'loading'; reason: string }
  | { status: 'fallback' };

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
      bridge.selectionOutsideMailbox || !bridge.workstationInfo?.paired) return <ReservationPaneHost bridge={bridge} />;
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
        if (live) setSource({ status: 'fallback' });
        return;
      }
      try {
        const contentHash = await selectedContentHash(selected);
        if (!live) return;
        const match = await trpcClient.reservationWorkflowV2.resolveSource.query({
          ...(selected.internetMessageId?.trim() ? { internetMessageId: selected.internetMessageId } : {}),
          selection: { kind: 'outlook', entryId: selected.entryId, storeId,
            ...(selected.folderEntryId ? { folderEntryId: selected.folderEntryId } : {}) },
          ...(contentHash ? { contentHash } : {}),
        }, options);
        if (!live) return;
        if (match.status !== 'ok' || match.propertyCode !== 'HRCEN' || match.source.propertyId !== match.propertyCode) {
          setSource({ status: 'fallback' });
          return;
        }
        const thread = await trpcClient.mail.get.query({ id: match.source.threadId, mergeLinked: true }, options);
        if (!live) return;
        if (thread.messages.some(message => message.id === match.source.messageId && (!message.body.trim() ||
            message.body === message.processedHtml && /<[a-z][\s\S]*>/i.test(message.body)))) {
          setSource({ status: 'fallback' });
          return;
        }
        const mapped = webThreadInput({ thread, requestedThreadId: match.source.threadId,
          selectedMessageId: match.source.messageId, connectionId: mailboxId, isDemo: false });
        setSource(mapped.status === 'ready'
          ? { status: 'ready', input: { ...mapped.input, source: 'outlook', property_code: match.propertyCode } }
          : { status: 'fallback' });
      } catch {
        if (live) setSource({ status: 'fallback' });
      }
    };
    void load();
    return () => { live = false; };
  }, [owner, email, storeId, mailboxId]);

  if (source.status === 'fallback') return <ReservationPaneHost bridge={bridge} />;
  return <NavaRewriteHost bridge={bridge} source={source} />;
}
