import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { isFrontendOnlyDemo, resolveMailMode } from '@/lib/runtime/mail-mode';
import { listDemoTemplates } from '@/lib/demo/local-store';
import type { DemoTemplate } from '@/lib/demo/local-store';
import { getFrontendApi } from '@/lib/api/client';
import { templatesListQueryKey, type ApiQueryContext } from '@/lib/api/query-options';

type TemplateListResponse = {
  templates: DemoTemplate[];
};

export const useTemplates = () => {
  const demoMode = isFrontendOnlyDemo();
  const queryCtx = useMemo<ApiQueryContext>(
    () => ({ mode: resolveMailMode(), accountId: null }),
    [],
  );

  return useQuery({
    queryKey: demoMode ? (['demo', 'templates'] as const) : templatesListQueryKey(queryCtx),
    queryFn: () =>
      demoMode
        ? Promise.resolve({ templates: listDemoTemplates() } satisfies TemplateListResponse)
        : getFrontendApi().templates.list({}),
    enabled: demoMode || queryCtx.mode === 'legacy',
    staleTime: 1000 * 60 * 5,
  });
};
