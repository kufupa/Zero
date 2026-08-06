import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

const CANONICAL_HOST = 'nava.legacyhotels.co.za';
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;
const CANONICAL_HOST_ENTRY = `127.0.0.1 ${CANONICAL_HOST}`;
const BASH_CHILD_TIMEOUT_MS = 10_000;
const BASH_CLEANUP_GRACE_MS = 1_000;
const TASKKILL_TIMEOUT_MS = 1_000;

type BashResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let helperKill = 'not requested';
    let helperError = '';

    killer.stdout.setEncoding('utf8');
    killer.stderr.setEncoding('utf8');
    killer.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    killer.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        helperKill = killer.kill('SIGKILL') ? 'requested' : 'returned false';
      } catch (error) {
        helperKill = `threw: ${errorMessage(error)}`;
      }
    }, TASKKILL_TIMEOUT_MS);

    killer.once('error', (error) => {
      if (timedOut) {
        helperError = `; helper error: ${error.message}`;
        return;
      }
      finish(new Error(`taskkill failed to start: ${error.message}`));
    });
    killer.once('close', (status, signal) => {
      const output = stderr.trim() || stdout.trim();
      if (timedOut) {
        finish(
          new Error(
            `taskkill timed out after ${TASKKILL_TIMEOUT_MS}ms; helper kill ${helperKill}; ` +
              `helper closed ${status ?? 'null'}${signal ? ` (${signal})` : ''}` +
              helperError +
              `${output ? `: ${output}` : ''}`,
          ),
        );
        return;
      }
      if (
        status === 0 ||
        /There is no running instance of the task/i.test(output)
      ) {
        finish();
        return;
      }
      finish(
        new Error(
          `taskkill exited ${status ?? 'null'}${signal ? ` (${signal})` : ''}` +
            `${output ? `: ${output}` : ''}`,
        ),
      );
    });
  });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await runTaskkill(pid);
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    throw new Error(`process-group kill failed: ${errorMessage(error)}`);
  }
}

function waitForClose(
  closePromise: Promise<BashResult>,
  graceMs: number,
): Promise<BashResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result?: BashResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result!);
    };
    const timeout = setTimeout(() => {
      finish(undefined, new Error(`bash did not close within ${graceMs}ms cleanup grace`));
    }, graceMs);

    closePromise.then(
      (result) => finish(result),
      (error) => finish(undefined, error),
    );
  });
}

async function runBash({
  args = [],
  input = '',
  env = process.env,
  timeoutMs = BASH_CHILD_TIMEOUT_MS,
  onSpawn,
}: {
  args?: string[];
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onSpawn?: (pid: number) => void;
} = {}): Promise<BashResult> {
  const child = spawn('bash', args, {
    detached: process.platform !== 'win32',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (child.pid != null) onSpawn?.(child.pid);
  let stdout = '';
  let stderr = '';
  let reportExecutionError!: (error: Error) => void;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const closePromise = new Promise<BashResult>((resolve) => {
    child.once('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
  const executionErrorPromise = new Promise<{ error: Error }>((resolve) => {
    reportExecutionError = (error) => resolve({ error });
  });
  child.once('error', (error) => {
    reportExecutionError(new Error(`failed to run bash: ${error.message}`));
  });
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      reportExecutionError(new Error(`failed to write bash stdin: ${error.message}`));
    }
  });
  try {
    child.stdin.end(input);
  } catch (error) {
    reportExecutionError(new Error(`failed to write bash stdin: ${errorMessage(error)}`));
  }

  let runTimeout: NodeJS.Timeout;
  const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
    runTimeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const outcome = await Promise.race([
    closePromise.then((result) => ({ result })),
    executionErrorPromise,
    timeoutPromise,
  ]);
  clearTimeout(runTimeout!);

  if ('result' in outcome) return outcome.result;
  if ('error' in outcome && child.pid == null) throw outcome.error;

  const cleanupReason =
    'timedOut' in outcome ? `timeout after ${timeoutMs}ms` : `error: ${outcome.error.message}`;
  let terminationError: Error | null = null;
  if (child.pid == null) {
    terminationError = new Error('child PID unavailable');
  } else {
    try {
      await terminateProcessTree(child.pid);
    } catch (error) {
      terminationError = new Error(errorMessage(error));
    }
  }

  let closedResult: BashResult;
  try {
    closedResult = await waitForClose(closePromise, BASH_CLEANUP_GRACE_MS);
  } catch (error) {
    throw new Error(
      `bash ${cleanupReason} cleanup failed: ${errorMessage(error)}` +
        `${terminationError ? `; tree termination error: ${terminationError.message}` : ''}`,
    );
  }

  if (terminationError) {
    throw new Error(
      `bash ${cleanupReason} cleanup failed: ${terminationError.message}; ` +
        `bash closed with status ${closedResult.status ?? 'null'}`,
    );
  }
  if ('error' in outcome) throw outcome.error;

  throw new Error(
    `bash timed out after ${timeoutMs}ms; process tree cleanup completed` +
      `${closedResult.stderr ? `\nstderr:\n${closedResult.stderr}` : ''}`,
  );
}

function curlCommands(source: string): string[] {
  const logicalCommands = source.replace(/\\\r?\n[ \t]*/g, ' ');
  return [...logicalCommands.matchAll(/\bcurl\b[^\r\n]*/g)].map(
    ([command]) => command,
  );
}

function insecureCurlCommands(source: string): string[] {
  return curlCommands(source).filter((command) =>
    /(?:--insecure|(?:^|\s)-[A-Za-z]*k[A-Za-z]*)/.test(command),
  );
}

async function runNavaHostMapping(initialHosts: string): Promise<string> {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
  const start = deploy.indexOf(`echo "== hosts: ${CANONICAL_HOST} =="`);
  const end = deploy.indexOf('echo "== hosts: appsrv-1.legacyhotels.co.za', start);
  if (start < 0 || end < 0) throw new Error('Nava hosts block not found');

  const tempDir = mkdtempSync(join(tmpdir(), 'nava-hosts-test-'));
  const hostsPath = join(tempDir, 'hosts');
  const bashHostsPath = hostsPath
    .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`)
    .replaceAll('\\', '/');
  try {
    writeFileSync(hostsPath, initialHosts, 'utf8');
    const block = deploy
      .slice(start, end)
      .replaceAll('sudo ', '')
      .replaceAll('/etc/hosts', `'${bashHostsPath}'`);
    const result = await runBash({ args: ['-c', block] });
    if (result.status !== 0) {
      throw new Error(result.stderr || `Nava hosts block exited ${result.status}`);
    }
    return readFileSync(hostsPath, 'utf8');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function activeCanonicalEntries(hosts: string): string[] {
  return hosts
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => line.split(/\s+/).includes(CANONICAL_HOST));
}

const SG_ONE = 'sg-0123456789abcdef0';
const SG_TWO = 'sg-0fedcba9876543210';
const INTENDED_UFW_ALLOW = 'ufw allow in on tun0 to any port 443 proto tcp';
const ACTIVE_DEFAULT_DENY_UFW = [
  'Status: active',
  'Logging: on (low)',
  'Default: deny (incoming), allow (outgoing), disabled (routed)',
].join('\n');

const validCors = (origins: string[] = [CANONICAL_ORIGIN]) => ({
  CORSRules: [
    {
      AllowedOrigins: origins,
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['Content-Type'],
      MaxAgeSeconds: 300,
    },
  ],
});

const validInstanceNetwork = () => ({
  securityGroups: [{ GroupId: SG_ONE }, { GroupId: SG_TWO }],
  ipv6: [],
});

const validSecurityGroups = () => [
  { id: SG_ONE, ingress: [] },
  { id: SG_TWO, ingress: [] },
];

type FirewallFacts = {
  statusRead: boolean;
  rulesRead: boolean;
  active: boolean;
  defaultDeny: boolean;
  tunnel443: boolean;
  broad443Absent: boolean;
};

type LaunchReadinessReport = {
  checks: Record<string, boolean>;
  observations: Record<string, unknown>;
};

type AwsPerimeterFacts = {
  cors: unknown;
  publicAccess: unknown;
  s3CorsOk: boolean;
  s3PublicAccessOk: boolean;
  instanceNetwork: unknown;
  securityGroups: unknown;
  instanceNetworkOk: boolean;
  securityGroupQueryOk: boolean;
};

const toBashPath = (path: string) =>
  path
    .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`)
    .replaceAll('\\', '/');

function extractSourceBlock(source: string, start: string, end: string): string {
  const normalized = source.replaceAll('\r\n', '\n');
  const startIndex = normalized.indexOf(start);
  const endIndex = normalized.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`source block not found: ${start} -> ${end}`);
  }
  return normalized.slice(startIndex, endIndex);
}

type NginxActivationScenario =
  | 'install'
  | 'link'
  | 'validate'
  | 'reload'
  | 'sigint'
  | 'sigterm'
  | 'unexpected-exit'
  | 'cleanup-exit';
type NginxPriorState = 'absent' | 'present' | 'dangling';

