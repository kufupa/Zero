import {
  createAwsRelayObjectStore,
  createDefaultRelaySourceRuntime,
  parseRelaySourceRuntimeConfigSnapshot,
  stageCenturionThreadCorpusRelay,
  type RelayBucketConfig,
  type RelayObjectStore,
  type RelaySourceRuntimePort,
} from '../src/ops/centurion-thread-corpus-relay-producer.js';
import {
  assessCenturionThreadCorpusReadiness,
  type CenturionThreadCorpusReadinessAssessment,
} from './check-centurion-thread-corpus-readiness.js';
import { buildCenturionThreadCorpusReadinessAttestation } from '../src/ops/centurion-thread-corpus-readiness.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type StageCommandDependencies = {
  args(): readonly string[];
  createTransferId(): string;
  runtime: RelaySourceRuntimePort;
  assessReadiness(): Promise<CenturionThreadCorpusReadinessAssessment>;
  objectStoreFor(config: RelayBucketConfig): RelayObjectStore;
  writeStdout(value: string): void;
};

type StageSelector =
  | { outcome: 'automatic' }
  | { outcome: 'explicit'; transferId: string }
  | { outcome: 'blocked' };

type SourceStageRecoveryRuntime = Required<
  Pick<
    RelaySourceRuntimePort,
    | 'assertSourceStageConfig'
    | 'findSingleResumableStage'
    | 'acquireSourceStageLease'
    | 'releaseSourceStageLease'
  >
>;

type StageOffer =
  | {
      schemaVersion: 'centurion-thread-corpus-relay-stage-offer-v1';
      outcome: 'staged';
      transferId: string;
      sourceManifestSha256: string;
      memberSetSha256: string;
    }
  | {
      schemaVersion: 'centurion-thread-corpus-relay-stage-offer-v1';
      outcome: 'blocked';
    };

function blockedOffer(): StageOffer {
  return {
    schemaVersion: 'centurion-thread-corpus-relay-stage-offer-v1',
    outcome: 'blocked',
  };
}

function writeOffer(dependencies: StageCommandDependencies, offer: StageOffer): void {
  try {
    dependencies.writeStdout(`${JSON.stringify(offer)}\n`);
  } catch {}
}

function isUuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isLeaseId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function parseStageSelector(args: readonly string[]): StageSelector {
  if (args.length === 0) return { outcome: 'automatic' };
  if (args.length === 2 && args[0] === '--transfer-id' && isUuidV4(args[1])) {
    return { outcome: 'explicit', transferId: args[1] };
  }
  return { outcome: 'blocked' };
}

function sourceStageRecoveryRuntime(
  runtime: RelaySourceRuntimePort,
): SourceStageRecoveryRuntime | null {
  return typeof runtime.findSingleResumableStage === 'function' &&
    typeof runtime.assertSourceStageConfig === 'function' &&
    typeof runtime.acquireSourceStageLease === 'function' &&
    typeof runtime.releaseSourceStageLease === 'function'
    ? (runtime as SourceStageRecoveryRuntime)
    : null;
}

function validDiscovery(
  value: Awaited<ReturnType<SourceStageRecoveryRuntime['findSingleResumableStage']>>,
): boolean {
  return (
    (value.outcome === 'none' && Object.keys(value).length === 1) ||
    (value.outcome === 'blocked' && Object.keys(value).length === 1) ||
    (value.outcome === 'one' && Object.keys(value).length === 2 && isUuidV4(value.transferId))
  );
}

export function createStageCenturionThreadCorpusRelayCommand(
  overrides: Partial<StageCommandDependencies> = {},
): () => Promise<number> {
  const dependencies: StageCommandDependencies = {
    args: () => process.argv.slice(2),
    createTransferId: randomUUID,
    runtime: createDefaultRelaySourceRuntime(),
    assessReadiness: assessCenturionThreadCorpusReadiness,
    objectStoreFor: createAwsRelayObjectStore,
    writeStdout: (value) => process.stdout.write(value),
    ...overrides,
  };
  return async (): Promise<number> => {
    try {
      const selector = parseStageSelector(dependencies.args());
      if (selector.outcome === 'blocked') {
        writeOffer(dependencies, blockedOffer());
        return 2;
      }
      const configSnapshot = parseRelaySourceRuntimeConfigSnapshot(
        await dependencies.runtime.readProtectedConfig(),
      );
      if (!configSnapshot) {
        writeOffer(dependencies, blockedOffer());
        return 3;
      }
      const { config, digest: configDigest } = configSnapshot;
      const recovery = sourceStageRecoveryRuntime(dependencies.runtime);
      if (!recovery) {
        writeOffer(dependencies, blockedOffer());
        return 3;
      }
      const assessment = await dependencies.assessReadiness();
      const expectedAttestation = buildCenturionThreadCorpusReadinessAttestation(
        assessment.report,
        config.readinessAttestationBinding,
      );
      if (
        expectedAttestation === null ||
        assessment.attestation === null ||
        JSON.stringify(assessment.attestation) !== JSON.stringify(expectedAttestation)
      ) {
        writeOffer(dependencies, blockedOffer());
        return 3;
      }
      const lease = await recovery.acquireSourceStageLease({ configDigest });
      if (!lease || !isLeaseId(lease.leaseId)) {
        writeOffer(dependencies, blockedOffer());
        return 3;
      }
      let offer: StageOffer = blockedOffer();
      let exitCode = 3;
      try {
        const discovery = await recovery.findSingleResumableStage({ config, configDigest });
        if (!validDiscovery(discovery) || discovery.outcome === 'blocked') {
          throw new Error('stage discovery blocked');
        }
        const transferId =
          discovery.outcome === 'one'
            ? selector.outcome === 'automatic' || selector.transferId === discovery.transferId
              ? discovery.transferId
              : null
            : selector.outcome === 'explicit'
              ? selector.transferId
              : dependencies.createTransferId();
        if (!isUuidV4(transferId)) throw new Error('stage selector blocked');
        if (!(await recovery.assertSourceStageConfig({ config, configDigest }))) {
          throw new Error('source config changed');
        }
        const result = await stageCenturionThreadCorpusRelay({
          config,
          configDigest,
          transferId,
          readinessAttestation: assessment.attestation,
          store: dependencies.objectStoreFor(config.relay),
          source: dependencies.runtime,
        });
        if (
          result.outcome !== 'staged' ||
          result.transferId !== transferId ||
          !isSha256(result.sourceManifestSha256) ||
          !isSha256(result.memberSetSha256)
        ) {
          throw new Error('stage result blocked');
        }
        offer = {
          schemaVersion: 'centurion-thread-corpus-relay-stage-offer-v1',
          outcome: 'staged',
          transferId: result.transferId,
          sourceManifestSha256: result.sourceManifestSha256,
          memberSetSha256: result.memberSetSha256,
        };
        exitCode = 0;
      } catch {}
      let released = false;
      try {
        released = await recovery.releaseSourceStageLease({ leaseId: lease.leaseId });
      } catch {}
      if (!released) {
        offer = blockedOffer();
        exitCode = 3;
      }
      writeOffer(dependencies, offer);
      return exitCode;
    } catch {
      writeOffer(dependencies, blockedOffer());
      return 3;
    }
  };
}

function isEntryScript(): boolean {
  const entryPath = process.argv[1];
  return (
    typeof entryPath === 'string' && fileURLToPath(import.meta.url) === path.resolve(entryPath)
  );
}

if (isEntryScript()) {
  void createStageCenturionThreadCorpusRelayCommand()().then((code) => {
    process.exitCode = code;
  });
}
