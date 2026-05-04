import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { getFrontendApi } from '@/lib/api/client';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useLabels } from '@/hooks/use-labels';
import { m } from '@/paraglide/messages';
import { Trash } from '../icons/icons';
import { Button } from '../ui/button';
import { toast } from 'sonner';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { demoDeleteLabel } from '@/lib/demo/local-actions';

interface LabelSidebarContextMenuProps {
  children: ReactNode;
  labelId: string;
  hide?: boolean;
}

export type LabelSidebarDeleteContextInput = {
  labelId: string;
  isFrontendOnlyDemoMode: boolean;
  setDeleteDialogOpen: (open: boolean) => void;
  deleteLabel: (input: { id: string }) => Promise<{ success: boolean }>;
  refetchLabels: () => Promise<unknown> | unknown;
  labelsSuccessMessage: string;
  errorMessage: string;
  onError: (error: unknown) => void;
};

export async function deleteLabelInSidebarContext(input: LabelSidebarDeleteContextInput): Promise<void> {
  try {
    if (input.isFrontendOnlyDemoMode) {
      await input.deleteLabel({ id: input.labelId });
      await Promise.resolve(input.refetchLabels());
      toast.success(input.labelsSuccessMessage);
      return;
    }

    const promise = input.deleteLabel({ id: input.labelId });
    toast.promise(promise, {
      success: input.labelsSuccessMessage,
      error: input.errorMessage,
      finally: () => {
        void Promise.resolve(input.refetchLabels());
        input.setDeleteDialogOpen(false);
      },
    });
    await promise;
  } catch (error) {
    input.onError(error);
  } finally {
    input.setDeleteDialogOpen(false);
  }
}

export function LabelSidebarContextMenu({ children, labelId, hide }: LabelSidebarContextMenuProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const { mutateAsync: deleteLabel } = useMutation({
    mutationFn: (input: unknown) => getFrontendApi().labels.delete(input),
  });
  const { refetch } = useLabels();

  const handleDelete = () => {
    void deleteLabelInSidebarContext({
      labelId,
      isFrontendOnlyDemoMode: isFrontendOnlyDemo(),
      setDeleteDialogOpen,
      deleteLabel: isFrontendOnlyDemo() ? demoDeleteLabel : (input) => deleteLabel(input),
      refetchLabels: refetch,
      labelsSuccessMessage: m['common.labels.deleteLabelSuccess'](),
      errorMessage: 'Error deleting label',
      onError: () => {
        setDeleteDialogOpen(false);
      },
    });
  };

  if (hide) return children;

  return (
    <>
      <ContextMenu modal={false}>
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
        <ContextMenuContent className="bg-white dark:bg-[#313131]">
          <ContextMenuItem
            asChild
            onClick={() => setDeleteDialogOpen(true)}
            disabled={false}
            className="gap-2 text-sm"
          >
            <Button
              size={'sm'}
              variant="ghost"
              className="hover:bg-[#FDE4E9] dark:hover:bg-[#411D23] [&_svg]:size-3.5"
            >
              <Trash className="fill-[#F43F5E]" />
              <span>{m['common.labels.deleteLabel']()}</span>
            </Button>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent showOverlay={true}>
          <DialogHeader>
            <DialogTitle>{m['common.labels.deleteLabelConfirm']()}</DialogTitle>
            <DialogDescription>
              {m['common.labels.deleteLabelConfirmDescription']()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="outline">{m['common.labels.deleteLabelConfirmCancel']()}</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button onClick={handleDelete}>
                {m['common.labels.deleteLabelConfirmDelete']()}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
