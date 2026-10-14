import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';
import {
  formatGoldenFreshJsonl,
  formatGoldenFreshSummary,
  goldenFreshSourceBody,
  parseGoldenFreshExtractArgs,
  resolveGoldenFreshOutputPath,
  runGoldenFreshExtract,
  summarizeGoldenFreshRows,
} from '../scripts/golden-fresh-extract.js';

const MODEL_OUTPUT = {
  sourceLanguage: 'en',
  kind: 'booking',
  origin: 'person',
  agency: null,
  endClient: null,
  contact: { name: null, email: null, phone: null },
  confirmationNumbers: [],
  stays: [],
  missing: [],
};

const SELECTION: SyncedQuoteSelection = {
  subject: 'Synthetic booking request',
  bodyText: 'Please book one room.',
  receivedAt: '2026-10-14T09:00:00.000Z',
  preceding: [],
  attachments: [],
  messageId: 'message-1',
  threadId: 'thread-1',
  fromAddress: 'guest@example.test',
};

function readOnlyDb(row: Record<string, unknown> | null) {
  const forbiddenWrites = {
    insert: vi.fn(() => {
      throw new Error('insert_called');
    }),
    update: vi.fn(() => {
      throw new Error('update_called');
    }),
    delete: vi.fn(() => {
      throw new Error('delete_called');
    }),
  };
  const tx = {
    ...forbiddenWrites,
    execute: vi.fn(async () => undefined),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => (row ? [row] : [])),
          })),
        })),
      })),
    })),
  };
  const db = {
    ...forbiddenWrites,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  return { db: db as unknown as Pick<DB, 'transaction'>, tx, forbiddenWrites };
}

function inboundMessage(fromAddress = 'guest@example.test', subject = 'Synthetic booking request') {
  return {
    id: 'message-1',
    transportId: 'transport-1',
    direction: 'inbound',
    fromAddress,
    subject,
    textBody: 'Please book one room.',
    htmlBody: null,
    mailbox: 'reservations@example.test',
  };
}

function fakeAdapter() {
  const adapter: ModelAdapter = {
    invoke: vi.fn(async () => ({
      modelId: 'gpt-6-luna',
      output: MODEL_OUTPUT,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        latencyMs: 1,
        estimatedCostUsd: 0,
        rateTableVersion: 'test',
      },
    })),
  };
  return adapter;
}

