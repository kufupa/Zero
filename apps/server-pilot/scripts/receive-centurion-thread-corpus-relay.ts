import {
  createDefaultReceiverFileSystem,
  createDefaultRelayReceiverRuntime,
  createWindowsPrivateAcl,
  parseRelayReceiverRuntimeConfig,
  receiveCenturionThreadCorpusRelay,
  type ReceiverFileSystem,
  type RelayReceiverRuntimePort,
  type WindowsPrivateAcl,
} from '../src/ops/centurion-thread-corpus-relay-receiver.js';
import {
  createAwsRelayObjectStore,
  type RelayBucketConfig,
  type RelayObjectStore,
} from '../src/ops/centurion-thread-corpus-relay-producer.js';
import { relayManifestKey } from '../src/ops/centurion-thread-corpus-relay.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type ReceiveCommandDependencies = {
  args(): readonly string[];
  runtime: RelayReceiverRuntimePort;
  objectStoreFor(config: RelayBucketConfig): RelayObjectStore;
  fileSystemFor(config: RelayReceiverRuntimeConfigForFileSystem): ReceiverFileSystem;
  acl: WindowsPrivateAcl;
  writeStdout(value: string): void;
};

type RelayReceiverRuntimeConfigForFileSystem = {
  privateDestination: { destinationRoot: string };
};

type ReceiveReceipt =
  | {
      schemaVersion: 'centurion-thread-corpus-relay-receive-receipt-v1';
      outcome: 'received';
      transferId: string;
      sourceManifestSha256: string;
      memberSetSha256: string;
    }
  | {
      schemaVersion: 'centurion-thread-corpus-relay-receive-receipt-v1';
      outcome: 'blocked';
    };

function blockedReceipt(): ReceiveReceipt {
  return {
    schemaVersion: 'centurion-thread-corpus-relay-receive-receipt-v1',
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

function writeReceipt(dependencies: ReceiveCommandDependencies, receipt: ReceiveReceipt): void {
  try {
    dependencies.writeStdout(`${JSON.stringify(receipt)}\n`);
  } catch {}
}

export function createReceiveCenturionThreadCorpusRelayCommand(
  overrides: Partial<ReceiveCommandDependencies> = {},
): () => Promise<number> {
  const dependencies: ReceiveCommandDependencies = {
    args: () => process.argv.slice(2),
    runtime: createDefaultRelayReceiverRuntime(),
    objectStoreFor: createAwsRelayObjectStore,
    fileSystemFor: (config) =>
      createDefaultReceiverFileSystem(config.privateDestination.destinationRoot),
    acl: createWindowsPrivateAcl(),
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
      const config = parseRelayReceiverRuntimeConfig(
        await dependencies.runtime.readProtectedConfig(),
      );
      if (!config) {
        writeReceipt(dependencies, blockedReceipt());
        return 3;
      }
      const result = await receiveCenturionThreadCorpusRelay({
        config,
        transferId: args[1],
        store: dependencies.objectStoreFor(config.relay),
        fileSystem: dependencies.fileSystemFor(config),
        acl: dependencies.acl,
        runtime: dependencies.runtime,
      });
      if (result.outcome !== 'received') {
        writeReceipt(dependencies, blockedReceipt());
        return 3;
      }
      writeReceipt(dependencies, {
        schemaVersion: 'centurion-thread-corpus-relay-receive-receipt-v1',
        outcome: 'received',
        transferId: result.transferId,
        sourceManifestSha256: result.sourceManifestSha256,
        memberSetSha256: result.memberSetSha256,
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
  void createReceiveCenturionThreadCorpusRelayCommand()().then((code) => {
    process.exitCode = code;
  });
}
