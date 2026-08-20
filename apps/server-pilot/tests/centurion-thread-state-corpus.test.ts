import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  malformedBlockFixture,
  THREAD_STATE_SOURCE,
  threadStateMessages,
} from './fixtures/centurion-thread-state-corpus.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

const legacyMarkdownDumpPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../scripts/dump-centurion-emails-md.mjs',
);

async function loadCorpus() {
  return import('../src/ops/centurion-thread-state-corpus.js');
}

async function loadRunner() {
  return import('../scripts/export-centurion-thread-state-corpus.ts');
}

describe('Centurion thread-state corpus', () => {
  it('exposes a strict canonical parser contract', async () => {
    await expect(loadCorpus()).resolves.toEqual(
      expect.objectContaining({
        createCenturionThreadStateSourceManifest: expect.any(Function),
        parseCenturionThreadStateCorpus: expect.any(Function),
        parsePersistedCenturionThreadStateCorpus: expect.any(Function),
        validateCenturionThreadStateOutputTarget: expect.any(Function),
      }),
    );
  });

  it('normalizes structured records, cutoffs, linkage, and digests', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    const corpus = corpusApi.parseCenturionThreadStateCorpus({
      source: clone(THREAD_STATE_SOURCE),
      manifest: corpusApi.createCenturionThreadStateSourceManifest(messages),
      messages,
    });

    expect(corpus.source).toMatchObject({
      schemaVersion: 'centurion_message_projection_v1',
      eventCutoff: '2026-08-02T00:00:00.000Z',
      ingestCutoff: '2026-08-02T00:00:00.000Z',
    });
    expect(corpus.messages.map((message: { id: string }) => message.id)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(corpus.messages[1]).toMatchObject({
      eventAt: '2026-08-01T09:00:00.000Z',
      participants: {
        from: 'sender@example.test',
        to: ['recipient@example.test'],
      },
      subject: 'Status update',
      headers: {
        messageId: 'message-2@fixture.test',
        inReplyTo: 'root-1@fixture.test',
        references: ['root-1@fixture.test'],
      },
      textBody: 'first line\nsecond line',
      htmlBody: '<p>first line</p>',
    });
    for (const message of corpus.messages) {
      expect(message.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(corpus.manifest).toMatchObject({
      messageCount: 2,
      threadCount: 1,
      messageIdsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      messageThreadPairsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceRowsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      corpusSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('uses direction-specific event timestamps without opposite-direction fallback', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    messages[0].sentAt = '2026-08-01T11:00:00.000Z';
    messages[0].receivedAt = '2026-08-01T09:00:00.000Z';
    messages[1].sentAt = null;
    messages[1].receivedAt = '2026-08-01T07:00:00.000Z';
    messages[1].createdAt = '2026-08-01T08:00:00.000Z';

    const corpus = corpusApi.parseCenturionThreadStateCorpus({
      source: clone(THREAD_STATE_SOURCE),
      manifest: corpusApi.createCenturionThreadStateSourceManifest(messages),
      messages,
    });

    expect(
      corpus.messages.find((message: { id: string }) => message.id === 'message-2')
        ?.eventAt,
    ).toBe('2026-08-01T09:00:00.000Z');
    expect(
      corpus.messages.find((message: { id: string }) => message.id === 'message-1')
        ?.eventAt,
    ).toBe('2026-08-01T08:00:00.000Z');
  });

  it('rejects synthetic malformed legacy blocks', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    expect(() =>
      corpusApi.parseCenturionThreadStateCorpus({
        source: clone(THREAD_STATE_SOURCE),
        manifest: corpusApi.createCenturionThreadStateSourceManifest(messages),
        messages: [malformedBlockFixture],
      }),
    ).toThrow('CENTURION_THREAD_STATE_INVALID_MESSAGE');
  });

  it('rejects messages with no timestamp', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    messages[0].createdAt = null;
    messages[0].sentAt = null;
    messages[0].receivedAt = null;
    expect(() =>
      corpusApi.parseCenturionThreadStateCorpus({
        source: clone(THREAD_STATE_SOURCE),
        manifest: corpusApi.createCenturionThreadStateSourceManifest(messages),
        messages,
      }),
    ).toThrow('CENTURION_THREAD_STATE_TIMESTAMP_REQUIRED');
  });

  it('rejects duplicate database message IDs', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    expect(() =>
      corpusApi.parseCenturionThreadStateCorpus({
        source: clone(THREAD_STATE_SOURCE),
        manifest: corpusApi.createCenturionThreadStateSourceManifest([
          messages[0],
        ]),
        messages: [messages[0], messages[0]],
      }),
    ).toThrow('CENTURION_THREAD_STATE_DUPLICATE_MESSAGE_ID');
  });

  it('preserves mismatched reply linkage headers as a conflict', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    messages[0].inReplyTo = '<other-parent@fixture.test>';
    const corpus = corpusApi.parseCenturionThreadStateCorpus({
      source: clone(THREAD_STATE_SOURCE),
      manifest: corpusApi.createCenturionThreadStateSourceManifest(messages),
      messages,
    });

    expect(
      corpus.messages.find((message) => message.id === 'message-2')?.headers,
    ).toMatchObject({
      inReplyTo: 'other-parent@fixture.test',
      references: ['root-1@fixture.test'],
      linkageConflict: true,
    });
  });

  it('quarantines malformed reference values without rejecting the corpus', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    messages[0].references = [
      '<root-1@fixture.test>',
      'malformed reference value',
    ];

    const corpus = corpusApi.parseCenturionThreadStateCorpus({
      source: clone(THREAD_STATE_SOURCE),
      manifest: corpusApi.createCenturionThreadStateSourceManifest(messages),
      messages,
    });

    expect(
      corpus.messages.find((message) => message.id === 'message-2')?.headers,
    ).toMatchObject({
      references: ['root-1@fixture.test'],
      malformedReferences: true,
    });
  });

  it('rejects cardinality and source-digest manifest drift', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    const manifest = corpusApi.createCenturionThreadStateSourceManifest(messages);

    expect(() =>
      corpusApi.parseCenturionThreadStateCorpus({
        source: clone(THREAD_STATE_SOURCE),
        manifest: { ...manifest, messageCount: manifest.messageCount + 1 },
        messages,
      }),
    ).toThrow('CENTURION_THREAD_STATE_CARDINALITY_MISMATCH');

    expect(() =>
      corpusApi.parseCenturionThreadStateCorpus({
        source: clone(THREAD_STATE_SOURCE),
        manifest: { ...manifest, sourceRowsSha256: '0'.repeat(64) },
        messages,
      }),
    ).toThrow('CENTURION_THREAD_STATE_SOURCE_DIGEST_MISMATCH');
  });

  it('rejects a message ID retained under a different thread', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    const manifest = corpusApi.createCenturionThreadStateSourceManifest(messages);
    messages[0].threadId = 'thread-reassigned';

    expect(() =>
      corpusApi.parseCenturionThreadStateCorpus({
        source: clone(THREAD_STATE_SOURCE),
        manifest,
        messages,
      }),
    ).toThrow('CENTURION_THREAD_STATE_KEYSET_MISMATCH');
  });

  it('strictly reloads canonical artifacts and verifies corpus digest', async () => {
    const corpusApi = await loadCorpus();
    const messages = clone(threadStateMessages);
    const corpus = corpusApi.parseCenturionThreadStateCorpus({
      source: clone(THREAD_STATE_SOURCE),
      manifest: corpusApi.createCenturionThreadStateSourceManifest(messages),
      messages,
    });

    expect(corpusApi.parsePersistedCenturionThreadStateCorpus(corpus)).toEqual(
      corpus,
    );
    expect(() =>
      corpusApi.parsePersistedCenturionThreadStateCorpus({
        ...corpus,
        manifest: { ...corpus.manifest, corpusSha256: '0'.repeat(64) },
      }),
    ).toThrow('CENTURION_THREAD_STATE_CORPUS_DIGEST_MISMATCH');
    expect(() =>
      corpusApi.parsePersistedCenturionThreadStateCorpus({
        ...corpus,
        manifest: {
          ...corpus.manifest,
          corpusSha256: corpus.manifest.corpusSha256.toUpperCase(),
        },
      }),
    ).toThrow('CENTURION_THREAD_STATE_CANONICAL_ARTIFACT_INVALID');
    expect(() =>
      corpusApi.parsePersistedCenturionThreadStateCorpus({
        ...corpus,
        source: {
          ...corpus.source,
          eventCutoff: '2026-08-01T00:00:00.000Z',
        },
      }),
    ).toThrow('CENTURION_THREAD_STATE_EVENT_CUTOFF_EXCEEDED');
    expect(() =>
      corpusApi.parsePersistedCenturionThreadStateCorpus({
        ...corpus,
        source: {
          ...corpus.source,
          eventCutoff: '2026-08-01T10:00:00.000+02:00',
        },
      }),
    ).toThrow('CENTURION_THREAD_STATE_EVENT_CUTOFF_EXCEEDED');
    expect(() =>
      corpusApi.parsePersistedCenturionThreadStateCorpus({
        ...corpus,
        extra: true,
      }),
    ).toThrow('CENTURION_THREAD_STATE_CANONICAL_ARTIFACT_INVALID');
  });

  it('reconstructs canonical message digests before trusting persisted artifacts', async () => {
    const corpusApi = await loadCorpus();
    const corpus = corpusApi.parseCenturionThreadStateCorpus({
      source: clone(THREAD_STATE_SOURCE),
      manifest: corpusApi.createCenturionThreadStateSourceManifest(
        clone(threadStateMessages),
      ),
      messages: clone(threadStateMessages),
    });
    const forged = clone(corpus);
    forged.messages[0].textBody = 'tampered body';
    forged.manifest.corpusSha256 = sha256(forged.messages);

    expect(() =>
      corpusApi.parsePersistedCenturionThreadStateCorpus(forged),
    ).toThrow('CENTURION_THREAD_STATE_MESSAGE_DIGEST_MISMATCH');
  });

  it('rejects unsafe output targets before client construction', async () => {
    const corpusApi = await loadCorpus();
    const safeRoot = {
      path: '/private/corpus',
      realPath: '/private/corpus',
      isDirectory: true,
      isSymbolicLink: false,
      mode: 0o40700,
      uid: 1000,
    };

    expect(() =>
      corpusApi.validateCenturionThreadStateOutputTarget({
        platform: 'linux',
        currentUid: 1000,
        root: { ...safeRoot, mode: 0o40755 },
        output: {
          isFile: true,
          isSymbolicLink: false,
          mode: 0o100600,
          uid: 1000,
        },
      }),
    ).toThrow('CENTURION_THREAD_STATE_OUTPUT_ROOT_PERMISSIONS');

    expect(() =>
      corpusApi.validateCenturionThreadStateOutputTarget({
        platform: 'linux',
        currentUid: 1000,
        root: { ...safeRoot, isSymbolicLink: true },
        output: {
          isFile: true,
          isSymbolicLink: false,
          mode: 0o100600,
          uid: 1000,
        },
      }),
    ).toThrow('CENTURION_THREAD_STATE_OUTPUT_ROOT_SYMLINK');

    expect(() =>
      corpusApi.validateCenturionThreadStateOutputTarget({
        platform: 'linux',
        currentUid: 1000,
        root: safeRoot,
        output: {
          isFile: true,
          isSymbolicLink: false,
          mode: 0o100644,
          uid: 1000,
        },
      }),
    ).toThrow('CENTURION_THREAD_STATE_OUTPUT_FILE_PERMISSIONS');
    const runner = await loadRunner();
    let clientConstructed = false;
    const danglingEntry = () => ({
      isSymbolicLink: () => true,
    });

    expect(() =>
      runner.assertCenturionThreadStateOutputTargetAbsent(
        '/private/corpus.json',
        danglingEntry,
      ),
    ).toThrow('CENTURION_THREAD_STATE_OUTPUT_FILE_SYMLINK');
    expect(
      runner.centurionThreadStateAnchoredOutputRootPath({
        platform: 'linux',
        directoryFd: 72,
      }),
    ).toBe('/proc/self/fd/72');
    expect(
      runner.centurionThreadStateAnchoredOutputRootPath({
        platform: 'linux',
        directoryFd: 72,
      }),
    ).not.toContain('/private/audit-output');
    await expect(
      runner.exportCenturionThreadStateCorpus(
        {
          kind: 'execute',
          transportId: 'transport-centurion',
          eventCutoff: '2026-08-02T00:00:00.000Z',
          ingestCutoff: '2026-08-02T00:00:00.000Z',
          outputRoot: '/private/audit-output',
        },
        {
          preflight: () => {
            runner.assertCenturionThreadStateOutputTargetAbsent(
              '/private/corpus.json',
              danglingEntry,
            );
            throw new Error('unreachable');
          },
          createClient: () => {
            clientConstructed = true;
            throw new Error('client should not be constructed');
          },
        },
      ),
    ).rejects.toThrow('CENTURION_THREAD_STATE_OUTPUT_FILE_SYMLINK');
    expect(clientConstructed).toBe(false);

    expect(() => runner.parseCenturionThreadStateExportArgs([])).toThrow(
      'CENTURION_THREAD_STATE_EXECUTE_REQUIRED',
    );
    expect(
      runner.parseCenturionThreadStateExportArgs([
        '--execute',
        '--event-cutoff',
        '2026-08-02T00:00:00.000Z',
        '--ingest-cutoff',
        '2026-08-02T00:00:00.000Z',
      ]),
    ).toMatchObject({
      kind: 'execute',
      transportId: 'transport-centurion',
      eventCutoff: '2026-08-02T00:00:00.000Z',
      ingestCutoff: '2026-08-02T00:00:00.000Z',
    });
  });

  it('requires offset-bearing RFC3339 cutoffs', async () => {
    const runner = await loadRunner();
    expect(() =>
      runner.parseCenturionThreadStateExportArgs([
        '--execute',
        '--event-cutoff',
        '2026-08-02T00:00:00',
        '--ingest-cutoff',
        '2026-08-02T00:00:00.000Z',
      ]),
    ).toThrow('CENTURION_THREAD_STATE_EVENT_CUTOFF_REQUIRED');
    expect(() =>
      runner.parseCenturionThreadStateExportArgs([
        '--execute',
        '--event-cutoff',
        '2026-02-30T00:00:00Z',
        '--ingest-cutoff',
        '2026-08-02T00:00:00.000Z',
      ]),
    ).toThrow('CENTURION_THREAD_STATE_EVENT_CUTOFF_REQUIRED');
    expect(() =>
      runner.parseCenturionThreadStateExportArgs([
        '--execute',
        '--event-cutoff',
        '2026-08-02T00:00:00.123456Z',
        '--ingest-cutoff',
        '2026-08-02T00:00:00.000Z',
      ]),
    ).toThrow('CENTURION_THREAD_STATE_EVENT_CUTOFF_REQUIRED');
    expect(() =>
      runner.parseCenturionThreadStateExportArgs([
        '--execute',
        '--event-cutoff',
        '2026-08-02T00:00:00-00:00',
        '--ingest-cutoff',
        '2026-08-02T00:00:00.000Z',
      ]),
    ).toThrow('CENTURION_THREAD_STATE_EVENT_CUTOFF_REQUIRED');
    expect(
      runner.parseCenturionThreadStateExportArgs([
        '--execute',
        '--event-cutoff',
        '2026-08-02T02:00:00.123+02:00',
        '--ingest-cutoff',
        '2026-08-02T00:00:00.000Z',
      ]),
    ).toMatchObject({
      eventCutoff: '2026-08-02T00:00:00.123Z',
    });
  });

  it('rejects non-canonical tracked repository output roots', async () => {
    const runner = await loadRunner();
    const repositoryRoot = '/workspace';
    const serverRoot = join(repositoryRoot, 'apps', 'server-pilot');
    const canonicalRoot = join(
      serverRoot,
      '.tmp-centurion-thread-state-audit',
    );

    expect(() =>
      runner.validateCenturionThreadStateOutputRootPath({
        outputRoot: join(serverRoot, 'audit-output'),
        serverRoot,
        repositoryRoot,
      }),
    ).toThrow('CENTURION_THREAD_STATE_OUTPUT_ROOT_REPOSITORY_REJECTED');
    expect(
      runner.validateCenturionThreadStateOutputRootPath({
        outputRoot: canonicalRoot,
        serverRoot,
        repositoryRoot,
      }),
    ).toBe(resolve(canonicalRoot));
    expect(
      runner.validateCenturionThreadStateOutputRootPath({
        outputRoot: '/private/audit-output',
        serverRoot,
        repositoryRoot,
      }),
    ).toBe(resolve('/private/audit-output'));
  });

  it('retires the Markdown dump before database or file operations', () => {
    const source = readFileSync(legacyMarkdownDumpPath, 'utf8');

    expect(source).toContain('CENTURION_MARKDOWN_DUMP_RETIRED');
    expect(source).not.toMatch(/postgres|DATABASE_URL|writeFileSync/u);
    expect(source).toContain('export-centurion-thread-state-corpus.ts');
  });
});
