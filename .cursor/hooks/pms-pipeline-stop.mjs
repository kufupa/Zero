import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hookDecision,
  pipelineStopGate,
  repoRootFrom,
  toolDir,
  verify,
} from '../../apps/server-pilot/tooling/pms-pipeline/pipeline.mjs';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const repoRoot = repoRootFrom(process.cwd());
const activePath = join(repoRoot, '.private/pms-pipeline/ACTIVE.json');

function reply(response) {
  process.stdout.write(JSON.stringify(response));
}

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

const active = readJson(activePath, null);
if (!pipelineStopGate(active, input.conversation_id).run) {
  reply({});
} else if (existsSync(join(toolDir(repoRoot, active.tool), 'DONE.md'))) {
  reply({});
} else {
  const dir = toolDir(repoRoot, active.tool);
  const stopFile = join(dir, 'STOP.md');
  const stopReason = existsSync(stopFile)
    ? (readFileSync(stopFile, 'utf8').match(/^reason:\s*(\S+)/m)?.[1] ?? null)
    : null;
  const statePath = join(dir, 'hook-state.json');
  const result = verify(dir, { repoRoot });
  const decision = hookDecision({ active: active.tool, result, state: readJson(statePath, {}), stopReason });
  if (decision.state) writeFileSync(statePath, JSON.stringify(decision.state, null, 2));
  if (decision.write === 'DONE') {
    writeFileSync(join(dir, 'DONE.md'), `# ${active.tool} DONE\n\nAll verify checks PASS at ${new Date().toISOString()}.\n`);
  }
  if (decision.write === 'STOP') {
    writeFileSync(stopFile, [
      'reason: human_decision',
      '',
      `check: ${result.next.id} (stage ${result.next.stage})`,
      `detail: ${result.next.detail}`,
      result.next.stop ? 'why: check is a stop condition' : `why: same failure after ${decision.state.repeats} attempts`,
      '',
    ].join('\n'));
  }
  reply(decision.response);
}
