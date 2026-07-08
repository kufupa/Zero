/**
 * Read-only xAI grok agent with repo tools — drop-in for cli-swarm codex backend.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SCOPE_ROOTS,
  isPathInScope,
  loadEnvFile,
} from './scope-allowlist.mjs';

const XAI_URL = 'https://api.x.ai/v1/chat/completions';

export function isRateLimited(text) {
  return /you'?ve hit your usage limit|usage limit|rate.?limit|\b429\b|too many requests|quota exceeded|insufficient_quota/i.test(
    String(text || ''),
  );
}

function loadXaiEnv() {
  const toolsRoot = resolve(import.meta.dirname, '../..');
  loadEnvFile(join(toolsRoot, '.env'));
  loadEnvFile(join(toolsRoot, '..', '..', '.env'));
  loadEnvFile(join(homedir(), '.t3mp3st', '.env'));
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 source file (path relative to repo root).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          start_line: { type: 'integer', description: 'Optional 1-based start line' },
          end_line: { type: 'integer', description: 'Optional 1-based end line (inclusive)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a regex pattern in scoped source files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path_prefix: { type: 'string', description: 'Optional path prefix under repo root' },
          max_matches: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'List scoped files matching a simple glob suffix (e.g. **/mail/*.ts).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          max_results: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
];

function maxFileBytes() {
  return Number(process.env.XAI_SWARM_MAX_FILE_BYTES) || 120_000;
}

function maxToolRounds() {
  return Number(process.env.XAI_SWARM_MAX_TOOL_ROUNDS) || 35;
}

function toolReadFile(repoRoot, scopeRoots, args) {
  const rel = String(args.path || '');
  if (!isPathInScope(repoRoot, rel, scopeRoots)) {
    return { error: `SCOPE DENIED: ${rel}` };
  }
  const abs = resolve(repoRoot, rel);
  if (!existsSync(abs)) return { error: `not found: ${rel}` };
  let text = readFileSync(abs, 'utf8');
  if (text.length > maxFileBytes()) text = `${text.slice(0, maxFileBytes())}\n...[truncated]`;
  const lines = text.split('\n');
  const start = Math.max(1, Number(args.start_line) || 1);
  const end = Math.min(lines.length, Number(args.end_line) || lines.length);
  const slice = lines.slice(start - 1, end).join('\n');
  return { path: rel, start_line: start, end_line: end, content: slice };
}

function walkAll(repoRoot, scopeRoots, dirRel, out) {
  const abs = resolve(repoRoot, dirRel);
  if (!existsSync(abs)) return;
  for (const name of readdirSync(abs)) {
    const rel = dirRel ? `${dirRel}/${name}` : name;
    if (!isPathInScope(repoRoot, rel, scopeRoots)) continue;
    const p = join(abs, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkAll(repoRoot, scopeRoots, rel, out);
    else out.push(rel);
  }
}

function toolGrep(repoRoot, scopeRoots, args) {
  const pattern = String(args.pattern || '');
  const prefix = args.path_prefix ? String(args.path_prefix) : '';
  const max = Math.min(Number(args.max_matches) || 40, 100);
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    return { error: `invalid regex: ${e.message}` };
  }

  const rg = spawnSync('rg', ['--no-heading', '-n', pattern, prefix || '.'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!rg.error && rg.status === 0) {
    const hits = rg.stdout
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const file = line.split(':')[0];
        return isPathInScope(repoRoot, file, scopeRoots);
      })
      .slice(0, max);
    return { matches: hits, engine: 'rg' };
  }

  const files = [];
  for (const root of scopeRoots) {
    if (prefix && !root.startsWith(prefix) && !prefix.startsWith(root)) continue;
    walkAll(repoRoot, scopeRoots, root, files);
  }
  const matches = [];
  for (const rel of files) {
    if (prefix && !rel.startsWith(prefix)) continue;
    const text = readFileSync(resolve(repoRoot, rel), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push(`${rel}:${i + 1}:${lines[i].slice(0, 200)}`);
        if (matches.length >= max) return { matches, engine: 'node' };
      }
    }
  }
  return { matches, engine: 'node' };
}

function globMatch(rel, pattern) {
  const p = pattern.replace(/\\/g, '/');
  if (p.includes('**')) {
    const suffix = p.split('**').pop().replace(/^\//, '');
    return suffix ? rel.endsWith(suffix) || rel.includes(suffix) : true;
  }
  return rel.endsWith(p) || rel.includes(p);
}

function toolGlob(repoRoot, scopeRoots, args) {
  const pattern = String(args.pattern || '**/*');
  const max = Math.min(Number(args.max_results) || 60, 200);
  const files = [];
  for (const root of scopeRoots) walkAll(repoRoot, scopeRoots, root, files);
  return { files: files.filter((f) => globMatch(f, pattern)).slice(0, max) };
}

