import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, '..', 'deploy');
const gate = join(deployDir, 'nava-preview-gate.sh');
const helper = join(deployDir, 'nava-preview-storage-state.mjs');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nava-preview-gate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The environment without any gate or AWS settings, so the test controls every input. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const {
    BETTER_AUTH_URL: _auth,
    S3_BUCKET: _bucket,
    AWS_REGION: _region,
    PLAYWRIGHT_REAL_MAIL_PASSWORD: _password,
    ...rest
  } = process.env;
  return { ...rest, ...extra };
}

function envFile(lines: string[]): string {
  const path = join(dir, 'env.production');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function gateRun(args: string[], extra: Record<string, string> = {}) {
  return spawnSync('bash', [gate, ...args], {
    encoding: 'utf8',
    env: cleanEnv(extra),
    timeout: 60_000,
  });
}

/** A results.json with PII in every text field, to prove the summary never prints it. */
function fixtureRun(outcomes: string[]): string {
  const runDir = join(dir, 'run');
  const results = outcomes.map((outcome, index) => ({
    threadId: `thread-${index + 1}`,
    subject: `Rooms for Ana Guest ana.guest@example.com ${index}`,
    outcome,
    intent: outcome === 'intent' ? (index % 2 ? 'Quote' : 'Booking') : null,
    prefilled: index === 0 ? [{ field: 'Client email', value: 'ana.guest@example.com' }] : [],
    banners: index === 0 ? ['Call +27 82 555 1234 about the group'] : [],
    blockedWrites: [],
  }));
  const data = {
    meta: { transportId: 'transport-centurion' },
    blockedOutsideThreads: [],
    results,
  };
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'results.json'), JSON.stringify(data));
  return runDir;
}