describe('golden fresh extract script', () => {
  it('caps the source-classifier body at the production admission limit', () => {
    const bounded = `${'a'.repeat(16_384)}ignored`;

    expect(goldenFreshSourceBody(bounded, 'html fallback')).toBe('a'.repeat(16_384));
    expect(goldenFreshSourceBody(null, 'html fallback')).toBe('html fallback');
  });

  it('parses JSON ids and positional ids, de-duplicates, and applies bounded defaults', () => {
    expect(
      parseGoldenFreshExtractArgs(
        ['--input', 'ids.json', '--out', '/tmp/out.jsonl', '--concurrency', '3', 'message-c'],
        () => JSON.stringify(['message-a', 'message-b', 'message-a']),
      ),
    ).toEqual({
      help: false,
      messageIds: ['message-a', 'message-b', 'message-c'],
      outPath: '/tmp/out.jsonl',
      concurrency: 3,
      timeoutMs: 60_000,
    });

    expect(
      parseGoldenFreshExtractArgs(['--out', '/tmp/out.jsonl', 'message-a']),
    ).toMatchObject({ concurrency: 2, timeoutMs: 60_000 });
  });

  it('rejects malformed id files and requires an output path', () => {
    expect(() =>
      parseGoldenFreshExtractArgs(['--input', 'ids.json', '--out', '/tmp/out.jsonl'], () => '{'),
    ).toThrow('input_json_invalid');
    expect(() => parseGoldenFreshExtractArgs(['message-a'])).toThrow('out_required');
  });

  it('rejects repository output paths, including symlinked parents', () => {
    const root = mkdtempSync(join(tmpdir(), 'zero-golden-fresh-'));
    const repository = join(root, 'repository');
    const outside = join(root, 'outside');
    mkdirSync(repository);
    mkdirSync(outside);
    symlinkSync(repository, join(outside, 'repository-link'), 'dir');
    try {
      expect(() =>
        resolveGoldenFreshOutputPath(join(repository, 'scores.jsonl'), repository, root),
      ).toThrow('out_inside_repo');
      expect(() =>
        resolveGoldenFreshOutputPath('repository-link/scores.jsonl', repository, outside),
      ).toThrow('out_inside_repo');
      expect(resolveGoldenFreshOutputPath('scores.jsonl', repository, outside)).toBe(
        join(outside, 'scores.jsonl'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the production extraction step for direct inbound mail without calling DB writers', async () => {
    const { db, tx, forbiddenWrites } = readOnlyDb(inboundMessage());
    const adapter = fakeAdapter();
    const loadSelection = vi.fn(async () => SELECTION);

    const rows = await runGoldenFreshExtract({
      messageIds: ['message-1'],
      db,
      loadSelection,
      adapter,
      concurrency: 2,
      timeoutMs: 1_000,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message_id: 'message-1',
      source: 'direct',
      status: 'succeeded',
      kind: 'booking',
      payload: {
        origin: 'person',
        agency: null,
        endClient: null,
        contact: { name: null, email: null, phone: null },
        confirmationNumbers: [],
        stays: [],
        missing: [],
      },
    });
    expect(loadSelection).toHaveBeenCalledWith({
      transportId: 'transport-1',
      messageId: 'message-1',
      signal: expect.any(AbortSignal),
    });
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    for (const writer of Object.values(forbiddenWrites)) expect(writer).not.toHaveBeenCalled();
  });

  it.each([
    ['channel', 'noreply@tiket.com', 'New reservation'],
    ['system', 'no-reply@hospitality.cloud', 'The Centurion Hotel Booking Secure Payment Link'],
  ] as const)('skips %s mail at the door before loading context or invoking a model', async (source, sender, subject) => {
    const { db } = readOnlyDb(inboundMessage(sender, subject));
    const adapter = fakeAdapter();
    const loadSelection = vi.fn(async () => SELECTION);

    const rows = await runGoldenFreshExtract({
      messageIds: ['message-1'],
      db,
      loadSelection,
      adapter,
      concurrency: 2,
      timeoutMs: 1_000,
    });

    expect(rows[0]).toEqual({
      message_id: 'message-1',
      source,
      status: 'skipped',
      kind: null,
      payload: null,
    });
    expect(loadSelection).not.toHaveBeenCalled();
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it('returns a bounded timeout row without waiting for a stuck context read', async () => {
    const { db } = readOnlyDb(inboundMessage());
    const adapter = fakeAdapter();
    const loadSelection = vi.fn(() => new Promise<SyncedQuoteSelection>(() => undefined));

    const rows = await runGoldenFreshExtract({
      messageIds: ['message-1'],
      db,
      loadSelection,
      adapter,
      concurrency: 1,
      timeoutMs: 5,
    });

    expect(rows[0]).toMatchObject({ status: 'failed', error_code: 'timeout', kind: null, payload: null });
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it('replaces raw context errors with a bounded code', async () => {
    const { db } = readOnlyDb(inboundMessage());
    const rows = await runGoldenFreshExtract({
      messageIds: ['message-1'],
      db,
      adapter: fakeAdapter(),
      loadSelection: vi.fn(async () => {
        throw new Error('PRIVATE_MAIL_MARKER');
      }),
      timeoutMs: 1_000,
    });

    expect(rows[0]).toMatchObject({ status: 'failed', error_code: 'error' });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_MAIL_MARKER');
  });

  it('keeps stdout summary to status/kind counts and JSONL preserves one row per id', () => {
    const rows = [
      {
        message_id: 'message-a',
        source: 'direct' as const,
        status: 'succeeded' as const,
        kind: 'booking' as const,
        payload: { private_value: 'PRIVATE_MAIL_MARKER' } as never,
      },
      {
        message_id: 'message-b',
        source: 'system' as const,
        status: 'skipped' as const,
        kind: null,
        payload: null,
      },
    ];

    expect(summarizeGoldenFreshRows(rows)).toEqual({
      statuses: { succeeded: 1, failed: 0, skipped: 1 },
      kinds: { '(none)': 1, booking: 1 },
    });
    expect(formatGoldenFreshSummary(rows)).not.toContain('PRIVATE_MAIL_MARKER');
    expect(formatGoldenFreshSummary(rows)).not.toContain('message-a');
    expect(formatGoldenFreshJsonl(rows).trimEnd().split('\n')).toHaveLength(2);
  });
});
