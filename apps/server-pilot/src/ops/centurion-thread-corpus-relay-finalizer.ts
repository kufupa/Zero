import {
  parseRelaySourceRuntimeConfig,
  validateRelayStageIntent,
  type FinalizeJournalV1,
  type RelayObjectMetadata,
  type RelayObjectStore,
  type RelaySourceRuntimeConfig,
  type RelaySourceRuntimePort,
  type StageIntentV1,
} from './centurion-thread-corpus-relay-producer.js';
import {
  receiverAcknowledgementKey,
  relayManifestKey,
  relayObjectKey,
} from './centurion-thread-corpus-relay.js';
import { createHash } from 'node:crypto';

export type FinalizeRelayResult =
  | { outcome: 'complete'; transferId: string }
  | { outcome: 'blocked' };

type ReceiverAcknowledgement = {
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  relayManifestSha256: string;
  memberSetSha256: string;
  receiveReceiptSha256: string;
};

type VerifiedAcknowledgement = {
  acknowledgement: ReceiverAcknowledgement;
  acknowledgementMetadata: RelayObjectMetadata;
  acknowledgementBytes: Uint8Array;
  relayManifestMetadata: RelayObjectMetadata;
  relayManifestBytes: Uint8Array;
};

const FINALIZE_JOURNAL_VERSION = 'centurion-thread-corpus-relay-finalize-journal-v1';
const RECEIVER_ACKNOWLEDGEMENT_VERSION = 'centurion-thread-corpus-relay-ack-v1';
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RELAY_MANIFEST_FILENAME = 'relay-manifest.v1.json';
const ACKNOWLEDGEMENT_MAX_BYTES = 64 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function blocked(): FinalizeRelayResult {
  return { outcome: 'blocked' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasCanonicalKeyOrder(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_IDENTIFIER.test(value);
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function relayPrefix(literalRelayRoot: string, transferId: string): string {
  const manifestKey = relayManifestKey(literalRelayRoot, transferId);
  return manifestKey.slice(0, -RELAY_MANIFEST_FILENAME.length);
}

function exactGitState(source: RelaySourceRuntimePort, config: RelaySourceRuntimeConfig): boolean {
  return (
    source.inspectGit('revision') === `${config.expectedEc2.revision}\n` &&
    source.inspectGit('worktree') === `${config.expectedEc2.worktree}\n` &&
    source.inspectGit('status') === ''
  );
}

function sameStageIntent(left: StageIntentV1, right: StageIntentV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateFinalizeJournal(
  value: unknown,
  config: RelaySourceRuntimeConfig,
  transferId: string,
): FinalizeJournalV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'stageIntent',
      'receiveReceiptSha256',
      'acknowledgementSha256',
      'state',
    ]) ||
    value.schemaVersion !== FINALIZE_JOURNAL_VERSION ||
    !isSha256(value.receiveReceiptSha256) ||
    !isSha256(value.acknowledgementSha256) ||
    ![
      'ack_verified',
      'relay_delete_started',
      'relay_empty',
      'source_delete_started',
      'complete',
    ].includes(value.state as string)
  ) {
    return null;
  }
  const stageIntent = validateRelayStageIntent(value.stageIntent, config, transferId);
  if (!stageIntent || stageIntent.state !== 'staged') return null;
  return {
    schemaVersion: FINALIZE_JOURNAL_VERSION,
    stageIntent,
    receiveReceiptSha256: value.receiveReceiptSha256,
    acknowledgementSha256: value.acknowledgementSha256,
    state: value.state as FinalizeJournalV1['state'],
  };
}

function parseAcknowledgement(content: Uint8Array): ReceiverAcknowledgement | null {
  try {
    if (
      content.byteLength >= 3 &&
      content[0] === 0xef &&
      content[1] === 0xbb &&
      content[2] === 0xbf
    ) {
      return null;
    }
    const json = textDecoder.decode(content);
    const parsed: unknown = JSON.parse(json);
    if (
      !isRecord(parsed) ||
      !hasCanonicalKeyOrder(parsed, [
        'schemaVersion',
        'transferId',
        'snapshotId',
        'sourceManifestSha256',
        'relayManifestSha256',
        'memberSetSha256',
        'receiveReceiptSha256',
      ]) ||
      parsed.schemaVersion !== RECEIVER_ACKNOWLEDGEMENT_VERSION ||
      !isUuidV4(parsed.transferId) ||
      !isOpaqueIdentifier(parsed.snapshotId) ||
      !isSha256(parsed.sourceManifestSha256) ||
      !isSha256(parsed.relayManifestSha256) ||
      !isSha256(parsed.memberSetSha256) ||
      !isSha256(parsed.receiveReceiptSha256) ||
      json !== `${JSON.stringify(parsed, null, 2)}\n`
    ) {
      return null;
    }
    return {
      transferId: parsed.transferId,
      snapshotId: parsed.snapshotId,
      sourceManifestSha256: parsed.sourceManifestSha256,
      relayManifestSha256: parsed.relayManifestSha256,
      memberSetSha256: parsed.memberSetSha256,
      receiveReceiptSha256: parsed.receiveReceiptSha256,
    };
  } catch {
    return null;
  }
}

