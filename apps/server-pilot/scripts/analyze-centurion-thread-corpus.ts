import {
  createDefaultAnalysisWorkspacePort,
  runCenturionThreadCorpusAnalysis,
  type AnalysisWorkspacePort,
} from '../src/ops/centurion-thread-corpus-analysis-workspace.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type AnalysisCommandDependencies = {
  args(): readonly string[];
  workspace: AnalysisWorkspacePort;
  writeStdout(value: string): void;
};

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function writeResult(
  dependencies: Pick<AnalysisCommandDependencies, 'writeStdout'>,
  result: { outcome: 'prepared' | 'reconciled' | 'blocked' },
): void {
  try {
    dependencies.writeStdout(`${JSON.stringify(result)}\n`);
  } catch {}
}

export function createAnalyzeCenturionThreadCorpusCommand(
  overrides: Partial<AnalysisCommandDependencies> = {},
): () => Promise<number> {
  const dependencies: AnalysisCommandDependencies = {
    args: overrides.args ?? (() => process.argv.slice(2)),
    workspace: overrides.workspace ?? createDefaultAnalysisWorkspacePort(),
    writeStdout: overrides.writeStdout ?? ((value) => process.stdout.write(value)),
  };
  return async (): Promise<number> => {
    try {
      const args = dependencies.args();
      if (
        args.length !== 3 ||
        (args[0] !== 'prepare' && args[0] !== 'reconcile') ||
        args[1] !== '--transfer-id' ||
        !isUuidV4(args[2])
      ) {
        writeResult(dependencies, { outcome: 'blocked' });
        return 2;
      }
      const result = await runCenturionThreadCorpusAnalysis({
        command: args[0],
        transferId: args[2],
        port: dependencies.workspace,
      });
      writeResult(dependencies, result);
      return result.outcome === 'blocked' ? 3 : 0;
    } catch {
      writeResult(dependencies, { outcome: 'blocked' });
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
  void createAnalyzeCenturionThreadCorpusCommand()().then((code) => {
    process.exitCode = code;
  });
}
