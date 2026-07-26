import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/providers/query-provider';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { m } from '@/paraglide/messages';
import { toast } from 'sonner';
import { useQueryState } from 'nuqs';

type EmptySpamButtonProps = {
  onCompleted: () => void;
};

export function EmptySpamButton({ onCompleted }: EmptySpamButtonProps) {
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();
  const [open, setOpen] = useState(false);
  const [, setThreadId] = useQueryState('threadId');

  const { mutateAsync: emptySpam, isPending } = useMutation(
    trpc.mail.emptySpam.mutationOptions(),
  );

  const handleConfirm = useCallback(async () => {
    if (demoMode) {
      toast.message(m['common.actions.featureNotImplemented']());
      setOpen(false);
      return;
    }

    try {
      const result = await emptySpam();
      setOpen(false);
      setThreadId(null);
      onCompleted();
      toast.success(m['common.actions.deletedAllSpam']({ count: result.updated }));
    } catch {
      toast.error(m['common.actions.errorDeletingSpam']());
    }
  }, [demoMode, emptySpam, onCompleted, setThreadId]);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-10 shrink-0 rounded-lg"
        onClick={() => setOpen(true)}
      >
        {m['common.actions.deleteAllSpam']()}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showOverlay className="z-99999 sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{m['common.actions.confirmDeleteSpam']()}</DialogTitle>
            <DialogDescription>
              {m['common.actions.confirmDeleteSpamDescription']()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              {m['common.actions.cancel']()}
            </Button>
            <Button onClick={() => void handleConfirm()} disabled={isPending}>
              {isPending ? m['common.actions.deletingAllSpam']() : m['common.actions.deleteAllSpam']()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