async function runNginxActivation({
  scenario,
  priorState,
  rollbackCopyFails = false,
}: {
  scenario: NginxActivationScenario;
  priorState: NginxPriorState;
  rollbackCopyFails?: boolean;
}): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  site: string | null;
  enabledState: 'absent' | 'valid' | 'dangling';
  enabledTarget: string | null;
  nginxCalls: number;
  reloadCalls: number;
  backupEntries: string[];
}> {
  const {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
  } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, isAbsolute, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const deploySource = readFileSync(
    join(here, '..', 'deploy', 'deploy-ec2.sh'),
    'utf8',
  );
  const nginxBlock = extractSourceBlock(
    deploySource,
    'echo "== nginx =="',
    'if [ "$QUIESCED" = "1" ]; then',
  );
  const tempDir = mkdtempSync(join(tmpdir(), 'nava-nginx-activation-test-'));
  const serverPilot = join(tempDir, 'server-pilot');
  const deployDir = join(serverPilot, 'deploy');
  const backupDir = join(tempDir, 'backups');
  const sitePath = join(tempDir, 'sites-available', 'nava-zero');
  const enabledPath = join(tempDir, 'sites-enabled', 'nava-zero');
  const enabledModelPath = join(tempDir, 'enabled-link.target');
  const nginxCallsPath = join(tempDir, 'nginx-calls');
  const reloadCallsPath = join(tempDir, 'reload-calls');
  const previousTargetPath = join(dirname(sitePath), 'previous-nava');
  const previousSite = 'previous nginx config\n';
  const previousTarget = '../sites-available/previous-nava';

  try {
    for (const directory of [
      deployDir,
      backupDir,
      dirname(sitePath),
      dirname(enabledPath),
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(deployDir, 'nginx.conf'), 'candidate nginx config\n', 'utf8');
    writeFileSync(nginxCallsPath, '0', 'utf8');
    writeFileSync(reloadCallsPath, '0', 'utf8');
    if (priorState !== 'absent') {
      writeFileSync(sitePath, previousSite, 'utf8');
      writeFileSync(enabledModelPath, previousTarget, 'utf8');
    }
    if (priorState === 'present') {
      writeFileSync(previousTargetPath, 'previous enabled config\n', 'utf8');
    }

    const harness = `set -euo pipefail
link_calls=0
nginx_calls=0
reload_calls=0
cleanup_calls=0

link_target_exists() {
  [ -f "$NGINX_TEST_LINK_MODEL" ] || return 1
  target="$(command cat "$NGINX_TEST_LINK_MODEL")"
  case "$target" in
    /*) resolved_target="$target" ;;
    *) resolved_target="$(command dirname "$NGINX_TEST_ENABLED")/$target" ;;
  esac
  command test -e "$resolved_target"
}

sudo() {
case "\${1:-}" in
  test)
    if [ "\${3:-}" = "$NGINX_TEST_ENABLED" ]; then
      case "\${2:-}" in
        -L) [ -f "$NGINX_TEST_LINK_MODEL" ] ;;
        -e) link_target_exists ;;
        *) exit 2 ;;
      esac
    else
      command test "\${@:2}"
    fi
    ;;
  readlink)
    if [ "\${2:-}" = "$NGINX_TEST_ENABLED" ]; then
      command cat "$NGINX_TEST_LINK_MODEL"
    else
      command readlink "\${@:2}"
    fi
    ;;
  cp)
    source_path="\${@: -2:1}"
    destination_path="\${@: -1}"
    if [ "\${NGINX_TEST_ROLLBACK_COPY_FAIL:-0}" = "1" ] &&
       [ "$destination_path" = "$NGINX_TEST_SITE" ]; then
      return 65
    fi
    command cp "$source_path" "$destination_path"
    ;;
  install)
    command cp "\${@: -2:1}" "\${@: -1}"
    if [ "$NGINX_TEST_SCENARIO" = "install" ]; then
      return 61
    fi
    ;;
  ln)
    link_calls=$((link_calls + 1))
    destination_path="\${@: -1}"
    target="\${@: -2:1}"
    if [ "$destination_path" != "$NGINX_TEST_ENABLED" ]; then
      return 97
    fi
    command rm -f "$NGINX_TEST_LINK_MODEL"
    if [ "$NGINX_TEST_SCENARIO" = "link" ] && [ "$link_calls" -eq 1 ]; then
      return 62
    fi
    printf '%s' "$target" >"$NGINX_TEST_LINK_MODEL"
    if [ "$link_calls" -eq 1 ]; then
      case "$NGINX_TEST_SCENARIO" in
        sigint) kill -INT "$BASHPID" ;;
        sigterm) kill -TERM "$BASHPID" ;;
        unexpected-exit) exit 73 ;;
      esac
    fi
    ;;
  rm)
    destination_path="\${@: -1}"
    if [ "$destination_path" = "$NGINX_TEST_ENABLED" ]; then
      command rm -f "$NGINX_TEST_LINK_MODEL"
    elif [[ "$destination_path" == "$NGINX_TEST_BACKUP_DIR"/nava-nginx.* ]]; then
      cleanup_calls=$((cleanup_calls + 1))
      if [ "$NGINX_TEST_SCENARIO" = "cleanup-exit" ] &&
         [ "$cleanup_calls" -eq 1 ]; then
        exit 74
      fi
      command rm "\${@:2}"
    else
      command rm "\${@:2}"
    fi
    ;;
  nginx|systemctl)
    "$@"
    ;;
  *)
    command "$@"
    ;;
esac
}

nginx() {
  nginx_calls=$((nginx_calls + 1))
  printf '%s' "$nginx_calls" >"$NGINX_TEST_NGINX_CALLS"
  if [ "$NGINX_TEST_SCENARIO" = "validate" ] && [ "$nginx_calls" -eq 1 ]; then
    return 63
  fi
}

systemctl() {
  reload_calls=$((reload_calls + 1))
  printf '%s' "$reload_calls" >"$NGINX_TEST_RELOAD_CALLS"
  if [ "$NGINX_TEST_SCENARIO" = "reload" ] && [ "$reload_calls" -eq 1 ]; then
    return 64
  fi
}
`;

    const result = await runBash({
      input: `${harness}\n${nginxBlock}`,
      env: {
        ...process.env,
        SERVER_PILOT: toBashPath(serverPilot),
        NGINX_SITE: toBashPath(sitePath),
        NGINX_ENABLED: toBashPath(enabledPath),
        TMPDIR: toBashPath(backupDir),
        NGINX_TEST_SCENARIO: scenario,
        NGINX_TEST_ROLLBACK_COPY_FAIL: rollbackCopyFails ? '1' : '0',
        NGINX_TEST_SITE: toBashPath(sitePath),
        NGINX_TEST_ENABLED: toBashPath(enabledPath),
        NGINX_TEST_LINK_MODEL: toBashPath(enabledModelPath),
        NGINX_TEST_NGINX_CALLS: toBashPath(nginxCallsPath),
        NGINX_TEST_RELOAD_CALLS: toBashPath(reloadCallsPath),
        NGINX_TEST_BACKUP_DIR: toBashPath(backupDir),
      },
    });

    const enabledTarget = existsSync(enabledModelPath)
      ? readFileSync(enabledModelPath, 'utf8')
      : null;
    const nativeTarget =
      process.platform === 'win32' && enabledTarget?.match(/^\/[A-Za-z]\//)
        ? `${enabledTarget[1]}:/${enabledTarget.slice(3)}`
        : enabledTarget;
    const resolvedTarget =
      nativeTarget == null
        ? null
        : isAbsolute(nativeTarget)
          ? nativeTarget
          : resolve(dirname(enabledPath), nativeTarget);

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      site: existsSync(sitePath) ? readFileSync(sitePath, 'utf8') : null,
      enabledState:
        enabledTarget == null
          ? 'absent'
          : resolvedTarget != null && existsSync(resolvedTarget)
            ? 'valid'
            : 'dangling',
      enabledTarget,
      nginxCalls: Number(readFileSync(nginxCallsPath, 'utf8')),
      reloadCalls: Number(readFileSync(reloadCallsPath, 'utf8')),
      backupEntries: readdirSync(backupDir),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function readLaunchReadiness(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', 'deploy', 'launch-readiness.sh'), 'utf8');
}

function validReportShellEnv(): Record<string, string> {
  return {
    REMOTE_JSON: JSON.stringify({
      health: { http: true, https: true, tls: true },
      pm2: {
        required: {
          http: { present: true, online: true, restarts: 0 },
          worker: { present: true, online: true, restarts: 0 },
          'ai-worker': { present: true, online: true, restarts: 0 },
        },
        allOnline: true,
      },
      hotelProbe: true,
      firewall: {
        statusRead: true,
        rulesRead: true,
        active: true,
        defaultDeny: true,
        tunnel443: true,
        broad443Absent: true,
      },
      config: {
        envLoaded: true,
        mailTransportModeReal: true,
        betterAuthUrlCorrect: true,
        undoSendSecondsCorrect: true,
        aiWriteGateEnabled: true,
        aiDraftsDisabled: true,
      },
      db: {
        connected: true,
        centurionActiveTransportCount: 1,
        centurionActiveCategoryCount: 5,
        workflowNonterminalCount: 0,
        workflowDeadLetterCount: 0,
        workflowDeadLetterRecentCount: 0,
        outboundNonterminalCount: 0,
        latestInboundAt: null,
        counts: { threads: 0, messages: 0, inboundMessages: 0 },
      },
      disk: { safe: true, usedPercent: 10, freeMB: 10_000 },
    }),
    RDS_JSON: JSON.stringify({
      status: 'available',
      deletionProtection: true,
      multiAZ: false,
      backupRetentionDays: 7,
      backupLatestRestorableAt: '2026-07-31T12:00:00.000Z',
    }),
    S3_AVAILABLE: 'true',
    S3_VERSIONING: 'Enabled',
    S3_LIFECYCLE: '[]',
    CLOUDWATCH_ALARM_COUNT: '1',
    SNS_TOPIC_COUNT: '1',
  };
}

async function runLaunchReadinessReport({
  firewall = {},
  cors = validCors(),
  publicAccess = {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  },
  instanceNetwork = validInstanceNetwork(),
  securityGroups = validSecurityGroups(),
  s3CorsOk = true,
  s3PublicAccessOk = true,
  instanceNetworkOk = true,
  securityGroupQueryOk = true,
  omitSecurityGroups = false,
}: {
  firewall?: Partial<FirewallFacts>;
  cors?: unknown;
  publicAccess?: unknown;
  instanceNetwork?: unknown;
  securityGroups?: unknown;
  s3CorsOk?: boolean;
  s3PublicAccessOk?: boolean;
  instanceNetworkOk?: boolean;
  securityGroupQueryOk?: boolean;
  omitSecurityGroups?: boolean;
} = {}): Promise<LaunchReadinessReport> {
  const source = await readLaunchReadiness();
  const reportBuilder = extractSourceBlock(
    source,
    '# BEGIN_READINESS_REPORT_BUILDER',
    '# END_READINESS_REPORT_BUILDER',
  );
  const shellEnv = validReportShellEnv();
  const remote = JSON.parse(shellEnv.REMOTE_JSON);
  remote.firewall = { ...remote.firewall, ...firewall };
  const result = await runBash({
    input: `${reportBuilder}\nbuild_readiness_report\n`,
    env: {
      ...process.env,
      ...shellEnv,
      REMOTE_JSON: JSON.stringify(remote),
      S3_CORS: JSON.stringify(cors),
      S3_PUBLIC_ACCESS: JSON.stringify(publicAccess),
      INSTANCE_NETWORK: JSON.stringify(instanceNetwork),
      SG_STATE: omitSecurityGroups ? '' : JSON.stringify(securityGroups),
      INSTANCE_NETWORK_OK: String(instanceNetworkOk),
      SG_QUERY_OK: String(securityGroupQueryOk),
      S3_CORS_OK: String(s3CorsOk),
      S3_PUBLIC_ACCESS_OK: String(s3PublicAccessOk),
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `readiness report builder exited ${result.status}`);
  }
  return JSON.parse(result.stdout) as LaunchReadinessReport;
}

async function runUfwCollection({
  verbose = ACTIVE_DEFAULT_DENY_UFW,
  added = INTENDED_UFW_ALLOW,
  failStatus = false,
  failAdded = false,
}: {
  verbose?: string;
  added?: string;
  failStatus?: boolean;
  failAdded?: boolean;
} = {}): Promise<{
  status: number | null;
  stderr: string;
  facts: FirewallFacts | null;
}> {
  const { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import(
    'node:fs'
  );
  const { tmpdir } = await import('node:os');
  const { delimiter, join } = await import('node:path');
  const tempDir = mkdtempSync(join(tmpdir(), 'nava-ufw-collection-test-'));
  const stubDir = join(tempDir, 'bin');

  try {
    mkdirSync(stubDir);
    const sudoPath = join(stubDir, 'sudo');
    writeFileSync(
      sudoPath,
      `#!/usr/bin/env bash
case "$*" in
  "ufw status verbose")
    if [ "\${UFW_TEST_FAIL_STATUS:-0}" = "1" ]; then
      printf '%s\\n' "\${UFW_TEST_SECRET}" >&2
      exit 41
    fi
    printf '%s\\n' "\${UFW_TEST_VERBOSE}"
    ;;
  "ufw show added")
    if [ "\${UFW_TEST_FAIL_ADDED:-0}" = "1" ]; then
      printf '%s\\n' "\${UFW_TEST_SECRET}" >&2
      exit 42
    fi
    printf '%s\\n' "\${UFW_TEST_ADDED}"
    ;;
  *)
    exit 97
    ;;
esac
`,
      'utf8',
    );
    chmodSync(sudoPath, 0o755);

    const block = extractSourceBlock(
      await readLaunchReadiness(),
      'UFW_STATUS_READ=false',
      'PM2_SUMMARY="$(',
    );
    const script = `set -euo pipefail
${block}
printf 'UFW_FACTS=%s,%s,%s,%s,%s,%s\\n' \
  "\${UFW_STATUS_READ:-false}" \
  "\${UFW_RULES_READ:-false}" \
  "$UFW_ACTIVE" "$UFW_DEFAULT_DENY" "$UFW_TUN443" "$UFW_BROAD443_ABSENT"
`;
    const result = await runBash({
      input: script,
      env: {
        ...process.env,
        PATH: `${toBashPath(stubDir)}${delimiter}${process.env.PATH ?? ''}`,
        UFW_TEST_VERBOSE: verbose,
        UFW_TEST_ADDED: added,
        UFW_TEST_FAIL_STATUS: failStatus ? '1' : '0',
        UFW_TEST_FAIL_ADDED: failAdded ? '1' : '0',
        UFW_TEST_SECRET: 'sensitive-ufw-stub-detail',
      },
    });
    const values = result.stdout.match(/UFW_FACTS=([^\r\n]+)/)?.[1]?.split(',');
    return {
      status: result.status,
      stderr: result.stderr,
      facts:
        values?.length === 6
          ? {
              statusRead: values[0] === 'true',
              rulesRead: values[1] === 'true',
              active: values[2] === 'true',
              defaultDeny: values[3] === 'true',
              tunnel443: values[4] === 'true',
              broad443Absent: values[5] === 'true',
            }
          : null,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runAwsPerimeterCollection({
  cors = validCors(),
  instanceNetwork = validInstanceNetwork(),
  securityGroups = validSecurityGroups(),
  corsRaw,
  publicAccessRaw = JSON.stringify({
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  }),
  instanceNetworkRaw,
  failCors = false,
  failPublicAccess = false,
  failInstance = false,
  failSecurityGroups = false,
}: {
  cors?: unknown;
  instanceNetwork?: unknown;
  securityGroups?: unknown;
  corsRaw?: string;
  publicAccessRaw?: string;
  instanceNetworkRaw?: string;
  failCors?: boolean;
  failPublicAccess?: boolean;
  failInstance?: boolean;
  failSecurityGroups?: boolean;
} = {}): Promise<{
  status: number | null;
  stderr: string;
  facts: AwsPerimeterFacts | null;
  report: LaunchReadinessReport | null;
  securityGroupArgs: string[];
}> {
  const {
    chmodSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
  } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { delimiter, join } = await import('node:path');
  const tempDir = mkdtempSync(join(tmpdir(), 'nava-aws-perimeter-test-'));
  const stubDir = join(tempDir, 'bin');
  const argsPath = join(tempDir, 'sg-args.txt');

  try {
    mkdirSync(stubDir);
    const awsPath = join(stubDir, 'aws');
    writeFileSync(
      awsPath,
      `#!/usr/bin/env bash
case "$1 $2" in
  "s3api get-bucket-cors")
    if [ "\${AWS_TEST_FAIL_CORS:-0}" = "1" ]; then
      printf '%s\\n' "\${AWS_TEST_SECRET}" >&2
      exit 53
    fi
    printf '%s' "\${AWS_TEST_CORS_RAW}"
    ;;
  "s3api get-public-access-block")
    if [ "\${AWS_TEST_FAIL_PUBLIC_ACCESS:-0}" = "1" ]; then
      printf '%s\\n' "\${AWS_TEST_SECRET}" >&2
      exit 54
    fi
    printf '%s' "\${AWS_TEST_PUBLIC_ACCESS_RAW}"
    ;;
  "ec2 describe-instances")
    if [ "\${AWS_TEST_FAIL_INSTANCE:-0}" = "1" ]; then
      printf '%s\\n' "\${AWS_TEST_SECRET}" >&2
      exit 51
    fi
    printf '%s' "\${AWS_TEST_INSTANCE}"
    ;;
  "ec2 describe-security-groups")
    printf '%s\\n' "$@" >"\${AWS_TEST_SG_ARGS}"
    if [ "\${AWS_TEST_FAIL_SG:-0}" = "1" ]; then
      printf '%s\\n' "\${AWS_TEST_SECRET}" >&2
      exit 52
    fi
    printf '%s' "\${AWS_TEST_SECURITY_GROUPS}"
    ;;
  *)
    exit 97
    ;;
esac
`,
      'utf8',
    );
    chmodSync(awsPath, 0o755);

    const source = await readLaunchReadiness();
    const collectionBlock = extractSourceBlock(
      source,
      '# BEGIN_READINESS_PERIMETER_COLLECTION',
      '# END_READINESS_PERIMETER_COLLECTION',
    );
    const reportBuilder = extractSourceBlock(
      source,
      '# BEGIN_READINESS_REPORT_BUILDER',
      '# END_READINESS_REPORT_BUILDER',
    );
    const script = `set -euo pipefail
${collectionBlock}
${reportBuilder}
node - "$S3_CORS" "$S3_PUBLIC_ACCESS" "$INSTANCE_NETWORK" "$SG_STATE" \
  "\${INSTANCE_NETWORK_OK:-false}" "\${SG_QUERY_OK:-false}" \
  "\${S3_CORS_OK:-false}" "\${S3_PUBLIC_ACCESS_OK:-false}" <<'NODE'
const facts = {
  cors: JSON.parse(process.argv[2]),
  publicAccess: JSON.parse(process.argv[3]),
  s3CorsOk: process.argv[8] === "true",
  s3PublicAccessOk: process.argv[9] === "true",
  instanceNetwork: JSON.parse(process.argv[4]),
  securityGroups: JSON.parse(process.argv[5]),
  instanceNetworkOk: process.argv[6] === "true",
  securityGroupQueryOk: process.argv[7] === "true",
};
process.stdout.write("AWS_FACTS=" + JSON.stringify(facts) + "\\n");
NODE
printf 'AWS_REPORT=%s\\n' "$(build_readiness_report)"
`;
    const result = await runBash({
      input: script,
      env: {
        ...process.env,
        PATH: `${toBashPath(stubDir)}${delimiter}${process.env.PATH ?? ''}`,
        AWS_REGION: 'test-region-1',
        S3_BUCKET: 'test-bucket',
        INSTANCE_ID: 'i-test',
        ...validReportShellEnv(),
        AWS_TEST_CORS_RAW: corsRaw ?? JSON.stringify(cors),
        AWS_TEST_PUBLIC_ACCESS_RAW: publicAccessRaw,
        AWS_TEST_INSTANCE: instanceNetworkRaw ?? JSON.stringify(instanceNetwork),
        AWS_TEST_SECURITY_GROUPS: JSON.stringify(securityGroups),
        AWS_TEST_FAIL_CORS: failCors ? '1' : '0',
        AWS_TEST_FAIL_PUBLIC_ACCESS: failPublicAccess ? '1' : '0',
        AWS_TEST_FAIL_INSTANCE: failInstance ? '1' : '0',
        AWS_TEST_FAIL_SG: failSecurityGroups ? '1' : '0',
        AWS_TEST_SECRET: 'sensitive-aws-stub-detail i-private sg-private',
        AWS_TEST_SG_ARGS: toBashPath(argsPath),
      },
    });
    const serialized = result.stdout.match(/AWS_FACTS=([^\r\n]+)/)?.[1];
    const serializedReport = result.stdout.match(/AWS_REPORT=([^\r\n]+)/)?.[1];
    return {
      status: result.status,
      stderr: result.stderr,
      facts: serialized ? (JSON.parse(serialized) as AwsPerimeterFacts) : null,
      report: serializedReport
        ? (JSON.parse(serializedReport) as LaunchReadinessReport)
        : null,
      securityGroupArgs: existsSync(argsPath)
        ? readFileSync(argsPath, 'utf8').split(/\r?\n/).filter(Boolean)
        : [],
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const VPN_HEALTH_OUTPUT_SENTINELS = {
  route: 'default via',
  address: 'inet ',
  host: 'PRIVATE_HOST_SENTINEL',
  port: 'PRIVATE_PORT_SENTINEL',
} as const;

async function runVpnHealth(
  address: string,
  interfacePresent: boolean,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const {
    chmodSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
  } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { delimiter, dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const sourcePath = join(here, '..', 'deploy', 'vpn-health-assert.sh');
  const tempDir = mkdtempSync(join(tmpdir(), 'nava-vpn-identity-test-'));
  const stubDir = join(tempDir, 'bin');

  try {
    mkdirSync(stubDir);
    const successStub = '#!/usr/bin/env bash\nexit 0\n';
    for (const command of ['aws', 'systemctl']) {
      const path = join(stubDir, command);
      writeFileSync(path, successStub, 'utf8');
      chmodSync(path, 0o755);
    }
    const ncPath = join(stubDir, 'nc');
    writeFileSync(
      ncPath,
      `#!/usr/bin/env bash
printf '%s\\n' '${VPN_HEALTH_OUTPUT_SENTINELS.host}:${VPN_HEALTH_OUTPUT_SENTINELS.port}'
exit 0
`,
      'utf8',
    );
    chmodSync(ncPath, 0o755);
    const ipPath = join(stubDir, 'ip');
    writeFileSync(
      ipPath,
      `#!/usr/bin/env bash
case "$*" in
  "link show tun0")
    [ "\${VPN_TEST_INTERFACE_PRESENT:-0}" = "1" ]
    ;;
  "-4 -o addr show dev tun0")
    printf '7: tun0    inet %s scope global tun0\\n' "\${VPN_TEST_ADDRESS:-}"
    ;;
  "-4 route show default")
    printf '%s\\n' 'default via 172.31.0.1 dev ens5'
    ;;
  "-4 route")
    printf '%s\\n' '172.24.0.0/16 dev tun0 scope link'
    ;;
  *)
    exit 97
    ;;
esac
`,
      'utf8',
    );
    chmodSync(ipPath, 0o755);

    const scriptPath = join(tempDir, 'vpn-health-assert.sh');
    const stsPath = toBashPath(join(tempDir, 'sts.json'));
    writeFileSync(
      scriptPath,
      readFileSync(sourcePath, 'utf8').replace(
        '/tmp/nava-vpn-health-sts.json',
        stsPath,
      ),
      'utf8',
    );
    chmodSync(scriptPath, 0o755);

    const result = await runBash({
      args: [toBashPath(scriptPath)],
      env: {
        ...process.env,
        PATH: `${toBashPath(stubDir)}${delimiter}${process.env.PATH ?? ''}`,
        VPN_TEST_ADDRESS: address,
        VPN_TEST_INTERFACE_PRESENT: interfacePresent ? '1' : '0',
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('deploy config', () => {
  it('runBash returns status, signal, stdout, and stderr', async () => {
    const result = await runBash({
      args: ['-c', "printf 'normal-out'; printf 'normal-err' >&2; exit 7"],
    });

    expect(result).toEqual({
      status: 7,
      signal: null,
      stdout: 'normal-out',
      stderr: 'normal-err',
    });
  });

  it('runBash rejects when bash cannot spawn', async () => {
    const pathlessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
    );
    pathlessEnv.PATH = '';

    await expect(
      runBash({
        args: ['-c', 'exit 0'],
        env: pathlessEnv,
      }),
    ).rejects.toThrow(/failed to run bash.*ENOENT/);
  });

  it('runBash rejects commands that exceed their timeout', async () => {
    await expect(
      runBash({
        args: ['-c', 'sleep 5'],
        timeoutMs: 50,
      }),
    ).rejects.toThrow('bash timed out after 50ms; process tree cleanup completed');
  });

  it('runBash removes descendants before timeout rejection completes', async () => {
    const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = mkdtempSync(join(tmpdir(), 'nava-bash-timeout-test-'));
    const markerPath = join(tempDir, 'descendant-finished');
    const pidPath = join(tempDir, 'descendant-pid');

    try {
      let bashPid: number | undefined;
      await expect(
        runBash({
          args: [
            '-c',
            'node -e \'const fs = require("node:fs"); fs.writeFileSync(process.env.PID_PATH, String(process.pid)); setTimeout(() => fs.writeFileSync(process.env.MARKER_PATH, "leaked"), 3000)\' & wait',
          ],
          env: {
            ...process.env,
            MARKER_PATH: markerPath,
            PID_PATH: pidPath,
          },
          timeoutMs: 500,
          onSpawn: (pid) => {
            bashPid = pid;
          },
        }),
      ).rejects.toThrow('bash timed out after 500ms; process tree cleanup completed');

      const descendantPid = Number(readFileSync(pidPath, 'utf8'));
      expect(bashPid).toBeTypeOf('number');
      expect(processIsAlive(bashPid!)).toBe(false);
      expect(processIsAlive(descendantPid)).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs worker with bounded autorestart policy', async () => {
    const { loadPm2Config } = await import('../src/deploy/load-pm2-config.js');
    const pm2 = loadPm2Config();
    expect(pm2.apps.filter((app) => app.name === 'worker')).toHaveLength(1);
    const worker = pm2.apps.find((app) => app.name === 'worker');
    expect(worker?.instances).toBe(1);
    expect(worker?.autorestart).toBe(true);
    expect(worker?.max_restarts).toBe(10);
    expect(pm2.apps.filter((app) => app.name === 'http')).toHaveLength(1);
    const http = pm2.apps.find((app) => app.name === 'http');
    expect(http?.autorestart).toBe(true);
    expect(http?.max_restarts).toBe(10);
    expect(http?.min_uptime).toBe(10_000);
    expect(pm2.apps.filter((app) => app.name === 'ai-worker')).toHaveLength(1);
    const aiWorker = pm2.apps.find((app) => app.name === 'ai-worker');
    expect(aiWorker?.env?.AI_ENABLED).toBe('true');
    expect(aiWorker?.env?.BEDROCK_REGION).toBe('us-east-1');
    expect(aiWorker?.env?.SMTP_HOST).toBeUndefined();
    expect(aiWorker?.env?.POP3_HOST).toBeUndefined();
  });

  it('nginx config proxies /api to localhost:8788', async () => {
    const { readNginxConfig } = await import('../src/deploy/load-pm2-config.js');
    const nginx = readNginxConfig();
    expect(nginx).toContain('listen 443 ssl');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:8788/api/');
    expect(nginx).toContain('try_files $uri /index.html');
    expect(nginx).toContain('client_max_body_size 35m');
  });

  it('nginx serves only the canonical host with the public fullchain', async () => {
    const { readNginxConfig } = await import('../src/deploy/load-pm2-config.js');
    const nginx = readNginxConfig();

    expect(nginx).toContain('listen 80 default_server');
    expect(nginx).toContain('listen 443 ssl default_server');
    expect(nginx).toContain('server_name nava.legacyhotels.co.za');
    expect(nginx).toContain(
      'ssl_certificate     /etc/nginx/ssl/nava.legacyhotels.co.za.fullchain.pem',
    );
    expect(nginx).toContain(
      'ssl_certificate_key /etc/nginx/ssl/nava.legacyhotels.co.za.key',
    );
    expect(nginx).toContain('if ($host != nava.legacyhotels.co.za)');
    expect(nginx).toContain('return 444');
    expect(nginx).not.toContain('nava.legacy.local');
  });

  it('nginx preserves security headers and allows only the exact S3 endpoint', async () => {
    const { readNginxConfig } = await import('../src/deploy/load-pm2-config.js');
    const nginx = readNginxConfig();

    expect(nginx).toContain(
      "connect-src 'self' https://nava-zero-mail-845242190536-af-south-1.s3.af-south-1.amazonaws.com",
    );
    expect(nginx).toContain('expires -1');
    expect(nginx).not.toContain('add_header Cache-Control "no-cache"');
    expect(nginx).toContain('add_header X-Frame-Options "DENY" always');
    expect(nginx).toContain('add_header X-Content-Type-Options "nosniff" always');
  });

  it('deploy-ec2.sh restores Nginx when validation or reload fails', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');

    expect(deploy).toContain('NGINX_BACKUP="$(mktemp');
    expect(deploy).toContain('sudo nginx -t');
    expect(deploy).toContain('sudo systemctl reload nginx');
    expect(deploy).toContain('restore_nginx');
    expect(deploy).toContain('nginx candidate failed; restored previous config');
    expect(deploy).toContain('nginx_on_exit');
    expect(deploy).toContain("trap 'nginx_on_signal 130' INT");
    expect(deploy).toContain("trap 'nginx_on_signal 143' TERM");
  });

  it.each([
    { scenario: 'install', priorState: 'absent', nginxCalls: 1, reloadCalls: 1 },
    { scenario: 'install', priorState: 'present', nginxCalls: 1, reloadCalls: 1 },
    { scenario: 'link', priorState: 'absent', nginxCalls: 1, reloadCalls: 1 },
    { scenario: 'link', priorState: 'present', nginxCalls: 1, reloadCalls: 1 },
    { scenario: 'validate', priorState: 'absent', nginxCalls: 2, reloadCalls: 1 },
    { scenario: 'validate', priorState: 'present', nginxCalls: 2, reloadCalls: 1 },
    { scenario: 'reload', priorState: 'absent', nginxCalls: 2, reloadCalls: 2 },
    { scenario: 'reload', priorState: 'present', nginxCalls: 2, reloadCalls: 2 },
  ] as const)(
    'restores priorState=$priorState state when Nginx $scenario fails',
    async ({ scenario, priorState, nginxCalls, reloadCalls }) => {
      const result = await runNginxActivation({ scenario, priorState });

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        'nginx candidate failed; restored previous config',
      );
      expect(result.site).toBe(
        priorState === 'present' ? 'previous nginx config\n' : null,
      );
      expect(result.enabledState).toBe(
        priorState === 'present' ? 'valid' : 'absent',
      );
      expect(result.enabledTarget).toBe(
        priorState === 'present' ? '../sites-available/previous-nava' : null,
      );
      expect(result.site).not.toBe('candidate nginx config\n');
      expect(result.nginxCalls).toBe(nginxCalls);
      expect(result.reloadCalls).toBe(reloadCalls);
      expect(result.backupEntries).toEqual([]);
    },
  );

  it.each([
    { scenario: 'sigint', priorState: 'absent', status: 130 },
    { scenario: 'sigint', priorState: 'present', status: 130 },
    { scenario: 'sigterm', priorState: 'absent', status: 143 },
    { scenario: 'sigterm', priorState: 'present', status: 143 },
    { scenario: 'unexpected-exit', priorState: 'absent', status: 73 },
    { scenario: 'unexpected-exit', priorState: 'present', status: 73 },
  ] as const)(
    'restores priorState=$priorState after $scenario and preserves status',
    async ({ scenario, priorState, status }) => {
      const result = await runNginxActivation({ scenario, priorState });

      expect(result.status, result.stderr).toBe(status);
      expect(result.stderr).toContain(
        scenario === 'unexpected-exit'
          ? 'nginx transaction aborted; restored previous config'
          : 'nginx transaction interrupted; restored previous config',
      );
      expect(result.site).toBe(
        priorState === 'present' ? 'previous nginx config\n' : null,
      );
      expect(result.enabledState).toBe(
        priorState === 'present' ? 'valid' : 'absent',
      );
      expect(result.enabledTarget).toBe(
        priorState === 'present' ? '../sites-available/previous-nava' : null,
      );
      expect(result.site).not.toBe('candidate nginx config\n');
      expect(result.nginxCalls).toBe(1);
      expect(result.reloadCalls).toBe(1);
      expect(result.backupEntries).toEqual([]);
    },
  );

  it('distinguishes and refuses a dangling prior enabled symlink model', async () => {
    const result = await runNginxActivation({
      scenario: 'validate',
      priorState: 'dangling',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nginx enabled symlink is already broken');
    expect(result.site).toBe('previous nginx config\n');
    expect(result.enabledState).toBe('dangling');
    expect(result.enabledTarget).toBe('../sites-available/previous-nava');
    expect(result.nginxCalls).toBe(0);
    expect(result.reloadCalls).toBe(0);
    expect(result.backupEntries).toEqual([]);
  });

  it('disarms rollback before cleaning up a successful activation', async () => {
    const result = await runNginxActivation({
      scenario: 'cleanup-exit',
      priorState: 'present',
    });

    expect(result.status).toBe(74);
    expect(result.stderr).not.toContain('restored previous config');
    expect(result.site).toBe('candidate nginx config\n');
    expect(result.enabledState).toBe('valid');
    expect(result.enabledTarget).toMatch(/\/sites-available\/nava-zero$/);
    expect(result.nginxCalls).toBe(1);
    expect(result.reloadCalls).toBe(1);
    expect(result.backupEntries).toEqual([]);
  });

  it('reports rollback failure and still removes temporary Nginx backups', async () => {
    const result = await runNginxActivation({
      scenario: 'validate',
      priorState: 'present',
      rollbackCopyFails: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nginx candidate failed; rollback failed');
    expect(result.backupEntries).toEqual([]);
  });

  it('reports trap rollback failure and exits nonzero', async () => {
    const result = await runNginxActivation({
      scenario: 'unexpected-exit',
      priorState: 'present',
      rollbackCopyFails: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nginx transaction aborted; rollback failed');
    expect(result.backupEntries).toEqual([]);
  });

  it('preserves the Infor hostname mapping used by the split tunnel', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');

    expect(deploy).toContain('appsrv-1.legacyhotels.co.za');
    expect(deploy).toContain('172.24.240.41');
  });

  it('uses BETTER_AUTH_URL as the only production app-origin source', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    const writer = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');

    expect(writer).toContain(
      ': "${BETTER_AUTH_URL:=https://nava.legacyhotels.co.za}"',
    );
    expect(deploy).toContain(
      ': "${BETTER_AUTH_URL:?BETTER_AUTH_URL required before SPA build}"',
    );
    expect(deploy).toContain(
      'export VITE_PUBLIC_APP_URL="${VITE_PUBLIC_APP_URL:-$BETTER_AUTH_URL}"',
    );
    expect(deploy).toContain('127.0.0.1 nava.legacyhotels.co.za');
    expect(deploy).not.toContain('127.0.0.1 nava.legacy.local');
  });

  it('repairs a wrong-IP canonical hostname entry without deleting unrelated aliases', async () => {
    const hosts = await runNavaHostMapping(
      [
        '127.0.0.1 localhost',
        `192.0.2.40 ${CANONICAL_HOST} keep-this-alias.example`,
        '192.0.2.50 untouched.example',
      ].join('\n'),
    );

    expect(activeCanonicalEntries(hosts)).toEqual([CANONICAL_HOST_ENTRY]);
    expect(hosts).toContain('192.0.2.40 keep-this-alias.example');
    expect(hosts).toContain('192.0.2.50 untouched.example');
  });

  it('adds an active canonical mapping when the hostname appears only in comments', async () => {
    const comment = `# 192.0.2.40 ${CANONICAL_HOST} documentation only`;
    const hosts = await runNavaHostMapping(
      [comment, '127.0.0.1 localhost', '192.0.2.50 untouched.example'].join('\n'),
    );

    expect(activeCanonicalEntries(hosts)).toEqual([CANONICAL_HOST_ENTRY]);
    expect(hosts).toContain(comment);
    expect(hosts).toContain('192.0.2.50 untouched.example');
  });

  it('write-ec2-env.sh quotes all env values', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
    expect(script).toContain('quote_val()');
    expect(script).toContain("NODE_ENV='production'");
    expect(script).toContain('DATABASE_URL=$(quote_val "$DATABASE_URL")');
    expect(script).toContain('BETTER_AUTH_SECRET=$(quote_val "$BETTER_AUTH_SECRET")');
  });

  it('write-ec2-env.sh persists SMTP password and AI gates', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
    expect(script).toContain('append_env SMTP_USER');
    expect(script).toContain('append_env SMTP_PASSWORD');
    expect(script).toContain('append_env AI_DRAFTS_ENABLED');
    expect(script).toContain('append_env AI_WRITE_GATE_ENABLED');
    expect(script).toContain('AI_WRITE_GATE_ENABLED:-true');
    expect(script).toMatch(/MAIL_TRANSPORT_MODE:-fixture\}" == "real"/);
  });

  it('write-ec2-env.sh writes UNDO_SEND_SECONDS', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
    expect(script).toContain('UNDO_SEND_SECONDS');
    expect(script).toMatch(/UNDO_SEND_SECONDS:=20/);
  });

  it('FakeSmtpTransport ring buffer caps at 100', async () => {
    const { FakeSmtpTransport, FAKE_SMTP_RING_MAX } = await import(
      '../src/mail/send/smtp.js'
    );
    expect(FAKE_SMTP_RING_MAX).toBe(100);
    const fake = new FakeSmtpTransport();
    const payload = {
      from: 'a@b.c',
      to: ['d@e.f'],
      cc: [] as string[],
      bcc: [] as string[],
      subject: 'x',
      html: '',
      text: 'x',
    };
    for (let i = 0; i < 110; i++) {
      await fake.send(payload);
    }
    expect(fake.sent).toHaveLength(100);
  });

  it('main.ts registers SIGTERM graceful shutdown with closeDb', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toContain("process.on('SIGTERM'");
    expect(main).toContain('server.close');
    expect(main).toContain('closeDb');
  });

  it('deploy-ec2.sh picks latest nvm node via version sort', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    expect(deploy).toMatch(/sort -V \| tail -1/);
  });

  it('deploy-ec2.sh retries health check with backoff', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    expect(deploy).toContain('health attempt');
    expect(deploy).toMatch(/seq 1 10/);
  });

  it('ssm-run-command.sh caps poll duration and empty-status spins', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'ssm-run-command.sh'), 'utf8');
    expect(script).toContain('SSM_MAX_POLL_SECONDS');
    expect(script).toContain('SSM_MAX_EMPTY_POLLS');
  });

  it('rds-smoke.sh falls back to postgres npm package when psql missing', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'rds-smoke.sh'), 'utf8');
    expect(script).toContain('postgres npm package');
    expect(script).not.toContain('require("pg")');
    expect(script).toContain('import postgres from "postgres"');
  });

  it('mailbox_access schema has is_default column', async () => {
    const { mailboxAccess } = await import('../src/db/schema/mail.js');
    expect(mailboxAccess.isDefault).toBeDefined();
  });

  it('deploy-ec2.sh installs pm2-startup and deletes fixture worker', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    expect(deploy).toContain('pm2-startup.sh');
    expect(deploy).toContain('pm2 delete worker');
    expect(deploy).toContain('pm2 start');
    expect(deploy).toContain('MAIL_TRANSPORT_MODE');
    expect(deploy).toContain('fixture');
    // startOrReload keeps stale process env after fixture→real cutover.
    expect(deploy).not.toContain('startOrReload');
  });

  it('pm2-boot.sh starts and verifies the exact mode-specific process set', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const boot = readFileSync(join(here, '..', 'deploy', 'pm2-boot.sh'), 'utf8');
    expect(boot).toContain('nvm.sh');
    expect(boot).toContain('.env.production');
    expect(boot).not.toContain('pm2 resurrect');
    expect(boot).toContain('delete_all_pm2_processes');
    expect(boot).toContain('verify_default_process_set');
    expect(boot).toContain('ensure_hms_absent');
    expect(boot).not.toMatch(/pm2 delete hms-ai-worker[^\n]*\|\| true/);
  });

  it('post-boot-smoke.sh checks :8788 and canonical :443 not :3000', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const smoke = readFileSync(join(here, '..', 'deploy', 'post-boot-smoke.sh'), 'utf8');
    expect(smoke).toContain('127.0.0.1:8788/health');
    expect(smoke).toContain('BETTER_AUTH_URL');
    expect(smoke).toContain('--resolve "${PUBLIC_HOST}:443:127.0.0.1"');
    expect(smoke).not.toContain('"https://127.0.0.1');
    expect(smoke).not.toContain(':3000');
    expect(smoke).toContain('systemctl is-active');
  });

  it('production browser and smoke gates never bypass TLS verification', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      'launch-readiness.sh',
      'post-boot-smoke.sh',
      'playwright-real-mail-ui-gate.sh',
      'playwright-ec2-gate.sh',
    ];

    for (const file of files) {
      const script = readFileSync(join(here, '..', 'deploy', file), 'utf8');
      expect(insecureCurlCommands(script), `${file} insecure curl commands`).toEqual([]);
      expect(script).not.toContain(
        'PLAYWRIGHT_IGNORE_HTTPS_ERRORS="${PLAYWRIGHT_IGNORE_HTTPS_ERRORS:-1}"',
      );
      const curlInvocations = curlCommands(script);
      expect(curlInvocations.length, `${file} curl invocation count`).toBeGreaterThan(0);
      for (const invocation of curlInvocations) {
        expect(invocation, `${file}: ${invocation}`).toMatch(
          /^curl --disable --noproxy '\*'/,
        );
      }
      expect(script).toContain(`CANONICAL_ORIGIN="${CANONICAL_ORIGIN}"`);
    }

    const launch = readFileSync(
      join(here, '..', 'deploy', 'launch-readiness.sh'),
      'utf8',
    );
    expect(launch).toContain('-servername "$PUBLIC_HOST"');
    expect(launch).toContain('-verify_hostname "$PUBLIC_HOST"');
    expect(launch).toContain('-verify_return_error');
    expect(launch).toContain('-CAfile /etc/ssl/certs/ca-certificates.crt');
    expect(launch).toContain('-checkend 2592000');
    expect(launch).not.toContain('--cacert "$CERT_FILE"');

    for (const file of ['playwright-real-mail-ui-gate.sh', 'playwright-ec2-gate.sh']) {
      const script = readFileSync(join(here, '..', 'deploy', file), 'utf8');
      expect(script).toContain('BACKEND_URL="$CANONICAL_ORIGIN"');
      expect(script).toContain('export PLAYWRIGHT_BASE_URL="$CANONICAL_ORIGIN"');
      expect(script).toContain('export VITE_PUBLIC_BACKEND_URL="$CANONICAL_ORIGIN"');
      expect(script).toContain('refusing: PLAYWRIGHT_BASE_URL must be canonical HTTPS origin');
      expect(script).toContain(
        'refusing: VITE_PUBLIC_BACKEND_URL must be canonical HTTPS origin',
      );
    }

    const ec2Gate = readFileSync(
      join(here, '..', 'deploy', 'playwright-ec2-gate.sh'),
      'utf8',
    );
    expect(ec2Gate).not.toContain(':3000');
    expect(ec2Gate).not.toContain('cleanup()');
    expect(ec2Gate).not.toContain('FE_PID');
    expect(ec2Gate).not.toContain('pkill');
    expect(ec2Gate).not.toContain('nohup');
    expect(ec2Gate).not.toContain('dlx serve');

    const config = readFileSync(
      join(here, '..', '..', '..', 'packages', 'testing', 'playwright.config.ts'),
      'utf8',
    );
    expect(config).not.toContain('|| realMailGate');
    expect(config).toContain('Real-mail Playwright requires PLAYWRIGHT_BASE_URL');
    expect(config).toContain('Real-mail Playwright forbids ignored HTTPS errors');
    expect(config).toContain('Real-mail Playwright requires canonical HTTPS base URL');
    expect(config).toContain(`const CANONICAL_ORIGIN = '${CANONICAL_ORIGIN}'`);
  });

  it('curl scanner rejects insecure options across shell continuations', () => {
    const fixtures = [
      `curl --disable --noproxy '*' -fsS \\\n  -k "${CANONICAL_ORIGIN}/health"`,
      `curl --disable --noproxy '*' \\\r\n  -Sfks "${CANONICAL_ORIGIN}/health"`,
      `curl --disable --noproxy '*' -fsS \\\n  --insecure "${CANONICAL_ORIGIN}/health"`,
    ];

    for (const fixture of fixtures) {
      expect(curlCommands(fixture)).toHaveLength(1);
      expect(curlCommands(fixture)[0]).toMatch(/^curl --disable --noproxy '\*'/);
      expect(insecureCurlCommands(fixture)).toHaveLength(1);
    }
  });

  it('production scripts reject noncanonical origins before external commands', async () => {
    const {
      chmodSync,
      existsSync,
      mkdirSync,
      mkdtempSync,
      readFileSync,
      rmSync,
      writeFileSync,
    } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { delimiter, dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..', '..');
    const deployDir = join(here, '..', 'deploy');
    const tempDir = mkdtempSync(join(tmpdir(), 'nava-tls-origin-test-'));
    const stubDir = join(tempDir, 'bin');
    const markerPath = join(tempDir, 'external-commands.log');

    mkdirSync(stubDir);
    const stub = `#!/usr/bin/env bash\nprintf '%s\\n' "$(basename "$0")" >>"$NAVA_TEST_MARKER"\nexit 97\n`;
    for (const command of [
      'aws',
      'curl',
      'mktemp',
      'openssl',
      'pm2',
      'pnpm',
      'sleep',
      'sudo',
      'systemctl',
      'timeout',
    ]) {
      const path = join(stubDir, command);
      writeFileSync(path, stub, 'utf8');
      chmodSync(path, 0o755);
    }

    const launchSource = readFileSync(
      join(deployDir, 'launch-readiness.sh'),
      'utf8',
    );
    const launchRemote = launchSource.match(
      /REMOTE_COMMAND="\$\(cat <<'REMOTE'\r?\n([\s\S]*?)\r?\nREMOTE\r?\n\)"/,
    )?.[1];
    expect(launchRemote, 'launch-readiness remote block').toBeTruthy();

    const baseEnv = {
      ...process.env,
      HOME: toBashPath(tempDir),
      PATH: `${toBashPath(stubDir)}${delimiter}${process.env.PATH ?? ''}`,
      REPO_ROOT: toBashPath(repoRoot),
      ENV_FILE: toBashPath(join(tempDir, 'missing.env')),
      NAVA_POST_BOOT_SMOKE_LOG: toBashPath(join(tempDir, 'smoke.log')),
      NAVA_TEST_MARKER: toBashPath(markerPath),
      SMOKE_MAX_ATTEMPTS: '1',
      SMOKE_SLEEP_SECS: '0',
      VPN_WAIT_SECS: '1',
      UNDO_SEND_SECONDS: '0',
      BETTER_AUTH_URL: CANONICAL_ORIGIN,
      PLAYWRIGHT_BASE_URL: CANONICAL_ORIGIN,
      VITE_PUBLIC_BACKEND_URL: CANONICAL_ORIGIN,
    };

    const run = async (
      scriptName: string,
      overrides: Record<string, string>,
      remote = false,
    ) => {
      rmSync(markerPath, { force: true });
      const result = await runBash({
        args: remote ? ['-c', launchRemote!] : [join(deployDir, scriptName)],
        env: { ...baseEnv, ...overrides },
      });
      return {
        ...result,
        externalCommands: existsSync(markerPath)
          ? readFileSync(markerPath, 'utf8')
          : '',
      };
    };

    const invalidOrigins = [
      `http://${CANONICAL_HOST}`,
      `https://other.example`,
      `https://user:pass@${CANONICAL_HOST}`,
      `${CANONICAL_ORIGIN}:444`,
      `${CANONICAL_ORIGIN}/mail`,
      `${CANONICAL_ORIGIN}?source=override`,
      `${CANONICAL_ORIGIN}#override`,
    ];

    try {
      for (const value of invalidOrigins) {
        for (const [scriptName, remote] of [
          ['post-boot-smoke.sh', false],
          ['launch-readiness.sh', true],
        ] as const) {
          const result = await run(scriptName, { BETTER_AUTH_URL: value }, remote);
          expect(result.status, `${scriptName} accepted ${value}`).toBe(2);
          expect(result.stderr).toContain(
            'refusing: BETTER_AUTH_URL must be canonical HTTPS origin',
          );
          expect(result.externalCommands, `${scriptName} ran command for ${value}`).toBe(
            '',
          );
        }
      }

      for (const scriptName of [
        'playwright-real-mail-ui-gate.sh',
        'playwright-ec2-gate.sh',
      ]) {
        for (const variable of [
          'BETTER_AUTH_URL',
          'PLAYWRIGHT_BASE_URL',
          'VITE_PUBLIC_BACKEND_URL',
        ] as const) {
          for (const value of invalidOrigins) {
            const overrides = { [variable]: value };
            const result = await run(scriptName, overrides);
            expect(
              result.status,
              `${scriptName} accepted ${JSON.stringify(overrides)}`,
            ).toBe(2);
            expect(result.stderr).toContain(
              `refusing: ${variable} must be canonical HTTPS origin`,
            );
            expect(
              result.externalCommands,
              `${scriptName} ran command for ${JSON.stringify(overrides)}`,
            ).toBe('');
          }
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('real-mail Playwright config rejects noncanonical base and normalizes one slash', async () => {
    const envKeys = [
      'REAL_MAIL_UI_GATE',
      'PLAYWRIGHT_BASE_URL',
      'PLAYWRIGHT_IGNORE_HTTPS_ERRORS',
    ] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

    try {
      process.env.REAL_MAIL_UI_GATE = '1';
      process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS = '0';

      delete process.env.PLAYWRIGHT_BASE_URL;
      vi.resetModules();
      await expect(
        import('../../../packages/testing/playwright.config.ts'),
      ).rejects.toThrow('Real-mail Playwright requires PLAYWRIGHT_BASE_URL');

      process.env.PLAYWRIGHT_BASE_URL = CANONICAL_ORIGIN;
      process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS = '1';
      vi.resetModules();
      await expect(
        import('../../../packages/testing/playwright.config.ts'),
      ).rejects.toThrow('Real-mail Playwright forbids ignored HTTPS errors');

      process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS = '0';
      process.env.PLAYWRIGHT_BASE_URL = 'https://other.example';
      vi.resetModules();
      await expect(
        import('../../../packages/testing/playwright.config.ts'),
      ).rejects.toThrow('Real-mail Playwright requires canonical HTTPS base URL');

      process.env.PLAYWRIGHT_BASE_URL = `${CANONICAL_ORIGIN}/`;
      vi.resetModules();
      const { default: config } = await import(
        '../../../packages/testing/playwright.config.ts'
      );
      expect((config.use as { baseURL?: string }).baseURL).toBe(CANONICAL_ORIGIN);
    } finally {
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    }
  }, 30_000);

  it('ops-deploy.sh syncs then SSM deploy-ec2 with optional migrate', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-deploy.sh'), 'utf8');
    expect(ops).toContain('sync-ec2-git-bundle.sh');
    expect(ops).toContain('ssm-run-command.sh');
    expect(ops).toContain('deploy-ec2.sh');
    expect(ops).toContain('--migrate');
    expect(ops).toContain('db:migrate');
  });

  it('quiesced deploy builds assets, skips PM2/health, allows online http, keeps VPN', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-deploy.sh'), 'utf8');

    /** Depth-aware if/fi — full QUIESCED branch, not first nested fi. */
    const extractBashIfBlock = (script: string, conditionRe: RegExp): string | null => {
      const match = script.match(conditionRe);
      if (!match || match.index == null) return null;
      const lines = script.slice(match.index).split(/\r?\n/);
      let depth = 0;
      const collected: string[] = [];
      for (const line of lines) {
        collected.push(line);
        if (/^\s*if\b/.test(line)) depth += 1;
        if (/^\s*fi\b/.test(line)) {
          depth -= 1;
          if (depth === 0) return collected.join('\n');
        }
      }
      return null;
    };

    expect(deploy).toContain('--quiesced');
    expect(ops).toContain('--quiesced');
    expect(ops).toContain('vpn-health-assert.sh');
    expect(deploy).toMatch(/\/opt\/nava\/shared/);
    expect(deploy).toMatch(
      /install -d -o root -g root -m 0755 \/opt\/nava \/opt\/nava\/shared/,
    );
    expect(deploy).toMatch(
      /install -d -o ubuntu -g ubuntu -m 0700[\s\S]*hms-browser-artifacts[\s\S]*hms-runtime/,
    );
    expect(deploy).not.toMatch(/chown ubuntu:ubuntu \/opt\/nava/);

    const deployQuiesced = extractBashIfBlock(
      deploy,
      /if\s+\[\s*"\$\{?QUIESCED\}?"\s*=\s*"1"\s*\]/,
    );
    expect(deployQuiesced, 'deploy-ec2.sh QUIESCED branch').toBeTruthy();
    expect(deployQuiesced).toContain('quiesced deploy ok');
    expect(deployQuiesced).toMatch(/exit 0/);
    expect(deployQuiesced).toMatch(/online http OK/);
    // Must not refuse while pm2 http is online.
    expect(deployQuiesced).not.toMatch(/must be stopped/);
    expect(deployQuiesced).not.toMatch(/quiesced deploy refused/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+start\b/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+delete\b/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+save\b/);
    expect(deployQuiesced).not.toMatch(/health attempt|8788\/health/);

    // Non-quiesced path still has PM2 start + health (launch safety).
    expect(deploy).toContain('pm2 start');
    expect(deploy).toContain('health attempt');

    const opsQuiesced = extractBashIfBlock(
      ops,
      /if\s+\[\s*"\$\{?QUIESCED\}?"\s*=\s*"1"\s*\]/,
    );
    expect(opsQuiesced, 'ops-deploy.sh QUIESCED branch').toBeTruthy();
    expect(opsQuiesced).toContain('deploy-ec2.sh --quiesced');
    expect(opsQuiesced).not.toMatch(/curl[^\n]*\/health/);
    expect(ops).toMatch(/deploy-ec2\.sh --quiesced|deploy-ec2\.sh"\s*--quiesced/);
  });

  it('ops-restart.sh reloads pm2 via SSM without sync', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-restart.sh'), 'utf8');
    expect(ops).toContain('ssm-run-command.sh');
    // delete+start refreshes process env; startOrReload kept stale MAIL_* after fixture→real.
    expect(ops).toContain('pm2 delete');
    expect(ops).toContain('pm2 start');
    expect(ops).not.toContain('sync-ec2-git-bundle');
  });

  it('ops-reboot.sh reboots instance then runs post-boot-smoke', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-reboot.sh'), 'utf8');
    expect(ops).toContain('reboot-instances');
    expect(ops).toContain('post-boot-smoke.sh');
    expect(ops).toContain('ssm-run-command.sh');
  });

  it('pilot-db-wipe.sh requires CONFIRM_PILOT_WIPE=1 and passes bash -n', async () => {
    const { readFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'deploy', 'pilot-db-wipe.sh');
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('CONFIRM_PILOT_WIPE=1');
    expect(script).toContain('exit 2');
    expect(script).toContain('/var/lib/nava-pilot/wipe-navaai.ok');
    expect(script).toContain('TRUNCATE TABLE');
    expect(script).toContain('mail_ingest_mailbox');
    expect(script).not.toMatch(/\bTRUNCATE TABLE[\s\S]*\buser\b/i);

    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);

    // Refuse without confirm: exit 2 before any DB touch (no DATABASE_URL needed).
    const refuse = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, CONFIRM_PILOT_WIPE: '', DATABASE_URL: '' },
    });
    expect(refuse.status).toBe(2);
    expect(refuse.stderr).toMatch(/CONFIRM_PILOT_WIPE=1/);
  });

  it('activate-real-mail.sh pins Rocketseed SMTP, no AUTH smoke, staged password wins', async () => {
    const { readFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'scripts', 'activate-real-mail.sh');
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('POP3_HOST:=172.24.0.10');
    expect(script).toContain('SMTP_HOST:=172.24.0.8');
    expect(script).not.toContain('SMTP_HOST:=172.24.0.10');
    expect(script).toContain('POP3_USER:=navaai@legacyhotels.co.za');
    expect(script).toContain('SMTP_USER:=navaai@legacyhotels.co.za');
    expect(script).toMatch(/SMTP_HOST[^\n]*172\.24\.0\.8/);
    expect(script).toContain('SMTP_HOST must be 172.24.0.8');

    // POP3 still requires credentials; SMTP password optional (IP-trust).
    expect(script).toContain('POP3_SECRET_ARN or POP3_PASSWORD required');
    expect(script).not.toContain('SMTP_SECRET_ARN or SMTP_PASSWORD required');

    // Staged passwords saved before source; restored after (staged wins).
    expect(script).toContain('STAGED_POP3_PASSWORD="${POP3_PASSWORD:-}"');
    expect(script).toContain('STAGED_SMTP_PASSWORD="${SMTP_PASSWORD:-}"');
    expect(script).toMatch(
      /STAGED_POP3_PASSWORD[\s\S]*source[\s\S]*\.env\.production[\s\S]*STAGED_POP3_PASSWORD/,
    );
    expect(script).toContain('export POP3_PASSWORD="${STAGED_POP3_PASSWORD}"');
    expect(script).toContain('export SMTP_PASSWORD="${STAGED_SMTP_PASSWORD}"');

    // Port probe: POP3 995→110; SMTP 587 only (no port 25).
    expect(script).toContain('for candidate in 995 110');
    expect(script).toContain('SMTP_PORT=587');
    expect(script).not.toContain('for candidate in 587 25');
    expect(script).toContain('POP3 port probe failed');
    expect(script).toContain('SMTP port probe failed');
    expect(script).toContain('POP3_TLS=true');
    expect(script).toContain('POP3_TLS=false');
    expect(script).toContain('SMTP_SECURE=false');

    // Rocketseed STARTTLS smoke — never AUTH verify with Zimbra creds.
    expect(script).toContain('SMTP STARTTLS OK');
    expect(script).not.toContain('auth: { user, pass }');
    expect(script).not.toContain('SMTP auth OK');
    expect(script).toContain('requireTLS: true');
    expect(script).toContain("servername: 'branding.legacyhotels.co.za'");
    expect(script).toContain('rejectUnauthorized: true');
    expect(script).toContain('trying next candidate');

    expect(script).toContain('export AI_DRAFTS_ENABLED=false');
    expect(script).toContain('export AI_WRITE_GATE_ENABLED=true');

    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
  });

  it('vitest-running gates unset pilot RDS vars and never source env files', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deployDir = join(here, '..', 'deploy');

    const vitestGates = [
      'hms-read-gate.sh',
      'mail-search-gate.sh',
      'fixture-loopback-gate.sh',
      'wire-gate.sh',
      'ai-gate.sh',
    ] as const;

    const sourcesForbiddenEnv = (script: string) =>
      /source\s+(?:\$ENV_FILE|"\$ENV_FILE"|'\$ENV_FILE')/.test(script) ||
      /source\s+\/home\/ubuntu\/\.env\.production/.test(script) ||
      /source\s+(?:\.\/)?\.env\.production/.test(script) ||
      /source\s+(?:\$\{?SERVER_PILOT\}?\/)?\.env(?:\s|$|")/.test(script) ||
      /source\s+"\$\{SERVER_PILOT\}\/\.env"/.test(script);

    for (const name of vitestGates) {
      const script = readFileSync(join(deployDir, name), 'utf8');
      expect(script, `${name} must unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`).toMatch(
        /unset\s+DATABASE_URL\s+VITEST_ALLOW_PILOT_RDS/,
      );
      expect(
        sourcesForbiddenEnv(script),
        `${name} must never source .env.production/.env`,
      ).toBe(false);
      expect(script, `${name} must never export VITEST_ALLOW_PILOT_RDS=1`).not.toContain(
        'VITEST_ALLOW_PILOT_RDS=1',
      );
      expect(script, `${name} must use pnpm exec vitest run`).toContain(
        'pnpm exec vitest run',
      );
    }
  });

  it('DB vitest gates require disposable URL confirm and reject pilot host', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deployDir = join(here, '..', 'deploy');

    // Gates whose Vitest path always needs a disposable DB.
    const alwaysDbVitestGates = [
      'mail-search-gate.sh',
      'fixture-loopback-gate.sh',
      'wire-gate.sh',
    ] as const;

    for (const name of alwaysDbVitestGates) {
      const script = readFileSync(join(deployDir, name), 'utf8');
      expect(script, `${name} must require TEST_DATABASE_URL`).toContain(
        'TEST_DATABASE_URL',
      );
      expect(script, `${name} must require CONFIRM_DISPOSABLE_TEST_DB=1`).toContain(
        'CONFIRM_DISPOSABLE_TEST_DB',
      );
      expect(script, `${name} must reject nava-zero-mail-pilot`).toContain(
        'nava-zero-mail-pilot',
      );
      // Map TEST_DATABASE_URL → DATABASE_URL on the Vitest invocation only.
      expect(
        script,
        `${name} must map TEST_DATABASE_URL onto vitest command only`,
      ).toMatch(/DATABASE_URL="\$TEST_DATABASE_URL"\s+pnpm exec vitest/);
      expect(script, `${name} must not globally export DATABASE_URL from TEST`).not.toMatch(
        /^\s*export DATABASE_URL="\$TEST_DATABASE_URL"/m,
      );
    }

    // hms-read-gate: fixture-only is DB-free; --full DB path must still be disposable-safe.
    const hmsGate = readFileSync(join(deployDir, 'hms-read-gate.sh'), 'utf8');
    expect(hmsGate).toContain('TEST_DATABASE_URL');
    expect(hmsGate).toContain('CONFIRM_DISPOSABLE_TEST_DB');
    expect(hmsGate).toContain('nava-zero-mail-pilot');
    expect(hmsGate).toMatch(/DATABASE_URL="\$TEST_DATABASE_URL"\s+pnpm exec vitest/);
  });

  it('test-db helper rejects dotenv load and implicit .env reads', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const helper = readFileSync(join(here, 'helpers', 'test-db.ts'), 'utf8');

    expect(helper).not.toContain('loadTestEnvFromDotenv');
    expect(helper).not.toMatch(/readFileSync\([^)]*\.env/);
    expect(helper).not.toMatch(/['"]\.env['"]/);
    expect(helper).toContain('TEST_DATABASE_URL');
    expect(helper).toContain('CONFIRM_DISPOSABLE_TEST_DB');
    expect(helper).toContain('nava-zero-mail-pilot');
    // Ambient DATABASE_URL without CONFIRM must not open a DB.
    expect(helper).toMatch(/Refuse ambient DATABASE_URL/);
    expect(helper).toMatch(/confirm !== true|CONFIRM_DISPOSABLE_TEST_DB === ['"]1['"]/);
    expect(helper).not.toMatch(/Legacy callers may already have DATABASE_URL/);
  });

  it('import-hms-secret.sh accepts only credentialMode=view_only', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'import-hms-secret.sh'), 'utf8');

    expect(script).toContain('view_only');
    expect(script).toMatch(/HMS_CREDENTIAL_MODE/);
    expect(script).not.toMatch(/HMS_CREDENTIAL_MODE=audited_write/);
    const refuseIdx = script.search(/!=\s*"view_only"|==\s*"view_only"/);
    const putIdx = script.indexOf('put-secret-value');
    expect(refuseIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(refuseIdx);
  });

  it('AI and Bedrock gates never bypass pilot-RDS Vitest guard', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deployDir = join(here, '..', 'deploy');

    const aiGate = readFileSync(join(deployDir, 'ai-gate.sh'), 'utf8');
    const bedrockGate = readFileSync(join(deployDir, 'bedrock-live-gate.sh'), 'utf8');

    for (const [name, script] of [
      ['ai-gate.sh', aiGate],
      ['bedrock-live-gate.sh', bedrockGate],
    ] as const) {
      expect(script, `${name} must not set VITEST_ALLOW_PILOT_RDS=1`).not.toContain(
        'VITEST_ALLOW_PILOT_RDS=1',
      );
      expect(script, `${name} must unset DATABASE_URL and VITEST_ALLOW_PILOT_RDS`).toMatch(
        /unset\s+DATABASE_URL\s+VITEST_ALLOW_PILOT_RDS/,
      );
    }

    // ai-gate is DB-free by default: never source production env into Vitest.
    expect(aiGate).not.toMatch(/source\s+"?\$\{?ENV_FILE/);
    expect(aiGate).not.toContain('source .env.production');
    expect(aiGate).toContain('pnpm exec vitest run');
    // Optional DB path must use canonical TEST_DATABASE_URL + CONFIRM, map on vitest only.
    expect(aiGate).toContain('TEST_DATABASE_URL');
    expect(aiGate).toContain('CONFIRM_DISPOSABLE_TEST_DB');
    expect(aiGate).toContain('nava-zero-mail-pilot');
    expect(aiGate).toMatch(/DATABASE_URL="\$TEST_DATABASE_URL"\s+pnpm exec vitest/);
    expect(aiGate).not.toMatch(/^\s*export DATABASE_URL=/m);

    // bedrock-live may source Bedrock/AWS settings, but must never invoke Vitest.
    expect(bedrockGate).not.toMatch(/\bpnpm exec vitest\b/);
    expect(bedrockGate).not.toMatch(/\bpnpm test\b/);
    expect(bedrockGate).toContain('bedrock-live-smoke');
    expect(bedrockGate).toMatch(/\btsx\b/);
  });

  it('stage-navaai-mail-env.sh refuses REPLACE_ and keeps password out of SSM argv', async () => {
    const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'deploy', 'stage-navaai-mail-env.sh');
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('navaai-mail-pass.txt');
    expect(script).toContain('REPLACE_');
    expect(script).toContain('mail-navaai');
    expect(script).toContain('/run/nava-mail/password');
    expect(script).toContain('chmod 600');
    expect(script).toContain('chown root:root');
    expect(script).toContain('STAGED_OK');
    expect(script).toContain('ssm-run-command.sh');
    expect(script).toContain('AWS_REGION:=af-south-1');
    expect(script).toContain('INSTANCE_ID:=i-008f737974a9ba9b3');

    // SSM installs via S3 cp as ubuntu (IMDS), then sudo cp into /run —
    // password bytes never interpolated into SYNC_CMD. sudo aws drops role → 403.
    expect(script).toContain('aws s3 cp "\\$S3_PREFIX/password"');
    expect(script).toContain('sudo cp "\\$TMP_PASS" /run/nava-mail/password');
    expect(script).not.toContain('sudo aws s3 cp');
    expect(script).not.toMatch(/ssm-run-command\.sh[^]*\$\(cat/);
    expect(script).not.toMatch(/echo\s+"?\$\{?(PASS|PASSWORD)/i);
    expect(script).not.toMatch(/\bcat\b[^\n]*\/run\/nava-mail\/password/);
    expect(script).not.toMatch(/SYNC_CMD=[\s\S]*PASS_FILE/);

    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);

    const mailDir = mkdtempSync(join(tmpdir(), 'nava-mail-stage-test-'));
    try {
      writeFileSync(
        join(mailDir, 'navaai-mail-pass.txt'),
        'REPLACE_WITH_NAVAAI_MAILBOX_PASSWORD\n',
        'utf8',
      );
      const refuse = spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, MAIL_DIR: mailDir },
      });
      expect(refuse.status).toBe(2);
      expect(refuse.stderr).toMatch(/placeholder/i);
      expect(refuse.stdout).not.toMatch(/REPLACE_WITH_NAVAAI/);
    } finally {
      rmSync(mailDir, { recursive: true, force: true });
    }

    const missingDir = mkdtempSync(join(tmpdir(), 'nava-mail-stage-missing-'));
    try {
      const missing = spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, MAIL_DIR: missingDir },
      });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toMatch(/missing/i);
    } finally {
      rmSync(missingDir, { recursive: true, force: true });
    }
  });

  it('VPN and launch readiness enforce the private HTTPS perimeter', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const vpn = readFileSync(
      join(here, '..', 'deploy', 'vpn-health-assert.sh'),
      'utf8',
    );
    const readiness = readFileSync(
      join(here, '..', 'deploy', 'launch-readiness.sh'),
      'utf8',
    );

    expect(vpn).toContain('EXPECTED_VPN_INTERFACE="${EXPECTED_VPN_INTERFACE:-tun0}"');
    expect(vpn).toContain('EXPECTED_VPN_CIDR="${EXPECTED_VPN_CIDR:-192.168.138.2/29}"');
    expect(readiness).toContain('ufwTunnel443Only');
    expect(readiness).toContain('securityGroupIngressEmpty');
    expect(readiness).toContain('s3CorsCanonical');
    expect(readiness).toContain('s3PublicAccessBlocked');
    expect(readiness).toContain('instanceHasNoPublicIpv6');
    expect(readiness).toContain('aws s3api get-bucket-cors');
    expect(readiness).toContain('aws s3api get-public-access-block');
    expect(readiness).toContain('aws ec2 describe-instances');
    expect(readiness).toContain('aws ec2 describe-security-groups');
    expect(readiness).toContain('--group-ids "${SG_IDS[@]}"');
    expect(readiness).not.toMatch(/--group-ids\s+\$SG_IDS/);
    expect(readiness).toContain('UFW_BROAD443_ABSENT=false');
    expect(readiness).toContain('# BEGIN_READINESS_PERIMETER_COLLECTION');
    expect(readiness).toContain('# END_READINESS_PERIMETER_COLLECTION');
    expect(readiness).toContain('build_readiness_report()');
  });

  it('VPN health rejects a missing tun0 interface or wrong exact tunnel CIDR', async () => {
    const missing = await runVpnHealth('192.168.138.2/29', false);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('VPN_HARD_FAIL_INTERFACE_tun0');

    const wrongAddress = await runVpnHealth('192.168.138.3/29', true);
    expect(wrongAddress.status).toBe(1);
    expect(wrongAddress.stdout).toContain('VPN_HARD_FAIL_ADDRESS');

    const exact = await runVpnHealth('192.168.138.2/29', true);
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.stdout).toBe(
      [
        '== vpn-health-assert ==',
        'VPN_HARD_OK',
        'HOTEL_PROBE_OK',
        'VPN_HOTEL_OK',
        '',
      ].join('\n'),
    );
    for (const sentinel of Object.values(VPN_HEALTH_OUTPUT_SENTINELS)) {
      expect(exact.stdout).not.toContain(sentinel);
    }
  });

  it('launch readiness accepts complete private perimeter facts', async () => {
    const report = await runLaunchReadinessReport();

    expect(report.checks).toMatchObject({
      ufwTunnel443Only: true,
      s3CorsCanonical: true,
      s3PublicAccessBlocked: true,
      securityGroupIngressEmpty: true,
      instanceHasNoPublicIpv6: true,
    });
    const observations = JSON.stringify(report.observations);
    expect(observations).not.toContain(CANONICAL_ORIGIN);
    expect(observations).not.toContain('AllowedOrigins');
    expect(observations).not.toContain(SG_ONE);
  });

  it('UFW collection accepts exactly one intended tunnel HTTPS allow', async () => {
    const exact = await runUfwCollection();
    expect(exact.status, exact.stderr).toBe(0);
    expect(exact.facts).toEqual({
      statusRead: true,
      rulesRead: true,
      active: true,
      defaultDeny: true,
      tunnel443: true,
      broad443Absent: true,
    });
    const exactReport = await runLaunchReadinessReport({ firewall: exact.facts! });
    expect(exactReport.checks.ufwTunnel443Only).toBe(true);

    const disallowedRules = [
      `${INTENDED_UFW_ALLOW}\nufw allow 'Nginx Full'`,
      `${INTENDED_UFW_ALLOW}\nufw allow 'Nginx HTTPS'`,
      `${INTENDED_UFW_ALLOW}\nufw allow 22/tcp`,
      `${INTENDED_UFW_ALLOW}\nufw allow in on tun0 to any port 443`,
      `${INTENDED_UFW_ALLOW}\nufw allow in on tun0 to any port 443 proto udp`,
      `${INTENDED_UFW_ALLOW}\nufw allow 443/tcp`,
      `${INTENDED_UFW_ALLOW}\n${INTENDED_UFW_ALLOW}`,
      `${INTENDED_UFW_ALLOW}\nufw limit 443/tcp`,
      `${INTENDED_UFW_ALLOW}\nufw route allow 443/tcp`,
      `${INTENDED_UFW_ALLOW}\nufw insert 1 allow 443/tcp`,
    ];
    for (const added of disallowedRules) {
      const collected = await runUfwCollection({ added });
      expect(collected.status, collected.stderr).toBe(0);
      expect(collected.facts?.tunnel443).toBe(false);
      expect(collected.facts?.broad443Absent).toBe(false);
      const report = await runLaunchReadinessReport({
        firewall: collected.facts!,
      });
      expect(report.checks.ufwTunnel443Only).toBe(false);
    }
  }, 60_000);

  it('UFW collection fails closed when either command fails', async () => {
    for (const failure of [{ failStatus: true }, { failAdded: true }]) {
      const collected = await runUfwCollection(failure);
      expect(collected.status).toBe(0);
      expect(collected.stderr).not.toContain('sensitive-ufw-stub-detail');
      expect(collected.facts?.statusRead && collected.facts?.rulesRead).toBe(false);
      if ('failAdded' in failure) {
        expect(collected.facts?.broad443Absent).toBe(false);
      }
      const report = await runLaunchReadinessReport({
        firewall: collected.facts!,
      });
      expect(report.checks.ufwTunnel443Only).toBe(false);
    }
  });

  it('UFW collection requires active status and default-deny incoming', async () => {
    for (const verbose of [
      'Status: inactive\nDefault: deny (incoming), allow (outgoing)',
      'Status: active\nDefault: allow (incoming), allow (outgoing)',
    ]) {
      const collected = await runUfwCollection({ verbose });
      expect(collected.status, collected.stderr).toBe(0);
      const report = await runLaunchReadinessReport({
        firewall: collected.facts!,
      });
      expect(report.checks.ufwTunnel443Only).toBe(false);
    }
  });

  it('launch readiness accepts overlap and final canonical CORS states', async () => {
    const overlap = await runLaunchReadinessReport({
      cors: validCors([
        CANONICAL_ORIGIN,
        'https://nava.legacy.local',
        'http://localhost:3000',
        'https://localhost:3000',
      ]),
    });
    expect(overlap.checks.s3CorsCanonical).toBe(true);

    const final = await runLaunchReadinessReport({
      cors: validCors([
        CANONICAL_ORIGIN,
        'http://localhost:3000',
        'https://localhost:3000',
      ]),
    });
    expect(final.checks.s3CorsCanonical).toBe(true);
  });

  it('launch readiness requires canonical CORS origin and methods in one valid rule', async () => {
    const splitRules = await runLaunchReadinessReport({
      cors: {
        CORSRules: [
          { AllowedOrigins: [CANONICAL_ORIGIN], AllowedMethods: [] },
          {
            AllowedOrigins: ['http://localhost:3000'],
            AllowedMethods: ['GET', 'HEAD'],
          },
        ],
      },
    });
    expect(splitRules.checks.s3CorsCanonical).toBe(false);

    for (const wildcardOrigin of ['*', 'https://*.legacyhotels.co.za', 'https://nava.*']) {
      const wildcard = await runLaunchReadinessReport({
        cors: validCors([CANONICAL_ORIGIN, wildcardOrigin]),
      });
      expect(wildcard.checks.s3CorsCanonical, wildcardOrigin).toBe(false);
    }
  });

  it('launch readiness rejects any malformed CORS rule or field', async () => {
    const canonicalRule = validCors().CORSRules[0];
    const malformedCors = [
      { CORSRules: [canonicalRule, null] },
      {
        CORSRules: [
          canonicalRule,
          { AllowedOrigins: CANONICAL_ORIGIN, AllowedMethods: ['GET', 'HEAD'] },
        ],
      },
      {
        CORSRules: [
          canonicalRule,
          { AllowedOrigins: [CANONICAL_ORIGIN, 7], AllowedMethods: ['GET', 'HEAD'] },
        ],
      },
      {
        CORSRules: [
          canonicalRule,
          { AllowedOrigins: [CANONICAL_ORIGIN], AllowedMethods: ['GET', 7] },
        ],
      },
      {
        CORSRules: [{ ...canonicalRule, AllowedHeaders: '*' }],
      },
      {
        CORSRules: [{ ...canonicalRule, MaxAgeSeconds: '300' }],
      },
      {
        CORSRules: [{ ...canonicalRule, UnexpectedField: true }],
      },
    ];

    for (const cors of malformedCors) {
      const report = await runLaunchReadinessReport({ cors });
      expect(report.checks.s3CorsCanonical).toBe(false);
    }
  });

  it('launch readiness requires all four S3 public-access blocks', async () => {
    const report = await runLaunchReadinessReport({
      publicAccess: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
      },
    });

    expect(report.checks.s3PublicAccessBlocked).toBe(false);
  });

  it('launch readiness fails closed for missing, partial, or nonempty SG results', async () => {
    const missing = await runLaunchReadinessReport({ omitSecurityGroups: true });
    expect(missing.checks.securityGroupIngressEmpty).toBe(false);

    const empty = await runLaunchReadinessReport({ securityGroups: [] });
    expect(empty.checks.securityGroupIngressEmpty).toBe(false);

    const ingress = await runLaunchReadinessReport({
      instanceNetwork: {
        securityGroups: [{ GroupId: SG_ONE }],
        ipv6: [],
      },
      securityGroups: [{ id: SG_ONE, ingress: [{ IpProtocol: 'tcp' }] }],
    });
    expect(ingress.checks.securityGroupIngressEmpty).toBe(false);

    const partial = await runLaunchReadinessReport({
      securityGroups: [{ id: SG_ONE, ingress: [] }],
    });
    expect(partial.checks.securityGroupIngressEmpty).toBe(false);
  });

  it('launch readiness rejects malformed or duplicate SG attachment/result records', async () => {
    const malformedCases = [
      {
        instanceNetwork: {
          securityGroups: [{ GroupId: SG_ONE }, {}],
          ipv6: [],
        },
        securityGroups: [{ id: SG_ONE, ingress: [] }],
      },
      {
        instanceNetwork: {
          securityGroups: [{ GroupId: SG_ONE }, { GroupId: SG_ONE }],
          ipv6: [],
        },
        securityGroups: [{ id: SG_ONE, ingress: [] }],
      },
      {
        instanceNetwork: {
          securityGroups: [{ GroupId: 'not-an-sg-id' }],
          ipv6: [],
        },
        securityGroups: [{ id: 'not-an-sg-id', ingress: [] }],
      },
      {
        instanceNetwork: {
          securityGroups: [{ GroupId: SG_ONE }],
          ipv6: [],
        },
        securityGroups: [
          { id: SG_ONE, ingress: [] },
          { ingress: [] },
        ],
      },
      {
        instanceNetwork: {
          securityGroups: [{ GroupId: SG_ONE }],
          ipv6: [],
        },
        securityGroups: [
          { id: SG_ONE, ingress: [] },
          { id: SG_ONE, ingress: [] },
        ],
      },
    ];

    for (const input of malformedCases) {
      const report = await runLaunchReadinessReport(input);
      expect(report.checks.securityGroupIngressEmpty).toBe(false);
    }
  });

  it('AWS perimeter collection quotes SG IDs and drives the real report inputs', async () => {
    const collected = await runAwsPerimeterCollection();
    expect(collected.status, collected.stderr).toBe(0);
    expect(collected.facts?.s3CorsOk).toBe(true);
    expect(collected.facts?.s3PublicAccessOk).toBe(true);
    expect(collected.facts?.instanceNetworkOk).toBe(true);
    expect(collected.facts?.securityGroupQueryOk).toBe(true);
    expect(collected.securityGroupArgs).toContain(SG_ONE);
    expect(collected.securityGroupArgs).toContain(SG_TWO);

    const report = collected.report!;
    expect(report.checks).toMatchObject({
      s3CorsCanonical: true,
      s3PublicAccessBlocked: true,
      securityGroupIngressEmpty: true,
      instanceHasNoPublicIpv6: true,
    });
  });

  it('S3 perimeter collection fails stably for bad commands and output', async () => {
    const cases = [
      {
        options: { failCors: true },
        message: 'launch-readiness: S3 CORS query failed',
        failedCheck: 's3CorsCanonical',
      },
      {
        options: { corsRaw: '' },
        message: 'launch-readiness: S3 CORS response invalid',
        failedCheck: 's3CorsCanonical',
      },
      {
        options: { corsRaw: '{"CORSRules":' },
        message: 'launch-readiness: S3 CORS response invalid',
        failedCheck: 's3CorsCanonical',
      },
      {
        options: { corsRaw: '{"CORSRules":[]}\ni-private-partial' },
        message: 'launch-readiness: S3 CORS response invalid',
        failedCheck: 's3CorsCanonical',
      },
      {
        options: { corsRaw: '{"CORSRules":"invalid"}' },
        message: 'launch-readiness: S3 CORS response invalid',
        failedCheck: 's3CorsCanonical',
      },
      {
        options: {
          corsRaw: JSON.stringify({ ...validCors(), UnexpectedField: true }),
        },
        message: 'launch-readiness: S3 CORS response invalid',
        failedCheck: 's3CorsCanonical',
      },
      {
        options: { failPublicAccess: true },
        message: 'launch-readiness: S3 public-access query failed',
        failedCheck: 's3PublicAccessBlocked',
      },
      {
        options: { publicAccessRaw: '' },
        message: 'launch-readiness: S3 public-access response invalid',
        failedCheck: 's3PublicAccessBlocked',
      },
      {
        options: { publicAccessRaw: '{"BlockPublicAcls":' },
        message: 'launch-readiness: S3 public-access response invalid',
        failedCheck: 's3PublicAccessBlocked',
      },
      {
        options: {
          publicAccessRaw:
            '{"BlockPublicAcls":true,"IgnorePublicAcls":true}\nsg-private-partial',
        },
        message: 'launch-readiness: S3 public-access response invalid',
        failedCheck: 's3PublicAccessBlocked',
      },
      {
        options: { publicAccessRaw: '{"BlockPublicAcls":true}' },
        message: 'launch-readiness: S3 public-access response invalid',
        failedCheck: 's3PublicAccessBlocked',
      },
      {
        options: {
          publicAccessRaw: JSON.stringify({
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
            UnexpectedField: true,
          }),
        },
        message: 'launch-readiness: S3 public-access response invalid',
        failedCheck: 's3PublicAccessBlocked',
      },
    ] as const;

    for (const testCase of cases) {
      const collected = await runAwsPerimeterCollection(testCase.options);
      expect(collected.status, JSON.stringify(testCase.options)).toBe(0);
      expect(collected.stderr).toContain(testCase.message);
      expect(collected.stderr).not.toMatch(
        /sensitive-aws-stub-detail|i-private|sg-private/,
      );
      expect(JSON.stringify(collected.facts)).not.toMatch(/i-private|sg-private/);
      const report = collected.report!;
      expect(report.checks[testCase.failedCheck]).toBe(false);
    }
  }, 30_000);

  it('AWS perimeter collection redacts EC2 and SG query failures', async () => {
    const instanceFailure = await runAwsPerimeterCollection({ failInstance: true });
    expect(instanceFailure.status).toBe(0);
    expect(instanceFailure.stderr).toContain(
      'launch-readiness: EC2 network query failed',
    );
    expect(instanceFailure.stderr).not.toContain('sensitive-aws-stub-detail');
    expect(instanceFailure.facts?.instanceNetworkOk).toBe(false);
    expect(instanceFailure.facts?.securityGroupQueryOk).toBe(false);
    const instanceReport = instanceFailure.report!;
    expect(instanceReport.checks.securityGroupIngressEmpty).toBe(false);
    expect(instanceReport.checks.instanceHasNoPublicIpv6).toBe(false);

    const sgFailure = await runAwsPerimeterCollection({
      failSecurityGroups: true,
    });
    expect(sgFailure.status).toBe(0);
    expect(sgFailure.stderr).toContain(
      'launch-readiness: security-group query failed',
    );
    expect(sgFailure.stderr).not.toContain('sensitive-aws-stub-detail');
    expect(sgFailure.facts?.instanceNetworkOk).toBe(true);
    expect(sgFailure.facts?.securityGroupQueryOk).toBe(false);
    const sgReport = sgFailure.report!;
    expect(sgReport.checks.securityGroupIngressEmpty).toBe(false);
  });

  it.each([
    {
      name: 'truncated JSON',
      instanceNetworkRaw: '{"securityGroups":',
    },
    {
      name: 'trailing private output',
      instanceNetworkRaw: `${JSON.stringify(validInstanceNetwork())}\ni-private sg-private`,
    },
    {
      name: 'missing security-group attachments',
      instanceNetworkRaw: JSON.stringify({ securityGroups: [], ipv6: [] }),
    },
  ])(
    'AWS perimeter collection safely rejects malformed EC2 stdout: $name',
    async ({ instanceNetworkRaw }) => {
      const collected = await runAwsPerimeterCollection({ instanceNetworkRaw });
      expect(collected.status, collected.stderr).toBe(0);
      expect(collected.stderr).toContain(
        'launch-readiness: EC2 network response invalid',
      );
      expect(collected.stderr).not.toMatch(
        /SyntaxError|JSON\.parse|Unexpected token|i-private|sg-private/,
      );
      expect(collected.securityGroupArgs).toEqual([]);
      expect(collected.facts).toMatchObject({
        instanceNetwork: {},
        instanceNetworkOk: false,
        securityGroupQueryOk: false,
      });
      expect(JSON.stringify(collected.facts)).not.toMatch(/i-private|sg-private/);
      expect(collected.report?.checks).toMatchObject({
        securityGroupIngressEmpty: false,
        instanceHasNoPublicIpv6: false,
      });
    },
  );

  it('AWS perimeter collection rejects malformed instance SG attachments', async () => {
    const malformedAttachment = await runAwsPerimeterCollection({
      instanceNetwork: {
        securityGroups: [{ GroupId: SG_ONE }, {}],
        ipv6: [],
      },
      securityGroups: [{ id: SG_ONE, ingress: [] }],
    });
    expect(malformedAttachment.status).toBe(0);
    expect(malformedAttachment.securityGroupArgs).toEqual([]);
    expect(malformedAttachment.facts?.instanceNetworkOk).toBe(false);
    const attachmentReport = malformedAttachment.report!;
    expect(attachmentReport.checks.securityGroupIngressEmpty).toBe(false);
    expect(attachmentReport.checks.instanceHasNoPublicIpv6).toBe(false);
  });

  it('AWS perimeter collection rejects malformed SG result records', async () => {
    const malformedResult = await runAwsPerimeterCollection({
      instanceNetwork: {
        securityGroups: [{ GroupId: SG_ONE }],
        ipv6: [],
      },
      securityGroups: [
        { id: SG_ONE, ingress: [] },
        { ingress: [] },
      ],
    });
    expect(malformedResult.status).toBe(0);
    const malformedReport = malformedResult.report!;
    expect(malformedReport.checks.securityGroupIngressEmpty).toBe(false);
  });

  it('AWS perimeter collection fails closed for partial SG result coverage', async () => {
    const partialResult = await runAwsPerimeterCollection({
      securityGroups: [{ id: SG_ONE, ingress: [] }],
    });
    expect(partialResult.status).toBe(0);
    const partialReport = partialResult.report!;
    expect(partialReport.checks.securityGroupIngressEmpty).toBe(false);
  });

  it('AWS-collected wildcard and malformed CORS fail the real report', async () => {
    for (const cors of [
      validCors([CANONICAL_ORIGIN, 'https://*.legacyhotels.co.za']),
      { CORSRules: [validCors().CORSRules[0], null] },
    ]) {
      const collected = await runAwsPerimeterCollection({ cors });
      expect(collected.status, collected.stderr).toBe(0);
      const report = collected.report!;
      expect(report.checks.s3CorsCanonical).toBe(false);
    }
  });

  it('launch readiness rejects public instance IPv6 addresses', async () => {
    const report = await runLaunchReadinessReport({
      instanceNetwork: {
        securityGroups: [{ GroupId: SG_ONE }],
        ipv6: ['2001:db8::1'],
      },
      securityGroups: [{ id: SG_ONE, ingress: [] }],
    });

    expect(report.checks.securityGroupIngressEmpty).toBe(true);
    expect(report.checks.instanceHasNoPublicIpv6).toBe(false);
  });

  it('launch-readiness.sh is strict, redacted, read-only, and syntactically valid', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'deploy', 'launch-readiness.sh');
    const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';

    expect(script).toContain('REQUIRE_HOTEL_PROBE=1');
    expect(script).toContain('RDS_INSTANCE_ID:=nava-zero-mail-pilot');
    expect(script).toContain('S3_BUCKET:=nava-zero-mail-845242190536-af-south-1');
    expect(script).toContain('MAIL_TRANSPORT_MODE');
    expect(script).toContain('BETTER_AUTH_URL');
    expect(script).toContain('UNDO_SEND_SECONDS');
    expect(script).toContain('AI_WRITE_GATE_ENABLED');
    expect(script).toContain('AI_DRAFTS_ENABLED');
    expect(script).toContain('monitoringMode');
    expect(script).toContain('deletionProtection');
    expect(script).toContain('multiAZ');
    expect(script).toContain('latestInboundAt');
    expect(script).toContain('backupLatestRestorableAt');
    expect(script).not.toMatch(/\bset\s+-x\b/);
    expect(script).not.toMatch(
      /(?:echo|printf)[^\n]*(?:DATABASE_URL|PASSWORD|SECRET_ARN|SECRET_STRING)/,
    );
    expect(script).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);

    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
  });

  it('real-mail UI gate has a non-mutating read-only mode', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(
      join(here, '..', 'deploy', 'playwright-real-mail-ui-gate.sh'),
      'utf8',
    );

    expect(script).toContain('--read-only');
    expect(script).toContain('READ_ONLY=1');
    expect(script).toContain('EXPECTED_UNDO_SEND_SECONDS=30');
    expect(script).toContain('READ_ONLY_SPECS=(');
    const readOnlySpecs = script.match(/READ_ONLY_SPECS=\(([\s\S]*?)\)/)?.[1] ?? '';
    expect(readOnlySpecs).toContain('real-mail-browser-login');
    expect(readOnlySpecs).toContain('real-mail-launch-readonly');
    expect(readOnlySpecs).not.toMatch(/compose|reply|force-sync|forceSync|send/i);
    expect(script).not.toContain('api/auth/sign-in/email');
    expect(script).not.toMatch(/echo[^\n]*PLAYWRIGHT_REAL_MAIL_PASSWORD/);
  });

  it('task-owned operations files never stage the whole worktree', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..', '..');
    const paths = [
      join(here, '..', 'deploy', 'launch-readiness.sh'),
      join(here, '..', 'deploy', 'playwright-real-mail-ui-gate.sh'),
      join(repoRoot, 'docs', 'runbooks', 'centurion-day-one-operations.md'),
    ];

    for (const path of paths) {
      const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
      expect(source, path).not.toMatch(/\bgit\s+add\s+(?:\.|-A|--all)(?:\s|$)/m);
    }
  });

  it('private production and SDD artifacts are ignored', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const gitignore = readFileSync(join(here, '..', '..', '..', '.gitignore'), 'utf8');

    expect(gitignore).toContain('live real data connection/');
    expect(gitignore).toContain('Nava.ovpn');
    expect(gitignore).toContain('Nava.zip');
    expect(gitignore).toContain('.cursor/debug-*.log');
    expect(gitignore).toContain('.superpowers/sdd/');
  });

  describe('Task 5 HMS shadow ops lifecycle (DB-free)', () => {
    it('generic deploy/restart/boot keep HMS off and start default apps only', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');

      const deployEc2 = readFileSync(join(deploy, 'deploy-ec2.sh'), 'utf8');
      const opsRestart = readFileSync(join(deploy, 'ops-restart.sh'), 'utf8');
      const pm2Boot = readFileSync(join(deploy, 'pm2-boot.sh'), 'utf8');
      const opsDeploy = readFileSync(join(deploy, 'ops-deploy.sh'), 'utf8');

      for (const [name, script] of [
        ['deploy-ec2.sh', deployEc2],
        ['ops-restart.sh', opsRestart],
        ['pm2-boot.sh', pm2Boot],
      ] as const) {
        expect(script, name).toMatch(/pm2 delete hms-ai-worker|delete hms-ai-worker/);
        expect(script, `${name} must not sole-start hms via --only hms`).not.toMatch(
          /--only hms-ai-worker/,
        );
        expect(script, name).toMatch(/NAVA_BUILD_COMMIT/);
      }

      // Non-fixture start must not load full ecosystem (would start HMS).
      expect(deployEc2).toMatch(/--only http/);
      expect(deployEc2).toMatch(/--only ai-worker/);
      expect(deployEc2).not.toMatch(
        /pm2 start "\$\{SERVER_PILOT\}\/deploy\/pm2\.config\.cjs" --update-env\s*$/m,
      );
      expect(opsRestart).toMatch(/pm2 delete hms-ai-worker/);
      expect(opsDeploy).toContain('sync-ec2-git-bundle.sh');
    });

    it('ops-hms-shadow.sh is sole HMS starter with canary/start/status/stop', async () => {
      const { existsSync, readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const path = join(here, '..', 'deploy', 'ops-hms-shadow.sh');
      expect(existsSync(path)).toBe(true);
      const script = readFileSync(path, 'utf8');
      expect(script).toMatch(/canary|start|status|stop/);
      expect(script).toMatch(/hms-live-proof\.js/);
      expect(script).toMatch(/pm2 start.*hms-ai-worker|--only hms-ai-worker|hms-ai-worker/);
      expect(script).not.toMatch(/vitest|VITEST_ALLOW_PILOT_RDS/);
      // No raw candidate/thread/message argv passthrough.
      expect(script).not.toMatch(/\$\{2\}|--confirmation|--thread|--message/);
    });

    it('hms-ai-worker uses autorestart false and permanent failure quiesces', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const { loadPm2Config } = await import('../src/deploy/load-pm2-config.js');
      const here = dirname(fileURLToPath(import.meta.url));
      const pm2 = loadPm2Config();
      const hms = pm2.apps.find((app) => app.name === 'hms-ai-worker');
      expect(hms).toBeDefined();
      expect(hms?.autorestart).toBe(false);
      expect(hms?.env?.AI_WORKER_LANE).toBe('hms');
      expect(hms?.env?.HMS_READ_ROLE_PROOF_PATH).toBeDefined();
      expect(hms?.env?.NAVA_BUILD_COMMIT).toBeDefined();

      const proof = readFileSync(join(here, '..', 'src', 'ops', 'hms-live-proof.ts'), 'utf8');
      expect(proof).toMatch(/RUN_ISOLATION_BLOCKED/);
      expect(proof).toMatch(/NONTERMINAL_AI_RUN_STATES|nonterminal/);
    });

    it('install-hms-browser.sh uses /opt/nava bootstrap and exact revisions', async () => {
      const { existsSync, readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const path = join(here, '..', 'deploy', 'install-hms-browser.sh');
      expect(existsSync(path)).toBe(true);
      const script = readFileSync(path, 'utf8');
      expect(script).toMatch(/\/opt\/nava/);
      expect(script).toMatch(/1\.52\.0/);
      expect(script).toMatch(/1169/);
      expect(script).not.toMatch(/EXPECTED_FFMPEG_REV|FFMPEG_EXE/);
      expect(script).toMatch(/HMS_DEPENDENCIES_OK/);
      expect(script).toMatch(/headless|chromium/i);
      expect(script).toMatch(/recordVideo/);
      // Bare playwright install forbidden (must pin revision / path).
      expect(script).not.toMatch(/^\s*npx playwright install\s*$/m);
      expect(script).not.toMatch(/pnpm exec playwright install(?!\s+chromium)/);
    });

    it('post-boot and launch-readiness include conditional HMS checks', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');
      const postBoot = readFileSync(join(deploy, 'post-boot-smoke.sh'), 'utf8');
      const launch = readFileSync(join(deploy, 'launch-readiness.sh'), 'utf8');
      for (const [name, script] of [
        ['post-boot-smoke.sh', postBoot],
        ['launch-readiness.sh', launch],
      ] as const) {
        expect(script, name).toMatch(/hms-ai-worker|HMS_/);
        expect(script, name).toMatch(
          /hms-reservation-canary-proof|hms-reservation-shadow-proof|HMS_OFF|hms-ai-worker/,
        );
      }
    });

    it('write-ec2-env exports NAVA_BUILD_COMMIT and HMS role-proof path', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
      expect(script).toMatch(/NAVA_BUILD_COMMIT/);
      expect(script).toMatch(/HMS_READ_ROLE_PROOF_PATH/);
      expect(script).toMatch(/HMS_EXPECTED_PROPERTY_CODE|HRCEN/);
      expect(script).toMatch(/PLAYWRIGHT_BROWSERS_PATH.*\/opt\/nava\/ms-playwright/);
      const pm2 = readFileSync(join(here, '..', 'deploy', 'pm2.config.cjs'), 'utf8');
      expect(pm2).toMatch(/PLAYWRIGHT_BROWSERS_PATH.*\/opt\/nava\/ms-playwright/s);
    });

    it('pins patched asm-exec process replacement and evidence-key bootstrap wiring', async () => {
      const { createHash } = await import('node:crypto');
      const { existsSync, readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');
      const pin =
        '5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f';
      const asmPath = join(deploy, 'vendor', 'asm-exec');
      expect(existsSync(asmPath)).toBe(true);
      const asmBytes = readFileSync(asmPath);
      expect(createHash('sha256').update(asmBytes).digest('hex')).toBe(pin);
      const asmText = asmBytes.toString('utf8');
      expect(asmText).toMatch(/os\.execvpe\(args\[0\], args, os\.environ\.copy\(\)\)/);
      expect(asmText).not.toMatch(/result = subprocess\.run\(args\)/);
      expect(asmText).not.toMatch(/sys\.exit\(result\.returncode\)/);

      const provision = readFileSync(
        join(deploy, 'provision-hms-evidence-key.sh'),
        'utf8',
      );
      expect(provision).toMatch(/umask 077/);
      expect(provision).toMatch(/chmod 600/);
      expect(provision).toMatch(/create-secret|describe-secret/);
      expect(provision).toMatch(/hms-evidence-hmac\.env/);
      expect(provision).toMatch(/secretMetadataReady/);
      expect(provision).toMatch(/instanceMetadataInstalled/);
      expect(provision).toMatch(/asmExecPinned/);
      expect(provision).not.toMatch(/get-secret-value/);
      expect(provision).not.toMatch(/HMS_EVIDENCE_HMAC_KEY=/);
      expect(provision).toMatch(/NavaZeroSecretsRead/);
      expect(provision).toMatch(
        /nava-zero\/server-pilot\/hms-evidence-hmac-\*/,
      );

      const install = readFileSync(join(deploy, 'install-hms-browser.sh'), 'utf8');
      expect(install).toMatch(/\/usr\/local\/bin\/asm-exec/);
      expect(install).toMatch(new RegExp(pin));
      expect(install).toMatch(/install -o root -g root -m 0755/);
      expect(install).toMatch(/tr -d ['"]\\r['"]|tr -d ['"]\\\\r['"]/);

      const writer = readFileSync(join(deploy, 'write-ec2-env.sh'), 'utf8');
      expect(writer).toMatch(/HMS_EVIDENCE_HMAC_SECRET_ARN/);
      expect(writer).toMatch(/HMS_EVIDENCE_HMAC_KEY_VERSION/);
      expect(writer).toMatch(/hms-evidence-hmac\.env/);
      expect(writer).not.toMatch(/append_env HMS_EVIDENCE_HMAC_KEY(?!_VERSION)/);
      expect(writer).not.toMatch(/HMS_EVIDENCE_HMAC_KEY=/);

      const pm2 = readFileSync(join(deploy, 'pm2.config.cjs'), 'utf8');
      expect(pm2).toMatch(/\/usr\/local\/bin\/asm-exec/);
      expect(pm2).toMatch(/interpreter:\s*['"]none['"]/);
      expect(pm2).toMatch(
        /\{\{resolve:secretsmanager:nava-zero\/server-pilot\/hms-evidence-hmac\}\}/,
      );
      expect(pm2).toMatch(/\/usr\/bin\/env HMS_EVIDENCE_HMAC_KEY=/);
      expect(pm2).toMatch(/\/usr\/bin\/node dist\/ai\/worker\.js/);
      expect(pm2).toMatch(/HMS_EVIDENCE_HMAC_SECRET_ARN/);
      expect(pm2).toMatch(/HMS_EVIDENCE_HMAC_KEY_VERSION/);
      expect(pm2).not.toMatch(/HMS_EVIDENCE_HMAC_KEY:\s/);

      const awsResources = readFileSync(join(deploy, 'aws-resources.md'), 'utf8');
      expect(awsResources).toMatch(/hms-evidence-hmac-\*/);
      expect(awsResources).toMatch(/NavaZeroSecretsRead/);

      const opsProof = readFileSync(join(deploy, 'ops-hms-proof.sh'), 'utf8');
      expect(opsProof).toMatch(
        /doctor.*--tool|--tool.*hms_find_reservation|doctor \[/,
      );
      expect(opsProof).toMatch(/--action/);
      expect(opsProof).toMatch(/ASM_EXEC_SENTINEL_OK|asm-exec/);
    });
  });
});