describe('nava-preview-gate.sh static safety', () => {
  const script = readFileSync(gate, 'utf8');

  it('passes bash syntax checking', () => {
    const result = spawnSync('bash', ['-n', gate], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('runs strict and keeps everything private by default', () => {
    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(script).toMatch(/^umask 077$/m);
    expect(script).not.toMatch(/^\s*set -x\b/m);
  });

  it('pins the canonical origin, the local nginx address and the transport', () => {
    expect(script).toContain('CANONICAL_HOST="nava.legacyhotels.co.za"');
    expect(script).toContain('RESOLVE_TO="127.0.0.1"');
    expect(script).toContain('TRANSPORT_ID="transport-centurion"');
    expect(script).toContain('LATEST_COUNT=20');
    expect(script).toContain('OUT_ROOT="${NAVA_PREVIEW_OUT_ROOT:-/opt/nava/shared/nava-preview}"');
    expect(script).toContain('--resolve "${CANONICAL_HOST}:443:${RESOLVE_TO}"');
  });

  it('never echoes the password or the raw secret', () => {
    const echoLines = script.split('\n').filter((line) => /^\s*echo\b/.test(line));
    for (const line of echoLines) {
      expect(line).not.toMatch(/\$\{?(PLAYWRIGHT_REAL_MAIL_PASSWORD|SECRET_JSON|PW)\b/);
    }
  });

  it('keeps the password off every command line', () => {
    expect(script).not.toMatch(/-d\s+"\{[^"]*password/);
    expect(script).toContain('--data-binary "@${AUTH_DIR}/signin.json"');
  });
});

describe('nava-preview-gate.sh --dry-run', () => {
  it('prints the plan with the run, gallery and transport settings and exits 0', () => {
    const env = envFile([
      'S3_BUCKET=test-bucket-xyz',
      'AWS_REGION=af-south-1',
      'BETTER_AUTH_URL=https://nava.legacyhotels.co.za',
    ]);
    // An exported NAVA_PREVIEW_THREADS would switch the selection, so the default case clears it.
    const result = gateRun(['--dry-run'], { ENV_FILE: env, NAVA_PREVIEW_THREADS: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('transport-centurion');
    expect(result.stdout).toContain('s3://test-bucket-xyz/nava-preview-gate/<run id>/');
    expect(result.stdout).toContain('/opt/nava/shared/nava-preview/gate-<UTC run id>/');
    expect(result.stdout).toContain('--latest 20');
    expect(result.stdout).toContain('never printed');
  });

  it('runs the listed threads instead of the latest when NAVA_PREVIEW_THREADS is set', () => {
    const env = envFile(['S3_BUCKET=test-bucket-xyz', 'BETTER_AUTH_URL=https://nava.legacyhotels.co.za']);
    const result = gateRun(['--dry-run'], { ENV_FILE: env, NAVA_PREVIEW_THREADS: 'thread-a,thread-b' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--threads thread-a,thread-b');
    expect(result.stdout).not.toContain('--latest 20');
  });

  it('refuses a non-canonical BETTER_AUTH_URL before any other step', () => {
    const env = envFile(['BETTER_AUTH_URL=https://pilot.example.test']);
    const result = gateRun(['--dry-run'], { ENV_FILE: env });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('BETTER_AUTH_URL must be https://nava.legacyhotels.co.za');
  });

  it('says so when no gallery bucket is configured', () => {
    const env = envFile(['BETTER_AUTH_URL=https://nava.legacyhotels.co.za']);
    const result = gateRun(['--dry-run'], { ENV_FILE: env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('local only (S3_BUCKET not set)');
  });

  it('rejects an unknown flag with usage', () => {
    const result = gateRun(['--run-everything']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
});

describe('nava-preview-gate.sh --ae4', () => {
  it('plans the AE4 proof on one thread with one HMS read', () => {
    const env = envFile(['S3_BUCKET=test-bucket-xyz', 'BETTER_AUTH_URL=https://nava.legacyhotels.co.za']);
    const result = gateRun(['--ae4', 'thread-ae4', '--dry-run'], { ENV_FILE: env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('AE4 discount override on thread thread-ae4');
    expect(result.stdout).toContain('one rates read (workstation.executeStaffQuote)');
    expect(result.stdout).toContain('/opt/nava/shared/nava-preview/ae4-<UTC run id>/');
    expect(result.stdout).not.toContain('--latest 20');
  });

  it('refuses a missing or malformed thread id and an unknown trailing flag', () => {
    for (const args of [['--ae4'], ['--ae4', 'bad id;rm'], ['--ae4', 'thread-ae4', '--now']]) {
      const result = gateRun(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('usage:');
    }
  });

  it('runs the AE4 runner and uploads only its own files', () => {
    const script = readFileSync(gate, 'utf8');
    expect(script).toContain(
      'RUNNER=(scripts/nava-ae4-override-proof.ts --threads "$AE4_THREAD" --out "$OUT_DIR" --timeout-ms "$AE4_TIMEOUT_MS")',
    );
    expect(script).toContain(
      "UPLOAD=(--exclude '*' --include 'summary.json' --include '*.png' --include 'quote.pdf' --include 'quote.xlsx')",
    );
  });
});

describe('nava-preview-gate.sh --ae1-rates and --ae2-find', () => {
  it('plans the AE1 proof with the room split and one rates read per stay', () => {
    const env = envFile(['S3_BUCKET=test-bucket-xyz', 'BETTER_AUTH_URL=https://nava.legacyhotels.co.za']);
    const result = gateRun(['--ae1-rates', 'thread-ae1', '--dry-run'], { ENV_FILE: env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('AE1 multi-stay rates on thread thread-ae1');
    expect(result.stdout).toContain('none (counts from the read) per stay where the pane has no count');
    expect(result.stdout).toContain('one rates read per stay (workstation.executeStaffQuote)');
    expect(result.stdout).toContain('/opt/nava/shared/nava-preview/ae1-rates-<UTC run id>/');
    expect(result.stdout).toContain('s3://test-bucket-xyz/nava-preview-gate/<run id>/');
  });

  it('plans the AE2 proof with one read-only find', () => {
    const env = envFile(['BETTER_AUTH_URL=https://nava.legacyhotels.co.za']);
    const result = gateRun(['--ae2-find', 'thread-ae2', '--dry-run'], { ENV_FILE: env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('AE2 amendment find on thread thread-ae2');
    expect(result.stdout).toContain('one read-only find (paneStayLookup.queueFind)');
    expect(result.stdout).toContain('/opt/nava/shared/nava-preview/ae2-find-<UTC run id>/');
  });

  it('refuses a missing or malformed thread id and an unknown trailing flag', () => {
    for (const mode of ['--ae1-rates', '--ae2-find']) {
      for (const args of [[mode], [mode, 'bad id;rm'], [mode, 'thread-x', '--now']]) {
        const result = gateRun(args);
        expect(result.status, args.join(' ')).toBe(2);
        expect(result.stderr).toContain(`usage: `);
        expect(result.stderr).toContain(mode);
      }
    }
  });

  it('runs each proof runner and uploads only its own files', () => {
    const script = readFileSync(gate, 'utf8');
    expect(script).toContain(
      'RUNNER=(scripts/nava-ae1-rates-proof.ts --threads "$AE4_THREAD" --out "$OUT_DIR" --timeout-ms "$AE1_TIMEOUT_MS")',
    );
    expect(script).toContain(
      'RUNNER=(scripts/nava-ae2-find-proof.ts --threads "$AE4_THREAD" --out "$OUT_DIR" --timeout-ms "$AE2_TIMEOUT_MS")',
    );
    expect(script).toContain("UPLOAD=(--exclude '*' --include 'summary.json' --include '*.png')");
    expect(existsSync(join(here, '..', 'scripts', 'nava-ae1-rates-proof.ts'))).toBe(true);
    expect(existsSync(join(here, '..', 'scripts', 'nava-ae2-find-proof.ts'))).toBe(true);
  });
});

describe('nava-preview-gate.sh --quote', () => {
  it('plans a sequential quote proof for the requested threads with the eight-minute rates bound', () => {
    const env = envFile(['S3_BUCKET=test-bucket-xyz', 'BETTER_AUTH_URL=https://nava.legacyhotels.co.za']);
    const result = gateRun(['--quote', 'thread-a,thread-b', '--dry-run'], { ENV_FILE: env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Quote proof on threads thread-a,thread-b');
    expect(result.stdout).toContain('480000 ms per thread');
    expect(result.stdout).toContain('/opt/nava/shared/nava-preview/quote-<UTC run id>/');
    expect(result.stdout).toContain('sequentially; one browser, no HMS writes');
  });

  it('refuses malformed thread lists and unknown trailing flags', () => {
    for (const args of [
      ['--quote'],
      ['--quote', 'thread-a,,thread-b'],
      ['--quote', 'bad id;rm'],
      ['--quote', 'thread-a', '--now'],
    ]) {
      const result = gateRun(args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('--quote');
    }
  });

  it('runs the quote driver and uploads only its proof artifacts', () => {
    const script = readFileSync(gate, 'utf8');
    expect(script).toContain(
      'RUNNER=(scripts/nava-quote-proof.ts --threads "$QUOTE_THREADS" --out "$OUT_DIR" --timeout-ms "$QUOTE_TIMEOUT_MS")',
    );
    expect(script).toContain("UPLOAD=(--exclude '*' --include 'summary.json' --include '*.png' --include '*.pdf' --include '*.xlsx')");
    expect(existsSync(join(here, '..', 'scripts', 'nava-quote-proof.ts'))).toBe(true);
  });
});

describe('nava-preview-gate.sh --summarize', () => {
  it('prints counts and thread ids, never subjects, emails or phone numbers', () => {
    const runDir = fixtureRun(['intent', 'intent', 'unsynced', 'timeout']);
    const result = gateRun(['--summarize', runDir]);
    expect(result.stdout).toContain('threads: 4 (transport transport-centurion)');
    expect(result.stdout).toContain('outcomes: intent=2 unsynced=1 timeout=1');
    expect(result.stdout).toContain('intents: Booking=1 Quote=1');
    expect(result.stdout).toContain('threads with prefill: 1 (1 fields)');
    expect(result.stdout).toContain('threads with banners: 1');
    expect(result.stdout).toContain('errors or timeouts: 1 -> thread-4');
    expect(result.stdout).toContain('blocked writes: 0');
    expect(result.stdout).not.toContain('ana.guest');
    expect(result.stdout).not.toContain('Guest');
    expect(result.stdout).not.toContain('555');
    // A timeout is a gate failure.
    expect(result.status).toBe(1);
  });

  it('exits 0 for a clean run and counts blocked writes as failures', () => {
    const clean = gateRun(['--summarize', fixtureRun(['intent', 'fallback'])]);
    expect(clean.status).toBe(0);
    const blockedDir = join(dir, 'blocked');
    mkdirSync(blockedDir, { recursive: true });
    writeFileSync(
      join(blockedDir, 'results.json'),
      JSON.stringify({
        meta: {},
        blockedOutsideThreads: ['workstation.bridgeTicket'],
        results: [],
      }),
    );
    const blocked = gateRun(['--summarize', blockedDir]);
    expect(blocked.stdout).toContain('blocked writes: 1');
    expect(blocked.status).toBe(1);
  });

  it('fails clearly when results.json is missing', () => {
    const result = gateRun(['--summarize', join(dir, 'nothing-here')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('unreadable');
  });
});

describe('nava-preview-storage-state.mjs', () => {
  it('copies only the better-auth session cookies into a private storage state', () => {
    const headers = join(dir, 'headers.txt');
    writeFileSync(
      headers,
      [
        'HTTP/2 200',
        'set-cookie: __Secure-better-auth.session_token=FAKE-TOKEN; Path=/; HttpOnly; Secure; SameSite=Lax',
        'set-cookie: __Secure-better-auth.session_data=FAKE-DATA; Path=/; HttpOnly; Secure',
        'set-cookie: unrelated=1; Path=/',
        '',
      ].join('\r\n'),
    );
    const out = join(dir, 'storage-state.json');
    const result = spawnSync('node', [helper, headers, out, 'nava.legacyhotels.co.za'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('2 session cookie(s)');
    expect(result.stdout).not.toContain('FAKE');
    const state = JSON.parse(readFileSync(out, 'utf8')) as {
      cookies: Array<Record<string, unknown>>;
    };
    expect(state.cookies.map((cookie) => cookie.name)).toEqual([
      '__Secure-better-auth.session_token',
      '__Secure-better-auth.session_data',
    ]);
    expect(state.cookies[0]).toMatchObject({
      domain: 'nava.legacyhotels.co.za',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('exits 3 and writes nothing when the sign-in carried no session cookie', () => {
    const headers = join(dir, 'empty.txt');
    writeFileSync(headers, 'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n');
    const out = join(dir, 'never.json');
    const result = spawnSync('node', [helper, headers, out, 'nava.legacyhotels.co.za'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(3);
    expect(() => statSync(out)).toThrow();
  });
});

describe('nava-preview-auth.mjs', () => {
  const auth = join(deployDir, 'nava-preview-auth.mjs');
  const pilot = 'navaai@legacyhotels.co.za';
  const secret = JSON.stringify({
    [pilot]: { password: 'PW-OBJECT-ENTRY' },
    'other@legacyhotels.co.za': 'PW-STRING-ENTRY',
  });

  it('returns the password for an object entry and for a plain string entry', () => {
    const object = spawnSync('node', [auth, 'password', pilot], {
      input: secret,
      encoding: 'utf8',
    });
    expect(object.status, object.stderr).toBe(0);
    expect(object.stdout).toBe('PW-OBJECT-ENTRY');
    const string = spawnSync('node', [auth, 'password', 'other@legacyhotels.co.za'], {
      input: secret,
      encoding: 'utf8',
    });
    expect(string.stdout).toBe('PW-STRING-ENTRY');
  });

  it('refuses an unknown account and a non-JSON secret without echoing the input', () => {
    const unknown = spawnSync('node', [auth, 'password', 'nobody@legacyhotels.co.za'], {
      input: secret,
      encoding: 'utf8',
    });
    expect(unknown.status).toBe(4);
    expect(unknown.stderr).toContain('pilot account is not in the secret');
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).not.toContain('PW-');

    const broken = spawnSync('node', [auth, 'password', pilot], {
      input: '{"navaai@legacyhotels.co.za": PW-OBJECT-ENTRY not json',
      encoding: 'utf8',
    });
    expect(broken.status).toBe(4);
    expect(broken.stderr).toContain('pilot secret is not JSON');
    expect(broken.stderr).not.toContain('PW-OBJECT');
  });

  it('writes the sign-in body at mode 600 and drops one trailing newline from the password', () => {
    const out = join(dir, 'signin.json');
    const result = spawnSync('node', [auth, 'signin-body', pilot, out], {
      input: 'PW-OBJECT-ENTRY\n',
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      email: pilot,
      password: 'PW-OBJECT-ENTRY',
    });
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it('prints usage for an unknown command', () => {
    const result = spawnSync('node', [auth, 'print-everything'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
});

/**
 * Runs the whole gate with shims for the network and AWS edges (curl, aws, sudo, pnpm).
 * Real bash, node, the auth and storage-state helpers and the summary all run.
 */
describe('nava-preview-gate.sh full run with shims', () => {
  const PASSWORD = 'PW-SIMULATED-DO-NOT-USE-4242';
  let outRoot: string;
  let bin: string;
  let log: string;
  let results: string;
  let quoteSummary: string;

  function shim(name: string, body: string) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body}\n`, { mode: 0o755 });
  }

  beforeEach(() => {
    outRoot = join(dir, 'shared', 'nava-preview');
    bin = join(dir, 'bin');
    log = join(dir, 'sim.log');
    results = join(dir, 'fixture-results.json');
    quoteSummary = join(dir, 'fixture-quote-summary.json');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      results,
      JSON.stringify({
        meta: { transportId: 'transport-centurion' },
        blockedOutsideThreads: [],
        results: [
          {
            threadId: 'thread-1',
            subject: 'Rooms for Ana Guest',
            outcome: 'intent',
            intent: 'Quote',
            prefilled: [{ field: 'Client email', value: '[email]' }],
            banners: [],
            blockedWrites: [],
          },
          {
            threadId: 'thread-2',
            subject: 'Booking',
            outcome: 'unsynced',
            intent: null,
            prefilled: [],
            banners: ['No guest email'],
            blockedWrites: [],
          },
        ],
      }),
    );
    writeFileSync(
      quoteSummary,
      JSON.stringify({ threads: [{ threadId: 'quote-thread', kind: 'quote' }], pass: true }, null, 2) + '\n',
    );

    // Health check and sign-in. The sign-in writes fake session cookies to the -D file.
    shim(
      'curl',
      `prev=""
url=""
headers=""
body=""
for arg in "$@"; do
  case "$prev" in
    -D) headers="$arg" ;;
    -o) body="$arg" ;;
  esac
  prev="$arg"
  case "$arg" in https://*) url="$arg" ;; esac
done
case "$url" in
  */health) exit 0 ;;
  */api/auth/sign-in/email)
    echo "$url" >> "\${SIM_LOG}"
    [ -n "$body" ] && printf '{}' > "$body"
    if [ -n "$headers" ]; then
      printf 'HTTP/2 200\\r\\nset-cookie: __Secure-better-auth.session_token=FAKE-TOKEN; Path=/; HttpOnly; Secure\\r\\nset-cookie: __Secure-better-auth.session_data=FAKE-DATA; Path=/; HttpOnly; Secure\\r\\n\\r\\n' > "$headers"
    fi
    printf '%s' "\${SIM_SIGNIN_STATUS:-200}"
    exit 0 ;;
esac
exit 1`,
    );
    shim(
      'aws',
      `if [ "$1" = secretsmanager ]; then printf '%s' "$SIM_SECRET_JSON"; exit 0; fi
if [ "$1" = s3 ] && [ "$2" = sync ]; then echo "s3 sync $*" >> "$SIM_LOG"; exit 0; fi
exit 1`,
    );
    shim('sudo', 'exec "$@"');
    shim(
      'pnpm',
      `if [ "$1" = install ]; then exit 0; fi
out=""
runner="preview"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    scripts/nava-quote-proof.ts) runner="quote"; shift ;;
    *) shift ;;
  esac
done
{
  echo "runner base=$NAVA_PREVIEW_BASE_URL"
  echo "runner resolve=$NAVA_PREVIEW_RESOLVE_TO"
  echo "runner transport=$NAVA_PREVIEW_TRANSPORT_ID"
  echo "runner state-file-mode=$(stat -c %a "$NAVA_PREVIEW_STORAGE_STATE")"
} >> "$SIM_LOG"
mkdir -p "$out"
if [ "$runner" = quote ]; then
  echo "quote runner progress"
  if [ "\${SIM_OMIT_QUOTE_SUMMARY:-0}" = "1" ]; then
    echo "quote runner config failed" >&2
    exit 2
  fi
  cp "$SIM_QUOTE_SUMMARY" "$out/summary.json"
else
  cp "$SIM_RESULTS" "$out/results.json"
fi
exit "\${SIM_RUN_EXIT:-0}"`,
    );
  });

  function runGate(extra: Record<string, string> = {}, args: string[] = []) {
    const env = envFile([
      'BETTER_AUTH_URL=https://nava.legacyhotels.co.za',
      'S3_BUCKET=test-bucket-xyz',
      'AWS_REGION=af-south-1',
    ]);
    return spawnSync('bash', [gate, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      env: cleanEnv({
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ENV_FILE: env,
        NAVA_PREVIEW_OUT_ROOT: outRoot,
        SIM_LOG: log,
        SIM_RESULTS: results,
        SIM_QUOTE_SUMMARY: quoteSummary,
        SIM_SECRET_JSON: JSON.stringify({ 'navaai@legacyhotels.co.za': { password: PASSWORD } }),
        ...extra,
      }),
    });
  }

  it('runs end to end, pins the host and transport, cleans its auth dir and prints no password', () => {
    const result = runGate();
    const combined = result.stdout + result.stderr;
    expect(result.status, combined).toBe(0);
    expect(combined).not.toContain(PASSWORD);
    expect(combined).not.toContain('FAKE-TOKEN');
    expect(combined).toContain('threads: 2 (transport transport-centurion)');
    expect(combined).toContain('gallery: s3://test-bucket-xyz/nava-preview-gate/');

    const simLog = readFileSync(log, 'utf8');
    expect(simLog).toContain('runner base=https://nava.legacyhotels.co.za');
    expect(simLog).toContain('runner resolve=127.0.0.1');
    expect(simLog).toContain('runner transport=transport-centurion');
    expect(simLog).toContain('runner state-file-mode=600');
    expect(simLog).toContain('s3 sync');
    expect(simLog).toContain('--include threads/*');

    const runs = readdirSync(outRoot).filter((name: string) => name.startsWith('gate-'));
    expect(runs).toHaveLength(1);
    expect(statSync(join(outRoot, runs[0] as string, 'results.json')).isFile()).toBe(true);
    expect(statSync(outRoot).mode & 0o777).toBe(0o700);
    const leftovers = readdirSync(outRoot).filter((name: string) => name.startsWith('.auth.'));
    expect(leftovers).toEqual([]);
  });

  it('reports a gate failure with exit 1 when the runner fails', () => {
    const result = runGate({ SIM_RUN_EXIT: '1' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('runner exit: 1');
    expect(result.stdout).toContain('errors or timeouts: 0');
  });

  it('prints the one-line quote summary last and preserves the runner exit status', () => {
    const summary = { threads: [{ threadId: 'quote-thread', kind: 'quote' }], pass: true };
    const lastLine = (stdout: string) => stdout.trimEnd().split(/\r?\n/).at(-1);
    const summaryLine = readFileSync(quoteSummary, 'utf8').replace(/[\r\n]/g, '');

    const passed = runGate({}, ['--quote', 'quote-thread']);
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.stdout).toContain('quote runner progress');
    expect(passed.stdout).toContain('gallery: s3://test-bucket-xyz/nava-preview-gate/');
    expect(passed.stdout).toContain('runner exit: 0');
    expect(lastLine(passed.stdout), passed.stdout + passed.stderr).toBe(summaryLine);
    expect(JSON.parse(summaryLine)).toEqual(summary);

    const failed = runGate({ SIM_RUN_EXIT: '1' }, ['--quote', 'quote-thread']);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('runner exit: 1');
    expect(lastLine(failed.stdout)).toBe(summaryLine);
  });

  it('prints a fail-closed quote summary for every requested thread when the runner writes none', () => {
    const result = runGate({ SIM_OMIT_QUOTE_SUMMARY: '1' }, ['--quote', 'thread-a,thread-b']);
    const lastLine = result.stdout.trimEnd().split(/\r?\n/).at(-1);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('quote runner config failed');
    expect(lastLine).toBe(
      JSON.stringify({
        threads: ['thread-a', 'thread-b'].map((threadId) => ({
          threadId,
          kind: 'unknown',
          prefilled: { contact: { name: null, email: null }, stays: [], ratePlan: null },
          party: { suggested: [], accepted: [], prefetched: false },
          rates: { outcome: null, seconds: null, cards: 0 },
          docs: { pdfBytes: null, xlsxBytes: null },
          blocker: 'crashed: quote proof runner did not produce summary.json (exit 2)',
        })),
        pass: false,
      }),
    );
  });

  it('stops before the runner when sign-in is refused, and leaves no auth files', () => {
    const result = runGate({ SIM_SIGNIN_STATUS: '401' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('sign-in refused with HTTP 401');
    expect(readFileSync(log, 'utf8')).not.toContain('runner base=');
    const leftovers = readdirSync(outRoot).filter((name: string) => name.startsWith('.auth.'));
    expect(leftovers).toEqual([]);
  });

  it('stops when the pilot account is missing from the secret, without printing the secret', () => {
    const result = runGate({
      SIM_SECRET_JSON: JSON.stringify({ 'other@legacyhotels.co.za': 'PW-OTHER' }),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('could not read the pilot account');
    expect(result.stdout + result.stderr).not.toContain('PW-OTHER');
  });
});
