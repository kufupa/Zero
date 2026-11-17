import { useEffect, useMemo, useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { resolvePublicBackendUrl } from '@/lib/public-backend-url';

type Eligibility = 'checking' | 'eligible' | 'ineligible';

export function useRewriteEligibility(mailboxId: string | null | undefined): Eligibility {
  const { data: session, isLoading } = useSession();
  const userId = session?.user?.id;
  const sessionId = session?.session?.id;
  const requestKey = useMemo(() => ({}), [mailboxId, userId, sessionId, isLoading]);
  const [result, setResult] = useState<{ key: object; status: Eligibility } | null>(null);

  useEffect(() => {
    if (!mailboxId || isLoading || !userId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
      setResult({ key: requestKey, status: 'ineligible' });
    }, 10_000);
    const query = new URLSearchParams({ mailbox_id: mailboxId });
    void fetch(`${resolvePublicBackendUrl()}/api/nava/v1/eligibility?${query}`, {
      credentials: 'include', signal: controller.signal,
    }).then(async response => response.ok ? response.json() : null)
      .then((value: unknown) => {
        if (controller.signal.aborted) return;
        const eligible = typeof value === 'object' && value !== null && 'eligible' in value && value.eligible === true;
        setResult({ key: requestKey, status: eligible ? 'eligible' : 'ineligible' });
      }).catch(() => {
        if (!controller.signal.aborted) setResult({ key: requestKey, status: 'ineligible' });
      }).finally(() => window.clearTimeout(timer));
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [mailboxId, userId, isLoading, requestKey]);

  if (!mailboxId) return 'ineligible';
  if (isLoading) return 'checking';
  if (!userId) return 'ineligible';
  return result?.key === requestKey ? result.status : 'checking';
}
