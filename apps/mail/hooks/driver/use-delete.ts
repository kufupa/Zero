import useBackgroundQueue from '@/hooks/ui/use-background-queue';
import { useMail } from '@/components/mail/use-mail';
import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { useThreads } from '@/hooks/use-threads';
import { m } from '@/paraglide/messages';
import { useState } from 'react';
import { toast } from 'sonner';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { useStats } from '@/hooks/use-stats';

const useDelete = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [mail, setMail] = useMail();
  const [{ refetch: refetchThreads }] = useThreads();
  const statsQuery = useStats() as ReturnType<typeof useStats> & {
    refetch?: () => Promise<unknown>;
  };
  const refetchStats = statsQuery.refetch ?? (async () => undefined);
  const { addToQueue } = useBackgroundQueue();
  const trpc = useTRPC();
  const { mutateAsync: deleteThread } = useMutation(trpc.mail.delete.mutationOptions());

  return {
    mutate: (id: string, type: 'thread' | 'email' = 'thread') => {
      setIsLoading(true);
      addToQueue(id);

      if (isFrontendOnlyDemo()) {
        return toast.promise(
          Promise.resolve().then(async () => {
            setMail({
              ...mail,
              bulkSelected: [],
            });
            setIsLoading(false);
            await refetchThreads();
            await refetchStats();
          }),
          {
            loading: m['common.actions.deletingMail'](),
            success: m['common.actions.deletedMail'](),
            error: m['common.actions.failedToDeleteMail'](),
          },
        );
      }

      return toast.promise(
        deleteThread({
          id,
        }),
        {
          loading: m['common.actions.deletingMail'](),
          success: m['common.actions.deletedMail'](),
          error: (error) => {
            console.error(`Error deleting ${type}:`, error);

            return m['common.actions.failedToDeleteMail']();
          },
          finally: async () => {
            setMail({
              ...mail,
              bulkSelected: [],
            });
            setIsLoading(false);
            await refetchThreads();
            await refetchStats();
          },
        },
      );
    },
    isLoading,
  };
};

export default useDelete;
