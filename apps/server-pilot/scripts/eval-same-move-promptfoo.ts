/**
 * Local Promptfoo MIT CLI wrap of U5 same-move gold.
 * Ops JSON only. Never share. Never send mail bodies.
 *
 *   pnpm --filter @zero/server eval:same-move
 */
import { runSameMovePromptfooEval } from '../src/ai/same-move-scorer.js';

const report = await runSameMovePromptfooEval();
process.stdout.write(
  `${JSON.stringify({
    event: report.passed ? 'same_move_promptfoo.complete' : 'same_move_promptfoo.failed',
    sharing: report.sharing,
    remote: report.remote,
    passed: report.passed,
    cases: report.cases,
  })}\n`,
);
process.exitCode = report.passed ? 0 : 1;
