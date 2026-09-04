import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CatchupUploadContent } from './catchup-upload';

export function CatchupUploadDialog({
  trigger,
  open,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent showOverlay className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Outlook backup</DialogTitle>
          <DialogDescription>
            Upload sent email archives (.pst, .zip, .msg). Files are saved to secure storage for mailbox catch-up. Max 50 GB per file.
          </DialogDescription>
        </DialogHeader>
        <div className="pt-2">
          <CatchupUploadContent />
        </div>
      </DialogContent>
    </Dialog>
  );
}
