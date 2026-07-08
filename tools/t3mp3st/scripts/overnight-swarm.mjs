#!/usr/bin/env node
/**
 * Overnight EC2-pilot audit — T3MP3ST cli-swarm + xAI grok-4.3.
 * Read-only: no production code edits. No AWS/network targets.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectScopedFiles, loadEnvFile } from './lib/scope-allowlist.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = join(__dirname, '..');
const REPO_ROOT = resolve(TOOLS_ROOT, '../..');
const VENDOR = join(TOOLS_ROOT, '.vendor', 'T3MP3ST');
const SWARM_SCRIPT = join(VENDOR, 'scripts/cli-swarm.mjs');
const REPORT_DIR = join(REPO_ROOT, 'docs/superpowers/plans/handoff-reports');
const DEFAULT_REPORT = join(REPORT_DIR, '2026-07-07-ec2-pilot-t3mp3st-cli-swarm-audit.md');
let REPORT = DEFAULT_REPORT;

function resolveReportPath(arg) {
  if (!arg) return DEFAULT_REPORT;
  return arg.startsWith('/') || /^[A-Za-z]:/.test(arg) ? arg : resolve(REPO_ROOT, arg);
}

const EC2_SCOPE_NOTE = `
EC2-pilot monorepo scope (production code only):
- apps/server-pilot/src/** EXCLUDING apps/server-pilot/src/ai/** (parallel Mastra work)
- apps/mail/** frontend
- OUT: legacy apps/server, production AWS, tests/fixtures as primary findings
- Re-check prior audit: HTML XSS seam, X-Zero-Mailbox header trust, RDS TLS, signed URL disposition, auth shortcuts
`;

function appendReport(title, body) {
  const block = `\n\n## ${title}\n\n_${new Date().toISOString()}_\n\n${body}\n`;
  appendFileSync(REPORT, block, 'utf8');
  console.log(`[swarm] appended: ${title}`);
}

function loadAllEnv() {
  loadEnvFile(join(REPO_ROOT, '.env'));
  loadEnvFile(join(TOOLS_ROOT, '.env'));
  loadEnvFile(join(homedir(), '.t3mp3st', '.env'));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
      if (opts.onStdout) opts.onStdout(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      process.stderr.write(s);
    });
    child.on('close', (code) => {
      if (code === 0 || opts.allowNonZero) resolvePromise({ out, err, code });
      else reject(new Error(`${cmd} exit ${code}\n${err || out}`));
    });
  });
}

function latestSwarmTranscript() {
  const dir = join(VENDOR, 'bench', 'wild-hunt', 'swarm');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('swarm-') && f.endsWith('.json'))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0] ? join(dir, files[0].f) : null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pass = process.env.XAI_SWARM_PASS || '1';
  const reportIdx = process.argv.indexOf('--report');
  if (reportIdx >= 0 && process.argv[reportIdx + 1]) {
    REPORT = resolveReportPath(process.argv[reportIdx + 1]);
  } else if (process.env.XAI_SWARM_REPORT) {
    REPORT = resolveReportPath(process.env.XAI_SWARM_REPORT);
  }
  loadAllEnv();

  mkdirSync(REPORT_DIR, { recursive: true });
  if (pass === '1') {
    writeFileSync(
      REPORT,
      `# EC2-pilot overnight cli-swarm audit (T3MP3ST + xAI grok-4.3)

**Branch:** EC2-pilot  
**Mode:** read-only code audit — T3MP3ST cli-swarm, no AWS prod, no live network probes  
**Backbone:** xAI \`grok-4.3\` + \`reasoning_effort=high\`  
**Pipeline:** cli-swarm specialists → skeptic → triage (NOT Cursor agent manual audit)

Progressive output below.

`,
      'utf8',
    );
  } else {
    appendReport(`Pass ${pass} start`, `Deep sweep — squad \`${process.env.XAI_SWARM_SQUAD || 'full'}\`, tool rounds ${process.env.XAI_SWARM_MAX_TOOL_ROUNDS || '35'}`);
  }

  if (!process.env.XAI_API_KEY) {
    appendReport('FATAL', 'XAI_API_KEY missing in repo `.env`');
    process.exit(1);
  }

  if (!existsSync(SWARM_SCRIPT)) {
    appendReport('FATAL', 'T3MP3ST vendor missing — run `pnpm t3mp3st:install`');
    process.exit(1);
  }

  appendReport('Setup', '- Report initialized\n- Loading XAI from repo `.env`');

  await run('bash', [join(TOOLS_ROOT, 'configure.sh')], { cwd: TOOLS_ROOT });
  const llmOut = await run('node', [join(TOOLS_ROOT, 'scripts/test-llm.mjs')], { cwd: TOOLS_ROOT });
  appendReport('LLM smoke test', `\`\`\`json\n${llmOut.out.trim().split('\n').pop()}\n\`\`\``);

  const scoped = collectScopedFiles(REPO_ROOT);
  appendReport(
    'Scope inventory',
    `**${scoped.length}** scoped TS/JS files under server-pilot (excl ai) + mail.\n\nTop paths:\n${scoped
      .slice(0, 30)
      .map((f) => `- \`${relative(REPO_ROOT, f).replace(/\\/g, '/')}\``)
      .join('\n')}\n\n${EC2_SCOPE_NOTE}`,
  );

  const squad =
    process.env.XAI_SWARM_SQUAD ||
    'full';

  const swarmArgs = [
    SWARM_SCRIPT,
    '--repo',
    REPO_ROOT,
    '--backend',
    'xai',
    '--model',
    'grok-4.3',
    '--effort',
    'high',
    '--rounds',
    String(process.env.XAI_SWARM_ROUNDS || '3'),
    '--concurrency',
    String(process.env.XAI_SWARM_CONCURRENCY || '2'),
    '--budget-min',
    String(process.env.XAI_SWARM_BUDGET_MIN || '240'),
    '--squad',
    squad,
  ];

  const env = {
    T3MP3ST_WRAPPER_ROOT: TOOLS_ROOT.replace(/\\/g, '/'),
    XAI_REASONING_EFFORT: process.env.XAI_REASONING_EFFORT || 'high',
    XAI_SWARM_SCOPE_ROOTS: 'apps/server-pilot/src,apps/mail',
  };

  if (dryRun) {
    appendReport('Dry run', `\`\`\`\nnode ${swarmArgs.join(' ')}\nenv T3MP3ST_WRAPPER_ROOT=${env.T3MP3ST_WRAPPER_ROOT}\n\`\`\``);
    console.log('[swarm] dry-run only');
    return;
  }

  appendReport('Starting cli-swarm', `Command: \`node scripts/cli-swarm.mjs --backend xai ...\`\nSquad: \`${squad}\``);

  let buf = '';
  let currentRound = '';
  try {
    const result = await run('node', swarmArgs, {
      cwd: VENDOR,
      env,
      allowNonZero: true,
      onStdout: (s) => {
        buf += s;
        const m = s.match(/ROUND (\d+)\//);
        if (m && m[1] !== currentRound) {
          currentRound = m[1];
          appendReport(`cli-swarm round ${currentRound} (partial)`, `\`\`\`\n${buf.slice(-80000)}\n\`\`\``);
        }
      },
    });

    appendReport('cli-swarm stdout (tail)', `\`\`\`\n${buf.slice(-150000)}\n\`\`\``);

    const transcript = latestSwarmTranscript();
    if (transcript) {
      const json = readFileSync(transcript, 'utf8');
      appendReport('Transcript JSON', `Path: \`${relative(REPO_ROOT, transcript).replace(/\\/g, '/')}\`\n\n\`\`\`json\n${json.slice(0, 200000)}\n\`\`\``);
    }

  appendReport(
    'Run complete',
    `- cli-swarm exit code: ${result.code}\n- T3MP3ST ran audit; no production code modified\n- Review transcript + sections above`,
  );

  const passLabel = process.env.XAI_SWARM_PASS || '1';
  if (passLabel === '1' && !process.env.XAI_SWARM_NO_DEEP_PASS) {
    appendReport(
      'Deep pass note',
      'Pass 1 done. Launch pass 2: `XAI_SWARM_PASS=2 pnpm t3mp3st:swarm:overnight` (full squad, 35 tool rounds).',
    );
  }
    console.log(`[swarm] report → ${REPORT}`);
    process.exit(result.code === 4 ? 1 : 0);
  } catch (e) {
    appendReport('FATAL', String(e));
    if (buf) appendReport('Partial stdout', `\`\`\`\n${buf.slice(-100000)}\n\`\`\``);
    process.exit(1);
  }
}

main().catch((e) => {
  try {
    appendReport('FATAL', String(e));
  } catch {
    // ignore
  }
  console.error(e);
  process.exit(1);
});
