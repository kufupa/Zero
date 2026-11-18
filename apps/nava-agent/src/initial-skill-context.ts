import { skillRead } from '../tools/skills/index.js';
import type { SkillConfig } from '../tools/skills/index.js';

const triagePaths = ['SKILL.md', 'references/rules.md', '../references/common.md', '../references/tools-and-proposal.md'];

export async function initialSkillContext(config: SkillConfig, sessionId: string, mode: 'live' | 'labtest' | 'historical', signal?: AbortSignal): Promise<string | null> {
  const results = await Promise.all(triagePaths.map(path => skillRead({ skill_name: 'triage', path }, { sessionId, mode, signal, skillConfig: config })));
  const files: { path: string; text: string }[] = [];
  for (const result of results) {
    const data = result.data;
    if (!result.ok || typeof data !== 'object' || data === null || !('path' in data) || typeof data.path !== 'string' || !('text' in data) || typeof data.text !== 'string') return null;
    files.push({ path: data.path, text: data.text });
  }
  return `The following pinned skill files are already loaded. Do not load these files again; use skill_read for other relevant workflow files and references.\n${files.map(file => `\n--- ${file.path} ---\n${file.text}`).join('\n')}`;
}