function sameMetadata(
  metadata: RelayObjectMetadata | null,
  expected: { key: string; bytes: number; sha256: string; kmsKeyArn: string },
): boolean {
  return (
    metadata !== null &&
    metadata.key === expected.key &&
    metadata.bytes === expected.bytes &&
    metadata.sha256 === expected.sha256 &&
    metadata.serverSideEncryption === 'aws:kms' &&
    metadata.sseKmsKeyId === expected.kmsKeyArn
  );
}

function exactInventory(
  actual: readonly RelayObjectMetadata[] | null,
  expected: readonly { key: string; bytes: number; sha256: string; kmsKeyArn: string }[],
): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  const byKey = new Map(actual.map((metadata) => [metadata.key, metadata]));
  return (
    byKey.size === actual.length &&
    expected.every((candidate) => sameMetadata(byKey.get(candidate.key) ?? null, candidate))
  );
}

function containsOnlyKnownKeys(
  actual: readonly RelayObjectMetadata[] | null,
  knownKeys: readonly string[],
): boolean {
  return (
    actual !== null &&
    new Set(actual.map((metadata) => metadata.key)).size === actual.length &&
    actual.every(
      (metadata) =>
        knownKeys.includes(metadata.key) &&
        metadata.serverSideEncryption === 'aws:kms' &&
        typeof metadata.sseKmsKeyId === 'string',
    )
  );
}

async function verifyAcknowledgement(input: {
  config: RelaySourceRuntimeConfig;
  transferId: string;
  stageIntent: StageIntentV1;
  store: RelayObjectStore;
}): Promise<VerifiedAcknowledgement | null> {
  try {
    const acknowledgementKey = receiverAcknowledgementKey(
      input.config.relay.literalRelayRoot,
      input.transferId,
    );
    const acknowledgementMetadata = await input.store.head(acknowledgementKey);
    const acknowledgementBytes = await input.store.getBounded(
      acknowledgementKey,
      Math.min(input.config.relay.maxSnapshotBytes, ACKNOWLEDGEMENT_MAX_BYTES),
    );
    if (
      !acknowledgementMetadata ||
      !acknowledgementBytes ||
      !sameMetadata(acknowledgementMetadata, {
        key: acknowledgementKey,
        bytes: acknowledgementBytes.byteLength,
        sha256: sha256(acknowledgementBytes),
        kmsKeyArn: input.config.relay.kmsKeyArn,
      })
    ) {
      return null;
    }
    const acknowledgement = parseAcknowledgement(acknowledgementBytes);
    if (
      !acknowledgement ||
      acknowledgement.transferId !== input.transferId ||
      acknowledgement.snapshotId !== input.stageIntent.snapshotId ||
      acknowledgement.sourceManifestSha256 !== input.stageIntent.sourceManifestSha256 ||
      acknowledgement.memberSetSha256 !== input.stageIntent.memberSetSha256
    ) {
      return null;
    }

    const manifestKey = relayManifestKey(input.config.relay.literalRelayRoot, input.transferId);
    const relayManifestMetadata = await input.store.head(manifestKey);
    const relayManifestBytes = await input.store.getBounded(
      manifestKey,
      input.config.relay.maxSnapshotBytes,
    );
    if (
      !relayManifestMetadata ||
      !relayManifestBytes ||
      acknowledgement.relayManifestSha256 !== sha256(relayManifestBytes) ||
      !sameMetadata(relayManifestMetadata, {
        key: manifestKey,
        bytes: relayManifestBytes.byteLength,
        sha256: acknowledgement.relayManifestSha256,
        kmsKeyArn: input.config.relay.kmsKeyArn,
      })
    ) {
      return null;
    }
    return {
      acknowledgement,
      acknowledgementMetadata,
      acknowledgementBytes,
      relayManifestMetadata,
      relayManifestBytes,
    };
  } catch {
    return null;
  }
}

function inventoryForVerifiedAcknowledgement(input: {
  config: RelaySourceRuntimeConfig;
  transferId: string;
  stageIntent: StageIntentV1;
  verified: VerifiedAcknowledgement;
}): Array<{ key: string; bytes: number; sha256: string; kmsKeyArn: string }> {
  return [
    ...input.stageIntent.members.map((member) => ({
      key: relayObjectKey(input.config.relay.literalRelayRoot, input.transferId, member.path),
      bytes: member.bytes,
      sha256: member.sha256,
      kmsKeyArn: input.config.relay.kmsKeyArn,
    })),
    {
      key: input.verified.relayManifestMetadata.key,
      bytes: input.verified.relayManifestBytes.byteLength,
      sha256: sha256(input.verified.relayManifestBytes),
      kmsKeyArn: input.config.relay.kmsKeyArn,
    },
    {
      key: input.verified.acknowledgementMetadata.key,
      bytes: input.verified.acknowledgementBytes.byteLength,
      sha256: sha256(input.verified.acknowledgementBytes),
      kmsKeyArn: input.config.relay.kmsKeyArn,
    },
  ];
}

