#!/usr/bin/env npx tsx
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseSealedCenturionThreadAuditSnapshotBytes,
} from '../src/ops/centurion-thread-audit-snapshot.js';
import {
  classifyCenturionThreadAuditPublication,
  publishCenturionThreadAuditSnapshot,
  type CenturionThreadAuditPublicationReceipt,
  type CenturionThreadAuditPublisherStore,
} from '../src/ops/centurion-thread-audit-publisher.js';
import { readVerifiedCenturionThreadAuditSnapshotCandidate } from '../src/ops/centurion-thread-audit-candidate.js';

const SHA256 = /^[a-f0-9]{64}$/u;

export type CenturionThreadAuditSnapshotCommand =
  | { kind: 'help' }
  | {
      kind: 'dry_run';
      candidatePath: string;
    }
  | {
      kind: 'apply';
      candidatePath: string;
      expectedPayloadDigest: string;
      expectedSealedEnvelopeDigest: string;
    };

export type CenturionThreadAuditSnapshotCliReceipt = {
  mode: 'dry_run' | 'apply';
  disposition: string;
  trustStatus: 'valid' | 'incomplete' | null;
  sourceIdentityDigest: string;
  payloadDigest: string;
  sealedEnvelopeDigest: string;
  attemptedAt: string;
  verifiedAt: string;
  publishedAt: string;
  messageCount: number | null;
  componentCount: number | null;
  persistedThreadCount: number | null;
  publicationIncarnationId?: string | null;
};

type Dependencies = {
  readVerifiedCandidate?: (path: string) => string | Promise<string>;
  publish?: (input: {
    envelopeBytes: string;
  }) => Promise<Pick<
    CenturionThreadAuditPublicationReceipt,
    'disposition' | 'trustStatus' | 'publicationIncarnationId'
  >>;
  now?: () => Date;
};

function fail(code: string): never {
  throw new Error(code);
}

function parsePath(value: string | undefined, code: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('--')) fail(code);
  const path = resolve(trimmed);
  if (!path) fail(code);
  return path;
}

function parseDigest(value: string | undefined, code: string): string {
  if (!value || !SHA256.test(value)) fail(code);
  return value;
}

function privateCandidatePath(value: string | undefined): string {
  return parsePath(value, 'CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_REQUIRED');
}

export function parseCenturionThreadAuditSnapshotArgs(
  argv: readonly string[],
): CenturionThreadAuditSnapshotCommand {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { kind: 'help' };
  }
  let apply = false;
  let dryRun = false;
  let candidatePath: string | undefined;
  let expectedPayloadDigest: string | undefined;
  let expectedSealedEnvelopeDigest: string | undefined;
  const seen = new Set<string>();
  const mark = (argument: string): void => {
    if (seen.has(argument)) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_ARGUMENT_DUPLICATE');
    seen.add(argument);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--seal') {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_EXTERNAL_SEAL_DISABLED');
    }
    if (argument === '--apply') {
      mark(argument);
      apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      mark(argument);
      dryRun = true;
      continue;
    }
    if (argument === '--candidate') {
      mark(argument);
      candidatePath = privateCandidatePath(argv[++index]);
      continue;
    }
    if (argument === '--expected-payload-digest') {
      mark(argument);
      expectedPayloadDigest = parseDigest(
        argv[++index],
        'CENTURION_THREAD_AUDIT_SNAPSHOT_EXPECTED_PAYLOAD_DIGEST_REQUIRED',
      );
      continue;
    }
    if (argument === '--expected-sealed-envelope-digest') {
      mark(argument);
      expectedSealedEnvelopeDigest = parseDigest(
        argv[++index],
        'CENTURION_THREAD_AUDIT_SNAPSHOT_EXPECTED_SEALED_DIGEST_REQUIRED',
      );
      continue;
    }
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_ARGUMENT_UNKNOWN');
  }

  if (apply && dryRun) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_MODE_CONFLICT');
  }
  if (!candidatePath) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_CANDIDATE_REQUIRED');
  if (!apply) {
    if (expectedPayloadDigest || expectedSealedEnvelopeDigest) {
      fail('CENTURION_THREAD_AUDIT_SNAPSHOT_DRY_RUN_DIGEST_ARGUMENT_INVALID');
    }
    return { kind: 'dry_run', candidatePath };
  }
  if (!expectedPayloadDigest) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_EXPECTED_PAYLOAD_DIGEST_REQUIRED');
  }
  if (!expectedSealedEnvelopeDigest) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_EXPECTED_SEALED_DIGEST_REQUIRED');
  }
  return {
    kind: 'apply',
    candidatePath,
    expectedPayloadDigest,
    expectedSealedEnvelopeDigest,
  };
}

