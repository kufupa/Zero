/**
 * Local Promptfoo MIT CLI wrap of U5 same-move gold.
 * Ops JSON only. Never share. Never send mail bodies.
 *
 *   pnpm --filter @zero/server eval:same-move
 *   pnpm --filter @zero/server eval:same-move -- --ops evals/same-move/joined-ops.jsonl
 */
import {
  parseSameMoveEvalCli,
  runSameMoveOpsEval,
  runSameMovePromptfooEval,
} from '../src/ai/same-move-scorer.js';

const cli = parseSameMoveEvalCli(process.argv.slice(2));
if (cli.mode === 'ops') {
  const report = runSameMoveOpsEval(cli.opsPath);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 0;
} else {
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
}
