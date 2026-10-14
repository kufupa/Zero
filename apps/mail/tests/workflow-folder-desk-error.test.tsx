/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useInfiniteQuery: vi.fn(),
  folder: 'quotes',
}));

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: (...args: unknown[]) => mocks.useInfiniteQuery(...args),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useQuery: () => ({ data: undefined, error: null }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('react-router', () => ({
  useParams: () => ({ folder: mocks.folder }),
}));

vi.mock('nuqs', () => ({
  useQueryState: () => [null, vi.fn()],
}));

vi.mock('@/hooks/use-threads', () => ({
  useThread: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/use-workflow-folder-summary', () => ({
  useWorkflowFolderSummary: () => ({ data: undefined }),
}));

vi.mock('@/lib/demo/runtime', () => ({
  isFrontendOnlyDemo: () => false,
}));

vi.mock('@/providers/query-provider', () => ({
  useTRPC: () => ({
    workflowFolders: {
      list: { infiniteQueryOptions: () => ({}) },
      thread: { queryOptions: () => ({}) },
      summary: { queryKey: () => ['workflowFolders', 'summary'] },
      setActionLabel: { mutationOptions: () => ({}) },
    },
    workItems: { adminReview: { mutationOptions: () => ({}) } },
  }),
}));

import { WorkflowFolderDesk } from '../components/mail/workflow-folder-desk';

describe('workflow folder desk errors', () => {
  beforeEach(() => {
    mocks.folder = 'quotes';
    mocks.useInfiniteQuery.mockReturnValue({
      data: undefined,
      error: new Error('X'),
      isError: true,
      isLoading: false,
      hasNextPage: false,
    });
  });

  afterEach(() => cleanup());

  it('shows the list query message in the owner-facing error notice', () => {
    render(<WorkflowFolderDesk />);

    expect(screen.getByRole('alert').textContent).toBe(
      'Could not load this workflow folder: X',
    );
  });

  it('keeps raw SQL out of the notice', () => {
    mocks.useInfiniteQuery.mockReturnValue({
      data: undefined,
      error: new Error('Failed query: select "id" from "message"\nparams: secret'),
      isError: true,
      isLoading: false,
      hasNextPage: false,
    });
    render(<WorkflowFolderDesk />);

    expect(screen.getByRole('alert').textContent).toBe(
      'Could not load this workflow folder: database query failed (see server logs)',
    );
  });
});
