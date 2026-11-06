import { ReservationPaneHost } from '@/components/nava-pane/reservation-pane-host';
import { useOutlookBridge } from '@/lib/workstation/use-outlook-bridge';

export default function OutlookPanePage() {
  const bridge = useOutlookBridge();
  return <ReservationPaneHost bridge={bridge} />;
}
