import { CheckCircle2, AlertCircle, RefreshCw, Send, Sparkles } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { useOutlookBridge } from '@/lib/workstation/use-outlook-bridge';
import { createOperationId } from '@/lib/workstation/bridge-protocol';
import { OutlookPaneSignIn } from './outlook-pane-sign-in';
import { trpcClient } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { Badge } from '@/components/ui/badge';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

export default function OutlookPanePage() {
  const { isConnected, activeEmail, workstationInfo, capabilities, supportsAction, sendCommand } =
    useOutlookBridge();
  const replyRetry = useRef<{ key: string; operationId: string } | null>(null);
  const { data: session, isLoading } = useSession();
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<{
    bridge: boolean | null;
    activeEmail: boolean | null;
    folderTable: boolean | null;
    serverPing: boolean | null;
  }>({
    bridge: null,
    activeEmail: null,
    folderTable: null,
    serverPing: null,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-slate-950 text-slate-100">
        <p className="text-sm text-slate-400">Loading session…</p>
      </div>
    );
  }

  if (!session?.user) {
    return <OutlookPaneSignIn />;
  }

  const runComprehensiveTest = async () => {
    setTesting(true);
    const results = {
      bridge: false,
      activeEmail: false,
      folderTable: false,
      serverPing: false,
    };

    try {
      const pingResp = await sendCommand<
        Record<string, never>,
        { version?: string; workstationUser?: string }
      >('PING', {} as Record<string, never>);
      results.bridge = Boolean(pingResp?.version || pingResp?.workstationUser);

      const activeResp = await sendCommand<Record<string, never>, { subject?: string }>(
        'GET_ACTIVE_EMAIL',
        {} as Record<string, never>,
      );
      results.activeEmail = Boolean(activeResp?.subject || activeEmail?.subject);

      const folderResp = await sendCommand<
        { folder: string; count: number; offset: number },
        unknown
      >('GET_FOLDER_EMAILS', { folder: 'Inbox', count: 5, offset: 0 });
      results.folderTable =
        Array.isArray(folderResp) ||
        (typeof folderResp === 'object' &&
          folderResp !== null &&
          'items' in folderResp &&
          Array.isArray(folderResp.items));

      const srv = await trpcClient.workstation.ping.mutate({
        workstationUser: workstationInfo?.workstationUser ?? 'unknown',
        outlookEmail: session.user.email,
        outlookVersion: workstationInfo?.outlookVersion ?? 'unknown',
      });
      results.serverPing = srv?.status === 'ok';

      setTestResults(results);
      toast.success('System Verification Complete!');
    } catch (err) {
      setTestResults(results);
      toast.error(`Verification error: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setTesting(false);
    }
  };

  const handleInsertAiDraft = async () => {
    if (!activeEmail?.entryId) return;
    const key = `${activeEmail.storeId ?? ''}:${activeEmail.entryId}`;
    if (replyRetry.current?.key !== key) {
      replyRetry.current = { key, operationId: createOperationId() };
    }
    try {
      await sendCommand('CREATE_REPLY_DRAFT', {
        operationId: replyRetry.current.operationId,
        entryId: activeEmail.entryId,
        ...(activeEmail.storeId ? { storeId: activeEmail.storeId } : {}),
        htmlBody: `<div style="font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #1F497D;">
          <p>Dear Guest,</p>
          <p>Thank you for contacting Centurion Lake Hotel. We have confirmed availability for your requested stay.</p>
          <p>Warm regards,<br><strong>Centurion Reservations Team</strong></p>
        </div>`,
        replyAll: false,
        openInComposer: true,
      });
      replyRetry.current = null;
      toast.success('AI Draft opened in Outlook Composer!');
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('timed out'))) replyRetry.current = null;
      toast.error(
        `Could not insert draft: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col space-y-4 bg-slate-950 p-4 text-slate-100">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-white">
            <Sparkles className="h-5 w-5 text-amber-400" />
            Nava AI Reservationist
          </h1>
          <p className="text-xs text-slate-400">
            {session.user.email || workstationInfo?.workstationUser || 'Workstation Assistant'}
          </p>
        </div>
        <Badge
          variant={isConnected ? 'default' : 'destructive'}
          className="px-2 py-0.5 text-[10px]"
        >
          {isConnected
            ? `● Connected to Classic Outlook (${workstationInfo?.outlookVersion ?? 'version unknown'}; product/build unknown)`
            : '○ Disconnected'}
        </Badge>
      </div>

      {isConnected &&
        !capabilities &&
        workstationInfo?.bridgeProtocolVersion !== undefined &&
        workstationInfo.bridgeProtocolVersion < 3 && (
          <div
            role="alert"
            className="rounded border border-amber-500/50 bg-amber-950/40 p-3 text-xs text-amber-200"
          >
            This workstation has an older bridge. Update the Outlook add-in to use protocol v3
            actions.
          </div>
        )}

      <Card className="border-slate-800 bg-slate-900">
        <CardHeader className="p-3 pb-1">
          <CardTitle className="flex items-center justify-between text-xs uppercase tracking-wider text-slate-400">
            <span>Selected Outlook Email</span>
            <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-400">
              Preview
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 p-3 pt-2 text-xs">
          {activeEmail ? (
            <>
              <div>
                <p className="truncate text-sm font-semibold text-slate-200">
                  {activeEmail.subject}
                </p>
                <p className="truncate text-[11px] text-slate-400">
                  From: {activeEmail.senderName} &lt;{activeEmail.senderEmail}&gt;
                </p>
              </div>
              <div className="max-h-24 overflow-y-auto rounded border border-slate-800/80 bg-slate-950/60 p-2 text-[11px] text-slate-300">
                {activeEmail.bodyText.slice(0, 180)}
                {activeEmail.bodyText.length > 180 ? '...' : ''}
              </div>
            </>
          ) : (
            <p className="italic text-slate-500">Click any email in Outlook to inspect.</p>
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-800 bg-slate-900">
        <CardHeader className="p-3 pb-1">
          <CardTitle className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-amber-400">
            <Sparkles className="h-3.5 w-3.5" />
            AI Reservation Draft
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-3 pt-2 text-xs">
          <p className="text-[10px] uppercase tracking-wider text-amber-500/80">
            Sample placeholder — not live AI output
          </p>
          <div className="rounded border border-amber-800/40 bg-amber-950/20 p-2.5 text-[11px] leading-relaxed text-amber-200">
            “Thank you for contacting Centurion Lake Hotel. We have confirmed availability for your
            requested stay...”
          </div>
          <Button
            size="sm"
            className="h-8 w-full bg-amber-600 text-xs text-white hover:bg-amber-500"
            onClick={handleInsertAiDraft}
            disabled={!activeEmail || !supportsAction('CREATE_REPLY_DRAFT')}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            Insert Draft in Outlook
          </Button>
        </CardContent>
      </Card>

      <div className="pt-2">
        <Button
          onClick={runComprehensiveTest}
          disabled={testing}
          className="h-9 w-full bg-blue-600 text-xs font-medium text-white shadow-lg shadow-blue-950 hover:bg-blue-500"
        >
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${testing ? 'animate-spin' : ''}`} />
          Run System Verification
        </Button>
      </div>

      {(testResults.bridge !== null || testResults.serverPing !== null) && (
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Diagnostic Verification
          </p>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-300">1. C# VSTO Bridge Handshake</span>
              {testResults.bridge ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 text-rose-400" />
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-300">2. Active Outlook Email COM Read</span>
              {testResults.activeEmail ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 text-rose-400" />
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-300">3. Folder Table Query (Non-Blocking)</span>
              {testResults.folderTable ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 text-rose-400" />
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-300">4. Nava Cloud Server HTTPS Ping</span>
              {testResults.serverPing ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 text-rose-400" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
