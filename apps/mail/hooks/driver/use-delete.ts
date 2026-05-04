import useBackgroundQueue from '@/hooks/ui/use-background-queue';
import { useMail } from '@/components/mail/use-mail';
import { getFrontendApi } from '@/lib/api/client';
import { useMutation } from '@tanstack/react-query';
import { useThreads } from '@/hooks/use-threads';
import { useStats } from '@/hooks/use-stats';
import { m } from '@/paraglide/messages';
import { useState } from 'react';
import { toast } from 'sonner';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

const useDelete = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [mail, setMail] = useMail();
  const [{ refetch: refetchThreads }] = useThreads();
  const { refetch: refetchStats } = useStats();
  const { addToQueue } = useBackgroundQueue();
  const { mutateAsync: deleteThread } = useMutation({
    mutationFn: (input: { id: string }) => getFrontendApi().mail.deleteThread(input),
  });

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
            await Promise.all([refetchThreads(), refetchStats()]);
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
            await Promise.all([refetchThreads(), refetchStats()]);
          },
        },
      );
    },
    isLoading,
  };
};

export default useDelete;
