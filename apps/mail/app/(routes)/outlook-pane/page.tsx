import { NavaPane } from '@/components/nava-pane/nava-pane';
import { useOutlookBridge } from '@/lib/workstation/use-outlook-bridge';

export default function OutlookPanePage() {
  const bridge = useOutlookBridge();
  return <NavaPane bridge={bridge} />;
}
