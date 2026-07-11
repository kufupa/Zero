#!/usr/bin/env node
/**
 * Overnight EC2-pilot code audit — T3MP3ST decompose + grok-4.5.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = join(__dirname, '..');
const REPO_ROOT = resolve(TOOLS_ROOT, '../..');
const VENDOR = join(TOOLS_ROOT, '.vendor', 'T3MP3ST');
const REPORT_DIR = join(REPO_ROOT, 'docs/superpowers/plans/handoff-reports');
const REPORT = join(REPORT_DIR, '2026-07-07-ec2-pilot-t3mp3st-overnight-audit.md');

const EXCLUDE_PARTS = [
  '/node_modules/',
  '/dist/',
  '/.next/',
  '/drizzle/',
  '/tests/',
  '/deploy/',
  '/src/ai/',
  '/ai/',
];

const PRIORITY_HINTS = [
  'auth',
  'mail',
  'ingest',
  'trpc',
  'sanitize',
  'session',
  'cookie',
  'upload',
  'attachment',
  'signed',
  'html',
  'xss',
  'csrf',
  'middleware',
  'env',
  'db/client',
];

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i);
    const v = t.slice(i + 1).replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function score(path) {
  const rel = path.replace(/\\/g, '/').toLowerCase();
  let s = 0;
  for (const h of PRIORITY_HINTS) if (rel.includes(h)) s += 10;
  if (rel.includes('server-pilot')) s += 5;
  if (rel.includes('routes/')) s += 8;
  return s;
}

function collectScope() {
  const roots = [
    join(REPO_ROOT, 'apps/server-pilot/src'),
    join(REPO_ROOT, 'apps/mail'),
  ];
  const files = [];
  for (const r of roots) {
    for (const f of walk(r)) {
      const rel = `/${relative(REPO_ROOT, f).replace(/\\/g, '/')}/`;
      if (EXCLUDE_PARTS.some((x) => rel.includes(x))) continue;
      if (rel.includes('/apps/server-pilot/src/ai/')) continue;
      files.push(f);
    }
  }
  return [...new Set(files)].sort((a, b) => score(b) - score(a));
}

function appendReport(title, body) {
  const block = `\n\n## ${title}\n\n_${new Date().toISOString()}_\n\n${body}\n`;
  appendFileSync(REPORT, block, 'utf8');
  console.log(`[audit] appended: ${title}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (opts.onStdout) opts.onStdout(d.toString());
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ out, err });
      else reject(new Error(`${cmd} ${args.join(' ')} exit ${code}\n${err || out}`));
    });
  });
}

async function testLlm() {
  const { out } = await run('node', [join(TOOLS_ROOT, 'scripts/test-llm.mjs')], {
    cwd: TOOLS_ROOT,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

async function decomposePass({ label, objective, files }) {
  const relFiles = files.map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/')).join(',');
  const env = {
    TEMPEST_ORCHESTRATOR_PROVIDER: 'xai',
    TEMPEST_ORCHESTRATOR_MODEL: 'grok-4.5',
    TEMPEST_WORKER_PROVIDER: 'xai',
    TEMPEST_WORKER_MODEL: 'grok-4.5',
    XAI_REASONING_EFFORT: 'high',
  };
  const args = [
    'scripts/decompose.mjs',
    '--objective',
    objective,
    '--source-dir',
    REPO_ROOT,
    '--source-files',
    relFiles,
    '--orchestrator-provider',
    'xai',
    '--orchestrator-model',
    'grok-4.5',
    '--worker-provider',
    'xai',
    '--worker-model',
    'grok-4.5',
    '--rounds',
    '3',
    '--queries-per-round',
    '6',
    '--parallel',
    'true',
    '--verbose',
    'true',
  ];
  let buf = '';
  await run('node', args, {
    cwd: VENDOR,
    env,
    onStdout: (s) => {
      buf += s;
      process.stdout.write(s);
    },
  });
  appendReport(`T3MP3ST decompose — ${label}`, `\`\`\`\n${buf.slice(-120000)}\n\`\`\``);
}

async function main() {
  loadEnv(join(REPO_ROOT, '.env'));
  loadEnv(join(TOOLS_ROOT, '.env'));
  loadEnv(join(homedir(), '.t3mp3st', '.env'));

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    REPORT,
    `# EC2-pilot overnight code audit (T3MP3ST + grok-4.5)

**Branch:** EC2-pilot  
**Mode:** code-only — no AWS prod, no live network probes  
**Scope:** \`apps/server-pilot/**\` (excl \`src/ai/**\` Mastra parallel work), \`apps/mail/**\` FE  
**Out of scope:** legacy \`apps/server\` Cloudflare worker, Mastra AI pipeline implementation  
**Backbone:** xAI \`grok-4.5\` + \`reasoning_effort=high\`

Progressive findings append below.

`,
    'utf8',
  );

  appendReport('Setup', '- Report initialized\n- Loading XAI from repo `.env`');

  if (!process.env.XAI_API_KEY) {
    throw new Error('XAI_API_KEY missing in repo .env');
  }

  await run('bash', [join(TOOLS_ROOT, 'configure.sh')], { cwd: TOOLS_ROOT });
  const llm = await testLlm();
  appendReport('LLM smoke test', `\`\`\`json\n${JSON.stringify(llm, null, 2)}\n\`\`\``);

  const files = collectScope();
  appendReport(
    'Scope inventory',
    `Collected **${files.length}** production TS/TSX files.\n\nTop priority paths:\n${files
      .slice(0, 40)
      .map((f) => `- \`${relative(REPO_ROOT, f).replace(/\\/g, '/')}\``)
      .join('\n')}`,
  );

  const serverPilot = files.filter((f) => f.includes('server-pilot'));
  const mailFe = files.filter((f) => f.includes(`${join('apps', 'mail')}`) || f.includes('apps/mail'));

  const passes = [
    {
      label: 'server-pilot trust boundaries',
      objective:
        'Authorized white-box security audit of EC2-pilot server-pilot backend. Find exploitable trust-boundary bugs: auth bypass, cross-mailbox isolation breaks, stored XSS in mail HTML, forged ingest headers, unsafe signed URLs, SQL injection, missing authorization on tRPC routes, TLS verification gaps, secret leakage. Ignore in-progress Mastra AI worker code under src/ai. Cite file:line. Rank P0-P3 with exploit path.',
      files: serverPilot.slice(0, 24),
    },
    {
      label: 'server-pilot mail ingest + routes (deep)',
      objective:
        'Deep audit mail ingest pipeline, parse-message, store, send, trpc mail routes, drafts, attachments, S3 storage. Focus regression vs prior audit findings: unsanitized htmlBody, X-Zero-Mailbox header trust, Content-Disposition filename injection. Code only — no live AWS.',
      files: serverPilot.filter((f) => /mail|ingest|trpc/.test(f)).slice(0, 20),
    },
    {
      label: 'mail frontend security',
      objective:
        'Authorized audit of apps/mail frontend: HTML email rendering XSS, CSP gaps, auth session handling, tRPC client trust, CSRF/cookie issues, dangerous dangerouslySetInnerHTML, attachment preview, polling/cache leaks across mailboxes. Cite file:line. P0-P3.',
      files: mailFe.slice(0, 24),
    },
    {
      label: 'cross-cutting regression vs 2026-07-01 audit',
      objective:
        'Re-validate EC2-pilot security audit items: stored XSS seam, forgeable mailbox header, RDS rejectUnauthorized false, signed URL disposition, open signup, accountLinking allowDifferentEmails, test shortcuts in prod auth middleware. Mark fixed/open/deferred with evidence.',
      files: [...serverPilot.slice(0, 12), ...mailFe.slice(0, 8)],
    },
  ];

  for (const pass of passes) {
    if (!pass.files.length) continue;
    appendReport(`Starting pass: ${pass.label}`, `${pass.files.length} files queued.`);
    try {
      await decomposePass(pass);
    } catch (e) {
      appendReport(`PASS FAILED: ${pass.label}`, String(e));
    }
  }

  appendReport(
    'Run complete',
    `- Finished ${passes.length} T3MP3ST decompose passes\n- Review sections above for findings\n- No production code was modified`,
  );
  console.log(`[audit] report → ${REPORT}`);
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
