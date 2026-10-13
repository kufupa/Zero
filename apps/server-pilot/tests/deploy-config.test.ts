import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const CANONICAL_HOST = 'nava.legacyhotels.co.za';
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;
const CANONICAL_HOST_ENTRY = `127.0.0.1 ${CANONICAL_HOST}`;
const REMOTE_ALB_TARGET_PRIVATE_IP = '172.31.12.112';
const REMOTE_ADMIN_HOST = 'nava-admin.trynava.io';
const REMOTE_ALB_NAME = 'nava-remote-admin-alb';
const REMOTE_TARGET_GROUP_NAME = 'nava-remote-admin';
const REMOTE_TARGET_SECURITY_GROUP_NAME = 'nava-remote-admin-target';
const REMOTE_WAF_NAME = 'nava-remote-admin-waf';
const REMOTE_LOG_BUCKET = 'nava-zero-remote-alb-logs-845242190536-af-south-1';
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
    // Linux retains a killed orphan as a zombie until PID 1 reaps it. It
    // cannot run or write the marker; kill(pid, 0) alone reports it as alive.
    if (process.platform === 'linux') {
      const state = readFileSync(`/proc/${pid}/stat`, 'utf8').match(/\) ([A-Z]) /)?.[1];
      if (state === 'Z' || state === 'X') return false;
    }
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
const SG_THREE = 'sg-00112233445566778';
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
  networkInterfaces: [
    {
      id: 'eni-0123456789abcdef0',
      deviceIndex: 0,
      securityGroups: [{ GroupId: SG_ONE }, { GroupId: SG_TWO }],
      publicIpv4: null,
      ipv6: [],
    },
  ],
  publicIpv4: [],
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
  remoteAlb8443Only?: boolean;
  listenerSafe?: boolean;
};

type LaunchReadinessReport = {
  checks: Record<string, boolean>;
  observations: Record<string, unknown>;
};

type RemoteAdminReadinessFacts = {
  resourcesResolved: boolean;
  targetGroupConfigured: boolean;
  listenerDefault404: boolean;
  preRegistrationClean: boolean;
  hostForwardExact: boolean;
  targetHealthy: boolean;
  targetSecurityGroupOnlyAlb: boolean;
  noDirectPublicTargetPath: boolean;
  logBucketCompliant: boolean;
  wafCompliant: boolean;
};

const validRemoteAdminReadinessFacts = (): RemoteAdminReadinessFacts => ({
  resourcesResolved: true,
  targetGroupConfigured: true,
  listenerDefault404: true,
  preRegistrationClean: true,
  hostForwardExact: true,
  targetHealthy: true,
  targetSecurityGroupOnlyAlb: true,
  noDirectPublicTargetPath: true,
  logBucketCompliant: true,
  wafCompliant: true,
});

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
  | 'cleanup-exit'
  | 'target-ip'
  | 'legacy-only'
  | 'remote-only'
  | 'pane-mismatch'
  | 'index-mismatch'
  | 'asset-mismatch'
  | 'pm2-health'
  | 'healthy';
type NginxPriorState = 'absent' | 'present' | 'dangling';

async function runNginxActivation({
  scenario,
  priorState,
  rollbackCopyFails = false,
  ens5PrimaryIp = REMOTE_ALB_TARGET_PRIVATE_IP,
  priorRelease = false,
  stableOnlyChange = false,
}: {
  scenario: NginxActivationScenario;
  priorState: NginxPriorState;
  rollbackCopyFails?: boolean;
  ens5PrimaryIp?: string;
  priorRelease?: boolean;
  stableOnlyChange?: boolean;
}): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  site: string | null;
  candidate: string;
  priorCandidate: string | null;
  currentStable: string;
  priorStable: string | null;
  currentId: string;
  priorId: string;
  enabledState: 'absent' | 'valid' | 'dangling';
  enabledTarget: string | null;
  nginxCalls: number;
  reloadCalls: number;
  backupEntries: string[];
  backupContents: Record<string, string>;
}> {
  const {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
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
  const webRoot = join(tempDir, 'web');
  const index = '<!doctype html><script>window.paneTest = 1</script>';
  const stableAsset = 'm0 w lines rounded edges.svg';
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
    writeFileSync(
      join(deployDir, 'pane-csp-release.mjs'),
      readFileSync(join(here, '..', 'deploy', 'pane-csp-release.mjs'), 'utf8'),
    );
    function stageFixtureRelease(html: string, stable: string, label: string) {
      const seed = join(tempDir, `${label}-client`);
      mkdirSync(join(seed, 'assets'), { recursive: true });
      // The staged index carries the build id the page reads (root.tsx); the release script requires it.
      const withBuild = html.includes('name="nava-pane-build"')
        ? html
        : `<meta name="nava-pane-build" content="fixture-build-0001">${html}`;
      writeFileSync(join(seed, 'index.html'), withBuild);
      writeFileSync(join(seed, 'assets', stableAsset), stable);
      const identity = spawnSync(process.execPath, [join(deployDir, 'pane-csp-release.mjs'), 'id', seed], {
        encoding: 'utf8',
      });
      if (identity.status !== 0) throw new Error(`fixture release identity failed: ${identity.stderr}`);
      const id = identity.stdout.trim();
      const directory = join(webRoot, 'releases', id);
      mkdirSync(dirname(directory), { recursive: true });
      renameSync(seed, directory);
      return { id, directory, stable };
    }
    const current = stageFixtureRelease(index, '<svg>new stable asset</svg>', 'new');
    const releaseId = current.id;
    const releaseDir = current.directory;
    const template = readFileSync(
      join(here, '..', 'deploy', 'nginx.conf'),
      'utf8',
    );
    const fixtureTemplate =
      scenario === 'legacy-only'
        ? template.replaceAll(
            'server_name nava-admin.trynava.io;',
            'server_name absent-admin.example;',
          )
        : scenario === 'remote-only'
          ? template.replaceAll(
              'server_name nava.legacyhotels.co.za;',
              'server_name absent-mail.example;',
            )
          : template;
    writeFileSync(join(deployDir, 'nginx.conf'), fixtureTemplate);
    const candidate = fixtureTemplate
      .replaceAll('__NAVA_RELEASE_ID__', releaseId)
      .replaceAll('__NAVA_WEB_ROOT__', webRoot)
      .replaceAll('__NAVA_PANE_BUILD__', 'fixture-build-0001')
      .replace(
        '__NAVA_PANE_SCRIPT_HASHES__',
        `'sha256-${createHash('sha256').update('window.paneTest = 1').digest('base64')}'`,
      );
    const oldIndex = stableOnlyChange ? index : '<!doctype html><script>window.paneTest = 0</script>';
    const previous = priorRelease
      ? stageFixtureRelease(oldIndex, '<svg>old stable asset</svg>', 'old')
      : null;
    const oldId = previous?.id ?? '';
    const priorCandidate = priorRelease
      ? fixtureTemplate
          .replaceAll('__NAVA_RELEASE_ID__', oldId)
          .replaceAll('__NAVA_WEB_ROOT__', webRoot)
          .replaceAll('__NAVA_PANE_BUILD__', 'fixture-build-0001')
          .replace(
            '__NAVA_PANE_SCRIPT_HASHES__',
            `'sha256-${createHash('sha256').update(stableOnlyChange ? 'window.paneTest = 1' : 'window.paneTest = 0').digest('base64')}'`,
          )
      : null;
    writeFileSync(nginxCallsPath, '0', 'utf8');
    writeFileSync(reloadCallsPath, '0', 'utf8');
    if (priorState !== 'absent') {
      writeFileSync(sitePath, priorCandidate ?? previousSite, 'utf8');
      writeFileSync(enabledModelPath, previousTarget, 'utf8');
    }
    if (priorState === 'present') {
      writeFileSync(
        previousTargetPath,
        priorCandidate ?? 'previous enabled config\n',
        'utf8',
      );
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

ip() {
  case "$*" in
    "-4 -o addr show dev ens5 scope global primary")
      printf '2: ens5    inet %s/20 scope global ens5\\n' "$NGINX_TEST_ENS5_PRIMARY_IP"
      ;;
    *)
      command ip "$@"
      ;;
  esac
}
`;

    const probe =
      scenario === 'pane-mismatch'
        ? `sed -i "s/script-src 'self'/script-src 'self' 'unsafe-inline'/" "$NGINX_SRC"`
        : scenario === 'index-mismatch'
          ? 'printf %s "changed" >> "$RELEASE_DIR/index.html"'
          : scenario === 'asset-mismatch'
            ? `printf %s "tampered" >> "$RELEASE_DIR/assets/m0 w lines rounded edges.svg"`
          : '';
    const activation = nginxBlock.replace(
      'if command -v nginx >/dev/null 2>&1; then',
      `${probe}\nif command -v nginx >/dev/null 2>&1; then`,
    );
    const result = await runBash({
      input: `${harness}\n${activation}\nif [ "$NGINX_TEST_SCENARIO" = 'pm2-health' ]; then
  NGINX_FAILURE_CONTEXT='backend startup or health check failed'
  exit 91
fi
if [ "$NGINX_TEST_SCENARIO" = 'cleanup-exit' ] || [ "$NGINX_TEST_SCENARIO" = 'healthy' ]; then
  finalize_nginx_release
fi`,
      env: {
        ...process.env,
        SERVER_PILOT: toBashPath(serverPilot),
        WEB_ROOT: toBashPath(webRoot),
        RELEASE_DIR: toBashPath(releaseDir),
        PANE_RELEASE_HELPER: toBashPath(
          join(deployDir, 'pane-csp-release.mjs'),
        ),
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
        NGINX_TEST_ENS5_PRIMARY_IP: ens5PrimaryIp,
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
      candidate,
      priorCandidate,
      currentStable: readFileSync(join(releaseDir, 'assets', stableAsset), 'utf8'),
      priorStable: previous
        ? readFileSync(join(previous.directory, 'assets', stableAsset), 'utf8')
        : null,
      currentId: releaseId,
      priorId: oldId,
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
      backupContents: Object.fromEntries(
        readdirSync(backupDir)
          .filter((entry) => entry.startsWith('nava-nginx.'))
          .map((entry) => [entry, readFileSync(join(backupDir, entry), 'utf8')]),
      ),
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
    REMOTE_ADMIN_FACTS: '{}',
    REMOTE_ADMIN_MODE: '0',
    REMOTE_TARGET_HEALTH_REQUIRED: '0',
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
        listenerSafe: true,
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
        centurionActiveCategoryCount: 12,
        workflowCategoryMissingCount: 0,
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
  remoteAdminMode = false,
  remoteTargetHealthRequired = false,
  remoteAdminFacts = validRemoteAdminReadinessFacts(),
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
  remoteAdminMode?: boolean;
  remoteTargetHealthRequired?: boolean;
  remoteAdminFacts?: RemoteAdminReadinessFacts;
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
      REMOTE_ADMIN_MODE: remoteAdminMode ? '1' : '0',
      REMOTE_TARGET_HEALTH_REQUIRED: remoteTargetHealthRequired ? '1' : '0',
      REMOTE_ADMIN_FACTS: JSON.stringify(remoteAdminFacts),
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

async function runListenerCollection({
  tcp = [
    'LISTEN 0 511 0.0.0.0:443 0.0.0.0:*',
    'LISTEN 0 511 127.0.0.1:8788 0.0.0.0:*',
    'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:*',
    'LISTEN 0 511 172.31.12.112:8443 0.0.0.0:*',
  ].join('\n'),
  udp = '',
}: {
  tcp?: string;
  udp?: string;
} = {}): Promise<boolean | null> {
  const { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import(
    'node:fs',
  );
  const { tmpdir } = await import('node:os');
  const { delimiter, join } = await import('node:path');
  const tempDir = mkdtempSync(join(tmpdir(), 'nava-listener-collection-test-'));
  const stubDir = join(tempDir, 'bin');

  try {
    mkdirSync(stubDir);
    const ssPath = join(stubDir, 'ss');
    writeFileSync(
      ssPath,
      `#!/usr/bin/env bash
case "$*" in
  "-ltnH") printf '%s\\n' "\${LISTENER_TEST_TCP}" ;;
  "-lunH") printf '%s\\n' "\${LISTENER_TEST_UDP}" ;;
  *) exit 97 ;;
esac
`,
      'utf8',
    );
    chmodSync(ssPath, 0o755);
    const block = extractSourceBlock(
      await readLaunchReadiness(),
      'LISTENER_SAFE=false',
      'PM2_SUMMARY="$(',
    );
    const result = await runBash({
      input: `set -euo pipefail
