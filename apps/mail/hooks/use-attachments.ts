import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

export const useAttachments = (messageId: string) => {
  const { data: session } = useSession();
  const trpc = useTRPC();
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const AttachmentsQuery = useQuery(
    trpc.mail.getMessageAttachments.queryOptions(
      { messageId },
      {
        enabled: !!session?.user.id && !!messageId && !frontendOnlyDemo,
        staleTime: 1000 * 60 * 60,
      },
    ),
  );

  return AttachmentsQuery;
};