export function centurionThreadAuditSnapshotHelp(): string {
  return [
    'usage:',
    '  publish-centurion-thread-audit-snapshot.ts --candidate PRIVATE_PATH',
    '  publish-centurion-thread-audit-snapshot.ts --apply --candidate PRIVATE_PATH --expected-payload-digest SHA256 --expected-sealed-envelope-digest SHA256',
    '  Default mode verifies a trusted private candidate and does not mutate the database.',
  ].join('\n');
}

function receiptFromEnvelope(input: {
  mode: CenturionThreadAuditSnapshotCliReceipt['mode'];
  disposition: string;
  envelopeBytes: string;
  publicationIncarnationId?: string | null;
  trustStatus?: 'valid' | 'incomplete' | null;
}): CenturionThreadAuditSnapshotCliReceipt {
  const envelope = parseSealedCenturionThreadAuditSnapshotBytes(input.envelopeBytes);
  const trustStatus =
    input.trustStatus === undefined ? envelope.trustStatus : input.trustStatus;
  const hasOperationalCounts =
    trustStatus === 'valid' && envelope.trustStatus === 'valid';
  return {
    mode: input.mode,
    disposition: input.disposition,
    trustStatus,
    sourceIdentityDigest: envelope.sourceIdentityDigest,
    payloadDigest: envelope.payloadDigest,
    sealedEnvelopeDigest: envelope.sealedEnvelopeDigest,
    attemptedAt: envelope.attemptedAt,
    verifiedAt: envelope.verifiedAt,
    publishedAt: envelope.publishedAt,
    messageCount: hasOperationalCounts ? envelope.messageCount : null,
    componentCount: hasOperationalCounts ? envelope.componentCount : null,
    persistedThreadCount:
      hasOperationalCounts ? envelope.persistedThreadCount : null,
    publicationIncarnationId: input.publicationIncarnationId ?? null,
  };
}

async function defaultPublish(input: {
  envelopeBytes: string;
  now: () => Date;
}): Promise<Pick<
  CenturionThreadAuditPublicationReceipt,
  'disposition' | 'trustStatus' | 'publicationIncarnationId'
>> {
  const { createCenturionThreadAuditDatabaseStore } = await import(
    '../src/ops/centurion-thread-audit-store.js'
  );
  const store = await createCenturionThreadAuditDatabaseStore();
  return publishCenturionThreadAuditSnapshot({
    envelopeBytes: input.envelopeBytes,
    store: store as CenturionThreadAuditPublisherStore,
    dependencies: {
      now: input.now,
      issueOpaqueId: (kind) => `${kind}_${randomBytes(32).toString('hex')}`,
    },
  });
}

function unsupportedVersionReceipt(
  mode: 'dry_run' | 'apply',
): CenturionThreadAuditSnapshotCliReceipt {
  return {
    mode,
    disposition: 'REJECTED_UNSUPPORTED_VERSION',
    trustStatus: null,
    sourceIdentityDigest: '',
    payloadDigest: '',
    sealedEnvelopeDigest: '',
    attemptedAt: '',
    verifiedAt: '',
    publishedAt: '',
    messageCount: null,
    componentCount: null,
    persistedThreadCount: null,
  };
}

