import {
  createAwsRelayObjectStore,
  createDefaultRelaySourceRuntime,
  parseRelaySourceRuntimeConfig,
  type RelayBucketConfig,
  type RelayObjectStore,
  type RelaySourceRuntimePort,
} from '../src/ops/centurion-thread-corpus-relay-producer.js';
import { finalizeCenturionThreadCorpusRelay } from '../src/ops/centurion-thread-corpus-relay-finalizer.js';
import { relayManifestKey } from '../src/ops/centurion-thread-corpus-relay.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type FinalizeCommandDependencies = {
  args(): readonly string[];
  runtime: RelaySourceRuntimePort;
  objectStoreFor(config: RelayBucketConfig): RelayObjectStore;
  writeStdout(value: string): void;
};

type CleanupReceipt =
  | {
      schemaVersion: 'centurion-thread-corpus-relay-cleanup-receipt-v1';
      outcome: 'complete';
      transferId: string;
    }
  | {
      schemaVersion: 'centurion-thread-corpus-relay-cleanup-receipt-v1';
      outcome: 'blocked';
    };

function blockedReceipt(): CleanupReceipt {
  return {
    schemaVersion: 'centurion-thread-corpus-relay-cleanup-receipt-v1',
    outcome: 'blocked',
  };
}

function isCanonicalTransferId(value: unknown): value is string {
  try {
    return typeof value === 'string' && Boolean(relayManifestKey('safe-relay', value));
  } catch {
    return false;
  }
}

function writeReceipt(dependencies: FinalizeCommandDependencies, receipt: CleanupReceipt): void {
  try {
    dependencies.writeStdout(`${JSON.stringify(receipt)}\n`);
  } catch {}
}

export function createFinalizeCenturionThreadCorpusRelayCommand(
  overrides: Partial<FinalizeCommandDependencies> = {},
): () => Promise<number> {
  const dependencies: FinalizeCommandDependencies = {
    args: () => process.argv.slice(2),
    runtime: createDefaultRelaySourceRuntime(),
    objectStoreFor: createAwsRelayObjectStore,
    writeStdout: (value) => process.stdout.write(value),
    ...overrides,
  };
  return async (): Promise<number> => {
    try {
      const args = dependencies.args();
      if (args.length !== 2 || args[0] !== '--transfer-id' || !isCanonicalTransferId(args[1])) {
        writeReceipt(dependencies, blockedReceipt());
        return 2;
      }
      const config = parseRelaySourceRuntimeConfig(
        await dependencies.runtime.readProtectedConfig(),
      );
      if (!config) {
        writeReceipt(dependencies, blockedReceipt());
        return 3;
      }
      const result = await finalizeCenturionThreadCorpusRelay({
        config,
        transferId: args[1],
        store: dependencies.objectStoreFor(config.relay),
        source: dependencies.runtime,
      });
      if (result.outcome !== 'complete') {
        writeReceipt(dependencies, blockedReceipt());
        return 3;
      }
      writeReceipt(dependencies, {
        schemaVersion: 'centurion-thread-corpus-relay-cleanup-receipt-v1',
        outcome: 'complete',
        transferId: result.transferId,
      });
      return 0;
    } catch {
      writeReceipt(dependencies, blockedReceipt());
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
  void createFinalizeCenturionThreadCorpusRelayCommand()().then((code) => {
    process.exitCode = code;
  });
}
