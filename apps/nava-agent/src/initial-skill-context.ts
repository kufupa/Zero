import { skillRead } from '../tools/skills/index.js';
import type { SkillConfig } from '../tools/skills/index.js';

const workflows = ['triage', 'create', 'amend', 'cancel', 'filing', 'quote'] as const;
const workflowFiles = ['SKILL.md', 'references/rules.md', 'references/replies.md'] as const;
const sharedFiles = ['../references/common.md', '../references/tools-and-proposal.md', '../references/stay-action.md'] as const;

export async function initialSkillContext(config: SkillConfig, sessionId: string, mode: 'live' | 'labtest' | 'historical', signal?: AbortSignal): Promise<string | null> {
  const requests = [
    ...workflows.flatMap(skill_name => workflowFiles.map(path => ({ skill_name, path }))),
    ...sharedFiles.map(path => ({ skill_name: 'triage' as const, path })),
  ];
  const results = await Promise.all(requests.map(request => skillRead(request, { sessionId, mode, signal, skillConfig: config })));
  const files: { path: string; text: string }[] = [];
  for (const [index, result] of results.entries()) {
    const request = requests[index]!;
    const data = result.data;
    if (!result.ok || typeof data !== 'object' || data === null || !('path' in data) || typeof data.path !== 'string' || !('text' in data) || typeof data.text !== 'string') {
      // triage has no replies.md; skip only that optional hole
      if (request.path === 'references/replies.md') continue;
      return null;
    }
    files.push({ path: data.path, text: data.text });
  }
  return `All workflow skills (triage, create, amend, cancel, filing, quote) and shared references are already loaded. Do not call skill_read.\n${files.map(file => `\n--- ${file.path} ---\n${file.text}`).join('\n')}`;
}
