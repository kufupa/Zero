import { NavaRewriteHost } from '@/components/nava-rewrite/host';
import { useOutlookBridge } from '@/lib/workstation/use-outlook-bridge';

export default function OutlookPanePage() {
  const bridge = useOutlookBridge();
  return <NavaRewriteHost bridge={bridge} source={{
    status: 'unavailable',
    reason: 'This Outlook conversation is not available to Nava yet. Message directions and attachment access are required.',
  }} />;
}
