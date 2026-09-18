import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export const OUTLOOK_SETUP_DOWNLOAD_HREF = '/download/NavaOutlookSetup.exe';

export function OutlookSetupDownloadButton() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex justify-end">
      <Button asChild variant="outline" size="sm">
        <a
          href={OUTLOOK_SETUP_DOWNLOAD_HREF}
          download="NavaOutlookSetup.exe"
          onClick={() => setOpen(true)}
        >
          <Download className="mr-2 h-4 w-4" />
          Download Outlook Setup
        </a>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showOverlay className="max-w-md">
          <DialogHeader>
            <DialogTitle>Install Nava in Outlook</DialogTitle>
            <DialogDescription>Your download started. Do these next:</DialogDescription>
          </DialogHeader>
          <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
            <li>Close Outlook</li>
            <li>
              Open Downloads and double-click <strong>NavaOutlookSetup.exe</strong>
            </li>
            <li>If Windows asks about a certificate, click Yes</li>
            <li>Open Outlook</li>
            <li>Click the Nava tab, then Nava Assistant</li>
          </ol>
        </DialogContent>
      </Dialog>
    </div>
  );
}
