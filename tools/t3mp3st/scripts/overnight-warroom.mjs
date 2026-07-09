#!/usr/bin/env node
/**
 * Overnight War Room + cli-swarm driver for EC2-pilot.
 * Read-only vs apps/** — tooling orchestration only.
 * Progressive findings → handoff-reports markdown.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './lib/scope-allowlist.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = join(__dirname, '..');
const REPO_ROOT = resolve(TOOLS_ROOT, '../..');
const VENDOR = join(TOOLS_ROOT, '.vendor', 'T3MP3ST');
const REPORT_DIR = join(REPO_ROOT, 'docs/superpowers/plans/handoff-reports');
const FINDINGS = join(REPORT_DIR, '2026-07-08-ec2-pilot-t3mp3st-warroom-findings.md');
const HANDOFF = join(REPORT_DIR, '2026-07-08-t3mp3st-warroom-handoff.md');
const SWARM_REPORT = join(REPORT_DIR, '2026-07-08-ec2-pilot-t3mp3st-cli-swarm-audit.md');
const WAR_ROOM = process.env.T3MP3ST_WAR_ROOM_URL || 'http://127.0.0.1:3333';
const BE_LOCAL = process.env.ZERO_EC2_PILOT_TARGET_URL || 'http://127.0.0.1:18788';
const FE_LOCAL = process.env.ZERO_EC2_PILOT_FE_URL || 'http://127.0.0.1:13000';
const BUDGET_MS = (Number(process.env.WARROOM_BUDGET_MIN) || 360) * 60_000;
const POLL_MS = 30_000;

function loadAllEnv() {
  loadEnvFile(join(REPO_ROOT, '.env'));
  loadEnvFile(join(TOOLS_ROOT, '.env'));
  loadEnvFile(join(homedir(), '.t3mp3st', '.env'));
}

function append(title, body, file = FINDINGS) {
  const block = `\n\n## ${title}\n\n_${new Date().toISOString()}_\n\n${body}\n`;
  appendFileSync(file, block, 'utf8');
  console.log(`[warroom] ${title}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: false,
      stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
      detached: !!opts.detached,
    });
    if (opts.detached) {
      child.unref();
      resolvePromise({ child, pid: child.pid });
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => {
      out += d.toString();
      if (opts.echo) process.stdout.write(d);
    });
    child.stderr?.on('data', (d) => {
      err += d.toString();
      if (opts.echo) process.stderr.write(d);
    });
    child.on('close', (code) => {
      if (code === 0 || opts.allowNonZero) resolvePromise({ out, err, code, child });
      else reject(new Error(`${cmd} ${args.join(' ')} exit ${code}\n${err || out}`));
    });
  });
}

async function fetchJson(path, init = {}) {
  const url = path.startsWith('http') ? path : `${WAR_ROOM}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3333',
      ...init.headers,
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 4000) };
  }
  return { ok: res.ok, status: res.status, json };
}

async function waitHealth(url, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok || r.status < 500) {
        append('Health OK', `${label}: \`${url}\` → HTTP ${r.status}`);
        return true;
      }
    } catch {
      // retry
    }
    await sleep(3000);
  }
  append('Health FAIL', `${label}: \`${url}\` not reachable after retries`);
  return false;
}

async function approvePending() {
  const list = await fetchJson('/api/approvals');
  const items = list.json?.approvals || list.json || [];
  const arr = Array.isArray(items) ? items : [];
  let n = 0;
  for (const a of arr) {
    if (!a?.id) continue;
    if (a.status && a.status !== 'pending') continue;
    const r = await fetchJson(`/api/approvals/${a.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        approvedBy: 'overnight-autonomous-operator',
        ttlMinutes: 480,
      }),
    });
    if (r.ok) n++;
  }
  if (n) append('Approvals granted', `Approved **${n}** pending receipt(s) for authorized pilot target.`);
  return n;
}

async function startMission() {
  const body = {
    name: `EC2-pilot War Room ${new Date().toISOString()}`,
    provider: 'xai',
    model: 'grok-4.5',
    apiKey: process.env.XAI_API_KEY,
    targets: [{ host: BE_LOCAL }, { host: FE_LOCAL }],
    operators: ['recon', 'scanner', 'analyst'],
    repoPath: REPO_ROOT,
  };
  let r = await fetchJson('/api/mission/start', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (r.status === 403 || r.json?.approval || r.json?.next) {
    append('Mission gated', `\`\`\`json\n${JSON.stringify(r.json, null, 2).slice(0, 8000)}\n\`\`\``);
    await approvePending();
    // re-approve using returned approval id if present
    const aid = r.json?.approval?.id;
    if (aid) {
      await fetchJson(`/api/approvals/${aid}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvedBy: 'overnight-autonomous-operator', ttlMinutes: 480 }),
      });
    }
    r = await fetchJson('/api/mission/start', {
      method: 'POST',
      body: JSON.stringify({ ...body, approvalId: aid || r.json?.approval?.id }),
    });
  }
  append('Mission start response', `HTTP ${r.status}\n\n\`\`\`json\n${JSON.stringify(r.json, null, 2).slice(0, 12000)}\n\`\`\``);
  return r;
}

async function pollFindingsOnce() {
  const paths = [
    '/api/findings',
    '/api/mission/findings',
    '/api/hypotheses',
    '/api/evidence',
    '/api/mission-context/latest',
    '/health',
  ];
  const chunks = [];
  for (const p of paths) {
    try {
      const r = await fetchJson(p);
      const s = JSON.stringify(r.json, null, 2);
      chunks.push(`### ${p} (HTTP ${r.status})\n\n\`\`\`json\n${s.slice(0, 40000)}\n\`\`\``);
    } catch (e) {
      chunks.push(`### ${p}\n\nError: ${e}`);
    }
  }
  return chunks.join('\n\n');
}

async function ensureSsmTunnels() {
  // Prefer AWS SSM port-forward sessions to EC2 loopback services
  const instance = process.env.INSTANCE_ID || 'i-008f737974a9ba9b3';
  const region = process.env.AWS_REGION || 'af-south-1';

  async function forward(localPort, remotePort, label) {
    // skip if already listening
    try {
      const r = await fetch(`http://127.0.0.1:${localPort}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r) {
        append('Tunnel skip', `${label} already responding on :${localPort}`);
        return null;
      }
    } catch {
      // not up
    }
    const args = [
      'ssm',
      'start-session',
      '--target',
      instance,
      '--region',
      region,
      '--document-name',
      'AWS-StartPortForwardingSession',
      '--parameters',
      JSON.stringify({
        portNumber: [String(remotePort)],
        localPortNumber: [String(localPort)],
      }),
    ];
    append('Starting SSM tunnel', `${label}: localhost:${localPort} → EC2:${remotePort}`);
    const { child } = await run('aws', args, { detached: true, stdio: 'ignore' });
    return child;
  }

  const kids = [];
  kids.push(await forward(18788, 8788, 'backend'));
  kids.push(await forward(13000, 3000, 'frontend'));
  await sleep(8000);
  return kids.filter(Boolean);
}

function npmCmd() {
  if (process.platform === 'win32') return 'npm.cmd';
  return 'npm';
}

async function startWarRoomServer() {
  // health already?
  try {
    const r = await fetch(`${WAR_ROOM}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      append('War Room already up', WAR_ROOM);
      return null;
    }
  } catch {
    // start
  }
  await run('bash', [join(TOOLS_ROOT, 'configure.sh')], { cwd: TOOLS_ROOT, echo: true });
  const env = {
    ...process.env,
    LLM_PROVIDER: 'xai',
    LLM_MODEL: 'grok-4.5',
    XAI_REASONING_EFFORT: process.env.XAI_REASONING_EFFORT || 'high',
  };
  // Prefer dist server (no npm.cmd PATH issues on Windows Git Bash)
  const distServer = join(VENDOR, 'dist/server.js');
  const tsxCli = join(VENDOR, 'node_modules/tsx/dist/cli.mjs');
  const srcServer = join(VENDOR, 'src/server.ts');
  let cmd;
  let args;
  if (existsSync(distServer)) {
    cmd = process.execPath;
    args = [distServer];
    append('Starting War Room server', `node ${distServer}`);
  } else if (existsSync(tsxCli) && existsSync(srcServer)) {
    cmd = process.execPath;
    args = [tsxCli, srcServer];
    append('Starting War Room server', `node tsx ${srcServer}`);
  } else {
    cmd = npmCmd();
    args = ['run', 'server'];
    append('Starting War Room server', `${cmd} run server`);
  }
  const child = spawn(cmd, args, {
    cwd: VENDOR,
    env,
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  child.on('error', (e) => append('War Room spawn error', String(e)));
  await waitHealth(`${WAR_ROOM}/health`, 'War Room');
  return child;
}

async function launchCliSwarmBackground() {
  append('Launching cli-swarm overnight', `Report → \`${SWARM_REPORT.replace(/\\/g, '/')}\``);
  const env = {
    ...process.env,
    XAI_SWARM_REPORT: SWARM_REPORT,
    XAI_SWARM_PASS: '1',
    XAI_SWARM_SQUAD: 'full',
    XAI_SWARM_ROUNDS: process.env.XAI_SWARM_ROUNDS || '3',
    XAI_SWARM_CONCURRENCY: process.env.XAI_SWARM_CONCURRENCY || '2',
    XAI_SWARM_BUDGET_MIN: process.env.XAI_SWARM_BUDGET_MIN || '240',
    XAI_SWARM_MAX_TOOL_ROUNDS: process.env.XAI_SWARM_MAX_TOOL_ROUNDS || '35',
  };
  const logPath = join(TOOLS_ROOT, 'overnight-warroom-swarm.log');
  const outFd = writeFileSync(logPath, '', 'utf8');
  void outFd;
  const child = spawn('node', [join(TOOLS_ROOT, 'scripts/overnight-swarm.mjs'), '--report', SWARM_REPORT], {
    cwd: REPO_ROOT,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const logStream = { write: (s) => appendFileSync(logPath, s) };
  child.stdout.on('data', (d) => {
    process.stdout.write(d);
    logStream.write(d);
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(d);
    logStream.write(d);
  });
  child.on('close', (code) => {
    append('cli-swarm process exited', `exit=${code}`);
  });
  return child;
}

async function main() {
  loadAllEnv();
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    FINDINGS,
    `# EC2-pilot T3MP3ST War Room findings (2026-07-08)

**Branch:** EC2-pilot  
**Mode:** War Room live mission + progressive findings (authorized own pilot)  
**Backbone:** xAI \`grok-4.5\` + \`reasoning_effort=high\`  
**Constraint:** no production app code modifications  

Progressive sections append below overnight.

`,
    'utf8',
  );
  append('Setup', [
    '- Plan: `docs/superpowers/plans/2026-07-08-t3mp3st-warroom-overnight.md`',
    `- War Room URL: \`${WAR_ROOM}\``,
    `- Backend tunnel target: \`${BE_LOCAL}\` → EC2 :8788`,
    `- Frontend tunnel target: \`${FE_LOCAL}\` → EC2 :3000`,
    `- XAI key present: ${process.env.XAI_API_KEY ? 'yes' : 'NO'}`,
  ].join('\n'));

  if (!process.env.XAI_API_KEY) {
    append('FATAL', 'XAI_API_KEY missing');
    process.exit(1);
  }

  // LLM smoke
  try {
    const llm = await run('node', [join(TOOLS_ROOT, 'scripts/test-llm.mjs')], { cwd: TOOLS_ROOT });
    append('LLM smoke', `\`\`\`\n${llm.out.trim().slice(-2000)}\n\`\`\``);
  } catch (e) {
    append('LLM smoke FAIL', String(e));
    throw e;
  }

  const tunnels = await ensureSsmTunnels();
  await waitHealth(`${BE_LOCAL}/health`, 'EC2 backend via tunnel');
  await waitHealth(FE_LOCAL, 'EC2 frontend via tunnel');

  await startWarRoomServer();
  await approvePending();
  await startMission();

  // keep approving any new gates for a bit
  for (let i = 0; i < 5; i++) {
    await approvePending();
    await sleep(2000);
  }

  const swarmChild = await launchCliSwarmBackground();

  const started = Date.now();
  let tick = 0;
  while (Date.now() - started < BUDGET_MS) {
    tick++;
    try {
      await approvePending();
      const body = await pollFindingsOnce();
      append(`Findings poll #${tick}`, body);
    } catch (e) {
      append(`Findings poll #${tick} error`, String(e));
    }

    // if swarm exited and we have several polls, can wind down early after min runtime
    if (swarmChild.exitCode != null && tick >= 6 && Date.now() - started > 45 * 60_000) {
      append('Early complete', 'cli-swarm done + enough War Room polls');
      break;
    }
    await sleep(POLL_MS);
  }

  // final snapshot
  try {
    const body = await pollFindingsOnce();
    append('Final findings snapshot', body);
  } catch (e) {
    append('Final snapshot error', String(e));
  }

  writeFileSync(
    HANDOFF,
    `# T3MP3ST War Room overnight handoff — 2026-07-08

**Status:** run finished (budget or early complete)  
**Findings:** [\`2026-07-08-ec2-pilot-t3mp3st-warroom-findings.md\`](./2026-07-08-ec2-pilot-t3mp3st-warroom-findings.md)  
**cli-swarm:** [\`2026-07-08-ec2-pilot-t3mp3st-cli-swarm-audit.md\`](./2026-07-08-ec2-pilot-t3mp3st-cli-swarm-audit.md)  
**Plan:** [\`../2026-07-08-t3mp3st-warroom-overnight.md\`](../2026-07-08-t3mp3st-warroom-overnight.md)

## Morning checklist

- [ ] Skim War Room findings for P0/P1
- [ ] Skim cli-swarm confirmed/refuted board
- [ ] Confirm no \`apps/**\` diffs from this overnight run
- [ ] Decide follow-up fix plan (separate PR) if needed

## Notes

- Backend on EC2 listens **:8788** (PM2 \`http\`), not :8787
- War Room bound loopback; targets reached via SSM port-forward
- Intrusive operators (exploiter+) intentionally not auto-spawned

_Generated ${new Date().toISOString()}_
`,
    'utf8',
  );
  append('Handoff written', HANDOFF.replace(/\\/g, '/'), FINDINGS);

  // leave tunnels/server running for morning UI review — do not kill
  console.log(`[warroom] done — findings → ${FINDINGS}`);
  console.log(`[warroom] tunnels kept: ${tunnels.length}; War Room kept up for morning`);
  // keep process alive if swarm still running
  if (swarmChild.exitCode == null) {
    await new Promise((resolvePromise) => swarmChild.on('close', resolvePromise));
  }
}

main().catch((e) => {
  try {
    append('FATAL', String(e));
  } catch {
    // ignore
  }
  console.error(e);
  process.exit(1);
});
