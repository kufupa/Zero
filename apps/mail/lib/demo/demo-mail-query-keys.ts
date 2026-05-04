/** React Query keys for demo-only mail list paths (partial match invalidates all search variants). */
export const DEMO_MAIL_LIST_DRAFTS_QUERY_PREFIX = ['demo', 'mail', 'listDrafts'] as const;

export function demoMailListDraftsQueryKey(search: string): readonly string[] {
  return [...DEMO_MAIL_LIST_DRAFTS_QUERY_PREFIX, search];
}
