import { createThreadReviewBatchBuilder } from '../scripts/build-thread-review-batches';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BATCH_BYTE_TARGET = 700_000;

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'thread-review-batches-'));
  tempRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function messageBlock(input: {
  index: number;
  threadId: string;
  textBody?: string;
  htmlBody?: string | null;
}): string {
  const text = input.textBody ?? 'b'.repeat(40);
  const lines = [
    `## Message ${input.index}: synthetic-${input.index}`,
    '',
    '- **Message ID:** `msg-' + input.index + '`',
    '- **Thread ID:** `' + input.threadId + '`',
    '- **Transport ID:** `transport-x`',
    '- **Direction:** inbound',
    '- **Received:** 2026-08-01T00:00:00.000Z',
    '',
    '### Text body',
    '',
    '```text',
    text,
    '```',
  ];
  if (input.htmlBody !== null) {
    lines.push('', '### HTML body', '', '```html', input.htmlBody ?? '<p>' + text + '</p>', '```');
  }
  lines.push('', '---', '', '');
  return lines.join('\n');
}

async function writeDump(root: string, blocks: string[]): Promise<string> {
  const dumpPath = path.join(root, 'connected-mailbox-inbox.md');
  await writeFile(dumpPath, '# Connected mailbox message dump\n\n' + blocks.join(''));
  return dumpPath;
}