${block}
printf 'LISTENER_SAFE=%s\\n' "$LISTENER_SAFE"
`,
      env: {
        ...process.env,
        PATH: `${toBashPath(stubDir)}${delimiter}${process.env.PATH ?? ''}`,
        LISTENER_TEST_TCP: tcp,
        LISTENER_TEST_UDP: udp,
      },
    });
    return result.stdout.match(/LISTENER_SAFE=(true|false)/)?.[1] === 'true';
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

type RemoteCollectorFacts = {
  resourcesResolved: boolean;
  targetHealthy: boolean;
  targetSecurityGroupOnlyAlb: boolean;
  noDirectPublicTargetPath: boolean;
  publicAddressPresence: { ipv4: boolean; ipv6: boolean };
  logBucketCompliant: boolean;
  wafCompliant: boolean;
};

function validRemoteCollectorResponses(): Record<string, unknown> {
  const albArn = 'arn:aws:elasticloadbalancing:af-south-1:845242190536:loadbalancer/app/nava-remote-admin-alb/test';
  const targetGroupArn =
    'arn:aws:elasticloadbalancing:af-south-1:845242190536:targetgroup/nava-remote-admin/test';
  const listenerArn =
    'arn:aws:elasticloadbalancing:af-south-1:845242190536:listener/app/nava-remote-admin-alb/test/test';
  const wafArn = 'arn:aws:wafv2:af-south-1:845242190536:regional/webacl/nava-remote-admin-waf/test';
  const expectedTargetIngress = {
    IpProtocol: 'tcp',
    FromPort: 8443,
    ToPort: 8443,
    UserIdGroupPairs: [{ GroupId: SG_ONE }],
    IpRanges: [],
    Ipv6Ranges: [],
    PrefixListIds: [],
  };
  const block = { Block: {} };
  const exactByteMatch = (field: 'UriPath' | 'Method', searchString: string) => ({
    ByteMatchStatement: {
      SearchString: searchString,
      FieldToMatch: { [field]: {} },
      TextTransformations: [{ Priority: 0, Type: 'NONE' }],
      PositionalConstraint: 'EXACTLY',
    },
  });

  return {
    alb: {
      LoadBalancers: [
        {
          LoadBalancerName: REMOTE_ALB_NAME,
          LoadBalancerArn: albArn,
          Scheme: 'internet-facing',
          Type: 'application',
          IpAddressType: 'ipv4',
          VpcId: 'vpc-0f078e17a5f0f8599',
          SecurityGroups: [SG_ONE],
          AvailabilityZones: [
            { SubnetId: 'subnet-0e6446aaaeaa8762e' },
            { SubnetId: 'subnet-094bf8643d98c22f6' },
          ],
        },
      ],
    },
    targetGroup: {
      TargetGroups: [
        {
          TargetGroupName: REMOTE_TARGET_GROUP_NAME,
          TargetGroupArn: targetGroupArn,
          Protocol: 'HTTP',
          Port: 8443,
          VpcId: 'vpc-0f078e17a5f0f8599',
          HealthCheckProtocol: 'HTTP',
          HealthCheckPath: '/health',
          Matcher: { HttpCode: '200' },
        },
      ],
    },
    targetAttributes: {
      Attributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
    },
    targetHealth: {
      TargetHealthDescriptions: [
        {
          Target: { Id: 'i-008f737974a9ba9b3', Port: 8443 },
          TargetHealth: { State: 'healthy' },
        },
      ],
    },
    listeners: {
      Listeners: [
        {
          ListenerArn: listenerArn,
          Protocol: 'HTTPS',
          Port: 443,
          DefaultActions: [
            { Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } },
          ],
        },
      ],
    },
    rules: { Rules: [] },
    albAttributes: {
      Attributes: [
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'access_logs.s3.bucket', Value: REMOTE_LOG_BUCKET },
        { Key: 'access_logs.s3.prefix', Value: '' },
      ],
    },
    targetSecurityGroup: {
      SecurityGroups: [
        {
          GroupId: SG_TWO,
          GroupName: REMOTE_TARGET_SECURITY_GROUP_NAME,
          VpcId: 'vpc-0f078e17a5f0f8599',
        },
      ],
    },
    albSecurityGroup: {
      SecurityGroups: [
        {
          GroupId: SG_ONE,
          GroupName: REMOTE_ALB_NAME,
          VpcId: 'vpc-0f078e17a5f0f8599',
          IpPermissions: [
            {
              IpProtocol: 'tcp',
              FromPort: 443,
              ToPort: 443,
              IpRanges: [{ CidrIp: '0.0.0.0/0' }],
              Ipv6Ranges: [],
              PrefixListIds: [],
              UserIdGroupPairs: [],
            },
          ],
          IpPermissionsEgress: [
            {
              IpProtocol: 'tcp',
              FromPort: 8443,
              ToPort: 8443,
              IpRanges: [],
              Ipv6Ranges: [],
              PrefixListIds: [],
              UserIdGroupPairs: [{ GroupId: SG_TWO }],
            },
          ],
        },
      ],
    },
    wafList: { WebACLs: [{ Name: REMOTE_WAF_NAME, Id: 'waf-test-id' }] },
    waf: {
      WebACL: {
        Name: REMOTE_WAF_NAME,
        Id: 'waf-test-id',
        ARN: wafArn,
        DefaultAction: { Allow: {} },
        Rules: [
          {
            Name: 'AWS-AmazonIpReputation',
            Priority: 10,
            OverrideAction: { None: {} },
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesAmazonIpReputationList',
              },
            },
          },
          {
            Name: 'AWS-Common',
            Priority: 20,
            OverrideAction: { None: {} },
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesCommonRuleSet',
              },
            },
          },
          {
            Name: 'AWS-KnownBadInputs',
            Priority: 30,
            OverrideAction: { None: {} },
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesKnownBadInputsRuleSet',
              },
            },
          },
          {
            Name: 'signin-25-per-5m',
            Priority: 40,
            Action: block,
            Statement: {
              RateBasedStatement: {
                Limit: 25,
                AggregateKeyType: 'IP',
                EvaluationWindowSec: 300,
                ScopeDownStatement: {
                  AndStatement: {
                    Statements: [
                      exactByteMatch('UriPath', 'L2FwaS9hdXRoL3NpZ24taW4vZW1haWw='),
                      exactByteMatch('Method', 'UE9TVA=='),
                    ],
                  },
                },
              },
            },
          },
          {
            Name: 'remote-plane-1000-per-5m',
            Priority: 50,
            Action: block,
            Statement: {
              RateBasedStatement: {
                Limit: 1000,
                AggregateKeyType: 'IP',
                EvaluationWindowSec: 300,
              },
            },
          },
        ],
      },
    },
    wafAssociation: { WebACL: { ARN: wafArn } },
    logEncryption: {
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    },
    logPublicAccess: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    },
    logOwnership: {
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    },
    logPolicy: {
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowAlbLogDeliveryWrite',
            Effect: 'Allow',
            Principal: { Service: 'logdelivery.elasticloadbalancing.amazonaws.com' },
            Action: 's3:PutObject',
            Resource: `arn:aws:s3:::${REMOTE_LOG_BUCKET}/AWSLogs/845242190536/*`,
            Condition: {
              ArnLike: { 'aws:SourceArn': albArn },
            },
          },
          {
            Sid: 'AllowAlbLogDeliveryLegacyWrite',
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::098369216593:root' },
            Action: 's3:PutObject',
            Resource: `arn:aws:s3:::${REMOTE_LOG_BUCKET}/AWSLogs/845242190536/*`,
          },
          {
            Sid: 'DenyInsecureTransport',
            Effect: 'Deny',
            Principal: '*',
            Action: 's3:*',
            Resource: [
              `arn:aws:s3:::${REMOTE_LOG_BUCKET}`,
              `arn:aws:s3:::${REMOTE_LOG_BUCKET}/*`,
            ],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          },
        ],
      }),
    },
    logLifecycle: { Rules: [{ Status: 'Enabled', Expiration: { Days: 365 } }] },
    instanceNetwork: {
      securityGroups: [{ GroupId: SG_THREE }, { GroupId: SG_TWO }],
      networkInterfaces: [
        {
          id: 'eni-remote-primary',
          deviceIndex: 0,
          securityGroups: [{ GroupId: SG_THREE }, { GroupId: SG_TWO }],
          publicIpv4: null,
          ipv6: [],
        },
      ],
      publicIpv4: [],
      ipv6: [],
    },
    securityGroups: [
      { id: SG_THREE, ingress: [] },
      { id: SG_TWO, ingress: [expectedTargetIngress] },
    ],
  };
}

async function runRemoteAdminPerimeterCollection(
  mutate: (responses: Record<string, any>) => void = () => {},
): Promise<{ status: number | null; stderr: string; facts: RemoteCollectorFacts | null }> {
  const { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import(
    'node:fs'
  );
  const { tmpdir } = await import('node:os');
  const { delimiter, join } = await import('node:path');
  const tempDir = mkdtempSync(join(tmpdir(), 'nava-remote-admin-perimeter-test-'));
  const stubDir = join(tempDir, 'bin');
  const responses = validRemoteCollectorResponses() as Record<string, any>;
  mutate(responses);

  try {
    mkdirSync(stubDir);
    const awsPath = join(stubDir, 'aws');
    writeFileSync(
      awsPath,
      `#!/usr/bin/env bash
case "$1 $2" in
  "elbv2 describe-load-balancers") printf '%s' "$REMOTE_TEST_ALB" ;;
  "elbv2 describe-target-groups") printf '%s' "$REMOTE_TEST_TARGET_GROUP" ;;
  "elbv2 describe-target-group-attributes") printf '%s' "$REMOTE_TEST_TARGET_ATTRIBUTES" ;;
  "elbv2 describe-target-health") printf '%s' "$REMOTE_TEST_TARGET_HEALTH" ;;
  "elbv2 describe-listeners") printf '%s' "$REMOTE_TEST_LISTENERS" ;;
  "elbv2 describe-rules") printf '%s' "$REMOTE_TEST_RULES" ;;
  "elbv2 describe-load-balancer-attributes") printf '%s' "$REMOTE_TEST_ALB_ATTRIBUTES" ;;
  "ec2 describe-security-groups")
    if [[ "$*" == *"--group-ids"* ]]; then
      printf '%s' "$REMOTE_TEST_ALB_SG"
    else
      printf '%s' "$REMOTE_TEST_TARGET_SG"
    fi
    ;;
  "wafv2 list-web-acls") printf '%s' "$REMOTE_TEST_WAF_LIST" ;;
  "wafv2 get-web-acl") printf '%s' "$REMOTE_TEST_WAF" ;;
  "wafv2 get-web-acl-for-resource") printf '%s' "$REMOTE_TEST_WAF_ASSOCIATION" ;;
  "s3api get-bucket-encryption") printf '%s' "$REMOTE_TEST_LOG_ENCRYPTION" ;;
  "s3api get-public-access-block") printf '%s' "$REMOTE_TEST_LOG_PUBLIC_ACCESS" ;;
  "s3api get-bucket-ownership-controls") printf '%s' "$REMOTE_TEST_LOG_OWNERSHIP" ;;
  "s3api get-bucket-policy") printf '%s' "$REMOTE_TEST_LOG_POLICY" ;;
  "s3api get-bucket-lifecycle-configuration") printf '%s' "$REMOTE_TEST_LOG_LIFECYCLE" ;;
  *) exit 97 ;;
esac
`,
      'utf8',
    );
    chmodSync(awsPath, 0o755);

    const source = await readLaunchReadiness();
    const collectionBlock = extractSourceBlock(
      source,
      "REMOTE_ADMIN_FACTS='{}'",
      'CLOUDWATCH_ALARM_COUNT=',
    );
    const result = await runBash({
      input: `set -euo pipefail
AWS_REGION=af-south-1
INSTANCE_ID=i-008f737974a9ba9b3
REMOTE_ADMIN_MODE=1
REMOTE_ALB_NAME=${REMOTE_ALB_NAME}
REMOTE_TARGET_GROUP_NAME=${REMOTE_TARGET_GROUP_NAME}
REMOTE_TARGET_SECURITY_GROUP_NAME=${REMOTE_TARGET_SECURITY_GROUP_NAME}
REMOTE_WAF_NAME=${REMOTE_WAF_NAME}
REMOTE_LOG_BUCKET=${REMOTE_LOG_BUCKET}
REMOTE_VPC_ID=vpc-0f078e17a5f0f8599
INSTANCE_NETWORK="$REMOTE_TEST_INSTANCE_NETWORK"
SG_STATE="$REMOTE_TEST_SECURITY_GROUPS"
${collectionBlock}
printf 'REMOTE_FACTS=%s\\n' "$REMOTE_ADMIN_FACTS"
`,
      env: {
        ...process.env,
        PATH: `${toBashPath(stubDir)}${delimiter}${process.env.PATH ?? ''}`,
        REMOTE_TEST_ALB: JSON.stringify(responses.alb),
        REMOTE_TEST_TARGET_GROUP: JSON.stringify(responses.targetGroup),
        REMOTE_TEST_TARGET_ATTRIBUTES: JSON.stringify(responses.targetAttributes),
        REMOTE_TEST_TARGET_HEALTH: JSON.stringify(responses.targetHealth),
        REMOTE_TEST_LISTENERS: JSON.stringify(responses.listeners),
        REMOTE_TEST_RULES: JSON.stringify(responses.rules),
        REMOTE_TEST_ALB_ATTRIBUTES: JSON.stringify(responses.albAttributes),
        REMOTE_TEST_TARGET_SG: JSON.stringify(responses.targetSecurityGroup),
        REMOTE_TEST_ALB_SG: JSON.stringify(responses.albSecurityGroup),
        REMOTE_TEST_WAF_LIST: JSON.stringify(responses.wafList),
        REMOTE_TEST_WAF: JSON.stringify(responses.waf),
        REMOTE_TEST_WAF_ASSOCIATION: JSON.stringify(responses.wafAssociation),
        REMOTE_TEST_LOG_ENCRYPTION: JSON.stringify(responses.logEncryption),
        REMOTE_TEST_LOG_PUBLIC_ACCESS: JSON.stringify(responses.logPublicAccess),
        REMOTE_TEST_LOG_OWNERSHIP: JSON.stringify(responses.logOwnership),
        REMOTE_TEST_LOG_POLICY: JSON.stringify(responses.logPolicy),
        REMOTE_TEST_LOG_LIFECYCLE: JSON.stringify(responses.logLifecycle),
        REMOTE_TEST_INSTANCE_NETWORK: JSON.stringify(responses.instanceNetwork),
        REMOTE_TEST_SECURITY_GROUPS: JSON.stringify(responses.securityGroups),
      },
    });
    const serialized = result.stdout.match(/REMOTE_FACTS=([^\r\n]+)/)?.[1];
    return {
      status: result.status,
      stderr: result.stderr,
      facts: serialized ? (JSON.parse(serialized) as RemoteCollectorFacts) : null,
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
    expect(nginx).toContain('try_files /releases/__NAVA_RELEASE_ID__$uri /index.html');
    expect(nginx).toContain('client_max_body_size 35m');
  });

  it('nginx keeps legacy ingress unchanged and exposes remote only through ALB :8443', async () => {
    const { readNginxConfig } = await import('../src/deploy/load-pm2-config.js');
    const nginx = readNginxConfig();
    const remoteListen = `listen ${REMOTE_ALB_TARGET_PRIVATE_IP}:8443`;
    const remoteDefaultStart = nginx.lastIndexOf(
      'server {',
      nginx.indexOf(`${remoteListen} default_server;`),
    );
    const remoteHealthStart = nginx.lastIndexOf(
      'server {',
      nginx.indexOf(`server_name ${REMOTE_ALB_TARGET_PRIVATE_IP};`),
    );
    const remoteAppStart = nginx.lastIndexOf(
      'server {',
      nginx.indexOf(`server_name ${REMOTE_ADMIN_HOST};`),
    );
    const legacyVhosts = nginx.slice(0, remoteDefaultStart);
    const remoteDefaultVhost = nginx.slice(remoteDefaultStart, remoteHealthStart);
    const remoteHealthVhost = nginx.slice(remoteHealthStart, remoteAppStart);
    const remoteAppVhost = nginx.slice(remoteAppStart);

    expect(remoteDefaultStart).toBeGreaterThanOrEqual(0);
    expect(remoteHealthStart).toBeGreaterThan(remoteDefaultStart);
    expect(remoteAppStart).toBeGreaterThan(remoteHealthStart);

    expect(legacyVhosts).toContain('listen 80 default_server');
    expect(legacyVhosts).toContain('listen 443 ssl default_server');
    expect(legacyVhosts).toContain(`server_name ${CANONICAL_HOST}`);
    expect(legacyVhosts).toContain(
      'ssl_certificate     /etc/nginx/ssl/nava.legacyhotels.co.za.fullchain.pem',
    );
    expect(legacyVhosts).toContain(
      'ssl_certificate_key /etc/nginx/ssl/nava.legacyhotels.co.za.key',
    );
    expect(legacyVhosts).toContain(`if ($host != ${CANONICAL_HOST})`);
    expect(legacyVhosts).toContain(
      "connect-src 'self' https://nava-zero-mail-845242190536-af-south-1.s3.af-south-1.amazonaws.com",
    );
    expect(legacyVhosts).toContain('proxy_pass http://127.0.0.1:8788/api/');
    expect(legacyVhosts).not.toContain(REMOTE_ADMIN_HOST);
    expect(legacyVhosts).not.toContain('127.0.0.1:8789/');

    expect(remoteDefaultVhost).toContain(`${remoteListen} default_server;`);
    expect(remoteDefaultVhost).toContain('server_name _;');
    expect(remoteDefaultVhost).toContain('return 444;');

    expect(remoteHealthVhost).toContain(`${remoteListen};`);
    expect(remoteHealthVhost).toContain(`server_name ${REMOTE_ALB_TARGET_PRIVATE_IP};`);
    expect(remoteHealthVhost).toContain(
      `if ($host != ${REMOTE_ALB_TARGET_PRIVATE_IP}) {`,
    );
    expect(remoteHealthVhost).toContain('location = /health {');
    expect(remoteHealthVhost).toContain(
      'proxy_pass http://127.0.0.1:8789/health;',
    );
    expect(remoteHealthVhost).not.toContain('proxy_pass http://127.0.0.1:8789/api/');
    expect(remoteHealthVhost).toContain('location / {');
    expect(remoteHealthVhost).toContain('return 444;');
    expect(remoteHealthVhost.indexOf('location = /health {')).toBeLessThan(
      remoteHealthVhost.indexOf('location / {'),
    );

    expect(remoteAppVhost).toContain(`${remoteListen};`);
    expect(remoteAppVhost).toContain(`server_name ${REMOTE_ADMIN_HOST};`);
    expect(remoteAppVhost).toContain(`if ($host != ${REMOTE_ADMIN_HOST}) {`);
    expect(remoteAppVhost).toContain('root __NAVA_WEB_ROOT__;');
    expect(remoteAppVhost).toContain('location = /health {');
    expect(remoteAppVhost).toContain('return 404;');
    expect(remoteAppVhost).toContain('proxy_pass http://127.0.0.1:8789/api/');
    expect(remoteAppVhost).toContain('proxy_set_header Host $host;');
    expect(remoteAppVhost).toContain(
      'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    );
    expect(remoteAppVhost).toContain('proxy_set_header X-Forwarded-Proto https;');
    expect(remoteAppVhost).toContain(
      'add_header X-Robots-Tag "noindex, nofollow, noarchive" always;',
    );
    for (const header of [
      'add_header Strict-Transport-Security',
      'add_header X-Frame-Options "DENY" always;',
      'add_header X-Content-Type-Options "nosniff" always;',
      'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
      'add_header Content-Security-Policy',
    ]) {
      expect(remoteAppVhost).toContain(header);
    }

    expect(
      nginx.match(
        new RegExp(
          `^\\s*listen ${REMOTE_ALB_TARGET_PRIVATE_IP.replaceAll('.', '\\.')}:8443(?:\\s+default_server)?;$`,
          'gm',
        ),
      ),
    ).toHaveLength(3);
    expect(nginx).not.toMatch(/^\s*listen 8443(?:\s+default_server)?;$/gm);
    expect(nginx.match(/^\s*ssl_certificate(?:_key)?\s+/gm)).toHaveLength(2);
    expect(nginx).not.toMatch(/listen\s+8443\s+ssl/);
    expect(remoteDefaultVhost).not.toMatch(/listen\s+(?:80|443)|ssl_certificate/);
    expect(remoteHealthVhost).not.toMatch(/listen\s+(?:80|443)|ssl_certificate/);
    expect(remoteAppVhost).not.toMatch(/listen\s+(?:80|443)|ssl_certificate/);
  });

  it('redirects host-local API mailto links before each API proxy', async () => {
    const { readNginxConfig } = await import('../src/deploy/load-pm2-config.js');
    const nginx = readNginxConfig();
    const legacyRedirect = nginx.indexOf('location = /api/mailto-handler {');
    const remoteRedirect = nginx.indexOf('location = /api/mailto-handler {', legacyRedirect + 1);
    const legacyApi = nginx.indexOf('proxy_pass http://127.0.0.1:8788/api/');
    const remoteApi = nginx.indexOf('proxy_pass http://127.0.0.1:8789/api/');

    expect(nginx).toContain('location = /api/mailto-handler {');
    expect(nginx).toContain('return 302 /mailto-handler$is_args$args;');
    expect(nginx.match(/location = \/api\/mailto-handler \{/g)).toHaveLength(2);
    expect(nginx.match(/proxy_pass http:\/\/127\.0\.0\.1:8788\/api\//g)).toHaveLength(1);
    expect(nginx.match(/proxy_pass http:\/\/127\.0\.0\.1:8789\/api\//g)).toHaveLength(1);
    expect(legacyRedirect).toBeLessThan(legacyApi);
    expect(remoteRedirect).toBeLessThan(remoteApi);
  });

  it('deploy-ec2.sh verifies fixed ALB target identity before candidate reload', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    const validator = deploy.match(
      /assert_remote_alb_target_private_ip\(\) \{([\s\S]*?)^\}/m,
    )?.[1];
    const activateNginx = deploy.match(/activate_nginx\(\) \{([\s\S]*?)^\}/m)?.[1];

    expect(deploy).toContain(
      `REMOTE_ALB_TARGET_PRIVATE_IP="${REMOTE_ALB_TARGET_PRIVATE_IP}"`,
    );
    expect(validator).toBeTruthy();
    expect(validator).toContain('ip -4 -o addr show dev ens5 scope global primary');
    expect(validator).toContain('REMOTE_ALB_TARGET_PRIVATE_IP');
    expect(activateNginx).toBeTruthy();
    expect(activateNginx.indexOf('assert_remote_alb_target_private_ip')).toBeGreaterThan(
      activateNginx.indexOf('sudo nginx -t'),
    );
    expect(activateNginx.indexOf('assert_remote_alb_target_private_ip')).toBeLessThan(
      activateNginx.indexOf('sudo systemctl reload nginx'),
    );
  });

  it('rolls back the Nginx candidate when primary ens5 does not own the ALB target IP', async () => {
    const result = await runNginxActivation({
      scenario: 'target-ip',
      priorState: 'present',
      ens5PrimaryIp: '172.31.12.113',
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      'remote ALB target private IP mismatch on primary ens5',
    );
    expect(result.site).toBe('previous nginx config\n');
    expect(result.enabledState).toBe('valid');
    expect(result.enabledTarget).toBe('../sites-available/previous-nava');
    expect(result.nginxCalls).toBe(2);
    expect(result.reloadCalls).toBe(1);
    expect(result.backupEntries).toEqual([]);
  });

  it('refuses a legacy-only Nginx candidate before install and leaves the prior site', async () => {
    const result = await runNginxActivation({
      scenario: 'legacy-only',
      priorState: 'present',
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('nginx dual-plane candidate missing');
    expect(result.stderr).toContain(
      'nginx candidate missing dual-plane contracts; prior site left untouched',
    );
    expect(result.site).toBe('previous nginx config\n');
    expect(result.enabledState).toBe('valid');
    expect(result.enabledTarget).toBe('../sites-available/previous-nava');
    expect(result.nginxCalls).toBe(0);
    expect(result.reloadCalls).toBe(0);
    expect(result.backupEntries).toEqual([]);
  });

  it('refuses a remote-only Nginx candidate before install and leaves the prior site', async () => {
    const result = await runNginxActivation({
      scenario: 'remote-only',
      priorState: 'present',
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('nginx dual-plane candidate missing');
    expect(result.stderr).toContain(
      'nginx candidate missing dual-plane contracts; prior site left untouched',
    );
    expect(result.site).toBe('previous nginx config\n');
    expect(result.enabledState).toBe('valid');
    expect(result.enabledTarget).toBe('../sites-available/previous-nava');
    expect(result.nginxCalls).toBe(0);
    expect(result.reloadCalls).toBe(0);
    expect(result.backupEntries).toEqual([]);
  });

  it.each(['pane-mismatch', 'index-mismatch', 'asset-mismatch'] as const)(
    'rejects %s before candidate publication and keeps the prior SPA/CSP pairing',
    async (scenario) => {
      const result = await runNginxActivation({
        scenario,
        priorState: 'present',
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/mismatch|release path/i);
      expect(result.site).toBe('previous nginx config\n');
      expect(result.enabledTarget).toBe('../sites-available/previous-nava');
      expect(result.backupEntries).toEqual([]);
    },
  );

  it.each(['validate', 'reload'] as const)(
    'keeps the old immutable index and its old hash policy paired after %s fails',
    async (scenario) => {
      const result = await runNginxActivation({
        scenario,
        priorState: 'present',
        priorRelease: true,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.priorCandidate).toBeTruthy();
      expect(result.site).toBe(result.priorCandidate);
      expect(result.site).not.toBe(result.candidate);
      expect(result.site).toContain("script-src 'self' 'sha256-");
      expect(result.site).toContain('releases/');
      expect(result.enabledState).toBe('valid');
      expect(result.enabledTarget).toBe('../sites-available/previous-nava');
      expect(result.backupEntries).toEqual([]);
    },
  );

  it.each(['validate', 'reload'] as const)(
    'retains the prior stable SVG on %s rollback despite the new release having the same index',
    async (scenario) => {
      const result = await runNginxActivation({
        scenario,
        priorState: 'present',
        priorRelease: true,
        stableOnlyChange: true,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.currentId).not.toBe(result.priorId);
      expect(result.site).toBe(result.priorCandidate);
      expect(result.site).toContain(`releases/${result.priorId}/index.html`);
      expect(result.site).toContain(`try_files /releases/${result.priorId}$uri /index.html;`);
      expect(result.site).not.toContain(`releases/${result.currentId}/index.html`);
      expect(result.priorStable).toBe('<svg>old stable asset</svg>');
      expect(result.currentStable).toBe('<svg>new stable asset</svg>');
      expect(result.enabledState).toBe('valid');
    },
  );

  it('deploy-ec2.sh asserts dual-plane Nginx contracts before activating the candidate', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    const assertor = deploy.match(
      /assert_dual_plane_nginx_candidate\(\) \{([\s\S]*?)^\}/m,
    )?.[1];
    const nginxBlock = deploy.slice(
      deploy.indexOf('echo "== nginx =="'),
      deploy.indexOf('if [ "$QUIESCED" = "1" ]; then'),
    );

    expect(assertor).toBeTruthy();
    expect(assertor).toContain('server_name nava.legacyhotels.co.za');
    expect(assertor).toContain('proxy_pass http://127.0.0.1:8788/api/');
    expect(assertor).toContain('server_name nava-admin.trynava.io');
    expect(assertor).toContain('proxy_pass http://127.0.0.1:8789/api/');
    expect(nginxBlock.indexOf('assert_dual_plane_nginx_candidate')).toBeGreaterThanOrEqual(
      0,
    );
    expect(nginxBlock.indexOf('assert_dual_plane_nginx_candidate')).toBeLessThan(
      nginxBlock.indexOf('NGINX_TRANSACTION_ACTIVE=1'),
    );
  });

  it('keeps legacy TLS local and remote-vhost probes private without TLS bypasses', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));

    for (const scriptName of ['deploy-ec2.sh', 'ops-restart.sh', 'post-boot-smoke.sh']) {
      const source = readFileSync(join(here, '..', 'deploy', scriptName), 'utf8');
      expect(source, scriptName).toContain('https://nava.legacyhotels.co.za');
      expect(source, scriptName).toContain('--resolve');
      expect(source, scriptName).toContain('nava-admin.trynava.io');
      expect(source, scriptName).toContain('--connect-to');
      expect(source, scriptName).toMatch(
        /-H "Host: (?:\$\{REMOTE_ADMIN_HOST\}|\$\{remote_host\}|nava-admin\.trynava\.io)"/,
      );
      expect(insecureCurlCommands(source), scriptName).toHaveLength(0);
    }
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

  it('keeps the previous web release when PM2 startup or health fails after Nginx activation', async () => {
    const result = await runNginxActivation({
      scenario: 'pm2-health', priorState: 'present', priorRelease: true,
    });
    expect(result.status, result.stderr).toBe(91);
    expect(result.stderr).toContain('backend startup or health check failed; restored previous config');
    expect(result.site).toBe(result.priorCandidate);
    expect(result.site).not.toBe(result.candidate);
    expect(result.enabledState).toBe('valid');
    expect(result.enabledTarget).toBe('../sites-available/previous-nava');
    expect(result.backupEntries).toEqual([]);
  });

  it('commits the matching new web release only after backend health succeeds', async () => {
    const result = await runNginxActivation({
      scenario: 'healthy', priorState: 'present', priorRelease: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.site).toBe(result.candidate);
    expect(result.enabledState).toBe('valid');
    expect(result.backupEntries).toEqual([]);
  });

  it('disarms rollback before cleaning up a successful activation', async () => {
    const result = await runNginxActivation({
      scenario: 'cleanup-exit',
      priorState: 'present',
    });

    expect(result.status).toBe(74);
    expect(result.stderr).not.toContain('restored previous config');
    expect(result.site).toBe(result.candidate);
    expect(result.enabledState).toBe('valid');
    expect(result.enabledTarget).toMatch(/\/sites-available\/nava-zero$/);
    expect(result.nginxCalls).toBe(1);
    expect(result.reloadCalls).toBe(1);
    expect(result.backupEntries).toEqual([]);
  });

  it('retains the recovery backup and reports its path when rollback fails', async () => {
    const result = await runNginxActivation({
      scenario: 'validate',
      priorState: 'present',
      rollbackCopyFails: true,
    });
    const backups = result.backupEntries.filter((entry) => entry.startsWith('nava-nginx.'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nginx candidate failed; rollback failed');
    expect(backups).toHaveLength(1);
    expect(result.backupContents[backups[0]]).toBe('previous nginx config\n');
    expect(result.stderr).toMatch(
      new RegExp(
        `nginx rollback failed; backup retained for manual recovery: .*/backups/${backups[0]}`,
      ),
    );
  });

  it('reports trap rollback failure and exits nonzero', async () => {
    const result = await runNginxActivation({
      scenario: 'unexpected-exit',
      priorState: 'present',
      rollbackCopyFails: true,
    });
    const backups = result.backupEntries.filter((entry) => entry.startsWith('nava-nginx.'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nginx transaction aborted; rollback failed');
    expect(backups).toHaveLength(1);
    expect(result.backupContents[backups[0]]).toBe('previous nginx config\n');
    expect(result.stderr).toMatch(
      new RegExp(
        `nginx rollback failed; backup retained for manual recovery: .*/backups/${backups[0]}`,
      ),
    );
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

  it('builds the production SPA host-neutrally', async () => {
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
      ': "${BETTER_AUTH_URL:?BETTER_AUTH_URL required for legacy HTTP}"',
    );
    expect(deploy).toContain('export VITE_PUBLIC_BACKEND_URL=""');
    expect(deploy).toContain('unset VITE_PUBLIC_APP_URL');
    expect(deploy).toContain('assert SPA did not bake undefined/api');
    expect(deploy).toContain('undefined/api/trpc');
    expect(deploy).not.toContain('export VITE_PUBLIC_APP_URL');
    expect(deploy.match(/pnpm --filter @zero\/mail build/g)).toHaveLength(1);
    expect(deploy).toContain('rsync -a --ignore-existing --chown=root:root');
    expect(deploy).not.toContain('rsync -a --delete');
    expect(deploy).toContain('WEB_ROOT}/downloads');
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

  it('write-ec2-env.sh persists QUOTE_WORKFLOW_LLM kill switch with Azure keys', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
    expect(script).toContain('append_env QUOTE_WORKFLOW_LLM');
    expect(script).toContain('append_env AZURE_OPENAI_BASE_URL');
  });

  it('write-ec2-env.sh persists GOTENBERG_URL for quote PDF convert', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
    expect(script).toContain('append_env GOTENBERG_URL');
    expect(script).toContain('GOTENBERG_URL:-http://127.0.0.1:3000');
  });

  it('gotenberg sidecar binds loopback, pins full Chromium/LibreOffice image, and never uses get.docker.com', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = join(here, '..', 'deploy');
    const compose = readFileSync(join(deploy, 'gotenberg.compose.yaml'), 'utf8');
    const install = readFileSync(join(deploy, 'install-gotenberg.sh'), 'utf8');
    const ops = readFileSync(join(deploy, 'ops-gotenberg.sh'), 'utf8');

    expect(compose).toMatch(/image: gotenberg\/gotenberg:8\.36\.0\s/);
    expect(compose).toContain('127.0.0.1:3000:3000');
    expect(compose).toContain('--api-timeout=60s');
    expect(compose).toContain('--libreoffice-auto-start=true');
    expect(compose).toContain('--libreoffice-start-timeout=60s');
    expect(compose).toContain('--api-download-from-deny-private-ips=true');
    expect(compose).toContain('--api-download-from-deny-public-ips=true');
    expect(compose).not.toMatch(/0\.0\.0\.0:3000/);

    expect(install).toContain('docker.io');
    expect(install).toContain('docker-compose-v2');
    expect(install).toContain('docker compose version');
    expect(install).toContain('127.0.0.1:3000');
    expect(install).toContain('GOTENBERG_URL');
    expect(install).toMatch(/4G|4096/);
    expect(install).not.toContain('get.docker.com');
    expect(install).not.toMatch(/usermod.*docker.*ubuntu/);
    expect(install).not.toMatch(/0\.0\.0\.0:3000/);
    expect(install).not.toMatch(/(?:^|[^-])-p ["']?3000:3000/);

    expect(ops).toContain('ssm-run-command.sh');
    expect(ops).toContain('install-gotenberg.sh');
    expect(ops).toContain('[ ! -f');
    expect(ops).toContain('deploy this commit first');
    expect(ops).not.toContain('get.docker.com');
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

  it('post-boot-smoke.sh checks both loopbacks, legacy :443, and private remote :8443', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const smoke = readFileSync(join(here, '..', 'deploy', 'post-boot-smoke.sh'), 'utf8');
    expect(smoke).toContain('127.0.0.1:8788/health');
    expect(smoke).toContain('127.0.0.1:8789/health');
    expect(smoke).toContain('BETTER_AUTH_URL');
    expect(smoke).toContain('CANONICAL_ORIGIN="https://nava.legacyhotels.co.za"');
    expect(smoke).toContain('--resolve "${PUBLIC_HOST}:443:127.0.0.1"');
    expect(smoke).toContain('REMOTE_ADMIN_HOST="nava-admin.trynava.io"');
    expect(smoke).toContain('--connect-to "${REMOTE_ADMIN_HOST}:8443:${REMOTE_ALB_TARGET_PRIVATE_IP}:8443"');
    expect(smoke).toContain('-H "Host: ${REMOTE_ADMIN_HOST}"');
    expect(smoke).not.toContain('https://nava-admin.trynava.io');
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
    expect(config.replace(/\r\n/g, '\n')).toContain(
      `const realMailGate = process.env.REAL_MAIL_UI_GATE === '1';

