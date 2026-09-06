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
import { useTRPC } from '@/providers/query-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useLabels } from '@/hooks/use-labels';
import { m } from '@/paraglide/messages';
import { Trash } from '../icons/icons';
import { CheckCheck } from 'lucide-react';
import { Button } from '../ui/button';
import { toast } from 'sonner';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { demoDeleteLabel } from '@/lib/demo/local-actions';

interface LabelSidebarContextMenuProps {
  children: ReactNode;
  labelId: string;
  hide?: boolean;
}

export type MarkFolderAsReadContextInput = {
  folder?: string;
  categoryId?: string;
  labelId?: string;
  isFrontendOnlyDemoMode: boolean;
  markAsReadMutation: (input: { folder?: string; categoryId?: string; labelId?: string }) => Promise<unknown>;
  invalidateQueries: () => Promise<unknown> | unknown;
  successMessage: string;
  errorMessage: string;
  onError?: (error: unknown) => void;
};

export async function markFolderAsReadInContext(input: MarkFolderAsReadContextInput): Promise<void> {
  try {
    if (input.isFrontendOnlyDemoMode) {
      toast.success(input.successMessage);
      return;
    }
    await input.markAsReadMutation({
      folder: input.folder,
      categoryId: input.categoryId,
      labelId: input.labelId,
    });
    await Promise.resolve(input.invalidateQueries());
    toast.success(input.successMessage);
  } catch (error) {
    if (input.onError) {
      input.onError(error);
    } else {
      toast.error(input.errorMessage);
    }
  }
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

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { mutateAsync: deleteLabel } = useMutation(trpc.labels.delete.mutationOptions());
  const { mutateAsync: markFolderAsRead } = useMutation(trpc.mail.markFolderAsRead.mutationOptions());
  const { refetch } = useLabels();

  const handleMarkAllAsRead = () => {
    void markFolderAsReadInContext({
      labelId,
      isFrontendOnlyDemoMode: isFrontendOnlyDemo(),
      markAsReadMutation: async (params) => markFolderAsRead(params),
      invalidateQueries: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.mail.unreadCounts.queryKey() });
        await queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.queryKey() });
      },
      successMessage: 'Marked all as read',
      errorMessage: 'Failed to mark all as read',
    });
  };

  const handleDelete = () => {
    void deleteLabelInSidebarContext({
      labelId,
      isFrontendOnlyDemoMode: isFrontendOnlyDemo(),
      setDeleteDialogOpen,
      deleteLabel: isFrontendOnlyDemo()
        ? (input) => demoDeleteLabel(input.id)
        : async (input) => {
            const result = await deleteLabel(input);
            return { success: result.deleted };
          },
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
            onClick={handleMarkAllAsRead}
            disabled={false}
            className="gap-2 text-sm"
          >
            <Button
              size={'sm'}
              variant="ghost"
              className="hover:bg-black/10 dark:hover:bg-[#404040] [&_svg]:size-3.5"
            >
              <CheckCheck className="text-muted-foreground" />
              <span>Mark all as read</span>
            </Button>
          </ContextMenuItem>
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