describe('createThreadReviewBatchBuilder', () => {
  it('rejects a missing dump file', async () => {
    const root = await makeTempRoot();
    const builder = createThreadReviewBatchBuilder();
    await expect(
      builder({
        dumpPath: path.join(root, 'nope.md'),
        outputRoot: path.join(root, 'batches'),
        batchByteTarget: BATCH_BYTE_TARGET,
      }),
    ).rejects.toThrow(/dump/i);
  });

  it('packs threads deterministically under the byte target and writes a manifest', async () => {
    const root = await makeTempRoot();
    await writeDump(root, [
      messageBlock({ index: 1, threadId: 't-1' }),
      messageBlock({ index: 2, threadId: 't-2' }),
      messageBlock({ index: 3, threadId: 't-3' }),
    ]);
    const builder = createThreadReviewBatchBuilder();
    const result = await builder({
      dumpPath: path.join(root, 'connected-mailbox-inbox.md'),
      outputRoot: path.join(root, 'batches'),
      batchByteTarget: BATCH_BYTE_TARGET,
    });
    expect(result.threadCount).toBe(3);
    expect(result.batchCount).toBe(1);

    const files = await readdir(path.join(root, 'batches'));
    expect(files).toContain('manifest.json');
    expect(files.some((f) => f.endsWith('.txt'))).toBe(true);

    const manifest = JSON.parse(
      await readFile(path.join(root, 'batches', 'manifest.json'), 'utf8'),
    );
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.threadCount).toBe(3);
    expect(manifest.batches).toHaveLength(1);
    expect(manifest.batches[0].threadIds).toEqual(['t-1', 't-2', 't-3']);
    expect(typeof manifest.batches[0].sha256).toBe('string');
  });

  it('splits into multiple batches when the byte cap is exceeded and never splits one thread across batches', async () => {
    const root = await makeTempRoot();
    await writeDump(root, [
      messageBlock({ index: 1, threadId: 't-a', textBody: 'a'.repeat(600) }),
      messageBlock({ index: 2, threadId: 't-b', textBody: 'a'.repeat(600) }),
      messageBlock({ index: 3, threadId: 't-c', textBody: 'a'.repeat(600) }),
    ]);
    const builder = createThreadReviewBatchBuilder();
    const result = await builder({
      dumpPath: path.join(root, 'connected-mailbox-inbox.md'),
      outputRoot: path.join(root, 'batches'),
      batchByteTarget: 900,
    });
    expect(result.batchCount).toBeGreaterThanOrEqual(2);

    const manifest = JSON.parse(
      await readFile(path.join(root, 'batches', 'manifest.json'), 'utf8'),
    );
    for (const batch of manifest.batches) {
      expect(batch.bytes).toBeLessThanOrEqual(900);
      expect(batch.oversize).toBe(false);
    }
    const allThreadIds = manifest.batches.flatMap((b: { threadIds: string[] }) => b.threadIds);
    expect(allThreadIds).toHaveLength(3);
    expect(new Set(allThreadIds).size).toBe(3);
  });

  it('solos an oversize thread larger than the byte cap instead of truncating it', async () => {
    const root = await makeTempRoot();
    await writeDump(root, [
      messageBlock({ index: 1, threadId: 'huge', textBody: 'h'.repeat(5_000) }),
      messageBlock({ index: 2, threadId: 'small', textBody: 's' }),
    ]);
    const builder = createThreadReviewBatchBuilder();
    const result = await builder({
      dumpPath: path.join(root, 'connected-mailbox-inbox.md'),
      outputRoot: path.join(root, 'batches'),
      batchByteTarget: 1_000,
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, 'batches', 'manifest.json'), 'utf8'),
    );

    const hugeBatch = manifest.batches.find((b: { threadIds: string[] }) =>
      b.threadIds.includes('huge'),
    );
    expect(hugeBatch).toBeDefined();
    expect(hugeBatch.threadIds).toEqual(['huge']);
    expect(hugeBatch.oversize).toBe(true);
    expect(hugeBatch.bytes).toBeGreaterThan(1_000);

    const smallBatch = manifest.batches.find((b: { threadIds: string[] }) =>
      b.threadIds.includes('small'),
    );
    expect(smallBatch).toBeDefined();
    expect(smallBatch.oversize).toBe(false);
    expect(result.batchCount).toBe(2);
  });

  it('emits compact semantic content with text body preferred and stripped-html fallback when text is empty', async () => {
    const root = await makeTempRoot();
    await writeDump(root, [
      messageBlock({
        index: 1,
        threadId: 't-text',
        textBody: 'PLAIN_BODY_MARKER',
        htmlBody: '<p>HTML_NOISE</p>',
      }),
      // Message 2: empty text body → builder must fall back to stripped html.
      messageBlock({
        index: 2,
        threadId: 't-html-only',
        textBody: '',
        htmlBody: '<p>Hello <b>world</b></p>',
      }),
    ]);
    const builder = createThreadReviewBatchBuilder();
    const result = await builder({
      dumpPath: path.join(root, 'connected-mailbox-inbox.md'),
      outputRoot: path.join(root, 'batches'),
      batchByteTarget: BATCH_BYTE_TARGET,
    });
    expect(result.batchCount).toBe(1);

    const batchFile = (await readdir(path.join(root, 'batches'))).find((f) => f.endsWith('.txt'));
    expect(batchFile).toBeDefined();
    const content = await readFile(path.join(root, 'batches', batchFile as string), 'utf8');

    // Text body kept verbatim.
    expect(content).toContain('PLAIN_BODY_MARKER');
    // HTML duplicate dropped when text body exists.
    expect(content).not.toContain('HTML_NOISE');
    // Stripped-html fallback keeps words, drops tags.
    expect(content).toContain('Hello world');
    expect(content).not.toContain('<p>');
    expect(content).not.toContain('<b>');
  });

  it('refuses to overwrite existing outputs unless overwrite is true', async () => {
    const root = await makeTempRoot();
    await writeDump(root, [messageBlock({ index: 1, threadId: 't-1' })]);
    const builder = createThreadReviewBatchBuilder();
    const first = await builder({
      dumpPath: path.join(root, 'connected-mailbox-inbox.md'),
      outputRoot: path.join(root, 'batches'),
      batchByteTarget: BATCH_BYTE_TARGET,
    });
    expect(first.batchCount).toBe(1);

    await expect(
      builder({
        dumpPath: path.join(root, 'connected-mailbox-inbox.md'),
        outputRoot: path.join(root, 'batches'),
        batchByteTarget: BATCH_BYTE_TARGET,
      }),
    ).rejects.toThrow(/exist/i);

    const second = await builder({
      dumpPath: path.join(root, 'connected-mailbox-inbox.md'),
      outputRoot: path.join(root, 'batches'),
      batchByteTarget: BATCH_BYTE_TARGET,
      overwrite: true,
    });
    expect(second.batchCount).toBe(1);
  });

  it('reports byte counts matching written batch files', async () => {
    const root = await makeTempRoot();
    await writeDump(root, [
      messageBlock({ index: 1, threadId: 't-1', textBody: 'x'.repeat(120) }),
      messageBlock({ index: 2, threadId: 't-2', textBody: 'y'.repeat(80) }),
    ]);
    const builder = createThreadReviewBatchBuilder();
    await builder({
      dumpPath: path.join(root, 'connected-mailbox-inbox.md'),
      outputRoot: path.join(root, 'batches'),
      batchByteTarget: BATCH_BYTE_TARGET,
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, 'batches', 'manifest.json'), 'utf8'),
    );
    for (const batch of manifest.batches) {
      const s = await stat(path.join(root, 'batches', batch.batchId + '.txt'));
      expect(s.size).toBe(batch.bytes);
    }
  });
});
