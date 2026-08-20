import { readFileSync } from 'node:fs';
import { adjudicateCenturionThreadState } from '../src/ops/centurion-thread-adjudication.js';

const [inputPath, rosterPath] = process.argv.slice(2);
const corpora = JSON.parse(readFileSync(inputPath!, 'utf8'));
const roster = JSON.parse(readFileSync(rosterPath!, 'utf8'));

try {
  adjudicateCenturionThreadState({
    corpora,
    roster,
    identityRulesVersion: 'identity-rules-v1',
    classifierVersion: 'deterministic-classifier-v1',
    metricDefinitionVersion: 'metric-definition-v2',
  });
  process.stdout.write('{"status":"unexpected_success"}\n');
} catch (error) {
  const stack = error instanceof Error ? error.stack ?? '' : '';
  process.stdout.write(
    `${JSON.stringify({
      status: 'failed',
      code: error instanceof Error ? error.message : 'unknown',
      frames: stack
        .split('\n')
        .filter((line) => line.includes('centurion-thread-adjudication'))
        .slice(0, 6),
    })}\n`,
  );
}
