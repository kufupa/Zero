import { readFile } from 'node:fs/promises';
import { pinSkills, skillRead } from './index.js';
import type { SkillPin } from './index.js';

async function main() {
  const [command, root, ...args] = process.argv.slice(2);
  if (command === 'pin' && root && args.length === 0) {
    console.log(JSON.stringify(await pinSkills(root)));
    return;
  }
  if (command === 'read' && root && (args.length === 2 || args.length === 3)) {
    const [pinFile, skill_name, path] = args;
    const pin: SkillPin = JSON.parse(await readFile(pinFile, 'utf8'));
    const result = await skillRead({ skill_name, ...(path === undefined ? {} : { path }) }, {
      sessionId: 'cli', mode: 'historical', skillConfig: { root, pin },
    });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: cli.ts pin <absolute-root> | read <absolute-root> <pin-json> <skill-name> [relative-path]');
}
main().catch(() => { console.error('Skill CLI failed.'); process.exitCode = 1; });
