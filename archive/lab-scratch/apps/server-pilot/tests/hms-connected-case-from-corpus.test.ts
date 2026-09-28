import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const scriptPath = fileURLToPath(
  new URL('../scripts/hms-connected-case-from-corpus.mjs', import.meta.url),
);
const appDir = dirname(scriptPath);

function corpusRow(input: {
  messageId: string;
  direction: 'inbound' | 'outbound';
  timestamp: string;
  body: string;
  subject?: string;
}) {
  return {
    sourceRowId: `${input.direction}-${input.messageId}`,
    messageId: input.messageId,
    receivedAt: input.timestamp,
    body: input.body,
    privateMessage: {
      direction: input.direction,
      subject: input.subject ?? '',
      addresses: {
        from: [input.direction === 'inbound' ? 'guest@example.test' : 'hotel@example.test'],
      },
    },
  };
}

function runGenerator(thread: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'hms-connected-case-'));
  const corpusPath = join(directory, 'corpus.jsonl');
  const outputPath = join(directory, 'case.json');
  writeFileSync(corpusPath, `${JSON.stringify(thread)}\n`);
  try {
    execFileSync('pnpm', ['exec', 'tsx', scriptPath, corpusPath, outputPath], {
      cwd: appDir,
      stdio: 'pipe',
    });
    return JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, any>;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('connected corpus packet generator', () => {
  it('orders paired metadata by instant and preserves the real incoming ID', () => {
    const packet = runGenerator({
      recordType: 'thread',
      threadId: 'chronology',
      messages: [
        {
          timestamp: '2026-09-17T10:00:00Z',
          sourceRows: [
            corpusRow({
              messageId: 'incoming-real-id',
              direction: 'inbound',
              // 08:00Z; the reply below is 09:00Z despite its smaller wall clock.
              timestamp: '2026-09-17T10:00:00+02:00',
              body: 'Confirmation: TEST-1234',
            }),
          ],
        },
        {
          timestamp: '2026-09-17T09:00:00Z',
          sourceRows: [
            corpusRow({
              messageId: 'hotel-reply-id',
              direction: 'outbound',
              timestamp: '2026-09-17T09:00:00Z',
              body: 'held-out reply body',
              subject: 'Re: Confirmation TEST-1234',
            }),
          ],
        },
      ],
    });

    expect(packet.incoming.messageId).toBe('incoming-real-id');
    expect(packet.pairedReply).toEqual({
      messageId: 'hotel-reply-id',
      timestamp: '2026-09-17T09:00:00Z',
    });
    expect(packet.incoming.body).toBe('Confirmation: TEST-1234');
  });

  it('does not admit a candidate found only in the incoming subject', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hms-connected-case-'));
    const corpusPath = join(directory, 'corpus.jsonl');
    const outputPath = join(directory, 'case.json');
    writeFileSync(
      corpusPath,
      `${JSON.stringify({
        recordType: 'thread',
        threadId: 'subject-only',
        messages: [
          {
            timestamp: '2026-09-17T08:00:00Z',
            sourceRows: [
              corpusRow({
                messageId: 'incoming-subject-only',
                direction: 'inbound',
                timestamp: '2026-09-17T08:00:00Z',
                body: 'Please see attached.',
                subject: 'Confirmation: TEST-1234',
              }),
            ],
          },
          {
            timestamp: '2026-09-17T09:00:00Z',
            sourceRows: [
              corpusRow({
                messageId: 'reply-subject-only',
                direction: 'outbound',
                timestamp: '2026-09-17T09:00:00Z',
                body: 'held-out reply body',
                subject: 'Re: Confirmation TEST-1234',
              }),
            ],
          },
        ],
      })}\n`,
    );
    try {
      expect(() =>
        execFileSync('pnpm', ['exec', 'tsx', scriptPath, corpusPath, outputPath], {
          cwd: appDir,
          stdio: 'pipe',
        }),
      ).toThrow(/no unique connected exact candidate/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
