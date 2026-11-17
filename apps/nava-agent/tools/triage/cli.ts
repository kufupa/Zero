import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tools, type ToolContext } from './index.js';

async function main() {
  const request: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (!request || typeof request !== 'object' || !('tool' in request) || typeof request.tool !== 'string' || !('input' in request)) throw new Error('INVALID_REQUEST');
  const tool = tools.find(item => item.name === request.tool);
  if (!tool) throw new Error('UNKNOWN_TOOL');
  const mode = 'mode' in request ? request.mode : 'live';
  if (mode !== 'live' && mode !== 'labtest' && mode !== 'historical') throw new Error('INVALID_MODE');
  const context: ToolContext = { sessionId: 'direct-cli', mode };
  const result = await tool.run(request.input, context);
  const output = process.argv[2];
  if (output) await writeFile(output, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ ok: result.ok, error: result.error, result_saved: Boolean(output) })}\n`);
  if (!result.ok) process.exitCode = 1;
}
main().catch(() => { process.stderr.write('CLI_FAILED\n'); process.exitCode = 1; });
