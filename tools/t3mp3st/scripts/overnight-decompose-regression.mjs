#!/usr/bin/env node
/**
 * Pass 3 — T3MP3ST decompose regression vs 2026-07-01 EC2-pilot security audit.
 * Appends to cli-swarm audit report. Read-only.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './lib/scope-allowlist.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = join(__dirname, '..');
const REPO_ROOT = resolve(TOOLS_ROOT, '../..');
const VENDOR = join(TOOLS_ROOT, '.vendor', 'T3MP3ST');
const REPORT = join(
  REPO_ROOT,
  'docs/superpowers/plans/handoff-reports/2026-07-07-ec2-pilot-t3mp3st-cli-swarm-audit.md',
);

const PRIOR_AUDIT = 'docs/superpowers/plans/2026-07-01-ec2-pilot-security-audit.md';

const PASSES = [
  {
    label: 'P2 stored XSS + htmlBody seam',
    objective:
      'Re-validate EC2-pilot finding #1: inbound email HTML stored/served unsanitized. Check mail/ingest/store.ts and trpc/routes/mail.ts processEmailContent. Mark FIXED/OPEN/DEFERRED with file:line evidence. Rank P0-P3.',
    files: [
      'apps/server-pilot/src/mail/ingest/store.ts',
      'apps/server-pilot/src/trpc/routes/mail.ts',
    ],
  },
  {
    label: 'P2 X-Zero-Mailbox header trust',
    objective:
      'Re-validate finding #2: forgeable X-Zero-Mailbox header for cross-mailbox injection. parse-message.ts, store.ts ingest path. FIXED/OPEN with exploit path.',
    files: [
      'apps/server-pilot/src/mail/ingest/parse-message.ts',
      'apps/server-pilot/src/mail/ingest/store.ts',
    ],
  },
  {
    label: 'P2 RDS TLS rejectUnauthorized',
    objective:
      'Re-validate finding #3: RDS TLS certificate verification disabled. db/client.ts ssl config. FIXED/OPEN.',
    files: ['apps/server-pilot/src/db/client.ts', 'apps/server-pilot/src/db/ssl-config.ts'],
  },
  {
    label: 'P3 auth + tRPC test shortcuts',
    objective:
      'Re-validate findings #4-7: signed URL Content-Disposition, open signup, accountLinking, test shortcuts in trpc middleware. lib/auth.ts, trpc/trpc.ts, mail routes attachments.',
    files: [
      'apps/server-pilot/src/lib/auth.ts',
      'apps/server-pilot/src/trpc/trpc.ts',
      'apps/server-pilot/src/trpc/routes/mail.ts',
    ],
  },
  {
    label: 'mail FE XSS rendering',
    objective:
      'Audit apps/mail for HTML email rendering XSS, dangerouslySetInnerHTML, CSP. Cite file:line. P0-P3.',
    files: [
      'apps/mail/components/mail/mail-display.tsx',
      'apps/mail/lib/mail/resolve-mail-display-html.ts',
    ],
  },
];

function append(title, body) {
  appendFileSync(REPORT, `\n\n## ${title}\n\n_${new Date().toISOString()}_\n\n${body}\n`, 'utf8');
  console.log(`[decompose] ${title}`);
}

function runDecompose({ label, objective, files }) {
  const rel = files.join(',');
  const args = [
    'scripts/decompose.mjs',
    '--objective',
    objective,
    '--source-dir',
    REPO_ROOT,
    '--source-files',
    rel,
    '--orchestrator-provider',
    'xai',
    '--orchestrator-model',
    'grok-4.3',
    '--worker-provider',
    'xai',
    '--worker-model',
    'grok-4.3',
    '--rounds',
    '3',
    '--queries-per-round',
    '6',
    '--parallel',
    'true',
    '--verbose',
    'true',
  ];
  return new Promise((resolve, reject) => {
    let buf = '';
    const child = spawn('node', args, {
      cwd: VENDOR,
      env: {
        ...process.env,
        XAI_REASONING_EFFORT: 'high',
        TEMPEST_ORCHESTRATOR_PROVIDER: 'xai',
        TEMPEST_ORCHESTRATOR_MODEL: 'grok-4.3',
        TEMPEST_WORKER_PROVIDER: 'xai',
        TEMPEST_WORKER_MODEL: 'grok-4.3',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', (code) => {
      if (code === 0) resolve(buf);
      else reject(new Error(`decompose ${label} exit ${code}\n${buf.slice(-4000)}`));
    });
  });
}

async function main() {
  loadEnvFile(join(REPO_ROOT, '.env'));
  loadEnvFile(join(TOOLS_ROOT, '.env'));
  loadEnvFile(join(homedir(), '.t3mp3st', '.env'));

  if (!process.env.XAI_API_KEY) {
    append('Pass 3 FATAL', 'XAI_API_KEY missing');
    process.exit(1);
  }
  if (!existsSync(join(VENDOR, 'scripts/decompose.mjs'))) {
    append('Pass 3 FATAL', 'vendor missing — pnpm t3mp3st:install');
    process.exit(1);
  }

  append(
    'Pass 3 start — decompose regression',
    `Cross-check vs [\`${PRIOR_AUDIT}\`](../../2026-07-01-ec2-pilot-security-audit.md). T3MP3ST decompose + grok-4.3.`,
  );

  for (const pass of PASSES) {
    const existing = pass.files.filter((f) => existsSync(join(REPO_ROOT, f)));
    if (!existing.length) {
      append(`Pass 3 SKIP: ${pass.label}`, 'No files on disk');
      continue;
    }
    append(`Pass 3 starting: ${pass.label}`, existing.map((f) => `- \`${f}\``).join('\n'));
    try {
      const out = await runDecompose({ ...pass, files: existing });
      append(`T3MP3ST decompose — ${pass.label}`, `\`\`\`\n${out.slice(-120000)}\n\`\`\``);
    } catch (e) {
      append(`Pass 3 FAILED: ${pass.label}`, String(e));
    }
  }

  append(
    'Pass 3 complete',
    '- Decompose regression passes finished\n- Compare with cli-swarm CLEAN verdict and prior audit table',
  );
  console.log(`[decompose] done → ${REPORT}`);
}

main().catch((e) => {
  append('Pass 3 FATAL', String(e));
  process.exit(1);
});