export async function runCenturionThreadAuditSnapshotCli(
  command: Exclude<CenturionThreadAuditSnapshotCommand, { kind: 'help' }>,
  dependencies: Dependencies = {},
): Promise<CenturionThreadAuditSnapshotCliReceipt> {
  const readVerifiedCandidate =
    dependencies.readVerifiedCandidate ??
    ((path: string) => readVerifiedCenturionThreadAuditSnapshotCandidate(path));
  const now = dependencies.now ?? (() => new Date());
  let envelopeBytes: string;
  try {
    envelopeBytes = await readVerifiedCandidate(command.candidatePath);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'CENTURION_THREAD_AUDIT_SNAPSHOT_UNSUPPORTED_VERSION'
    ) {
      return unsupportedVersionReceipt(command.kind);
    }
    throw error;
  }
  let envelope;
  try {
    envelope = parseSealedCenturionThreadAuditSnapshotBytes(envelopeBytes);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'CENTURION_THREAD_AUDIT_SNAPSHOT_UNSUPPORTED_VERSION'
    ) {
      return unsupportedVersionReceipt(command.kind);
    }
    throw error;
  }
  if (command.kind === 'dry_run') {
    const disposition = classifyCenturionThreadAuditPublication({
      current: null,
      candidate: envelope,
      now: now(),
    });
    return receiptFromEnvelope({
      mode: 'dry_run',
      disposition: disposition.disposition,
      trustStatus: disposition.trustStatus,
      envelopeBytes,
    });
  }
  if (
    envelope.payloadDigest !== command.expectedPayloadDigest ||
    envelope.sealedEnvelopeDigest !== command.expectedSealedEnvelopeDigest
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_EXPECTED_DIGEST_MISMATCH');
  }
  const publication = await (
    dependencies.publish ??
    ((input: { envelopeBytes: string }) => defaultPublish({ ...input, now }))
  )({ envelopeBytes });
  return receiptFromEnvelope({
    mode: 'apply',
    disposition: publication.disposition,
    trustStatus: publication.trustStatus,
    publicationIncarnationId: publication.publicationIncarnationId,
    envelopeBytes,
  });
}

export function formatCenturionThreadAuditSnapshotReceipt(
  receipt: CenturionThreadAuditSnapshotCliReceipt,
): string {
  return JSON.stringify({
    ok: true,
    mode: receipt.mode,
    disposition: receipt.disposition,
    trustStatus: receipt.trustStatus,
    sourceIdentityDigest: receipt.sourceIdentityDigest,
    payloadDigest: receipt.payloadDigest,
    sealedEnvelopeDigest: receipt.sealedEnvelopeDigest,
    attemptedAt: receipt.attemptedAt,
    verifiedAt: receipt.verifiedAt,
    publishedAt: receipt.publishedAt,
    messageCount: receipt.messageCount,
    componentCount: receipt.componentCount,
    persistedThreadCount: receipt.persistedThreadCount,
    publicationIncarnationId: receipt.publicationIncarnationId ?? null,
  });
}

export function safeCenturionThreadAuditSnapshotErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^CENTURION_THREAD_AUDIT_(?:SNAPSHOT|PUBLISHER)_[A-Z0-9_:-]+$/u.test(
    message,
  )
    ? message
    : 'CENTURION_THREAD_AUDIT_SNAPSHOT_FAILED';
}

async function main(): Promise<void> {
  const command = parseCenturionThreadAuditSnapshotArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    process.stdout.write(`${centurionThreadAuditSnapshotHelp()}\n`);
    return;
  }
  const receipt = await runCenturionThreadAuditSnapshotCli(command);
  process.stdout.write(`${formatCenturionThreadAuditSnapshotReceipt(receipt)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${safeCenturionThreadAuditSnapshotErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
