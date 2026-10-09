import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { PaneBridge } from '@/lib/workstation/pane-bridge-types';
import { trpcClient } from '@/providers/query-provider';

export type SystemCheckResults = {
  bridge: boolean | null;
  activeEmail: boolean | null;
  folderTable: boolean | null;
  serverPing: boolean | null;
};

/**
 * The ⋯ menu's system check: four checks run in turn. Their results stay until the next run or a scope change.
 */
export function useSystemCheck({
  activeEmail,
  capabilities,
  detectedEmail,
  sendCommand,
}: {
  activeEmail: PaneBridge['activeEmail'];
  capabilities: PaneBridge['capabilities'];
  detectedEmail: string;
  sendCommand: PaneBridge['sendCommand'];
}) {
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<SystemCheckResults>({
    bridge: null,
    activeEmail: null,
    folderTable: null,
    serverPing: null,
  });
  // The check's results sit at the foot of the tool. A check started from the ⋯ menu brings them into view when it ends.
  useEffect(() => {
    if (!testing) document.getElementById('system-check-results')?.scrollIntoView?.({ block: 'nearest' });
  }, [testing]);

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
        { version?: string; bridgeProtocolVersion?: number }
      >('PING', {} as Record<string, never>);
      results.bridge = pingResp?.bridgeProtocolVersion === 4;

      const activeResp = await sendCommand<Record<string, never>, { subject?: string }>(
        'GET_ACTIVE_EMAIL',
        {} as Record<string, never>,
      );
      results.activeEmail = Boolean(activeResp?.subject || activeEmail?.subject);

      try {
        const folders = await sendCommand<
          Record<string, never>,
          {
            items: Array<{ entryId: string; defaultFolderType?: number }>;
            truncated: boolean;
          }
        >('LIST_FOLDERS', {});
        const inbox = folders.items.find((folder) => folder.defaultFolderType === 6);
        if (inbox) {
          const folderResp = await sendCommand<
            { folderEntryId: string; count: number; offset: number },
            { items: unknown[] }
          >('GET_FOLDER_EMAILS', { folderEntryId: inbox.entryId, count: 5, offset: 0 });
          results.folderTable = Array.isArray(folderResp.items);
        }
      } catch {
        // No approved Inbox ID: never fall back to a name-based or arbitrary folder read.
        results.folderTable = false;
      }

      const srv = await trpcClient.workstation.ping.mutate({
        workstationUser: 'unknown',
        outlookEmail: detectedEmail,
        outlookVersion: capabilities?.outlookVersion ?? 'unknown',
      });
      results.serverPing = srv?.status === 'ok';

      setTestResults(results);
      toast.success('System check complete.');
    } catch (err) {
      setTestResults(results);
      toast.error(`System check failed: ${err instanceof Error ? err.message : 'unknown error'}. Try again.`);
    } finally {
      setTesting(false);
    }
  };

  const resetTestResults = () =>
    setTestResults({ bridge: null, activeEmail: null, folderTable: null, serverPing: null });

  return { testing, testResults, runComprehensiveTest, resetTestResults };
}
