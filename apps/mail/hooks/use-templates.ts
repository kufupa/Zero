import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { isFrontendOnlyDemo } from '@/lib/demo/runtime';
import { listDemoTemplates } from '@/lib/demo/local-store';
import type { DemoTemplate } from '@/lib/demo/local-store';

type TemplateListResponse = {
  templates: DemoTemplate[];
};

export const useTemplates = () => {
  const trpc = useTRPC();
  const demoMode = isFrontendOnlyDemo();

  if (demoMode) {
    return useQuery({
      queryKey: ['demo', 'templates'],
      queryFn: async (): Promise<TemplateListResponse> => ({
        templates: listDemoTemplates(),
      }),
      enabled: true,
      staleTime: 1000 * 60 * 5,
    });
  }

  return useQuery(
    trpc.templates.list.queryOptions(void 0, {
      staleTime: 1000 * 60 * 5,
    }),
  );
}; 