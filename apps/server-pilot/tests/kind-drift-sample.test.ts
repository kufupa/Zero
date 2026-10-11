import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  formatKindDriftReport,
  parseKindDriftArgs,
  summarizeKindDriftRows,
} from '../scripts/kind-drift-sample.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const SCRIPT = fileURLToPath(new URL('../scripts/kind-drift-sample.ts', import.meta.url));
const SERVER_ROOT = resolve(dirname(SCRIPT), '..');
const TRANSPORT = 'transport-centurion';
const PRIVATE_BODY_MARKER = 'do-not-print-this-mail-body';

describe('kind drift sample script', () => {
  it('parses and de-duplicates message ids from a file and positional arguments', () => {
    expect(
      parseKindDriftArgs(['--file', 'ids.txt', 'message-b', 'message-c'], () =>
        'message-a\nmessage-b\n',
      ),
    ).toEqual({ help: false, messageIds: ['message-a', 'message-b', 'message-c'] });
  });

  it('formats per-id origin and kind×origin counts without mail text', () => {
    const rows = [
      { messageId: 'message-a', kind: 'booking', origin: 'system_notice' },
      { messageId: 'message-b', kind: 'voucher_pop', origin: 'person' },
      { messageId: 'message-c', kind: 'booking', origin: 'system_notice' },
    ];

    expect(summarizeKindDriftRows(rows)).toEqual([
      {
        kind: 'booking',
        origin: 'system_notice',
        count: 2,
        messageIds: ['message-a', 'message-c'],
      },
      { kind: 'voucher_pop', origin: 'person', count: 1, messageIds: ['message-b'] },
    ]);
    expect(formatKindDriftReport(rows)).toBe(
      [
        'message_id\tkind\torigin',
        'message-a\tbooking\tsystem_notice',
        'message-b\tvoucher_pop\tperson',
        'message-c\tbooking\tsystem_notice',
        '',
        'kind\torigin\tcount\tmessage_ids',
        'booking\tsystem_notice\t2\tmessage-a,message-c',
        'voucher_pop\tperson\t1\tmessage-b',
      ].join('\n'),
    );
  });

  it('prints latest kind/origin per id and kind×origin counts without mail text', () =>
    withIngestionDb(async ({ db, url }) => {
      const ids = ['msg-kind-drift-a', 'msg-kind-drift-b', 'msg-kind-drift-c'];
      for (const [index, messageId] of ids.entries()) {
        await seedInboxThread(db, {
          threadId: `thread-kind-drift-${index}`,
          transportId: TRANSPORT,
          transportEmail: 'centurion@legacyhotels.co.za',
          messageId,
          fromAddress: 'guest@example.test',
          subject: `subject ${PRIVATE_BODY_MARKER}`,
          textBody: PRIVATE_BODY_MARKER,
        });
      }

      await db.insert(mailExtraction).values([
        {
          messageId: ids[0]!,
          extractorVersion: 'extract-old',
          status: 'succeeded',
          kind: 'voucher_pop',
          payload: { origin: 'person' },
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
        },
        {
          messageId: ids[0]!,
          extractorVersion: 'extract-new',
          status: 'succeeded',
          kind: 'booking',
          payload: { origin: 'system_notice' },
          createdAt: new Date('2026-10-02T00:00:00.000Z'),
        },
        {
          messageId: ids[1]!,
          extractorVersion: 'extract-new',
          status: 'succeeded',
          kind: 'booking',
          payload: { origin: 'system_notice' },
          createdAt: new Date('2026-10-02T00:00:00.000Z'),
        },
        {
          messageId: ids[2]!,
          extractorVersion: 'extract-new',
          status: 'succeeded',
          kind: 'voucher_pop',
          payload: { origin: 'person' },
          createdAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ]);

      const directory = mkdtempSync(join(tmpdir(), 'zero-kind-drift-'));
      const idsFile = join(directory, 'ids.txt');
      writeFileSync(idsFile, `${ids[0]}\n${ids[1]}\n`, 'utf8');
      let result;
      try {
        result = spawnSync(
          process.execPath,
          ['--import', 'tsx', SCRIPT, '--file', idsFile, ids[1]!, ids[2]!, 'msg-kind-drift-missing'],
          {
            cwd: SERVER_ROOT,
            encoding: 'utf8',
            env: { ...process.env, DATABASE_URL: url },
          },
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('message_id\tkind\torigin');
      expect(result.stdout).toContain(`${ids[0]}\tbooking\tsystem_notice`);
      expect(result.stdout).toContain(`${ids[1]}\tbooking\tsystem_notice`);
      expect(result.stdout).toContain(`${ids[2]}\tvoucher_pop\tperson`);
      expect(result.stdout).toContain('msg-kind-drift-missing\t(none)\t(none)');
      expect(result.stdout).toContain(`booking\tsystem_notice\t2\t${ids[0]},${ids[1]}`);
      expect(result.stdout).toContain(`voucher_pop\tperson\t1\t${ids[2]}`);
      expect(result.stdout).toContain('(none)\t(none)\t1\tmsg-kind-drift-missing');
      expect(result.stdout).not.toContain(PRIVATE_BODY_MARKER);

      const latestRows = await db
        .select({ kind: mailExtraction.kind })
        .from(mailExtraction)
        .where(eq(mailExtraction.messageId, ids[0]!));
      expect(latestRows).toHaveLength(2);
    }));
});