function runTool(repoRoot, scopeRoots, name, rawArgs) {
  let args = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs || {};
  } catch {
    return JSON.stringify({ error: 'invalid tool arguments JSON' });
  }
  let result;
  if (name === 'read_file') result = toolReadFile(repoRoot, scopeRoots, args);
  else if (name === 'grep') result = toolGrep(repoRoot, scopeRoots, args);
  else if (name === 'glob') result = toolGlob(repoRoot, scopeRoots, args);
  else result = { error: `unknown tool: ${name}` };
  return JSON.stringify(result);
}

async function xaiChat({ apiKey, model, messages, effort, timeoutMs }) {
  const body = {
    model,
    messages,
    tools: TOOL_DEFS,
    max_tokens: 8192,
  };
  if (effort) body.reasoning_effort = effort;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(XAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`xAI ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function systemPrompt(repoRoot, scopeRoots) {
  const roots = scopeRoots.join(', ');
  return `You are a read-only security code auditor. Repository root: ${repoRoot}.
IN-SCOPE: EC2-pilot production code — apps/server-pilot/src (NOT src/ai), apps/mail. Application audit, not npm library.
Paths: ${roots}. Exclude tests/node_modules as primary findings.
Use tools read_file, grep, glob. NEVER modify files.
When finished, put your final answer as a SINGLE JSON array or object on the LAST line with no prose after it.`;
}

/**
 * @returns {Promise<{ok:boolean,text:string,error?:string,rateLimited?:boolean,label?:string}>}
 */
export async function runXaiReadonlyAgent(
  repoRoot,
  prompt,
  { model, effort, label, timeoutMs = 10 * 60 * 1000, scopeRoots } = {},
) {
  loadXaiEnv();
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { ok: false, text: '', error: 'XAI_API_KEY missing', label };
  }

  const roots = (process.env.XAI_SWARM_SCOPE_ROOTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const effectiveRoots = scopeRoots || (roots.length ? roots : DEFAULT_SCOPE_ROOTS);

  const useModel = model || process.env.LLM_MODEL || 'grok-4.3';
  const useEffort = effort || process.env.XAI_REASONING_EFFORT || 'high';

  const messages = [
    { role: 'system', content: systemPrompt(repoRoot, effectiveRoots) },
    { role: 'user', content: prompt },
  ];

  try {
    for (let round = 0; round < maxToolRounds(); round++) {
      const data = await xaiChat({
        apiKey,
        model: useModel,
        messages,
        effort: useEffort,
        timeoutMs,
      });
      const choice = data.choices?.[0];
      const msg = choice?.message;
      if (!msg) {
        return { ok: false, text: '', error: 'empty xAI response', label };
      }

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length) {
        messages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: toolCalls,
        });
        for (const tc of toolCalls) {
          const fn = tc.function || {};
          const out = runTool(repoRoot, effectiveRoots, fn.name, fn.arguments);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: out,
          });
        }
        continue;
      }

      const content = msg.content || '';
      if (isRateLimited(content)) {
        return {
          ok: false,
          text: content,
          error: 'BACKEND rate-limited (usage limit)',
          rateLimited: true,
          label,
        };
      }
      return { ok: true, text: content, label };
    }
    return { ok: false, text: '', error: 'max tool rounds exceeded', label };
  } catch (e) {
    const body = e.body || e.message || String(e);
    if (isRateLimited(body) || e.status === 429) {
      return {
        ok: false,
        text: body,
        error: 'BACKEND rate-limited (usage limit)',
        rateLimited: true,
        label,
      };
    }
    if (e.name === 'AbortError') {
      return { ok: false, text: '', error: 'timeout', label };
    }
    return { ok: false, text: '', error: e.message || String(e), label };
  }
}

export function xaiRunnerModuleUrl() {
  const wrapperRoot = process.env.T3MP3ST_WRAPPER_ROOT;
  const p = wrapperRoot
    ? join(wrapperRoot, 'scripts/lib/xai-repo-agent.mjs')
    : resolve(import.meta.dirname, 'xai-repo-agent.mjs');
  return pathToFileURL(p).href;
}
