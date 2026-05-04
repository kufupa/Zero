import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { defaultUserSettings } from '@/lib/domain/settings';
import { getFrontendApi } from '@/lib/api/client';
import { resolveMailMode } from '@/lib/runtime/mail-mode';
import { mailSettingsQueryKey, type ApiQueryContext } from '@/lib/api/query-options';
import { getBrowserTimezone } from '@/lib/timezones';
import { useSettings } from '@/hooks/use-settings';
import { m } from '@/paraglide/messages';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { resolveMailHtml } from '@/lib/mail/resolve-mail-html';
import { demoSetSettings } from '@/lib/demo/local-actions';

export async function persistTrustedSender(params: {
  senderEmail: string;
  data?: { settings?: typeof defaultUserSettings };
  isFrontendOnlyDemo: boolean;
  saveUserSettings: (settings: typeof defaultUserSettings) => Promise<{ success?: boolean }>;
  demoSetSettings: (settings: typeof defaultUserSettings) => Promise<unknown>;
}) {
  const existingSettings = params.data?.settings ?? {
    ...defaultUserSettings,
    timezone: getBrowserTimezone(),
  };

  const nextSettings = {
    ...existingSettings,
    trustedSenders: Array.from(new Set([...(existingSettings.trustedSenders ?? []), params.senderEmail])),
  };

  if (params.isFrontendOnlyDemo) {
    await params.demoSetSettings(nextSettings);
    return 'demo';
  }

  const { success } = await params.saveUserSettings(nextSettings);
  if (!success) {
    throw new Error('Failed to trust sender');
  }

  return 'backend';
}

interface MailContentProps {
  id: string;
  html: string;
  senderEmail: string;
}

export function MailContent({ id, html, senderEmail }: MailContentProps) {
  const { data, refetch } = useSettings();
  const queryClient = useQueryClient();
  const frontendOnlyDemo = isFrontendOnlyDemo();
  const isTrustedSender = useMemo(
    () => data?.settings?.externalImages || data?.settings?.trustedSenders?.includes(senderEmail),
    [data?.settings, senderEmail],
  );
  const [cspViolation, setCspViolation] = useState(false);
  const [temporaryImagesEnabled, setTemporaryImagesEnabled] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRootRef = useRef<ShadowRoot | null>(null);
  const { resolvedTheme } = useTheme();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  const { mutateAsync: saveUserSettings } = useMutation({
    mutationFn: (input: unknown) => getFrontendApi().settings.save(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mailSettingsQueryKey(queryCtx) });
    },
  });

  const { mutateAsync: trustSender } = useMutation({
    mutationFn: async () => {
      await persistTrustedSender({
        senderEmail,
        data: data ?? undefined,
        isFrontendOnlyDemo: frontendOnlyDemo,
        saveUserSettings: (nextSettings: typeof defaultUserSettings) =>
          saveUserSettings({
            ...nextSettings,
          }),
        demoSetSettings,
      });
    },
    onSuccess: () => {
      refetch();
    },
    onError: () => {
      toast.error('Failed to trust sender');
    },
  });

  const { mutateAsync: processEmailContent } = useMutation({
    mutationFn: (input: unknown) => getFrontendApi().mail.processEmailContent(input),
  });

  const {
    data: processedData,
    isError: isProcessEmailError,
    isFetched: hasProcessedEmailResponse,
  } = useQuery({
    queryKey: ['email-content', id, isTrustedSender || temporaryImagesEnabled, resolvedTheme],
    queryFn: async () => {
      const result = await processEmailContent({
        html,
        shouldLoadImages: isTrustedSender || temporaryImagesEnabled,
        theme: (resolvedTheme as 'light' | 'dark') || 'light',
      });

      return {
        html: result.processedHtml,
        hasBlockedImages: result.hasBlockedImages,
      };
    },
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    enabled: !frontendOnlyDemo && Boolean(html),
  });

  const resolvedHtml = useMemo(() => {
    if (processedData?.html) {
      return processedData.html;
    }

    if (frontendOnlyDemo || isProcessEmailError || hasProcessedEmailResponse) {
      return resolveMailHtml({
        rawHtml: html,
        processedHtml: processedData?.html,
      });
    }

    return null;
  }, [
    frontendOnlyDemo,
    hasProcessedEmailResponse,
    html,
    isProcessEmailError,
    processedData?.html,
  ]);

  useEffect(() => {
    if (processedData) {
      if (processedData.hasBlockedImages) {
        setCspViolation(true);
      }
    }
  }, [processedData]);

  useEffect(() => {
    if (!hostRef.current || shadowRootRef.current) return;

    shadowRootRef.current = hostRef.current.attachShadow({ mode: 'open' });
  }, []);

  useEffect(() => {
    if (!shadowRootRef.current || !resolvedHtml) return;

    shadowRootRef.current.innerHTML = resolvedHtml;
  }, [resolvedHtml]);

  const handleImageError = useCallback(
    (e: Event) => {
      const target = e.target as HTMLImageElement;
      if (target.tagName === 'IMG') {
        if (!(isTrustedSender || temporaryImagesEnabled)) {
          setCspViolation(true);
        }
        target.style.display = 'none';
      }
    },
    [isTrustedSender, temporaryImagesEnabled],
  );

  useEffect(() => {
    if (!shadowRootRef.current) return;

    const root = shadowRootRef.current;

    // Add event listeners for image errors and link clicks
    root.addEventListener('error', handleImageError, true);

    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'A') {
        e.preventDefault();
        const href = target.getAttribute('href');
        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
          window.open(href, '_blank', 'noopener,noreferrer');
        } else if (href && href.startsWith('mailto:')) {
          window.location.href = href;
        }
      }
    };

    root.addEventListener('click', handleClick);

    return () => {
      root.removeEventListener('error', handleImageError, true);
      root.removeEventListener('click', handleClick);
    };
  }, [resolvedHtml, handleImageError]);

  useEffect(() => {
    if (isTrustedSender || temporaryImagesEnabled) {
      setCspViolation(false);
    }
  }, [isTrustedSender, temporaryImagesEnabled]);

  return (
    <>
      {cspViolation && !isTrustedSender && !data?.settings?.externalImages && (
        <div className="flex items-center justify-start bg-amber-600/20 px-2 py-1 text-sm text-amber-600">
          <p>{m['common.actions.hiddenImagesWarning']()}</p>
          <button
            onClick={() => setTemporaryImagesEnabled(!temporaryImagesEnabled)}
            className="ml-2 cursor-pointer underline"
          >
            {temporaryImagesEnabled
              ? m['common.actions.disableImages']()
              : m['common.actions.showImages']()}
          </button>
          <button
            onClick={async () => {
              try {
                await trustSender();
              } catch (error) {
                console.error('Error trusting sender:', error);
              }
            }}
            className="ml-2 cursor-pointer underline"
          >
            {m['common.actions.trustSender']()}
          </button>
        </div>
      )}
      <div ref={hostRef} className={cn('mail-content w-full flex-1 overflow-scroll no-scrollbar px-4 text-black dark:text-white')} />
    </>
  );
}
