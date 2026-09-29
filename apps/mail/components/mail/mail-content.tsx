import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useTheme } from 'next-themes';
import { defaultUserSettings } from '@zero/server/schemas';
import { useTRPC } from '@/providers/query-provider';
import { getBrowserTimezone } from '@/lib/timezones';
import { useSettings } from '@/hooks/use-settings';
import { m } from '@/paraglide/messages';
import { toast } from 'sonner';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { cleanHtml } from '@/lib/email-utils';
import { resolveMailDisplayContent } from '@/lib/mail/resolve-mail-display-html';
import { MAIL_PAPER_NEUTRALIZE_STYLE } from '@/lib/mail/mail-paper-neutralize';
import { isImageTrustedSender } from '@/lib/mail/trust-sender';
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

type ContentDigestState = {
  html: string;
  digest: string | null;
  hasError: boolean;
};

async function digestMailHtml(html: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function MailContent({ id, html, senderEmail }: MailContentProps) {
  const { data, refetch } = useSettings();
  const queryClient = useQueryClient();
  const frontendOnlyDemo = isFrontendOnlyDemo();
  // HOTFIX: skip the server processEmailContent gate while it can block
  // ordinary message bodies. The client fallback stays visible, and DOMPurify
  // sanitizes every resolved body immediately before shadow-DOM insertion.
  const shouldProcessContent = false;
  const [contentDigestRetry, setContentDigestRetry] = useState(0);
  const [contentDigestState, setContentDigestState] = useState<ContentDigestState>({
    html,
    digest: null,
    hasError: false,
  });
  const contentDigest =
    contentDigestState.html === html ? contentDigestState.digest : null;
  const contentDigestFailed =
    contentDigestState.html === html && contentDigestState.hasError;
  const isTrustedSender = useMemo(
    () =>
      isImageTrustedSender({
        senderEmail,
        externalImages: data?.settings?.externalImages,
        trustedSenders: data?.settings?.trustedSenders,
      }),
    [data?.settings, senderEmail],
  );
  const [cspViolation, setCspViolation] = useState(false);
  const [temporaryImagesEnabled, setTemporaryImagesEnabled] = useState(false);
  const [retryingContentKey, setRetryingContentKey] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRootRef = useRef<ShadowRoot | null>(null);
  const trpc = useTRPC();
  const shouldLoadImages = isTrustedSender || temporaryImagesEnabled;
  const { resolvedTheme } = useTheme();
  const processingTheme: 'light' | 'dark' =
    resolvedTheme === 'dark' ||
    (resolvedTheme !== 'light' &&
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark'))
      ? 'dark'
      : 'light';
  const contentQueryKey = [
    'email-content-v3',
    id,
    contentDigest,
    shouldLoadImages,
    processingTheme,
  ] as const;
  const contentQueryIdentity = JSON.stringify(contentQueryKey);
  const retryInFlightRef = useRef<string | null>(null);
  const focusContentAfterRetryRef = useRef<string | null>(null);
  const focusContentQueryIdentityRef = useRef(contentQueryIdentity);

  useEffect(() => {
    if (!shouldProcessContent) return;

    let cancelled = false;
    setContentDigestState({
      html,
      digest: null,
      hasError: false,
    });
    void digestMailHtml(html).then(
      (digest) => {
        if (!cancelled) {
          setContentDigestState({
            html,
            digest,
            hasError: false,
          });
        }
      },
      () => {
        if (!cancelled) {
          setContentDigestState({
            html,
            digest: null,
            hasError: true,
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [contentDigestRetry, html, shouldProcessContent]);

  const { mutateAsync: saveUserSettings } = useMutation({
    ...trpc.settings.save.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
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

  const { mutateAsync: processEmailContent } = useMutation(
    trpc.mail.processEmailContent.mutationOptions(),
  );

  const {
    data: processedData,
    isError: isProcessingError,
    isFetching: isProcessingFetching,
    isPending: isProcessingPending,
    isSuccess: isProcessingSuccess,
    refetch: refetchProcessedContent,
  } = useQuery({
    queryKey: contentQueryKey,
    queryFn: async () => {
      const result = await processEmailContent({
        html,
        messageId: id,
        shouldLoadImages,
        theme: processingTheme,
      });

      return {
        html: result.processedHtml,
        hasBlockedImages: result.hasBlockedImages,
      };
    },
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    enabled: shouldProcessContent && Boolean(contentDigest),
  });

  const isRetryingContent =
    shouldProcessContent &&
    (retryingContentKey === contentQueryIdentity || (isProcessingError && isProcessingFetching));
  const isContentDigestPending =
    shouldProcessContent && !contentDigest && !contentDigestFailed;
  const isLoadingContent =
    isContentDigestPending || (shouldProcessContent && isProcessingPending && !isRetryingContent);
  const isProcessingErrorState =
    shouldProcessContent && (contentDigestFailed || isProcessingError);
  const shouldRenderContent =
    frontendOnlyDemo ||
    !shouldProcessContent ||
    (!isContentDigestPending && !contentDigestFailed && isProcessingSuccess);

  const handleRetry = useCallback(() => {
    if (contentDigestFailed) {
      setContentDigestState({
        html,
        digest: null,
        hasError: false,
      });
      setContentDigestRetry((attempt) => attempt + 1);
      return;
    }

    const retryKey = contentQueryIdentity;
    if (retryInFlightRef.current === retryKey || isProcessingFetching) return;

    retryInFlightRef.current = retryKey;
    focusContentAfterRetryRef.current = retryKey;
    setRetryingContentKey(retryKey);
    void refetchProcessedContent()
      .then(
        (result) => result.isSuccess,
        () => false,
      )
      .then((isSuccess) => {
        if (!isSuccess && focusContentAfterRetryRef.current === retryKey) {
          focusContentAfterRetryRef.current = null;
        }
      })
      .finally(() => {
        if (retryInFlightRef.current === retryKey) {
          retryInFlightRef.current = null;
        }
        setRetryingContentKey((currentKey) => (currentKey === retryKey ? null : currentKey));
      });
  }, [
    contentDigestFailed,
    contentQueryIdentity,
    html,
    isProcessingFetching,
    refetchProcessedContent,
  ]);

  const resolvedDisplay = useMemo(
    () =>
      resolveMailDisplayContent({
        frontendOnlyDemo,
        processedHtml: processedData?.html,
        rawHtml: html,
        shouldLoadImages,
      }),
    [frontendOnlyDemo, html, processedData?.html, shouldLoadImages],
  );
  const resolvedHtml = resolvedDisplay.html;

  const shadowHtml = useMemo(() => {
    if (!resolvedHtml) return resolvedHtml;
    return processingTheme === 'dark'
      ? `${MAIL_PAPER_NEUTRALIZE_STYLE}${resolvedHtml}`
      : resolvedHtml;
  }, [processingTheme, resolvedHtml]);

  useEffect(() => {
    setCspViolation(isProcessingSuccess && processedData
      ? processedData.hasBlockedImages
      : resolvedDisplay.hasBlockedImages);
  }, [isProcessingSuccess, processedData?.hasBlockedImages, resolvedDisplay.hasBlockedImages]);

  useEffect(() => {
    if (focusContentQueryIdentityRef.current !== contentQueryIdentity) {
      focusContentQueryIdentityRef.current = contentQueryIdentity;
      focusContentAfterRetryRef.current = null;
    }
  }, [contentQueryIdentity]);

  useEffect(() => {
    const host = hostRef.current;
    if (!shouldRenderContent || !host) {
      shadowRootRef.current = null;
      return;
    }

    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    shadowRootRef.current = root;

    return () => {
      if (shadowRootRef.current === root) {
        shadowRootRef.current = null;
      }
    };
  }, [shouldRenderContent]);

  useEffect(() => {
    if (!shouldRenderContent || !shadowRootRef.current || !shadowHtml) return;

    shadowRootRef.current.innerHTML = cleanHtml(shadowHtml);
  }, [shadowHtml, shouldRenderContent]);

  useEffect(() => {
    if (
      focusContentAfterRetryRef.current !== contentQueryIdentity ||
      !isProcessingSuccess ||
      !shouldRenderContent ||
      !hostRef.current
    ) {
      return;
    }

    const activeElement = document.activeElement;
    const focusWasVacated =
      !activeElement ||
      activeElement === document.body ||
      activeElement === document.documentElement ||
      !document.contains(activeElement);
    if (focusWasVacated) {
      hostRef.current.focus();
    }
    focusContentAfterRetryRef.current = null;
  }, [contentQueryIdentity, isProcessingSuccess, shouldRenderContent]);

  const handleImageError = useCallback(
    (e: Event) => {
      const target = e.target as HTMLImageElement;
      if (target.tagName !== 'IMG') return;
      const src = target.getAttribute('src') ?? target.src ?? '';
      if (src.includes('/attachments/') && src.includes('/inline')) {
        target.removeAttribute('src');
        // Keep alt. Never treat CID inline fail as remote-block banner when trusted.
        return;
      }
      if (!(isTrustedSender || temporaryImagesEnabled)) {
        setCspViolation(true);
      }
      target.style.display = 'none';
    },
    [isTrustedSender, temporaryImagesEnabled],
  );

  useEffect(() => {
    if (!shouldRenderContent || !shadowRootRef.current) return;

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
  }, [resolvedHtml, handleImageError, shouldRenderContent]);

  useEffect(() => {
    if (isTrustedSender || temporaryImagesEnabled) {
      setCspViolation(false);
    }
  }, [isTrustedSender, temporaryImagesEnabled]);

  if (isLoadingContent) {
    return (
      <div role="status" aria-live="polite" className="px-4 py-3 text-sm">
        Loading message content safely…
      </div>
    );
  }

  if (isProcessingErrorState || isRetryingContent) {
    return (
      <div
        role={isRetryingContent ? 'status' : 'alert'}
        aria-live={isRetryingContent ? 'polite' : undefined}
        className="px-4 py-3 text-sm"
      >
        <p>
          {isRetryingContent
            ? 'Retrying message content…'
            : 'Unable to load message content safely. Please try again.'}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          disabled={isRetryingContent}
          aria-busy={isRetryingContent}
          aria-label="Retry message content"
          className="mt-2 cursor-pointer underline disabled:cursor-not-allowed"
        >
          Retry
        </button>
      </div>
    );
  }

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
      <div
        ref={hostRef}
        role="region"
        aria-label="Message content"
        tabIndex={-1}
        className="mail-content min-w-0 max-w-full w-full flex-1 overflow-scroll no-scrollbar px-4 bg-background text-foreground"
      />
    </>
  );
}
