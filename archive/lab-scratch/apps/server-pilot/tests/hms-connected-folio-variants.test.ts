import {
  CONNECTED_FOLIO_MAX_PAGE_CALLS,
  runConnectedFolioPagingVariant,
} from '../src/hms/connected-folio-variants.js';
import { describe, expect, it } from 'vitest';

function page(input: {
  status?: string;
  scopeRef?: string;
  hasMore?: boolean | null;
  nextCursor?: string | null;
  returnedCount?: number;
}) {
  return {
    status: input.status ?? 'ok',
    completeness: 'complete' as const,
    scopeRef: input.scopeRef ?? 'reservation-1',
    page: {
      returnedCount: input.returnedCount ?? 1,
      hasMore: input.hasMore ?? false,
      nextCursor: input.nextCursor ?? null,
    },
    evidence: [{ sourceHash: 'a'.repeat(64) }],
    unavailableSections: [],
    issues: [],
  };
}

describe('bounded connected folio paging', () => {
  it('requests only transactions at limit 50 and follows a valid continuation', async () => {
    const requests: Array<{ cursor?: string; sections: string[]; limit: number }> = [];
    const result = await runConnectedFolioPagingVariant({
      resourceRef: 'reservation-1',
      execute: async (request) => {
        requests.push(request);
        return request.cursor === undefined
          ? page({ hasMore: true, nextCursor: 'cursor-1' })
          : page({ hasMore: false });
      },
    });

    expect(result.stopReason).toBe('exhausted');
    expect(requests).toEqual([
      { resourceRef: 'reservation-1', sections: ['transactions'], limit: 50 },
      { resourceRef: 'reservation-1', sections: ['transactions'], limit: 50, cursor: 'cursor-1' },
    ]);
    expect(result.calls).toHaveLength(2);
  });

  it('fails closed on a repeated cursor and never exceeds the hard call bound', async () => {
    let calls = 0;
    const result = await runConnectedFolioPagingVariant({
      resourceRef: 'reservation-1',
      execute: async () => {
        calls += 1;
        return page({ hasMore: true, nextCursor: 'same-cursor' });
      },
    });

    expect(result.stopReason).toBe('repeated_cursor');
    expect(calls).toBe(2);
    expect(calls).toBeLessThanOrEqual(CONNECTED_FOLIO_MAX_PAGE_CALLS);
  });

  it('stops when the provider scope or source status is not usable', async () => {
    const scopeMismatch = await runConnectedFolioPagingVariant({
      resourceRef: 'reservation-1',
      execute: async () => page({ scopeRef: 'other-reservation', hasMore: true, nextCursor: 'x' }),
    });
    expect(scopeMismatch.stopReason).toBe('scope_mismatch');

    const sourceFailure = await runConnectedFolioPagingVariant({
      resourceRef: 'reservation-1',
      execute: async () => page({ status: 'manual_required' }),
    });
    expect(sourceFailure.stopReason).toBe('source_failure');
  });
});