async function writeJournal(
  source: RelaySourceRuntimePort,
  journal: FinalizeJournalV1,
): Promise<boolean> {
  try {
    return await source.writeFinalizeJournal(journal);
  } catch {
    return false;
  }
}

export async function finalizeCenturionThreadCorpusRelay(input: {
  config: RelaySourceRuntimeConfig;
  transferId: string;
  store: RelayObjectStore;
  source: RelaySourceRuntimePort;
}): Promise<FinalizeRelayResult> {
  try {
    const config = parseRelaySourceRuntimeConfig(JSON.stringify(input.config));
    if (!config || !isUuidV4(input.transferId)) return blocked();
    if (input.source.platform() !== 'linux') return blocked();
    if (!(await input.source.attestImdsV2(config.expectedEc2.instanceId))) return blocked();
    if (!exactGitState(input.source, config)) return blocked();
    if (!(await input.store.assertRelayBucket(config.relay))) return blocked();

    const stageFromRuntime = await input.source.readStageIntent(input.transferId);
    const validatedRuntimeStage = stageFromRuntime
      ? validateRelayStageIntent(stageFromRuntime, config, input.transferId)
      : null;
    if (stageFromRuntime && (!validatedRuntimeStage || validatedRuntimeStage.state !== 'staged')) {
      return blocked();
    }

    const rawJournal = await input.source.readFinalizeJournal(input.transferId);
    let journal = rawJournal ? validateFinalizeJournal(rawJournal, config, input.transferId) : null;
    if (rawJournal && !journal) return blocked();
    if (
      journal &&
      validatedRuntimeStage &&
      !sameStageIntent(journal.stageIntent, validatedRuntimeStage)
    ) {
      return blocked();
    }
    const stageIntent = journal?.stageIntent ?? validatedRuntimeStage;
    if (!stageIntent || stageIntent.state !== 'staged') return blocked();

    const prefix = relayPrefix(config.relay.literalRelayRoot, input.transferId);
    const acknowledgementKey = receiverAcknowledgementKey(
      config.relay.literalRelayRoot,
      input.transferId,
    );
    const knownKeys = [...stageIntent.createdKeys, acknowledgementKey];
    if (new Set(knownKeys).size !== knownKeys.length) return blocked();

    if (!journal) {
      const verified = await verifyAcknowledgement({
        config,
        transferId: input.transferId,
        stageIntent,
        store: input.store,
      });
      if (!verified) return blocked();
      if (
        !exactInventory(
          await input.store.listAll(prefix),
          inventoryForVerifiedAcknowledgement({
            config,
            transferId: input.transferId,
            stageIntent,
            verified,
          }),
        )
      ) {
        return blocked();
      }
      journal = {
        schemaVersion: FINALIZE_JOURNAL_VERSION,
        stageIntent,
        receiveReceiptSha256: verified.acknowledgement.receiveReceiptSha256,
        acknowledgementSha256: sha256(verified.acknowledgementBytes),
        state: 'ack_verified',
      };
      if (!(await writeJournal(input.source, journal))) return blocked();
    }

    if (journal.state === 'complete') {
      return { outcome: 'complete', transferId: input.transferId };
    }

    if (journal.state === 'ack_verified') {
      const verified = await verifyAcknowledgement({
        config,
        transferId: input.transferId,
        stageIntent,
        store: input.store,
      });
      if (
        !verified ||
        verified.acknowledgement.receiveReceiptSha256 !== journal.receiveReceiptSha256 ||
        sha256(verified.acknowledgementBytes) !== journal.acknowledgementSha256 ||
        !exactInventory(
          await input.store.listAll(prefix),
          inventoryForVerifiedAcknowledgement({
            config,
            transferId: input.transferId,
            stageIntent,
            verified,
          }),
        )
      ) {
        return blocked();
      }
      journal = { ...journal, state: 'relay_delete_started' };
      if (!(await writeJournal(input.source, journal))) return blocked();
    }

    if (journal.state === 'relay_delete_started') {
      if (!containsOnlyKnownKeys(await input.store.listAll(prefix), knownKeys)) return blocked();
      if (!(await input.store.deleteExact(knownKeys))) return blocked();
      const remaining = await input.store.listAll(prefix);
      if (remaining === null || remaining.length !== 0) return blocked();
      journal = { ...journal, state: 'relay_empty' };
      if (!(await writeJournal(input.source, journal))) return blocked();
    }

    if (journal.state === 'relay_empty') {
      const remaining = await input.store.listAll(prefix);
      if (remaining === null || remaining.length !== 0) return blocked();
      journal = { ...journal, state: 'source_delete_started' };
      if (!(await writeJournal(input.source, journal))) return blocked();
    }

    if (journal.state === 'source_delete_started') {
      const remaining = await input.store.listAll(prefix);
      if (remaining === null || remaining.length !== 0) return blocked();
      if (!(await input.source.removeTrustedSnapshot(stageIntent.sourceSnapshot))) return blocked();
      journal = { ...journal, state: 'complete' };
      if (!(await writeJournal(input.source, journal))) return blocked();
      return { outcome: 'complete', transferId: input.transferId };
    }

    return blocked();
  } catch {
    return blocked();
  }
}
