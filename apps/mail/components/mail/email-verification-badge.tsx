import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck } from '../icons/icons';
import React, { useMemo } from 'react';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import { mailVerifyEmailQueryKey, type ApiQueryContext } from '@/lib/api/query-options';

interface EmailVerificationBadgeProps {
  messageId: string | undefined;
}

export const EmailVerificationBadge: React.FC<EmailVerificationBadgeProps> = ({ messageId }) => {
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  const {
    data: verificationResult,
    isLoading,
    isError,
  } = useQuery({
    queryKey: mailVerifyEmailQueryKey(queryCtx, { id: messageId || '' }),
    queryFn: () => getFrontendApi().mail.verifyEmail({ id: messageId as string }),
    enabled: !!messageId && !frontendOnlyDemo && queryCtx.mode === 'legacy',
    staleTime: 5 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!verificationResult?.isVerified || isLoading || isError) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center">
          <CircleCheck className="h-4 w-4 fill-blue-600 text-blue-600 dark:fill-blue-500 dark:text-blue-500" />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-sm">
          Verified sender - This email passed email authentication (SPF/DKIM/DMARC) and BIMI
          validation
        </p>
      </TooltipContent>
    </Tooltip>
  );
};
