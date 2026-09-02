#!/usr/bin/env npx tsx
/** Gold eval for Layer B conversation signals — confusion matrix counts only (no PII). */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateGoldContract,
  evaluateGoldGate,
  formatConfusionMatrixStdout,
  GOLD_ACTIONABLE_TOTAL,
  GOLD_RESPONDED_TOTAL,
  GOLD_UNANSWERED_TOTAL,
  resolvePrivateCorpusRoot,
  runConversationSignalsGoldEvalFromCorpus,
} from '../src/ops/centurion-conversation-signals-eval.js';

function main() {
  const startDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const corpusRoot = resolvePrivateCorpusRoot(startDir);
  const result = runConversationSignalsGoldEvalFromCorpus(corpusRoot);
  console.log(formatConfusionMatrixStdout(result.matrix));
  if (!evaluateGoldContract(result.matrix).pass) {
    console.error(
      [
        `Gold contract failed: expected skippedThreads=0, goldTotal=${GOLD_ACTIONABLE_TOTAL}, ` +
          `goldResponded=${GOLD_RESPONDED_TOTAL}, goldUnanswered=${GOLD_UNANSWERED_TOTAL}`,
        `Got skippedThreads=${result.matrix.skippedThreads}, goldTotal=${result.matrix.goldTotal}, ` +
          `goldResponded=${result.matrix.goldResponded}, goldUnanswered=${result.matrix.goldUnanswered}`,
      ].join('\n'),
    );
    process.exit(1);
  }
  process.exit(evaluateGoldGate(result.matrix).pass ? 0 : 1);
}

main();
