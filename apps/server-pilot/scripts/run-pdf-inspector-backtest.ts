#!/usr/bin/env npx tsx
import { pathToFileURL } from 'node:url';
import { runPdfInspectorBacktestCli } from '../src/ops/pdf-inspector-backtest-runner.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift();
  process.exitCode = await runPdfInspectorBacktestCli(argv);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
