import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type AttachmentCorpusVerification = {
  snapshotId: string;
  schemaVersion: string;
  recordCount: number;
  attachmentCount: number;
  artifactCount: number;
  attachmentBytesArtifactCount: number;
  attachmentTextArtifactCount: number;
};

const SOURCE_SCHEMA_VERSION = 'connected-mailbox-corpus-v4';

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fail(): never {
  throw new Error('Invalid attachment corpus export');
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function safeByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeStatus(
  value: unknown,
  statuses: readonly string[],
): value is string {
  return typeof value === 'string' && statuses.includes(value);
}

function within(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

async function verifyArtifact(
  snapshotDir: string,
  kind: 'attachment_bytes' | 'attachment_text' | 'raw_mime',
  ownerId: string,
  schemaVersion: string,
  snapshotId: string,
  reference: Record<string, unknown>,
): Promise<void> {
  const id = reference.id;
  const digest = reference.sha256;
  const bytes = reference.bytes;
  if (
    typeof id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(id) ||
    typeof digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !safeByteCount(bytes) ||
    id !== sha256(`${schemaVersion}\0${snapshotId}\0${kind}\0${ownerId}`)
  ) {
    return fail();
  }
  const directory =
    kind === 'attachment_bytes'
      ? 'attachment-bytes'
      : kind === 'attachment_text'
        ? 'attachment-text'
        : 'raw-mime';
  const extension =
    kind === 'raw_mime' ? 'eml' : kind === 'attachment_text' ? 'txt' : 'bin';
  const root = path.resolve(snapshotDir);
  const directoryPath = path.join(root, directory);
  const target = path.join(directoryPath, `${id}.${extension}`);
  if (!within(directoryPath, root) || !within(target, directoryPath))
    return fail();
  const directoryDetails = await lstat(directoryPath);
  if (
    !directoryDetails.isDirectory() ||
    directoryDetails.isSymbolicLink() ||
    (directoryDetails.mode & 0o777) !== 0o700 ||
    (await realpath(directoryPath)) !== directoryPath
  ) {
    return fail();
  }
  const targetDetails = await lstat(target);
  if (
    !targetDetails.isFile() ||
    targetDetails.isSymbolicLink() ||
    (targetDetails.mode & 0o777) !== 0o600 ||
    (await realpath(target)) !== target
  ) {
    return fail();
  }
  const content = await readFile(target);
  if (content.byteLength !== bytes || sha256(content) !== digest) return fail();
}

export async function verifyAttachmentCorpusExport(
  snapshotDirInput: string,
): Promise<AttachmentCorpusVerification> {
  const snapshotDir = path.resolve(snapshotDirInput);
  const rootDetails = await lstat(snapshotDir);
  if (
    !rootDetails.isDirectory() ||
    rootDetails.isSymbolicLink() ||
    (rootDetails.mode & 0o777) !== 0o700 ||
    (await realpath(snapshotDir)) !== snapshotDir
  ) {
    return fail();
  }
  const rootEntries = await readdir(snapshotDir, { withFileTypes: true });
  const allowedRootEntries = new Set([
    'corpus.jsonl',
    'manifest.json',
    'attachment-bytes',
    'attachment-text',
    'raw-mime',
  ]);
  if (
    rootEntries.some(
      (entry) => !allowedRootEntries.has(entry.name) || entry.isSymbolicLink(),
    )
  ) {
    return fail();
  }
  for (const name of ['corpus.jsonl', 'manifest.json']) {
    const filePath = path.join(snapshotDir, name);
    const fileDetails = await lstat(filePath);
    if (
      !fileDetails.isFile() ||
      fileDetails.isSymbolicLink() ||
      (fileDetails.mode & 0o777) !== 0o600 ||
      (await realpath(filePath)) !== filePath
    ) {
      return fail();
    }
  }
  const manifest = record(
    JSON.parse(await readFile(path.join(snapshotDir, 'manifest.json'), 'utf8')),
  );
  const corpus = await readFile(path.join(snapshotDir, 'corpus.jsonl'), 'utf8');
  const manifestJson = await readFile(
    path.join(snapshotDir, 'manifest.json'),
    'utf8',
  );
  if (!corpus.endsWith('\n') || !manifestJson.endsWith('\n')) return fail();
  if (
    typeof manifest.schemaVersion !== 'string' ||
    typeof manifest.snapshotId !== 'string' ||
    !digest(manifest.orderedRecordSha256) ||
    !digest(manifest.localObjectSha256) ||
    !digest(manifest.artifactInventorySha256) ||
    !exactKeys(manifest, [
      'schemaVersion',
      'snapshotId',
      'scope',
      'window',
      'exporterVersion',
      'orderedRecordSha256',
      'localObjectSha256',
      'artifactInventorySha256',
      'counts',
      'sourceObject',
    ])
  ) {
    return fail();
  }
  if (
    manifest.schemaVersion !== SOURCE_SCHEMA_VERSION ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(manifest.snapshotId)
  )
    return fail();
  const manifestCounts = record(manifest.counts);
  const attachmentBytesMode =
    Object.hasOwn(manifestCounts, 'attachmentBytesAvailable') ||
    Object.hasOwn(manifestCounts, 'attachmentBytesUnavailable');
  const lines = corpus.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0))
    return fail();
  const metadata = record(JSON.parse(lines[0]!));
  const records = lines.slice(1).map((line) => record(JSON.parse(line)));
  if (
    metadata.recordType !== 'metadata' ||
    metadata.schemaVersion !== manifest.schemaVersion ||
    metadata.snapshotId !== manifest.snapshotId ||
    metadata.recordCount !== records.length ||
    !digest(metadata.orderedRecordSha256) ||
    records.some(
      (entry) =>
        entry.recordType !== 'thread' ||
        entry.schemaVersion !== manifest.schemaVersion ||
        entry.snapshotId !== manifest.snapshotId,
    )
  ) {
    return fail();
  }
  const ordered =
    records.length === 0
      ? ''
      : `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  if (
    metadata.orderedRecordSha256 !== sha256(ordered) ||
    manifest.orderedRecordSha256 !== sha256(ordered) ||
    manifest.localObjectSha256 !== sha256(corpus)
  )
    return fail();

  const references = new Map<
    string,
    {
      kind: 'attachment_bytes' | 'attachment_text' | 'raw_mime';
      ownerId: string;
      reference: Record<string, unknown>;
    }
  >();
  const attachmentIds = new Set<string>();
  let attachmentCount = 0;
  for (const thread of records) {
    if (!Array.isArray(thread.messages)) return fail();
    for (const message of thread.messages) {
      const messageRecord = record(message);
      if (!Array.isArray(messageRecord.sourceRows)) return fail();
      for (const row of messageRecord.sourceRows) {
        const rowRecord = record(row);
        const sourceRowId = rowRecord.sourceRowId;
        if (typeof sourceRowId !== 'string' || !sourceRowId) return fail();
        const privateMessage = rowRecord.privateMessage;
        if (!privateMessage) continue;
        const privateRecord = record(privateMessage);
        if (!Array.isArray(privateRecord.attachments)) return fail();
        if (
          privateRecord.rawMime === undefined ||
          !exactKeys(record(privateRecord.rawMime), ['status', 'artifact'])
        )
          return fail();
        for (const attachment of privateRecord.attachments) {
          attachmentCount += 1;
          const attachmentRecord = record(attachment);
          const attachmentId = attachmentRecord.id;
          if (
            typeof attachmentId !== 'string' ||
            !attachmentId ||
            attachmentIds.has(attachmentId) ||
            attachmentRecord.messageId !== sourceRowId ||
            typeof attachmentRecord.contentType !== 'string' ||
            !safeNonNegativeInteger(attachmentRecord.byteSize)
          ) {
            return fail();
          }
          if (!Object.hasOwn(attachmentRecord, 'textArtifact')) return fail();
          if (
            attachmentBytesMode &&
            !Object.hasOwn(attachmentRecord, 'bytesArtifact')
          )
            return fail();
          attachmentIds.add(attachmentId);
          for (const [field, kind] of [
            ['textArtifact', 'attachment_text'],
            ['bytesArtifact', 'attachment_bytes'],
          ] as const) {
            const artifact = attachmentRecord[field];
            if (artifact === undefined || artifact === null) continue;
            const artifactRecord = record(artifact);
            if (!exactKeys(artifactRecord, ['status', 'artifact']))
              return fail();
            const statuses =
              kind === 'attachment_text'
                ? [
                    'available',
                    'expired_or_missing',
                    'too_large',
                    'budget_exhausted',
                    'unsupported',
                    'encrypted',
                    'no_embedded_text',
                    'malformed',
                    'too_many_pages',
                    'timeout',
                    'parser_failure',
                    'read_failed',
                  ]
                : [
                    'available',
                    'expired_or_missing',
                    'too_large',
                    'budget_exhausted',
                    'unsupported',
                    'timeout',
                    'read_failed',
                    'malformed',
                  ];
            if (!safeStatus(artifactRecord.status, statuses)) return fail();
            if (artifactRecord.status !== 'available') {
              if (artifactRecord.artifact !== null) return fail();
              continue;
            }
            const reference = record(artifactRecord.artifact);
            if (!exactKeys(reference, ['id', 'sha256', 'bytes'])) return fail();
            const key = `${kind}:${String(reference.id)}`;
            if (references.has(key)) return fail();
            references.set(key, {
              kind,
              ownerId: String(attachmentId),
              reference,
            });
          }
        }
        const rawMime = privateRecord.rawMime;
        if (rawMime) {
          const rawMimeRecord = record(rawMime);
          const rawStatuses = [
            'available',
            'missing',
            'expired_or_missing',
            'too_large',
            'budget_exhausted',
            'read_failed',
            'not_recorded',
            'not_recorded_outbound',
            'parse_failed',
            'not_applicable',
          ];
          if (!safeStatus(rawMimeRecord.status, rawStatuses)) return fail();
          if (rawMimeRecord.status !== 'available') {
            if (rawMimeRecord.artifact !== null) return fail();
            continue;
          }
          if (rawMimeRecord.artifact === null) return fail();
          const reference = record(rawMimeRecord.artifact);
          if (!exactKeys(reference, ['id', 'sha256', 'bytes'])) return fail();
          const key = `raw_mime:${String(reference.id)}`;
          if (references.has(key)) return fail();
          references.set(key, {
            kind: 'raw_mime',
            ownerId: sourceRowId,
            reference,
          });
        }
      }
    }
  }
  for (const entry of references.values()) {
    await verifyArtifact(
      snapshotDir,
      entry.kind,
      entry.ownerId,
      String(manifest.schemaVersion),
      String(manifest.snapshotId),
      entry.reference,
    );
  }
  const expectedFiles = new Set(
    [...references.values()].map((entry) => {
      const directory =
        entry.kind === 'attachment_bytes'
          ? 'attachment-bytes'
          : entry.kind === 'attachment_text'
            ? 'attachment-text'
            : 'raw-mime';
      const extension =
        entry.kind === 'raw_mime'
          ? 'eml'
          : entry.kind === 'attachment_text'
            ? 'txt'
            : 'bin';
      return `${directory}/${String(entry.reference.id)}.${extension}`;
    }),
  );
  for (const directory of ['attachment-bytes', 'attachment-text', 'raw-mime']) {
    try {
      const directoryPath = path.join(snapshotDir, directory);
      const directoryDetails = await lstat(directoryPath);
      if (
        !directoryDetails.isDirectory() ||
        directoryDetails.isSymbolicLink() ||
        (directoryDetails.mode & 0o777) !== 0o700 ||
        (await realpath(directoryPath)) !== directoryPath
      )
        return fail();
      const entries = await readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !expectedFiles.has(`${directory}/${entry.name}`))
          return fail();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail();
    }
  }
  const expectedInventory = sha256(
    [...references.values()]
      .sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          String(left.reference.id).localeCompare(String(right.reference.id)),
      )
      .map(
        (entry) =>
          `${entry.kind}\t${entry.reference.id}\t${entry.reference.sha256}\t${entry.reference.bytes}\n`,
      )
      .join(''),
  );
  if (manifest.artifactInventorySha256 !== expectedInventory) return fail();
  const counts = manifestCounts;
  const byteCount = [...references.values()].filter(
    (entry) => entry.kind === 'attachment_bytes',
  ).length;
  const textCount = [...references.values()].filter(
    (entry) => entry.kind === 'attachment_text',
  ).length;
  // Attachment-inclusive mode is signaled by the manifest's byte counters,
  // even when every byte read ended in an unavailable status.
  if (!attachmentBytesMode && byteCount > 0) return fail();
  if (
    typeof counts.attachments !== 'number' ||
    counts.attachments !== attachmentCount
  )
    return fail();
  if (
    Object.hasOwn(counts, 'attachmentBytesAvailable') &&
    counts.attachmentBytesAvailable !== byteCount
  )
    return fail();
  if (
    Object.hasOwn(counts, 'attachmentTextAvailable') &&
    counts.attachmentTextAvailable !== textCount
  )
    return fail();
  if (
    Object.hasOwn(counts, 'attachmentTextUnavailable') &&
    counts.attachmentTextUnavailable + textCount !== attachmentCount
  )
    return fail();
  if (
    Object.hasOwn(counts, 'attachmentBytesUnavailable') &&
    counts.attachmentBytesUnavailable + byteCount !== attachmentCount
  )
    return fail();
  const files = await readdir(snapshotDir, { withFileTypes: true });
  if (
    files.some(
      (entry) => entry.name.startsWith('.') && entry.name.endsWith('.tmp'),
    )
  )
    return fail();
  return {
    snapshotId: String(manifest.snapshotId),
    schemaVersion: String(manifest.schemaVersion),
    recordCount: records.length,
    attachmentCount,
    artifactCount: references.size,
    attachmentBytesArtifactCount: byteCount,
    attachmentTextArtifactCount: textCount,
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--snapshot-dir') {
    process.stderr.write(
      `${JSON.stringify({ event: 'attachment_corpus_verify.failed', code: 'invalid_arguments' })}\n`,
    );
    return 1;
  }
  try {
    process.stdout.write(
      `${JSON.stringify(await verifyAttachmentCorpusExport(args[1]!))}\n`,
    );
    return 0;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: 'attachment_corpus_verify.failed', code: 'verification_failed' })}\n`,
    );
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === path.resolve(entryPath)) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
