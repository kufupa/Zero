#!/usr/bin/env npx tsx
/** Gold eval for Layer B conversation signals — confusion matrix counts only (no PII). */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateGoldGate,
  formatConfusionMatrixStdout,
  GOLD_ACTIONABLE_TOTAL,
  resolvePrivateCorpusRoot,
  runConversationSignalsGoldEvalFromCorpus,
} from '../src/ops/centurion-conversation-signals-eval.js';

function main() {
  const startDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const corpusRoot = resolvePrivateCorpusRoot(startDir);
  const result = runConversationSignalsGoldEvalFromCorpus(corpusRoot);
  console.log(formatConfusionMatrixStdout(result.matrix));
  if (!result.matrix.skippedThreads && result.matrix.goldTotal !== GOLD_ACTIONABLE_TOTAL) {
    console.error(`Expected ${GOLD_ACTIONABLE_TOTAL} gold threads, got ${result.matrix.goldTotal}`);
    process.exit(1);
  }
  process.exit(evaluateGoldGate(result.matrix).pass ? 0 : 1);
}

main();