if (!realMailGate) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}`,
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
  }, 60_000);

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

  it('sync deploys main by default and creates its selected EC2 branch from the verified fetched ref', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const sync = readFileSync(
      join(here, '..', 'deploy', 'sync-ec2-git-bundle.sh'),
      'utf8',
    );

    expect(sync).toContain(': "${GIT_BRANCH:=main}"');
    expect(sync).toContain(': "${BUNDLE_KEY:=git-bundles/zero-${GIT_BRANCH}.bundle}"');
    expect(sync).toContain(
      'printf -v Q_BUNDLE_REF \'%q\' "refs/remotes/bundle/${GIT_BRANCH}"',
    );
    expect(sync).toContain(
      'printf -v Q_BUNDLE_REFSPEC \'%q\' "+refs/heads/${GIT_BRANCH}:refs/remotes/bundle/${GIT_BRANCH}"',
    );
    expect(sync).toContain(
      'git rev-parse --verify --quiet "$BUNDLE_COMMIT^{commit}"',
    );
    expect(sync).toContain(
      'git bundle create "$BUNDLE_FILE" "refs/heads/$GIT_BRANCH"',
    );
    expect(sync).toContain('git bundle list-heads "$BUNDLE_FILE"');
    expect(
      sync.indexOf('git bundle create "$BUNDLE_FILE" "refs/heads/$GIT_BRANCH"'),
    ).toBeLessThan(sync.indexOf('git bundle list-heads "$BUNDLE_FILE"'));
    expect(sync).not.toContain(
      'BUNDLE_COMMIT="$(git rev-parse --verify --quiet "refs/heads/$GIT_BRANCH^{commit}")"',
    );
    expect(sync).toContain(
      'printf -v Q_BUNDLE_COMMIT \'%q\' "$BUNDLE_COMMIT"',
    );
    expect(
      sync.match(/git fetch \$\{Q_REMOTE_BUNDLE\} \$\{Q_BUNDLE_REFSPEC\}/g),
    ).toHaveLength(2);
    expect(sync.match(/bundle commit mismatch/g)).toHaveLength(2);
    expect(
      sync.match(
        /git checkout -f -B \$\{Q_GIT_BRANCH\} \$\{Q_BUNDLE_COMMIT\}; git reset --hard \$\{Q_BUNDLE_COMMIT\}/g,
      ),
    ).toHaveLength(2);
    expect(sync).toContain('else git init ${Q_REPO_PATH}; cd ${Q_REPO_PATH};');
    expect(sync).not.toContain('git clone ${Q_REMOTE_BUNDLE}');
    expect(sync).not.toContain(
      'git checkout ${Q_GIT_BRANCH}; git reset --hard ${Q_BUNDLE_REF}',
    );
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

  it('runs remote-admin readiness on the operator host after remote SSM actions', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deployDir = join(here, '..', 'deploy');
    const readinessCommand =
      'REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 REMOTE_ADMIN_LIFECYCLE_MODE=auto bash "${SCRIPT_DIR}/launch-readiness.sh"';

    for (const scriptName of ['ops-deploy.sh', 'ops-restart.sh', 'ops-reboot.sh']) {
      const source = readFileSync(join(deployDir, scriptName), 'utf8');
      const marker = 'remote-admin lifecycle readiness';
      const start = source.indexOf(marker);
      expect(start, scriptName).toBeGreaterThanOrEqual(0);
      const section = source.slice(start, source.indexOf('\necho', start + marker.length));
      expect(section, scriptName).toContain(readinessCommand);
      expect(section, scriptName).not.toContain('ssm-run-command.sh');
      expect(section, scriptName).not.toContain('/home/ubuntu/repos/zero');
    }
  });

  it('passes collected remote perimeter facts into the readiness report builder', async () => {
    const readiness = await readLaunchReadiness();
    const reportBuilder = extractSourceBlock(
      readiness,
      'build_readiness_report() {',
      'REPORT_JSON="$(build_readiness_report)"',
    );

    expect(reportBuilder).toContain('REMOTE_ADMIN_FACTS="$REMOTE_ADMIN_FACTS" node -');
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

  it('defines remote-admin readiness contracts for legacy, pre-registration, and active target paths', async () => {
    const source = await readLaunchReadiness();
    for (const requiredFragment of [
      'REMOTE_ADMIN_MODE',
      'REMOTE_TARGET_HEALTH_REQUIRED',
      REMOTE_ALB_NAME,
      REMOTE_TARGET_GROUP_NAME,
      REMOTE_TARGET_SECURITY_GROUP_NAME,
      REMOTE_WAF_NAME,
      REMOTE_LOG_BUCKET,
      'aws elbv2 describe-load-balancers',
      'aws wafv2 get-web-acl',
      'aws s3api get-bucket-ownership-controls',
    ]) {
      expect(source.includes(requiredFragment), requiredFragment).toBe(true);
    }

    const legacy = await runLaunchReadinessReport();
    expect(legacy.checks.securityGroupIngressEmpty).toBe(true);

    const remoteInstanceNetwork = {
      securityGroups: [{ GroupId: SG_THREE }, { GroupId: SG_TWO }],
      networkInterfaces: [
        {
          id: 'eni-remote-primary',
          deviceIndex: 0,
          securityGroups: [{ GroupId: SG_THREE }, { GroupId: SG_TWO }],
          publicIpv4: null,
          ipv6: [],
        },
      ],
      publicIpv4: [],
      ipv6: [],
    };
    const remoteSecurityGroups = [
      { id: SG_THREE, ingress: [] },
      {
        id: SG_TWO,
        ingress: [
          {
            IpProtocol: 'tcp',
            FromPort: 8443,
            ToPort: 8443,
            UserIdGroupPairs: [{ GroupId: SG_ONE }],
          },
        ],
      },
    ];
    const preregistration = await runLaunchReadinessReport({
      remoteAdminMode: true,
      remoteTargetHealthRequired: false,
      firewall: { remoteAlb8443Only: true },
      cors: validCors([CANONICAL_ORIGIN, `https://${REMOTE_ADMIN_HOST}`]),
      instanceNetwork: remoteInstanceNetwork,
      securityGroups: remoteSecurityGroups,
      remoteAdminFacts: {
        ...validRemoteAdminReadinessFacts(),
        hostForwardExact: false,
        targetHealthy: false,
      },
    });
    expect(preregistration.checks).toMatchObject({
      remoteResourcesResolved: true,
      remoteListenerDefault404: true,
      remotePreRegistrationClean: true,
      remoteUfwAlb8443Only: true,
      s3CorsRemoteAdmin: true,
    });
    expect(preregistration.checks).not.toHaveProperty('securityGroupIngressEmpty');
    expect(preregistration.checks).not.toHaveProperty('remoteTargetHealthy');
    expect(preregistration.checks).not.toHaveProperty('remoteHostForwardExact');

    const remoteCorsWithPut = await runLaunchReadinessReport({
      remoteAdminMode: true,
      remoteTargetHealthRequired: false,
      firewall: { remoteAlb8443Only: true },
      cors: {
        CORSRules: [
          {
            ...validCors([CANONICAL_ORIGIN, `https://${REMOTE_ADMIN_HOST}`]).CORSRules[0],
            AllowedMethods: ['GET', 'HEAD', 'PUT'],
          },
        ],
      },
      instanceNetwork: remoteInstanceNetwork,
      securityGroups: remoteSecurityGroups,
    });
    expect(remoteCorsWithPut.checks.s3CorsRemoteAdmin).toBe(false);

    const remoteCorsWithSeparatePut = await runLaunchReadinessReport({
      remoteAdminMode: true,
      remoteTargetHealthRequired: false,
      firewall: { remoteAlb8443Only: true },
      cors: {
        CORSRules: [
          {
            ...validCors([CANONICAL_ORIGIN]).CORSRules[0],
            AllowedMethods: ['GET', 'HEAD', 'PUT'],
            ExposeHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length', 'ETag'],
          },
          {
            AllowedOrigins: [`https://${REMOTE_ADMIN_HOST}`],
            AllowedMethods: ['GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length'],
            MaxAgeSeconds: 300,
          },
          {
            AllowedOrigins: [`https://${REMOTE_ADMIN_HOST}`],
            AllowedMethods: ['PUT'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length', 'ETag'],
            MaxAgeSeconds: 300,
          },
        ],
      },
      instanceNetwork: remoteInstanceNetwork,
      securityGroups: remoteSecurityGroups,
      remoteAdminFacts: {
        ...validRemoteAdminReadinessFacts(),
        hostForwardExact: false,
        targetHealthy: false,
      },
    });
    expect(remoteCorsWithSeparatePut.checks.s3CorsRemoteAdmin).toBe(true);

    const preregistrationDirty = await runLaunchReadinessReport({
      remoteAdminMode: true,
      remoteTargetHealthRequired: false,
      firewall: { remoteAlb8443Only: true },
      cors: validCors([CANONICAL_ORIGIN, `https://${REMOTE_ADMIN_HOST}`]),
      instanceNetwork: remoteInstanceNetwork,
      securityGroups: remoteSecurityGroups,
      remoteAdminFacts: {
        ...validRemoteAdminReadinessFacts(),
        preRegistrationClean: false,
        hostForwardExact: false,
        targetHealthy: false,
      },
    });
    expect(preregistrationDirty.checks.remotePreRegistrationClean).toBe(false);

    const active = await runLaunchReadinessReport({
      remoteAdminMode: true,
      remoteTargetHealthRequired: true,
      firewall: { remoteAlb8443Only: true },
      cors: validCors([CANONICAL_ORIGIN, `https://${REMOTE_ADMIN_HOST}`]),
    });
    expect(active.checks).toMatchObject({
      remoteResourcesResolved: true,
      remoteTargetGroupConfigured: true,
      remoteListenerDefault404: true,
      remoteHostForwardExact: true,
      remoteTargetHealthy: true,
      remoteTargetSecurityGroupOnlyAlb: true,
      remoteNoDirectPublicTargetPath: true,
      remoteAlbLoggingCompliant: true,
      remoteWafCompliant: true,
    });
    expect(active.checks).not.toHaveProperty('remotePreRegistrationClean');

    const unhealthy = await runLaunchReadinessReport({
      remoteAdminMode: true,
      remoteTargetHealthRequired: true,
      firewall: { remoteAlb8443Only: true },
      cors: validCors([CANONICAL_ORIGIN, `https://${REMOTE_ADMIN_HOST}`]),
      remoteAdminFacts: {
        ...validRemoteAdminReadinessFacts(),
        targetHealthy: false,
      },
    });
    expect(unhealthy.checks.remoteTargetHealthy).toBe(false);
  });

  it('treats remote public-address assignment as sanitized observation', async () => {
    const addressPresent = await runRemoteAdminPerimeterCollection((responses) => {
      responses.instanceNetwork.publicIpv4 = ['198.51.100.23'];
      responses.instanceNetwork.ipv6 = ['2001:db8::23'];
    });

    expect(addressPresent.status, addressPresent.stderr).toBe(0);
    expect(addressPresent.facts).toMatchObject({
      targetSecurityGroupOnlyAlb: true,
      noDirectPublicTargetPath: true,
      publicAddressPresence: { ipv4: true, ipv6: true },
    });
    expect(JSON.stringify(addressPresent.facts)).not.toContain('198.51.100.23');
    expect(JSON.stringify(addressPresent.facts)).not.toContain('2001:db8::23');

    const readiness = await runLaunchReadinessReport({
      remoteAdminMode: true,
      firewall: { remoteAlb8443Only: true, listenerSafe: true },
      cors: validCors([CANONICAL_ORIGIN, `https://${REMOTE_ADMIN_HOST}`]),
      instanceNetwork: {
        securityGroups: [{ GroupId: SG_ONE }, { GroupId: SG_TWO }],
        networkInterfaces: [
          {
            id: 'eni-public-address',
            deviceIndex: 0,
            securityGroups: [{ GroupId: SG_ONE }, { GroupId: SG_TWO }],
            publicIpv4: '198.51.100.23',
            ipv6: ['2001:db8::23'],
          },
        ],
        publicIpv4: ['198.51.100.23'],
        ipv6: ['2001:db8::23'],
      },
    });
    expect(readiness.checks).not.toHaveProperty('instanceHasNoPublicIpv6');
    expect(readiness.checks.remoteListenerSafe).toBe(true);
    expect(readiness.observations.network).toEqual({
      publicAddressPresence: { ipv4: true, ipv6: true },
    });

    const exposedListener = await runLaunchReadinessReport({
      remoteAdminMode: true,
      firewall: { remoteAlb8443Only: true, listenerSafe: false },
      cors: validCors([CANONICAL_ORIGIN, `https://${REMOTE_ADMIN_HOST}`]),
      instanceNetwork: {
        securityGroups: [{ GroupId: SG_ONE }, { GroupId: SG_TWO }],
        networkInterfaces: [
          {
            id: 'eni-public-address',
            deviceIndex: 0,
            securityGroups: [{ GroupId: SG_ONE }, { GroupId: SG_TWO }],
            publicIpv4: '198.51.100.23',
            ipv6: ['2001:db8::23'],
          },
        ],
        publicIpv4: ['198.51.100.23'],
        ipv6: ['2001:db8::23'],
      },
    });
    expect(exposedListener.checks.remoteListenerSafe).toBe(false);
  }, 30_000);

  it('remote collector rejects broad ingress, wrong target identity, and unsafe WAF rules', async () => {
    const valid = await runRemoteAdminPerimeterCollection();
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.facts).toMatchObject({
      resourcesResolved: true,
      targetHealthy: true,
      targetSecurityGroupOnlyAlb: true,
      noDirectPublicTargetPath: true,
      logBucketCompliant: true,
      wafCompliant: true,
    });

    const allTrafficIngress = await runRemoteAdminPerimeterCollection((responses) => {
      responses.securityGroups[0].ingress.push({
        IpProtocol: '-1',
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
      });
    });
    expect(allTrafficIngress.facts?.targetSecurityGroupOnlyAlb).toBe(false);
    expect(allTrafficIngress.facts?.noDirectPublicTargetPath).toBe(false);

    const public443Ingress = await runRemoteAdminPerimeterCollection((responses) => {
      responses.securityGroups[0].ingress.push({
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
      });
    });
    expect(public443Ingress.facts?.targetSecurityGroupOnlyAlb).toBe(false);

    const wrongTarget = await runRemoteAdminPerimeterCollection((responses) => {
      responses.targetHealth.TargetHealthDescriptions[0].Target = {
        Id: 'i-00000000000000000',
        Port: 9443,
      };
    });
    expect(wrongTarget.facts?.targetHealthy).toBe(false);

    const countRateRule = await runRemoteAdminPerimeterCollection((responses) => {
      responses.waf.WebACL.Rules[3].Action = { Count: {} };
    });
    expect(countRateRule.facts?.wafCompliant).toBe(false);

    const swappedWafRules = await runRemoteAdminPerimeterCollection((responses) => {
      const rules = responses.waf.WebACL.Rules;
      [rules[0], rules[1]] = [rules[1], rules[0]];
    });
    expect(swappedWafRules.facts?.wafCompliant).toBe(false);

    const broadSigninScope = await runRemoteAdminPerimeterCollection((responses) => {
      responses.waf.WebACL.Rules[3].Statement.RateBasedStatement.ScopeDownStatement.AndStatement.Statements.push(
        {
          ByteMatchStatement: {
            SearchString: '/api/auth',
            FieldToMatch: { UriPath: {} },
            TextTransformations: [{ Priority: 0, Type: 'NONE' }],
            PositionalConstraint: 'STARTS_WITH',
          },
        },
      );
    });
    expect(broadSigninScope.facts?.wafCompliant).toBe(false);

    const lowercaseMethodTransform = await runRemoteAdminPerimeterCollection((responses) => {
      responses.waf.WebACL.Rules[3].Statement.RateBasedStatement.ScopeDownStatement.AndStatement.Statements[1]
        .ByteMatchStatement.TextTransformations = [{ Priority: 0, Type: 'LOWERCASE' }];
    });
    expect(lowercaseMethodTransform.facts?.wafCompliant).toBe(false);

    const dualstackAlb = await runRemoteAdminPerimeterCollection((responses) => {
      responses.alb.LoadBalancers[0].IpAddressType = 'dualstack';
    });
    expect(dualstackAlb.facts?.resourcesResolved).toBe(false);

    const broadAlbSecurityGroup = await runRemoteAdminPerimeterCollection((responses) => {
      responses.albSecurityGroup.SecurityGroups[0].IpPermissions.push({
        IpProtocol: '-1',
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
      });
    });
    expect(broadAlbSecurityGroup.facts?.resourcesResolved).toBe(false);

    const secondaryEniBroadIngress = await runRemoteAdminPerimeterCollection((responses) => {
      responses.instanceNetwork.networkInterfaces.push({
        id: 'eni-remote-secondary',
        deviceIndex: 1,
        securityGroups: [{ GroupId: SG_ONE }],
        publicIpv4: null,
        ipv6: [],
      });
      responses.securityGroups.push({
        id: SG_ONE,
        ingress: [
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            IpRanges: [{ CidrIp: '0.0.0.0/0' }],
          },
        ],
      });
    });
    expect(secondaryEniBroadIngress.facts?.targetSecurityGroupOnlyAlb).toBe(false);
    expect(secondaryEniBroadIngress.facts?.noDirectPublicTargetPath).toBe(false);
  }, 60_000);

  it('remote collector requires final ALB log policy and rejects stale source-account policy', async () => {
    const exactFinalPolicy = await runRemoteAdminPerimeterCollection();
    expect(exactFinalPolicy.status, exactFinalPolicy.stderr).toBe(0);
    expect(exactFinalPolicy.facts?.logBucketCompliant).toBe(true);

    const staleSourceAccountPolicy = await runRemoteAdminPerimeterCollection((responses) => {
      const policy = JSON.parse(responses.logPolicy.Policy);
      const [modernAllow, legacyAllow, tlsDeny] = policy.Statement;
      modernAllow.Condition = {
        StringEquals: { 'aws:SourceAccount': '845242190536' },
        ArnLike: modernAllow.Condition.ArnLike,
      };
      policy.Statement = [modernAllow, legacyAllow, tlsDeny];
      responses.logPolicy.Policy = JSON.stringify(policy);
    });
    expect(staleSourceAccountPolicy.status, staleSourceAccountPolicy.stderr).toBe(0);
    expect(staleSourceAccountPolicy.facts?.logBucketCompliant).toBe(false);
  }, 60_000);

  it('remote collector requires an empty ALB access-log prefix', async () => {
    const missingPrefix = await runRemoteAdminPerimeterCollection((responses) => {
      responses.albAttributes.Attributes = responses.albAttributes.Attributes.filter(
        (attribute: { Key: string }) => attribute.Key !== 'access_logs.s3.prefix',
      );
    });
    expect(missingPrefix.status, missingPrefix.stderr).toBe(0);
    expect(missingPrefix.facts?.logBucketCompliant).toBe(false);

    const nonemptyPrefix = await runRemoteAdminPerimeterCollection((responses) => {
      const prefix = responses.albAttributes.Attributes.find(
        (attribute: { Key: string }) => attribute.Key === 'access_logs.s3.prefix',
      );
      prefix.Value = 'unexpected-prefix';
    });
    expect(nonemptyPrefix.status, nonemptyPrefix.stderr).toBe(0);
    expect(nonemptyPrefix.facts?.logBucketCompliant).toBe(false);
  }, 60_000);

  it('remote collector rejects a broad ALB log-delivery resource', async () => {
    const broadResourcePolicy = await runRemoteAdminPerimeterCollection((responses) => {
      const policy = JSON.parse(responses.logPolicy.Policy);
      const [modernAllow, legacyAllow, tlsDeny] = policy.Statement;
      modernAllow.Resource = `arn:aws:s3:::${REMOTE_LOG_BUCKET}/*`;
      policy.Statement = [modernAllow, legacyAllow, tlsDeny];
      responses.logPolicy.Policy = JSON.stringify(policy);
    });

    expect(broadResourcePolicy.status, broadResourcePolicy.stderr).toBe(0);
    expect(broadResourcePolicy.facts?.logBucketCompliant).toBe(false);
  }, 60_000);

  it('remote collector rejects an extra ALB log-policy Allow statement', async () => {
    const extraAllowPolicy = await runRemoteAdminPerimeterCollection((responses) => {
      const policy = JSON.parse(responses.logPolicy.Policy);
      const [modernAllow] = policy.Statement;
      policy.Statement.push({
        ...modernAllow,
        Sid: 'AllowUnexpectedDuplicateLogDeliveryWrite',
      });
      responses.logPolicy.Policy = JSON.stringify(policy);
    });

    expect(extraAllowPolicy.status, extraAllowPolicy.stderr).toBe(0);
    expect(extraAllowPolicy.facts?.logBucketCompliant).toBe(false);
  }, 60_000);

  it('remote collector rejects an extra high-priority WAF Allow rule', async () => {
    const bypass = await runRemoteAdminPerimeterCollection((responses) => {
      responses.waf.WebACL.Rules.unshift({
        Name: 'bypass-all',
        Priority: 0,
        Action: { Allow: {} },
        Statement: {},
      });
    });

    expect(bypass.status, bypass.stderr).toBe(0);
    expect(bypass.facts?.wafCompliant).toBe(false);
  }, 60_000);

  it('remote collector rejects a non-Allow WAF default action', async () => {
    const defaultBlock = await runRemoteAdminPerimeterCollection((responses) => {
      responses.waf.WebACL.DefaultAction = { Block: {} };
    });

    expect(defaultBlock.status, defaultBlock.stderr).toBe(0);
    expect(defaultBlock.facts?.wafCompliant).toBe(false);
  }, 60_000);

  it('remote collector requires API Base64 WAF byte-match strings', async () => {
    const plaintextMethod = await runRemoteAdminPerimeterCollection((responses) => {
      responses.waf.WebACL.Rules[3].Statement.RateBasedStatement.ScopeDownStatement.AndStatement.Statements[1]
        .ByteMatchStatement.SearchString = 'POST';
    });

    expect(plaintextMethod.status, plaintextMethod.stderr).toBe(0);
    expect(plaintextMethod.facts?.wafCompliant).toBe(false);
  }, 60_000);

  it('documents gated, idempotent remote-admin edge provisioning without changing legacy access', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..', '..');
    const resources = readFileSync(join(here, '..', 'deploy', 'aws-resources.md'), 'utf8');
    const provisionerPath = join(here, '..', 'deploy', 'remote-edge-provisioner.sh');
    const statePath = join(here, '..', 'deploy', 'remote-edge-state.mjs');
    const provisioner = existsSync(provisionerPath)
      ? readFileSync(provisionerPath, 'utf8')
      : '';
    const state = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
    const readiness = readFileSync(join(here, '..', 'deploy', 'ops-deploy.sh'), 'utf8');
    const runbook = readFileSync(
      join(repoRoot, 'docs', 'runbooks', 'centurion-day-one-operations.md'),
      'utf8',
    );
    const companionPath = join(
      repoRoot,
      'docs',
      'solutions',
      'architecture-patterns',
      'nava-remote-admin-alb-companion.md',
    );
    const taskFourReportPath = join(
      repoRoot,
      'docs',
      'superpowers',
      'plans',
      'handoff-reports',
      'task-4-report.md',
    );

    for (const requiredFragment of [
      `REMOTE_ALB_NAME=${REMOTE_ALB_NAME}`,
      `REMOTE_TARGET_GROUP_NAME=${REMOTE_TARGET_GROUP_NAME}`,
      `REMOTE_TARGET_SECURITY_GROUP_NAME=${REMOTE_TARGET_SECURITY_GROUP_NAME}`,
      `REMOTE_WAF_NAME=${REMOTE_WAF_NAME}`,
      `REMOTE_LOG_BUCKET=${REMOTE_LOG_BUCKET}`,
      'aws acm request-certificate',
      'remote-edge-provisioner.sh inspect',
      'remote-edge-provisioner.sh apply-one --action ACTION',
      'launch-readiness.sh',
      'canonicalizeCorsRules',
      'PROVE_ALB_LOG_DELIVERY',
      'REMOTE_EDGE_LOG_PROOF_MAX_ATTEMPTS',
      'Name=vpc-id,Values=$VPC_ID',
      'const main = tables.find',
      'const table = explicit ?? main;',
      'PREFLIGHT_SCRATCH_DIR',
      'describe-network-interfaces',
      'globalEniIdentityAndGroupCorrespondenceConfirmed',
      'instanceNetworkInterfaceIds',
      'rm -rf -- "$PREFLIGHT_SCRATCH_DIR"',
      'CORS_SCRATCH_DIR',
      'CORS_EVIDENCE_DIR',
      'must not include `aws:SourceAccount`',
      'aws s3api put-bucket-cors',
    ]) {
      expect(resources.includes(requiredFragment), requiredFragment).toBe(true);
    }
    expect(resources).not.toMatch(
      />\s*"\$EVIDENCE_DIR\/(?:identity|instance|network-interfaces|subnets|routes|attached-security-groups|permission-simulation)\.json"/,
    );
    expect(resources).not.toMatch(
      /CORS_(?:BEFORE|INTENDED|APPLIED)="\$EVIDENCE_DIR\//,
    );
    const preflightProcedure = resources.slice(
      resources.indexOf('### Fixed names and preflight facts'),
      resources.indexOf('Lovable is already confirmed'),
    );
    expect(preflightProcedure).toContain('globalForInstance');
    expect(preflightProcedure).toContain('globalEniCorrespondence');
    expect(preflightProcedure).not.toContain('instance?.SecurityGroups');
    expect(existsSync(provisionerPath)).toBe(true);
    expect(existsSync(statePath)).toBe(true);
    expect(provisioner).toContain('collect_current');
    expect(provisioner).toContain('mutate_one');
    expect(provisioner).toContain('remote-edge: blocked');
    expect(state).toContain('STAGE_TABLE');
    expect(state).not.toContain('ACTION_BY_STAGE');
    expect(state).not.toContain('NEXT_STAGE_BY_STAGE');
    expect(state).toContain('PROVE_ALB_LOG_DELIVERY');
    expect(provisioner).toContain('prove_alb_log_delivery');
    expect(provisioner).toContain('wait_for_ssm_success');
    expect(resources).not.toContain('LOVABLE_DNS_CONTROL_CONFIRMED');
    expect(resources.includes('secretsmanager get-secret-value')).toBe(false);
    for (const requiredFragment of [
      'aws_file_uri()',
      'cygpath -w -- "$path"',
      '--secret-string "$(aws_file_uri "$SECRET_FILE")"',
      '--policy-document "$(aws_file_uri "$UPDATED_POLICY")"',
      '--cors-configuration "$(aws_file_uri "$CORS_INTENDED")"',
    ]) {
      expect(resources.includes(requiredFragment), requiredFragment).toBe(true);
    }
    expect(resources).not.toMatch(
      /(?:--secret-string|--policy-document|--cors-configuration)\s+"file:\/\/\$/,
    );
    expect(
      readiness.includes(
        'REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 REMOTE_ADMIN_LIFECYCLE_MODE=auto bash "${SCRIPT_DIR}/launch-readiness.sh"',
      ),
    ).toBe(true);
    expect(runbook.includes('Gate A')).toBe(true);
    expect(runbook.includes('ACM CNAME saved')).toBe(true);
    expect(existsSync(companionPath)).toBe(true);
    expect(existsSync(taskFourReportPath)).toBe(true);
    const companion = existsSync(companionPath) ? readFileSync(companionPath, 'utf8') : '';
    const taskFourReport = existsSync(taskFourReportPath)
      ? readFileSync(taskFourReportPath, 'utf8')
      : '';
    expect(companion).toContain('nava.legacyhotels.co.za');
    expect(companion).toContain('tun0:443');
    expect(companion).toContain('nava-admin.trynava.io');
    expect(companion).toContain(':8443');
    expect(companion).toContain('must not include `aws:SourceAccount`');
    expect(taskFourReport).toContain('must not include `aws:SourceAccount`');
    const provisionerProcedure = resources.slice(
      resources.indexOf('### Idempotent edge resources after Gate A'),
      resources.indexOf('### Gate B and Task 5 handoff'),
    );
    expect(provisionerProcedure).toContain('PROVE_ALB_LOG_DELIVERY');
    expect(provisionerProcedure).toContain('body-discarding');
    expect(provisionerProcedure).toContain('only boolean');
  });

  it('documents live-readback resume for current final unattached security-group prefix', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const resources = readFileSync(join(here, '..', 'deploy', 'aws-resources.md'), 'utf8');
    const provisioner = readFileSync(
      join(here, '..', 'deploy', 'remote-edge-provisioner.sh'),
      'utf8',
    );
    const state = readFileSync(
      join(here, '..', 'deploy', 'remote-edge-state.mjs'),
      'utf8',
    );
    const procedure = resources.slice(
      resources.indexOf('### Idempotent edge resources after Gate A'),
      resources.indexOf('### Gate B and Task 5 handoff'),
    );

    expect(procedure).toContain('SG_FINAL_UNATTACHED');
    expect(procedure).toContain('ATTACH_TARGET_SECURITY_GROUP');
    expect(provisioner).toContain('SG_FINAL_UNATTACHED)');
    expect(state).toContain("stage: 'SG_FINAL_UNATTACHED'");
    expect(state).toContain("action: 'ATTACH_TARGET_SECURITY_GROUP'");
    expect(state).toContain("next: 'TARGET_SG_ATTACHED'");
    expect(provisioner).not.toContain('--stage');
    expect(provisioner).not.toContain('--facts');
    expect(provisioner).not.toContain('--resume');
  });

  it('documents rejection of unknown and malformed remote edge partial states', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const resources = readFileSync(join(here, '..', 'deploy', 'aws-resources.md'), 'utf8');
    const provisioner = readFileSync(
      join(here, '..', 'deploy', 'remote-edge-provisioner.sh'),
      'utf8',
    );
    const state = readFileSync(
      join(here, '..', 'deploy', 'remote-edge-state.mjs'),
      'utf8',
    );
    const procedure = resources.slice(
      resources.indexOf('### Idempotent edge resources after Gate A'),
      resources.indexOf('### Gate B and Task 5 handoff'),
    );

    expect(procedure).toContain('fails closed');
    expect(procedure).toContain('duplicate names');
    expect(procedure).not.toContain('transition_security_group_prefix_once');
    expect(procedure).not.toContain('advance_remote_edge_once');
    expect(provisioner).toContain('state_bridge "$scratch" result');
    expect(provisioner).toContain('remote-edge: blocked');
    expect(state).toContain('exactKeys');
    expect(state).toContain('deriveFacts');
    expect(state).toContain('classifyFacts');
    expect(procedure).not.toContain('EDGE_REUSE_STATE');
  });

  it('documents one mutation and semantic readback for every remote edge prefix transition', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const provisioner = readFileSync(
      join(here, '..', 'deploy', 'remote-edge-provisioner.sh'),
      'utf8',
    );
    const state = readFileSync(
      join(here, '..', 'deploy', 'remote-edge-state.mjs'),
      'utf8',
    );
    const transitions = [
      ['FRESH', 'ALB_SG_CREATED'],
      ['ALB_SG_CREATED', 'SGS_CREATED'],
      ['SGS_CREATED', 'ALB_INGRESS_READY'],
      ['ALB_INGRESS_READY', 'ALB_EGRESS_REVOKED'],
      ['ALB_EGRESS_REVOKED', 'ALB_EGRESS_READY'],
      ['ALB_EGRESS_READY', 'SG_FINAL_UNATTACHED'],
      ['SG_FINAL_UNATTACHED', 'TARGET_SG_ATTACHED'],
      ['TARGET_SG_ATTACHED', 'TARGET_GROUP_CREATED'],
      ['TARGET_GROUP_CREATED', 'TARGET_GROUP_READY'],
      ['TARGET_GROUP_READY', 'ALB_CREATED'],
      ['ALB_CREATED', 'LOG_BUCKET_CREATED'],
      ['LOG_BUCKET_CREATED', 'LOG_BUCKET_PUBLIC_BLOCKED'],
      ['LOG_BUCKET_PUBLIC_BLOCKED', 'LOG_BUCKET_OWNERSHIP_ENFORCED'],
      ['LOG_BUCKET_OWNERSHIP_ENFORCED', 'LOG_BUCKET_ENCRYPTED'],
      ['LOG_BUCKET_ENCRYPTED', 'LOG_BUCKET_LIFECYCLE_READY'],
      ['LOG_BUCKET_LIFECYCLE_READY', 'LOG_BUCKET_POLICY_READY'],
      ['LOG_BUCKET_POLICY_READY', 'ALB_LOGGING_READY'],
      ['ALB_LOGGING_READY', 'WAF_CREATED'],
      ['WAF_CREATED', 'WAF_ASSOCIATED'],
      ['WAF_ASSOCIATED', 'LISTENER_FIXED_404'],
      ['LISTENER_FIXED_404', 'UFW_SUBNET_A_READY'],
      ['UFW_SUBNET_A_READY', 'UFW_READY'],
      ['UFW_READY', 'TASK4_PRE_GATE_B_READY'],
    ];

    for (const [from, to] of transitions) {
      expect(state, `${from} -> ${to}`).toMatch(
        new RegExp(`stage: '${from}'[\\s\\S]{0,200}next: '${to}'`),
      );
    }
    expect(provisioner).toContain('collect_current "$PRE_SCRATCH"');
    expect(provisioner).toContain(
      'PRE_STAGE="$(result_stage "$PRE_SCRATCH/result.json")" || die',
    );
    expect(provisioner).toContain('mutate_one "$PRE_STAGE" "$PRE_SCRATCH"');
    expect(provisioner).toContain('collect_current "$POST_SCRATCH"');
    expect(provisioner).toContain(
      'POST_STAGE="$(result_stage "$POST_SCRATCH/result.json")" || die',
    );
    expect(provisioner).toContain('state.validatePostMutationStage(');
    expect(provisioner).toMatch(
      /REMOTE_EDGE_STAGE="\$PRE_STAGE" REMOTE_EDGE_POST_STAGE="\$POST_STAGE" \\\s+state_bridge "\$POST_SCRATCH" post/,
    );
    expect(provisioner).not.toContain('[[ "$POST_STAGE" == "$EXPECTED_NEXT" ]]');
  });

  it('documents no early public exposure across provisioning transitions', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const provisioner = readFileSync(
      join(here, '..', 'deploy', 'remote-edge-provisioner.sh'),
      'utf8',
    );

    expect(provisioner).not.toContain('register-targets');
    expect(provisioner).not.toContain('create-rule');
    expect(provisioner).not.toContain('route53');
    expect(provisioner).not.toMatch(
      /create-listener[\s\S]{0,400}--protocol HTTP\s+--port 80/,
    );
    expect(provisioner).toContain('--protocol HTTPS --port 443');
    expect(provisioner).toContain('StatusCode=404');
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
  }, 60_000);

  it('launch readiness collects TCP and UDP listeners for the private target boundary', async () => {
    expect(await runListenerCollection()).toBe(true);

    for (const [tcp, udp] of [
      [
        [
          'LISTEN 0 511 0.0.0.0:443 0.0.0.0:*',
          'LISTEN 0 511 127.0.0.1:8788 0.0.0.0:*',
          'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:*',
          'LISTEN 0 511 0.0.0.0:8443 0.0.0.0:*',
        ].join('\n'),
        '',
      ],
      [
        [
          'LISTEN 0 511 0.0.0.0:443 0.0.0.0:*',
          'LISTEN 0 511 127.0.0.1:8788 0.0.0.0:*',
          'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:*',
          'LISTEN 0 511 [::]:8443 [::]:*',
        ].join('\n'),
        '',
      ],
      [
        [
          'LISTEN 0 511 0.0.0.0:443 0.0.0.0:*',
          'LISTEN 0 511 127.0.0.1:8788 0.0.0.0:*',
          'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:*',
          'LISTEN 0 511 172.31.12.112:8443 0.0.0.0:*',
        ].join('\n'),
        'UNCONN 0 0 172.31.12.112:8443 0.0.0.0:*',
      ],
    ] as const) {
      expect(await runListenerCollection({ tcp, udp })).toBe(false);
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

    const withPutAndEtag = await runLaunchReadinessReport({
      cors: {
        CORSRules: [
          {
            AllowedOrigins: [
              CANONICAL_ORIGIN,
              'http://localhost:3000',
              'https://localhost:3000',
            ],
            AllowedMethods: ['GET', 'HEAD', 'PUT'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length', 'ETag'],
            MaxAgeSeconds: 300,
          },
                 {
                   AllowedOrigins: [`https://${REMOTE_ADMIN_HOST}`],
                   AllowedMethods: ['GET', 'HEAD'],
                   AllowedHeaders: ['*'],
                   ExposeHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length'],
                   MaxAgeSeconds: 300,
                 },
                 {
                   AllowedOrigins: [`https://${REMOTE_ADMIN_HOST}`],
                   AllowedMethods: ['PUT'],
                   AllowedHeaders: ['*'],
                   ExposeHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length', 'ETag'],
                   MaxAgeSeconds: 300,
                 },
        ],
      },
    });
    expect(withPutAndEtag.checks.s3CorsCanonical).toBe(true);
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

  it('launch readiness enumerates every ENI and requires complete secondary-SG facts', async () => {
    const withSecondaryEni = {
      securityGroups: [{ GroupId: SG_ONE }],
      networkInterfaces: [
        {
          id: 'eni-primary',
          deviceIndex: 0,
          securityGroups: [{ GroupId: SG_ONE }],
          publicIpv4: null,
          ipv6: [],
        },
        {
          id: 'eni-secondary',
          deviceIndex: 1,
          securityGroups: [{ GroupId: SG_TWO }],
          publicIpv4: null,
          ipv6: [],
        },
      ],
      publicIpv4: [],
      ipv6: [],
    };
    const missingSecondary = await runLaunchReadinessReport({
      instanceNetwork: withSecondaryEni,
      securityGroups: [{ id: SG_ONE, ingress: [] }],
    });
    expect(missingSecondary.checks.securityGroupIngressEmpty).toBe(false);

    const collected = await runAwsPerimeterCollection({
      instanceNetwork: withSecondaryEni,
      securityGroups: [
        { id: SG_ONE, ingress: [] },
        {
          id: SG_TWO,
          ingress: [
            {
              IpProtocol: 'tcp',
              FromPort: 443,
              ToPort: 443,
              IpRanges: [{ CidrIp: '0.0.0.0/0' }],
            },
          ],
        },
      ],
    });
    expect(collected.securityGroupArgs).toContain(SG_TWO);
    expect(collected.report?.checks.securityGroupIngressEmpty).toBe(false);
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
        networkInterfaces: [
          {
            id: 'eni-public-ipv6',
            deviceIndex: 0,
            securityGroups: [{ GroupId: SG_ONE }],
            publicIpv4: null,
            ipv6: ['2001:db8::1'],
          },
        ],
        publicIpv4: [],
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
    expect(script).toContain('workflowCategoryMissingCount');
    expect(script).toContain('workflowCategoriesComplete');
    expect(script).toContain("centurionActiveCategoryCount === 12");
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
    expect(script).not.toMatch(/(?:^|\n)\s*(?:source|\.)\s+/m);
    expect(script).not.toContain('ENV_FILE');
    expect(script).not.toContain('.env.production');
    expect(script.replace(/\r\n/g, '\n')).toMatch(
      /set -euo pipefail\s*\n(?:\s*#[^\n]*\n)*\s*unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_OPTIONS DOTENV_CONFIG_PATH/,
    );
    expect(script).not.toMatch(/grep[^\n]*UNDO_SEND_SECONDS/);
    expect(script).toContain(
      'UNDO_VAL="${UNDO_SEND_SECONDS:?UNDO_SEND_SECONDS must be explicitly set by operator}"',
    );
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
      const vendorPin =
        '5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f';
      const installedPin =
        '81fd29e1f039209282bc8cbe482cda033d331f07284533a46f990368228a7e65';
      const asmPath = join(deploy, 'vendor', 'asm-exec');
      expect(existsSync(asmPath)).toBe(true);
      const asmBytes = readFileSync(asmPath);
      expect(createHash('sha256').update(asmBytes).digest('hex')).toBe(vendorPin);
      const lfBytes = Buffer.from(asmBytes.filter((byte) => byte !== 0x0d));
      expect(createHash('sha256').update(lfBytes).digest('hex')).toBe(installedPin);
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
      expect(provision).toMatch(/ASM_EXEC_INSTALLED_SHA256/);
      expect(provision).toMatch(new RegExp(vendorPin));
      expect(provision).toMatch(new RegExp(installedPin));
      expect(provision).toMatch(/INSTALLED_PIN.*\/usr\/local\/bin\/asm-exec/);

      const install = readFileSync(join(deploy, 'install-hms-browser.sh'), 'utf8');
      expect(install).toMatch(/\/usr\/local\/bin\/asm-exec/);
      expect(install).toMatch(new RegExp(vendorPin));
      expect(install).toMatch(new RegExp(installedPin));
      expect(install).toMatch(/ASM_EXEC_INSTALLED_SHA256/);
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
      expect(awsResources).toMatch(/ASM_EXEC_INSTALLED_SHA256|installed LF/);
      expect(awsResources).toMatch(new RegExp(vendorPin));
      expect(awsResources).toMatch(new RegExp(installedPin));

      const opsProof = readFileSync(join(deploy, 'ops-hms-proof.sh'), 'utf8');
      expect(opsProof).toMatch(
        /doctor.*--tool|--tool.*hms_find_reservation|doctor \[/,
      );
      expect(opsProof).toMatch(/--action/);
      expect(opsProof).toMatch(/ASM_EXEC_SENTINEL_OK|asm-exec/);
      expect(opsProof).toMatch(/ASM_EXEC_INSTALLED_SHA256/);
      expect(opsProof).toMatch(new RegExp(installedPin));
      expect(opsProof).toMatch(/INSTALLED_PIN.*\/usr\/local\/bin\/asm-exec/);
      // Task 12: shared local-operator envelope; no PHASE_B_BLOCKED; resume grammar.
      expect(opsProof).toMatch(/local-operator|phase-b-operation/);
      expect(opsProof).toMatch(/--resume/);
      expect(opsProof).not.toMatch(/PHASE_B_BLOCKED/);
      expect(opsProof).toMatch(/phase_b_local_operator|phase_b_parse/);
    });

    it('Task 13: active registry env + source/registry CAS markers', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');

      const pm2 = readFileSync(join(deploy, 'pm2.config.cjs'), 'utf8');
      expect(pm2).toMatch(/HMS_ACTIVE_REGISTRY_PATH/);
      expect(pm2).toMatch(/HMS_RELEASE_ROOT/);
      expect(pm2).toMatch(/hms-active-registry\/active\.json/);

      const sync = readFileSync(join(deploy, 'sync-ec2-git-bundle.sh'), 'utf8');
      expect(sync).toMatch(/before_source_switch/);
      expect(sync).toMatch(/after_registry_rename/);
      expect(sync).toMatch(/exit 20|incomplete restore/i);
      expect(sync).toMatch(/source-registry-cas|runSourceRegistryTransaction/);

      const opsDeploy = readFileSync(join(deploy, 'ops-deploy.sh'), 'utf8');
      expect(opsDeploy).toMatch(/source\+registry CAS|source-registry-transaction/);
      expect(opsDeploy).toMatch(/exit 20/);
      expect(opsDeploy).toMatch(/before_pm2_restart|after_health_verdict/);
      expect(opsDeploy).toMatch(/source-registry-cas\.sh/);
      expect(opsDeploy).toMatch(/HMS_REGISTRY_CANDIDATE/);

      const deployEc2 = readFileSync(join(deploy, 'deploy-ec2.sh'), 'utf8');
      expect(deployEc2).toMatch(/source-registry-transaction|registry-candidate|exit 20/);
      expect(deployEc2).toMatch(/source-registry-cas\.sh/);

      const casSh = readFileSync(join(deploy, 'source-registry-cas.sh'), 'utf8');
      expect(casSh).toMatch(/run-source-registry-cas/);
      expect(casSh).toMatch(/exit 20/);
      expect(casSh).toMatch(/HMS_REGISTRY_CANDIDATE/);
    });
  });

  describe('Task 2 remote HTTP lifecycle (DB-free)', () => {
    it('defines isolated legacy and remote HTTP forks with fixed auth profiles', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const { resolveDatabasePoolMax } = await import('../src/lib/auth-profile.js');
      const here = dirname(fileURLToPath(import.meta.url));
      const pm2 = readFileSync(join(here, '..', 'deploy', 'pm2.config.cjs'), 'utf8');

      expect(pm2).toMatch(
        /name:\s*['"]http['"][\s\S]*?script:\s*['"]dist\/main\.js['"][\s\S]*?PORT:\s*['"]8788['"][\s\S]*?NAVA_AUTH_SESSION_PROFILE:\s*['"]legacy['"]/,
      );
      expect(pm2).toMatch(
        /name:\s*['"]remote-http['"][\s\S]*?script:\s*['"]dist\/main\.js['"][\s\S]*?PORT:\s*['"]8789['"][\s\S]*?NAVA_AUTH_SESSION_PROFILE:\s*['"]remote['"]/,
      );
      expect(pm2).toMatch(
        /name:\s*['"]remote-http['"][\s\S]*?instances:\s*1[\s\S]*?exec_mode:\s*['"]fork['"]/,
      );
      const remoteStart = pm2.indexOf("name: 'remote-http'");
      const nextProcess = pm2.indexOf("name: 'worker'", remoteStart);
      const remoteProcess = pm2.slice(remoteStart, nextProcess);
      expect(remoteProcess).not.toContain('dist/mail/ingest/worker.js');
      expect(remoteProcess).not.toContain('dist/ai/worker.js');
      expect(resolveDatabasePoolMax('legacy')).toBe(10);
      expect(resolveDatabasePoolMax('remote')).toBe(3);
    });

    it('allows remote HTTP to start without POP3 runtime values', async () => {
      const { parseEnv } = await import('../src/env.js');

      const env = parseEnv({
        NODE_ENV: 'production',
        PORT: '8789',
        DATABASE_URL: 'postgres://example.invalid/zero',
        BETTER_AUTH_URL: 'https://nava-admin.trynava.io',
        BETTER_AUTH_SECRET: 'remote-signing-secret',
        AWS_REGION: 'af-south-1',
        S3_BUCKET: 'nava-test-bucket',
      });

      expect(env.POP3_POLL_INTERVAL_MS).toBe(30_000);
      expect(env.POP3_MAX_MESSAGES_PER_CYCLE).toBe(500);
    });

    it('bootstraps remote env as ubuntu without root checkout execution', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');
      const opsDeploy = readFileSync(join(deploy, 'ops-deploy.sh'), 'utf8');
      const writer = readFileSync(join(deploy, 'write-ec2-remote-env.sh'), 'utf8');
      const ubuntuGuard = writer.indexOf('write-ec2-remote-env.sh must run as ubuntu');
      const modeDispatch = writer.indexOf('case "${1:-}" in');

      expect(opsDeploy).toContain('bash apps/server-pilot/deploy/write-ec2-remote-env.sh;');
      expect(opsDeploy).not.toContain(
        'sudo -n bash apps/server-pilot/deploy/write-ec2-remote-env.sh;',
      );
      expect(ubuntuGuard).toBeGreaterThanOrEqual(0);
      expect(ubuntuGuard).toBeLessThan(modeDispatch);
      expect(writer).toMatch(
        /if \[ "\$\(id -un\)" != "ubuntu" \]; then\s+echo "write-ec2-remote-env\.sh must run as ubuntu" >&2\s+exit 2\s+fi/,
      );
      expect(writer).not.toMatch(/\b(?:sudo|chown)\b/);
      expect(writer).not.toMatch(/\binstall\s+-d\b/);
    });

    it('requires exact Ubuntu-owned 0600 legacy metadata before parsing', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const writer = readFileSync(
        join(here, '..', 'deploy', 'write-ec2-remote-env.sh'),
        'utf8',
      );
      const legacyFileGuard = writer.indexOf('legacy runtime env missing or unsafe');
      const legacyMetadataGuard = writer.indexOf(
        'legacy runtime env must be ubuntu-owned mode 0600',
      );
      const parser = writer.indexOf('parse-ec2-legacy-env.mjs');

      expect(writer).toMatch(
        /if \[ ! -f "\$LEGACY_ENV_FILE" \] \|\| \[ -L "\$LEGACY_ENV_FILE" \]; then/,
      );
      expect(writer).toMatch(
        /if \[ "\$\(stat -c '%a:%U:%G' "\$LEGACY_ENV_FILE"\)" != "600:ubuntu:ubuntu" \]; then/,
      );
      expect(legacyMetadataGuard).toBeGreaterThan(legacyFileGuard);
      expect(parser).toBeGreaterThan(legacyMetadataGuard);
    });

    it('executes remote writer identity, metadata, and raw-secret gates', async () => {
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
      const { delimiter, dirname, join } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const here = dirname(fileURLToPath(import.meta.url));
      const writer = join(here, '..', 'deploy', 'write-ec2-remote-env.sh');
      const tempDir = mkdtempSync(join(tmpdir(), 'nava-remote-env-writer-test-'));
      const repoRoot = join(tempDir, 'repo');
      const serverPilot = join(repoRoot, 'apps', 'server-pilot');
      const legacyEnv = join(serverPilot, '.env.production');
      const stubDir = join(tempDir, 'bin');
      const awsMarker = join(tempDir, 'aws-called');

      try {
        mkdirSync(serverPilot, { recursive: true });
        mkdirSync(stubDir);
        writeFileSync(
          legacyEnv,
          [
            "NODE_ENV='production'",
            "DATABASE_URL='postgres://example.invalid/zero'",
            "AWS_REGION='af-south-1'",
            "S3_BUCKET='nava-test-bucket'",
            '',
          ].join('\n'),
          'utf8',
        );

        const idPath = join(stubDir, 'id');
        writeFileSync(idPath, '#!/usr/bin/env bash\nprintf "%s\\n" "$FAKE_ID_USER"\n', 'utf8');
        chmodSync(idPath, 0o755);

        const statPath = join(stubDir, 'stat');
        writeFileSync(
          statPath,
          `#!/usr/bin/env bash
if [ "$3" = "$FAKE_LEGACY_ENV" ]; then
  printf '%s\\n' "$FAKE_LEGACY_METADATA"
else
  printf '%s\\n' '600:ubuntu:ubuntu'
fi
`,
          'utf8',
        );
        chmodSync(statPath, 0o755);

        const awsPath = join(stubDir, 'aws');
        writeFileSync(
          awsPath,
          `#!/usr/bin/env bash
printf 'called\\n' >"$FAKE_AWS_MARKER"
printf '%s' "$FAKE_AWS_SECRET_JSON"
`,
          'utf8',
        );
        chmodSync(awsPath, 0o755);

        const runWriter = async ({
          user = 'ubuntu',
          metadata = '600:ubuntu:ubuntu',
          secret = 'remote-signing-secret',
        }: {
          user?: string;
          metadata?: string;
          secret?: string;
        } = {}) => {
          rmSync(awsMarker, { force: true });
          return runBash({
            args: [toBashPath(writer)],
            env: {
              ...process.env,
              PATH: `${toBashPath(stubDir)}${delimiter}${process.env.PATH ?? ''}`,
              REPO_ROOT: toBashPath(repoRoot),
              FAKE_ID_USER: user,
              FAKE_LEGACY_ENV: toBashPath(legacyEnv),
              FAKE_LEGACY_METADATA: metadata,
              FAKE_AWS_MARKER: toBashPath(awsMarker),
              FAKE_AWS_SECRET_JSON: JSON.stringify({ BETTER_AUTH_SECRET: secret }),
            },
          });
        };

        const root = await runWriter({ user: 'root' });
        expect(root.status).toBe(2);
        expect(root.stderr).toContain('must run as ubuntu');
        expect(existsSync(awsMarker)).toBe(false);

        const wrongMetadata = await runWriter({ metadata: '644:ubuntu:ubuntu' });
        expect(wrongMetadata.status).toBe(2);
        expect(wrongMetadata.stderr).toContain('must be ubuntu-owned mode 0600');
        expect(existsSync(awsMarker)).toBe(false);

        const valid = await runWriter();
        expect(existsSync(awsMarker)).toBe(true);
        if (process.platform === 'win32') {
          // Windows temp volumes reject the production fsync syscall after every gate ran.
          expect(valid.status).toBe(1);
          expect(valid.stderr).toContain('fsync');
        } else {
          expect(valid.status, valid.stderr).toBe(0);
          expect(readFileSync(join(serverPilot, '.env.remote-common'), 'utf8')).toContain(
            "DATABASE_URL='postgres://example.invalid/zero'",
          );
        }

        const rawNul = await runWriter({ secret: 'nonblank\0nul' });
        expect(rawNul.status).toBe(2);
        expect(rawNul.stderr).toContain('remote auth secret is missing or malformed');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }, 30_000);

    it('treats the legacy runtime file as data, never shell input', async () => {
      const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import(
        'node:fs'
      );
      const { spawnSync } = await import('node:child_process');
      const { tmpdir } = await import('node:os');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');
      const writer = readFileSync(join(deploy, 'write-ec2-remote-env.sh'), 'utf8');
      const parser = join(deploy, 'parse-ec2-legacy-env.mjs');

      expect(writer).not.toMatch(/^\s*(?:source|\.)\s+"\$LEGACY_ENV_FILE"/m);
      expect(existsSync(parser)).toBe(true);

      const tempDir = mkdtempSync(join(tmpdir(), 'nava-legacy-env-parser-test-'));
      const legacyEnv = join(tempDir, '.env.production');
      const remoteCommon = join(tempDir, '.env.remote-common');
      const marker = join(tempDir, 'legacy-shell-ran');
      try {
        writeFileSync(
          legacyEnv,
          [
            "NODE_ENV='production'",
            "DATABASE_URL='postgres://example.invalid/zero'",
            "AWS_REGION='af-south-1'",
            "S3_BUCKET='nava-test-bucket'",
            `touch ${JSON.stringify(marker)}`,
            '',
          ].join('\n'),
          'utf8',
        );
        writeFileSync(remoteCommon, 'untouched\n', 'utf8');

        const result = spawnSync(
          process.execPath,
          [parser, legacyEnv, remoteCommon, 'DATABASE_URL', 'AWS_REGION', 'S3_BUCKET'],
          { encoding: 'utf8' },
        );

        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('legacy runtime env malformed');
        expect(existsSync(marker)).toBe(false);
        expect(readFileSync(remoteCommon, 'utf8')).toBe('untouched\n');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('renders quoted allowlisted legacy values without remote forbidden credentials', async () => {
      const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
      const { spawnSync } = await import('node:child_process');
      const { tmpdir } = await import('node:os');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const parser = join(here, '..', 'deploy', 'parse-ec2-legacy-env.mjs');
      const tempDir = mkdtempSync(join(tmpdir(), 'nava-legacy-env-parser-test-'));
      const legacyEnv = join(tempDir, '.env.production');
      const remoteCommon = join(tempDir, '.env.remote-common');

      try {
        writeFileSync(
          legacyEnv,
          [
            "NODE_ENV='production'",
            "DATABASE_URL='postgres://example.invalid/zero'",
            "AWS_REGION='af-south-1'",
            "S3_BUCKET='nava-test-bucket'",
            "MAIL_TRANSPORT_MODE='real'",
            "AI_MODEL_ID='model'\\''s'",
            "BETTER_AUTH_SECRET='legacy-signing-secret'",
            "POP3_PASSWORD='legacy-pop3-password'",
            "HMS_READ_SECRET_ARN='arn:aws:secretsmanager:example'",
            "GOOGLE_CLIENT_SECRET='legacy-google-secret'",
            '',
          ].join('\n'),
          'utf8',
        );

        const result = spawnSync(
          process.execPath,
          [
            parser,
            legacyEnv,
            remoteCommon,
            'DATABASE_URL',
            'AWS_REGION',
            'S3_BUCKET',
            'MAIL_TRANSPORT_MODE',
            'AI_MODEL_ID',
          ],
          { encoding: 'utf8' },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
        const common = readFileSync(remoteCommon, 'utf8');
        expect(common).toBe(
          [
            "NODE_ENV='production'",
            "DATABASE_URL='postgres://example.invalid/zero'",
            "AWS_REGION='af-south-1'",
            "S3_BUCKET='nava-test-bucket'",
            "MAIL_TRANSPORT_MODE='real'",
            "AI_MODEL_ID='model'\\''s'",
            '',
          ].join('\n'),
        );
        expect(common).not.toContain('BETTER_AUTH_SECRET');
        expect(common).not.toContain('POP3_PASSWORD');
        expect(common).not.toContain('HMS_READ_SECRET_ARN');
        expect(common).not.toContain('GOOGLE_CLIENT_SECRET');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('accepts safe unquoted legacy tokens without evaluating them', async () => {
      const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import(
        'node:fs'
      );
      const { spawnSync } = await import('node:child_process');
      const { tmpdir } = await import('node:os');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const parser = join(here, '..', 'deploy', 'parse-ec2-legacy-env.mjs');
      const tempDir = mkdtempSync(join(tmpdir(), 'nava-legacy-env-parser-test-'));
      const legacyEnv = join(tempDir, '.env.production');
      const remoteCommon = join(tempDir, '.env.remote-common');
      const marker = join(tempDir, 'legacy-shell-ran');

      try {
        writeFileSync(
          legacyEnv,
          [
            "NODE_ENV='production'",
            "DATABASE_URL='postgres://example.invalid/zero'",
            "AWS_REGION='af-south-1'",
            "S3_BUCKET='nava-test-bucket'",
            'HMS_READ_SECRET_ARN=arn:aws:secretsmanager:af-south-1:123456789012:secret:test',
            'NAVA_BUILD_COMMIT=0123456789abcdef0123456789abcdef01234567',
            '',
          ].join('\n'),
          'utf8',
        );

        const safe = spawnSync(
          process.execPath,
          [parser, legacyEnv, remoteCommon, 'DATABASE_URL', 'AWS_REGION', 'S3_BUCKET', 'NAVA_BUILD_COMMIT'],
          { encoding: 'utf8' },
        );
        expect(safe.status, safe.stderr).toBe(0);
        expect(readFileSync(remoteCommon, 'utf8')).toContain(
          "NAVA_BUILD_COMMIT='0123456789abcdef0123456789abcdef01234567'",
        );
        expect(readFileSync(remoteCommon, 'utf8')).not.toContain('HMS_READ_SECRET_ARN');

        writeFileSync(
          legacyEnv,
          [
            "NODE_ENV='production'",
            "DATABASE_URL='postgres://example.invalid/zero'",
            "AWS_REGION='af-south-1'",
            "S3_BUCKET='nava-test-bucket'",
            'NAVA_BUILD_COMMIT=$(touch legacy-shell-ran)',
            '',
          ].join('\n'),
          'utf8',
        );
        const unsafe = spawnSync(
          process.execPath,
          [parser, legacyEnv, remoteCommon, 'DATABASE_URL', 'AWS_REGION', 'S3_BUCKET', 'NAVA_BUILD_COMMIT'],
          { cwd: tempDir, encoding: 'utf8' },
        );
        expect(unsafe.status).toBe(2);
        expect(unsafe.stderr).toContain('legacy runtime env malformed');
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('writes only explicitly allowlisted remote HTTP environment files', async () => {
      const { existsSync, readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const path = join(here, '..', 'deploy', 'write-ec2-remote-env.sh');

      expect(existsSync(path)).toBe(true);
      const writer = readFileSync(path, 'utf8');
      expect(writer).toContain('.env.remote-common');
      expect(writer).toContain('.env.remote-admin');
      expect(writer).toContain('REMOTE_AUTH_SECRET_NAME:=nava-zero/server-pilot/remote-auth');
      expect(writer).toContain('REMOTE_AUTH_URL:=https://nava-admin.trynava.io');
      expect(writer).toContain('REMOTE_COMMON_ALLOWLIST=(');
      expect(writer).toContain('--validate');
      expect(writer).toContain('validate_remote_env_files');
      expect(writer).toContain('DATABASE_URL');
      expect(writer).toContain('S3_BUCKET');
      expect(writer).toContain('SMTP_HOST');
      expect(writer).toContain('AI_ENABLED');
      const allowlist = writer.match(/REMOTE_COMMON_ALLOWLIST=\(\r?\n([\s\S]*?)\r?\n\)/)?.[1];
      expect(allowlist).toBeTruthy();
      const keys = allowlist!.trim().split(/\s+/);
      expect(new Set(keys).size).toBe(keys.length);
      expect(allowlist).not.toContain('BETTER_AUTH_');
      expect(allowlist).not.toContain('POP3_');
      expect(allowlist).not.toContain('HMS_');
      expect(allowlist).not.toContain('GOOGLE_');
      expect(writer).toContain('const parsed = JSON.parse(data);');
      expect(writer).toContain('process.stdout.write(parsed.BETTER_AUTH_SECRET)');
      expect(writer).toMatch(/Object\.keys\(parsed\).*BETTER_AUTH_SECRET/);
      expect(writer).toMatch(/chmod 600 "\$REMOTE_COMMON_TMP"/);
      expect(writer).toMatch(/chmod 600 "\$REMOTE_ADMIN_TMP"/);
      expect(writer).not.toMatch(/echo[^\n]*BETTER_AUTH_SECRET/);
      expect(writer).not.toMatch(/source[^\n]*\.env\.remote/);
    });

    it('rejects blank or control-character dedicated remote auth JSON secrets', async () => {
      const { readFileSync } = await import('node:fs');
      const { spawnSync } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const writer = readFileSync(
        join(here, '..', 'deploy', 'write-ec2-remote-env.sh'),
        'utf8',
      ).replaceAll('\r\n', '\n');
      const parser = writer.match(/\|\s*node -e '\n([\s\S]*?)\n'\n\)/)?.[1];

      expect(parser).toBeTruthy();
      for (const secret of [
        ' ',
        '\t',
        ' \t ',
        'nonblank\nnewline',
        'nonblank\rcarriage-return',
        'nonblank\0nul',
      ]) {
        const result = spawnSync(process.execPath, ['-e', parser!], {
          input: JSON.stringify({ BETTER_AUTH_SECRET: secret }),
          encoding: 'utf8',
        });
        expect(result.status, `dedicated JSON accepted ${JSON.stringify(secret)}`).toBe(2);
        expect(result.stdout).toBe('');
      }
    });

    it('rejects blank or control-character remote admin values during --validate', async () => {
      const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
      const { spawnSync } = await import('node:child_process');
      const { tmpdir } = await import('node:os');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const writer = readFileSync(
        join(here, '..', 'deploy', 'write-ec2-remote-env.sh'),
        'utf8',
      ).replaceAll('\r\n', '\n');
      const start = 'node - "$path" "$kind" <<\'NODE\'\n';
      const validatorStart = writer.indexOf(start);
      const validatorEnd = writer.indexOf('\nNODE\n}', validatorStart);
      const validator =
        validatorStart < 0 || validatorEnd < 0
          ? null
          : writer.slice(validatorStart + start.length, validatorEnd);

      expect(validator).toBeTruthy();
      const tempDir = mkdtempSync(join(tmpdir(), 'nava-remote-auth-validate-test-'));
      const adminEnv = join(tempDir, '.env.remote-admin');
      try {
        for (const secret of [
          ' ',
          '\t',
          ' \t ',
          'nonblank\rcarriage-return',
          'nonblank\0nul',
        ]) {
          writeFileSync(
            adminEnv,
            [
              "BETTER_AUTH_URL='https://nava-admin.trynava.io'",
              `BETTER_AUTH_SECRET='${secret}'`,
              '',
            ].join('\n'),
            'utf8',
          );
          const result = spawnSync(process.execPath, ['-', adminEnv, 'admin'], {
            input: validator!,
            encoding: 'utf8',
          });
          expect(result.status, `--validate accepted ${JSON.stringify(secret)}`).toBe(2);
          expect(result.stderr).toContain('remote env malformed');
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('decodes required remote-common values during --validate', async () => {
      const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
      const { spawnSync } = await import('node:child_process');
      const { tmpdir } = await import('node:os');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const writer = readFileSync(
        join(here, '..', 'deploy', 'write-ec2-remote-env.sh'),
        'utf8',
      ).replaceAll('\r\n', '\n');
      const start = 'node - "$path" "$kind" <<\'NODE\'\n';
      const validatorStart = writer.indexOf(start);
      const validatorEnd = writer.indexOf('\nNODE\n}', validatorStart);
      const validator =
        validatorStart < 0 || validatorEnd < 0
          ? null
          : writer.slice(validatorStart + start.length, validatorEnd);

      expect(validator).toBeTruthy();
      const tempDir = mkdtempSync(join(tmpdir(), 'nava-remote-common-validate-test-'));
      const commonEnv = join(tempDir, '.env.remote-common');
      const valid = [
        "NODE_ENV='production'",
        "DATABASE_URL='postgres://example.invalid/zero'",
        "AWS_REGION='af-south-1'",
        "S3_BUCKET='nava-test-bucket'",
        '',
      ].join('\n');
      try {
        writeFileSync(commonEnv, valid, 'utf8');
        const validResult = spawnSync(process.execPath, ['-', commonEnv, 'common'], {
          input: validator!,
          encoding: 'utf8',
        });
        expect(validResult.status).toBe(0);

        // The pane queue flag and the Needs-you cutoff are the only non-secret pane switches webmail needs.
        writeFileSync(
          commonEnv,
          `${valid}HMS_JOB_QUEUE='on'\nNEEDS_YOU_SINCE='2026-10-12T15:00:00Z'\n`,
          'utf8',
        );
        const flagsResult = spawnSync(process.execPath, ['-', commonEnv, 'common'], {
          input: validator!,
          encoding: 'utf8',
        });
        expect(flagsResult.status).toBe(0);

        for (const [label, replacement] of [
          ['blank DATABASE_URL', "DATABASE_URL=' \t '"],
          ['blank AWS_REGION', "AWS_REGION='\t'"],
          ['blank S3_BUCKET', "S3_BUCKET='  '"],
          ['incorrect NODE_ENV', "NODE_ENV='staging'"],
          ['padded NODE_ENV', "NODE_ENV=' production '"],
        ] as const) {
          const lines = valid
            .split('\n')
            .map((line) =>
              line.startsWith(replacement.slice(0, replacement.indexOf('=')))
                ? replacement
                : line,
            );
          writeFileSync(commonEnv, lines.join('\n'), 'utf8');
          const result = spawnSync(process.execPath, ['-', commonEnv, 'common'], {
            input: validator!,
            encoding: 'utf8',
          });
          expect(result.status, `--validate accepted ${label}`).toBe(2);
          expect(result.stderr).toContain('remote env malformed');
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('validates remote files before PM2 mutation and isolates remote startup', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');

      for (const file of ['deploy-ec2.sh', 'ops-restart.sh', 'pm2-boot.sh']) {
        const source = readFileSync(join(deploy, file), 'utf8');
        const validation = source.lastIndexOf('validate_remote_env_files');
        const lifecycle = source.slice(validation);
        const firstPm2Mutation = lifecycle.search(/\bpm2\s+(?:delete|start|save)\b/);
        expect(validation, `${file} remote validation`).toBeGreaterThanOrEqual(0);
        expect(firstPm2Mutation, `${file} PM2 mutation`).toBeGreaterThanOrEqual(0);
        expect(firstPm2Mutation, `${file} validates before PM2`).toBeGreaterThan(0);
        expect(source).toContain('.env.remote-common');
        expect(source).toContain('.env.remote-admin');
        expect(source).toContain('start_remote_http');

        const remoteStart = source.match(
          /start_remote_http\(\)\s*\{([\s\S]*?)^\}/m,
        )?.[1];
        expect(remoteStart, `${file} remote startup body`).toBeTruthy();
        expect(remoteStart).toContain('env -i');
        expect(remoteStart).toContain('source "$REMOTE_COMMON_ENV"');
        expect(remoteStart).toContain('source "$REMOTE_ADMIN_ENV"');
        expect(remoteStart).not.toContain('.env.production');
        expect(remoteStart).toContain('--only remote-http');
      }
    });

    it('keeps normal deploy, restart, and boot remote-aware without starting HMS', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');

      for (const file of ['deploy-ec2.sh', 'ops-restart.sh', 'pm2-boot.sh']) {
        const source = readFileSync(join(deploy, file), 'utf8');
        expect(source, file).toMatch(/start_remote_http[\s\S]*--only remote-http/);
        expect(source, file).not.toMatch(/--only hms-ai-worker/);
      }

      const reboot = readFileSync(join(deploy, 'ops-reboot.sh'), 'utf8');
      expect(reboot).toContain('pm2-boot.sh');
      expect(reboot.indexOf('pm2-boot.sh')).toBeLessThan(
        reboot.lastIndexOf('post-boot-smoke.sh'),
      );

      const smoke = readFileSync(join(deploy, 'post-boot-smoke.sh'), 'utf8');
      expect(smoke).toContain('127.0.0.1:8788/health');
      expect(smoke).toContain('127.0.0.1:8789/health');
      expect(smoke).toContain('remote-http');
      expect(insecureCurlCommands(smoke)).toEqual([]);
    });

    it('reasserts raw HTTP loopback-only listeners after reboot', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const deploy = join(here, '..', 'deploy');
      const boot = readFileSync(join(deploy, 'pm2-boot.sh'), 'utf8');
      const smoke = readFileSync(join(deploy, 'post-boot-smoke.sh'), 'utf8');

      for (const [file, source] of [
        ['pm2-boot.sh', boot],
        ['post-boot-smoke.sh', smoke],
      ] as const) {
        const assertionStart = source.indexOf('assert_http_loopback_only() {');
        expect(assertionStart, `${file} listener assertion`).toBeGreaterThanOrEqual(0);
        const assertion = source.slice(assertionStart);
        expect(assertion, file).toContain("ss -ltnH '( sport = :8788 or sport = :8789 )'");
        expect(assertion, file).toContain('for (const port of [8788,8789]) {');
        expect(assertion, file).toContain('line.split(/\\s+/)[3]===`127.0.0.1:${port}`');
        expect(assertion, file).toContain(
          '!/127\\.0\\.0\\.1:(8788|8789)\\b/.test(line)',
        );
      }

      expect(boot.lastIndexOf('assert_http_loopback_with_retry')).toBeGreaterThan(
        boot.lastIndexOf('start_remote_http'),
      );
      expect(boot).toContain('raw HTTP processes must listen only on 127.0.0.1');
      expect(smoke.lastIndexOf('assert_http_loopback_only')).toBeGreaterThan(
        smoke.indexOf('127.0.0.1:8789/health'),
      );
      expect(smoke).toContain('raw HTTP processes must listen only on 127.0.0.1');
    });

    it('refuses root before boot can source the legacy runtime environment', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const boot = readFileSync(join(here, '..', 'deploy', 'pm2-boot.sh'), 'utf8');
      const rootGuard = boot.indexOf('pm2-boot.sh must run as ubuntu');
      const legacySource = boot.indexOf('source "$ENV_FILE"');

      expect(rootGuard).toBeGreaterThanOrEqual(0);
      expect(legacySource).toBeGreaterThan(rootGuard);
      expect(boot).toMatch(
        /if \[ "\$\(id -u\)" -eq 0 \]; then\s+echo "pm2-boot\.sh must run as ubuntu" >&2\s+exit 2\s+fi/,
      );
    });

    it('uses a bounded loopback-listener retry after PM2 boot', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const boot = readFileSync(join(here, '..', 'deploy', 'pm2-boot.sh'), 'utf8').replaceAll(
        '\r\n',
        '\n',
      );
      const retryStart = boot.indexOf('assert_http_loopback_with_retry() {');
      const retryEnd = boot.indexOf('\n}\n', retryStart);
      const retry = retryStart < 0 || retryEnd < 0 ? null : boot.slice(retryStart, retryEnd);

      expect(retry).toBeTruthy();
      expect(retry).toContain('for attempt in 1 2 3 4 5; do');
      expect(retry).toContain('assert_http_loopback_only && return 0');
      expect(retry).toMatch(/\bsleep\s+1\b/);
      expect(retry).toContain('return 1');
      expect(boot).toMatch(
        /start_legacy_processes\s*\nstart_remote_http\s*\nassert_http_loopback_with_retry\s+\|\|/,
      );
    });
  });
});
