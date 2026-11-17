import { useOutlookBridge } from '@/lib/workstation/use-outlook-bridge';
import { OutlookRewritePane } from './rewrite-pane';

export default function OutlookPanePage() {
  const bridge = useOutlookBridge();
  return <OutlookRewritePane bridge={bridge} />;
}
