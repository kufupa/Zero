// @vitest-environment happy-dom
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createElement } from 'react';
const pending = vi.hoisted(() => new Map<string, (value: any) => void>());
vi.mock('../providers/query-provider', () => ({ useTRPC: () => rpc }));
vi.mock('../lib/auth-client', () => ({ useSession: () => ({ data: null }) }));
const rpc = {
  drafts: {
    getArtifact: {
      queryOptions: ({ draftId }: { draftId: string }) => ({
        queryKey: ['artifact', draftId],
        queryFn: () => new Promise((resolve) => pending.set(draftId, resolve)),
      }),
      queryKey: () => ['artifact'],
    },
  },
};
import { useDraftArtifactHydration } from '../hooks/use-drafts';
afterEach(() => {
  cleanup();
  pending.clear();
});
it('late draft A response cannot publish A bytes under draft B snapshot', async () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  const hash = async (s: string) =>
    Array.from(
      new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
  const a = {
      id: 'A',
      attachments: [
        {
          artifactRef: 'a',
          filename: 'a.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 6,
          sourceHash: await hash('%PDF-A'),
          state: 'available',
        },
      ],
    },
    b = {
      id: 'B',
      attachments: [
        {
          artifactRef: 'b',
          filename: 'b.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 6,
          sourceHash: await hash('%PDF-B'),
          state: 'available',
        },
      ],
    };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: any) => createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(({ draft }) => useDraftArtifactHydration(draft), {
    initialProps: { draft: a },
    wrapper,
  });
  await waitFor(() => expect(pending.has('A')).toBe(true));
  hook.rerender({ draft: b });
  expect(hook.result.current.files).toEqual([]);
  await waitFor(() => expect(pending.has('B')).toBe(true));
  await act(async () => pending.get('A')!({ base64: btoa('%PDF-A') }));
  expect(hook.result.current.files).toEqual([]);
  await act(async () => pending.get('B')!({ base64: btoa('%PDF-B') }));
  await waitFor(() => expect(hook.result.current.files[0]?.name).toBe('b.pdf'));
  expect(hook.result.current.snapshotKey).toContain('B');
});
