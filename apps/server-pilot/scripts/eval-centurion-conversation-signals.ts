#!/usr/bin/env npx tsx
/** Gold eval for Layer B conversation signals — confusion matrix counts only (no PII). */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatConfusionMatrixStdout,
  resolvePrivateCorpusRoot,
  runConversationSignalsGoldEvalFromCorpus,
} from '../src/ops/centurion-conversation-signals-eval.js';

function main() {
  const startDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const corpusRoot = resolvePrivateCorpusRoot(startDir);
  const result = runConversationSignalsGoldEvalFromCorpus(corpusRoot);
  console.log(formatConfusionMatrixStdout(result.matrix));
  if (!result.matrix.skippedThreads && result.matrix.goldTotal !== 438) {
    console.error(`Expected 438 gold threads, got ${result.matrix.goldTotal}`);
    process.exit(1);
  }
  const gate = result.matrix.truePositives >= 221 && result.matrix.falsePositives <= 4;
  process.exit(gate ? 0 : 1);
}

main();
