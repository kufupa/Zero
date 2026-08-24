import {
  createAwsRelayObjectStore,
  createDefaultRelaySourceRuntime,
  parseRelaySourceRuntimeConfig,
  stageCenturionThreadCorpusRelay,
  type RelayBucketConfig,
  type RelayObjectStore,
  type RelaySourceRuntimePort,
} from '../src/ops/centurion-thread-corpus-relay-producer.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type StageCommandDependencies = {
  args(): readonly string[];
  createTransferId(): string;
  runtime: RelaySourceRuntimePort;
  objectStoreFor(config: RelayBucketConfig): RelayObjectStore;
  writeStdout(value: string): void;
};

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

export function createStageCenturionThreadCorpusRelayCommand(
  overrides: Partial<StageCommandDependencies> = {},
): () => Promise<number> {
  const dependencies: StageCommandDependencies = {
    args: () => process.argv.slice(2),
    createTransferId: randomUUID,
    runtime: createDefaultRelaySourceRuntime(),
    objectStoreFor: createAwsRelayObjectStore,
    writeStdout: (value) => process.stdout.write(value),
    ...overrides,
  };
  return async (): Promise<number> => {
    try {
      if (dependencies.args().length !== 0) {
        writeOffer(dependencies, blockedOffer());
        return 2;
      }
      const config = parseRelaySourceRuntimeConfig(
        await dependencies.runtime.readProtectedConfig(),
      );
      if (!config) {
        writeOffer(dependencies, blockedOffer());
        return 3;
      }
      const result = await stageCenturionThreadCorpusRelay({
        config,
        transferId: dependencies.createTransferId(),
        store: dependencies.objectStoreFor(config.relay),
        source: dependencies.runtime,
      });
      if (result.outcome !== 'staged') {
        writeOffer(dependencies, blockedOffer());
        return 3;
      }
      writeOffer(dependencies, {
        schemaVersion: 'centurion-thread-corpus-relay-stage-offer-v1',
        outcome: 'staged',
        transferId: result.transferId,
        sourceManifestSha256: result.sourceManifestSha256,
        memberSetSha256: result.memberSetSha256,
      });
      return 0;
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
