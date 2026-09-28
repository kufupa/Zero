import {
  filterNotesForAudience,
  notesTracesContextDataSchema,
} from '../../../../../apps/server-pilot/src/hms/context-read-contracts.js';
import { describe, expect, it } from 'vitest';

const observedAt = '2026-09-17T12:00:00.000Z';
const expiresAt = '2026-09-17T12:05:00.000Z';

function known<T>(value: T) {
  return {
    state: 'known' as const,
    value,
    data: value,
    evidenceRef: 'evidence-notes-traces-sections',
    observedAt,
    sourceUpdatedAt: null,
    expiresAt,
  };
}

function unknown() {
  return {
    state: 'unknown' as const,
    value: null,
    data: null,
    reasonCode: 'NOT_APPLICABLE' as const,
    evidenceRef: 'evidence-notes-traces-sections',
    observedAt,
    sourceUpdatedAt: null,
    expiresAt,
  };
}

function item(
  ref: string,
  audience: 'staff_only' | 'customer_disclosable',
  customerPrintable: boolean,
  sourceKind: 'note' | 'trace',
) {
  return {
    noteRef: ref,
    resourceRef: 'reservation-parent-42',
    sourceKind: known(sourceKind),
    permittedText: known(`${sourceKind}-${ref}-text`),
    audience: known(audience),
    customerPrintable: known(customerPrintable),
    status: known('open'),
    dueAt: unknown(),
    deliveredAt: unknown(),
    method: unknown(),
    authorLabel: unknown(),
    createdAt: known(observedAt),
  };
}

function list(items: ReturnType<typeof item>[], nextCursor: string) {
  return {
    items,
    page: {
      returnedCount: items.length,
      hasMore: true,
      nextCursor,
    },
  };
}

describe('notes and traces section contract', () => {
  it('accepts typed traces while keeping legacy notes-only data parseable', () => {
    const notes = list([item('note-public', 'customer_disclosable', true, 'note')], 'notes-next');
    const traces = list(
      [item('trace-public', 'customer_disclosable', true, 'trace')],
      'traces-next',
    );

    const parsed = notesTracesContextDataSchema.parse({
      notes,
      traces: {
        state: 'available',
        data: traces,
        completeness: 'complete',
        issues: [],
      },
    });
    expect(parsed.traces).toMatchObject({
      state: 'available',
      data: { page: { returnedCount: 1, hasMore: true, nextCursor: 'traces-next' } },
    });

    const legacy = notesTracesContextDataSchema.parse({ notes });
    expect(legacy).not.toHaveProperty('traces');
  });

  it('filters private notes and traces for customers but preserves public text and bindings', () => {
    const notes = list(
      [
        item('note-private', 'staff_only', false, 'note'),
        item('note-public', 'customer_disclosable', true, 'note'),
      ],
      'notes-next',
    );
    const traces = list(
      [
        item('trace-private', 'staff_only', false, 'trace'),
        item('trace-public', 'customer_disclosable', true, 'trace'),
      ],
      'traces-next',
    );
    const data = notesTracesContextDataSchema.parse({
      notes: {
        state: 'available',
        data: notes,
        completeness: 'partial',
        issues: [{ code: 'PARTIAL_WINDOW', retryable: false, safeNextAction: 'manual_review' }],
      },
      traces: {
        state: 'available',
        data: traces,
        completeness: 'complete',
        issues: [],
      },
    });

    const filtered = filterNotesForAudience(data, 'customer');
    expect(filtered.notes).toMatchObject({
      state: 'available',
      completeness: 'partial',
      issues: [{ code: 'PARTIAL_WINDOW' }],
      data: {
        items: [{ noteRef: 'note-public', resourceRef: 'reservation-parent-42' }],
        page: { returnedCount: 1, hasMore: true, nextCursor: 'notes-next' },
      },
    });
    expect(filtered.traces).toMatchObject({
      state: 'available',
      data: {
        items: [{ noteRef: 'trace-public', resourceRef: 'reservation-parent-42' }],
        page: { returnedCount: 1, hasMore: true, nextCursor: 'traces-next' },
      },
    });
    expect(JSON.stringify(filtered)).not.toContain('private');
  });

  it('keeps private items for staff and leaves an unavailable traces section explicit', () => {
    const data = notesTracesContextDataSchema.parse({
      notes: list([item('note-private', 'staff_only', false, 'note')], 'notes-next'),
      traces: {
        state: 'unavailable',
        data: null,
        reasonCode: 'SURFACE_UNPROVEN',
        issues: [],
      },
    });

    const filtered = filterNotesForAudience(data, 'staff');
    expect(filtered.notes).toMatchObject({
      items: [{ noteRef: 'note-private' }],
      page: { returnedCount: 1, hasMore: true, nextCursor: 'notes-next' },
    });
    expect(filtered.traces).toEqual(data.traces);
  });

  it('rejects a malformed available traces section', () => {
    expect(() =>
      notesTracesContextDataSchema.parse({
        notes: list([], 'notes-next'),
        traces: {
          state: 'available',
          data: { items: [] },
          completeness: 'complete',
          issues: [],
        },
      }),
    ).toThrow();
  });

  it('requires an explicit section wrapper for traces while keeping legacy notes raw', () => {
    expect(() =>
      notesTracesContextDataSchema.parse({
        notes: list([], 'notes-next'),
        traces: list([], 'traces-next'),
      }),
    ).toThrow();

    expect(() =>
      notesTracesContextDataSchema.parse({
        notes: list([], 'notes-next'),
      }),
    ).not.toThrow();
  });
});
