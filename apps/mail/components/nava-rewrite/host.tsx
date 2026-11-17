'use client';

import { useState } from 'react';
import { OutlookPaneSignIn } from '@/app/(routes)/outlook-pane/outlook-pane-sign-in';
import { OutlookSyncProgress } from '@/components/workstation/outlook-sync-progress';
import { useActiveConnection } from '@/hooks/use-connections';
import { useSession } from '@/lib/auth-client';
import { resolvePublicBackendUrl } from '@/lib/public-backend-url';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { useOutlookSync } from '@/lib/workstation/use-outlook-sync';
import { createNavaApi } from './api';
import { NavaController } from './controller';
import { NavaPane, PaneMessage } from './pane';
import type { SelectedEmail } from './pane';
import type { ThreadInput } from './wire';

const api = createNavaApi({
  baseUrl: resolvePublicBackendUrl(),
  fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
});

type Source =
  | { status: 'ready'; input: ThreadInput }
  | { status: 'unavailable'; reason: string }
  | { status: 'loading'; reason: string };

function selectedEmail(bridge: PaneBridge): SelectedEmail | null {
  const email = bridge.activeEmail;
  if (!email || bridge.selectionOutsideMailbox) return null;
  const date = new Date(email.receivedTime);
  const validDate = !Number.isNaN(date.getTime());
  return {
    sender: email.senderName || email.senderEmail,
    subject: email.subject,
    ...(validDate ? { receivedLabel: date.toLocaleString(), receivedDateTime: email.receivedTime } : {}),
    ...(email.bodyText ? { body: email.bodyText } : {}),
  };
}

/** Host owns authentication, mailbox and native bridge; workflow calls use only the new API. */
export function NavaRewriteHost({ bridge, source, preview = false }: {
  bridge: PaneBridge;
  source: Source;
  preview?: boolean;
}) {
  const { data: session, isLoading: sessionLoading } = useSession();
  const { data: connection, isLoading: connectionLoading } = useActiveConnection();
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const sync = useOutlookSync({
    userId: session?.user?.id ?? null,
    sessionId: session?.session?.id ?? null,
    transportId: connection?.id ?? null,
    mailbox: connection?.email ?? '',
    deviceId: bridge.workstationInfo?.deviceId ?? null,
    capabilityVersion: bridge.capabilities?.mailboxSync,
    readRoots: bridge.capabilities?.readRoots ?? [],
    authorized: Boolean(bridge.isConnected && !bridge.requiresRelogin && !bridge.authorizationUnavailable),
    readOnlyStatus: preview,
    activateNative: bridge.activateMailboxSync,
  });

  if (sessionLoading || connectionLoading) return <p className="p-4 text-sm text-slate-600">Loading Nava…</p>;
  if (!session?.user || bridge.requiresRelogin) return <OutlookPaneSignIn />;

  const email = selectedEmail(bridge);
  const bridgeUnavailable = !preview && (bridge.updateRequired || bridge.selectionOutsideMailbox || bridge.authorizationUnavailable || !bridge.workstationInfo?.paired);
  const sourceMessage = bridge.updateRequired ? 'Update the Outlook add-in to open email in Nava.'
    : bridge.selectionOutsideMailbox ? 'Select an email in the connected mailbox.'
    : bridge.authorizationUnavailable ? 'Reconnect Outlook to open email in Nava.'
    : !preview && !bridge.workstationInfo?.paired ? 'Connect this Outlook to open email in Nava.'
    : source.status !== 'ready' && (preview || email) ? source.reason : null;
  const owner = JSON.stringify([session.user.id, session.session?.id, connection?.id]);

  return (
    <div className={`flex w-full min-w-0 min-h-0 flex-col overflow-hidden bg-white ${preview ? 'h-full' : 'h-screen'}`}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 text-xs text-slate-500">
        <span className="min-w-0 truncate">{connection?.email || 'Select a mailbox'}</span>
        <OutlookSyncProgress status={sync.status} notApplicable={sync.notApplicable} mailbox={connection?.email ?? ''}
          onControl={(operation) => { void sync.control(operation).catch(() => setBridgeError('Could not update Outlook sync. Try again.')); }}
          error={sync.error} busy={sync.busy} controlsEnabled={!preview && sync.eligible} />
      </div>
      {!preview && !bridge.workstationInfo?.paired && !bridge.updateRequired && <button type="button" className="m-3 rounded border p-2 text-sm"
        onClick={() => { setBridgeError(null); void bridge.pairDevice().catch(() => setBridgeError('Could not connect Outlook. Try again.')); }}>Connect this Outlook</button>}
      {!preview && bridge.authorizationUnavailable && <button type="button" className="m-3 rounded border p-2 text-sm"
        onClick={bridge.refreshAuthorization}>Reconnect Outlook</button>}
      {bridgeError && <p role="alert" className="px-3 py-2 text-sm">{bridgeError}</p>}
      {!bridgeUnavailable && source.status === 'ready' && email ? <NavaController key={owner} input={source.input} email={email} api={api} /> : <>
        <NavaPane email={email}>{sourceMessage && <PaneMessage>{sourceMessage}</PaneMessage>}</NavaPane>
        {!email && sourceMessage && <p role="status" className="px-4 pb-4 text-sm text-slate-600">{sourceMessage}</p>}
      </>}
    </div>
  );
}
