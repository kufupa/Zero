/**
 * 50-user HTTP load gate for the EC2 pilot.
 *
 * Simulates concurrent authenticated sessions against the local HTTP server:
 *   - thread list on a 30s cadence (override with LOAD_CYCLE_MS for shorter runs)
 *   - 10 concurrent thread opens per cycle
 *   - 5 concurrent fake SMTP sends per cycle
 *
 * Reports p50/p95 latencies for list/get and total HTTP 5xx count.
 *
 * Run:
 *   pnpm --filter @zero/server tsx scripts/load-50-users.ts
 *
 * Env:
 *   LOAD_BASE_URL          default http://127.0.0.1:8788
 *   LOAD_SESSIONS          default 50
 *   LOAD_CYCLES            default 2 (use 1 for a quick smoke)
 *   LOAD_CYCLE_MS          default 30000
 *   LOAD_CONCURRENT_OPENS  default 10
 *   LOAD_CONCURRENT_SENDS  default 5
 *   PILOT_PASSWORDS_JSON   optional JSON map email -> { password }
 *   LOAD_TEST_PASSWORD     optional single password for all pilot users
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  PILOT_USERS,
  TRANSPORT_ID,
} from '../src/db/seed.js';

const BASE_URL = (process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:8788').replace(
  /\/$/,
  '',
);
const SESSION_COUNT = Number(process.env.LOAD_SESSIONS ?? 50);
const CYCLES = Number(process.env.LOAD_CYCLES ?? 2);
const CYCLE_MS = Number(process.env.LOAD_CYCLE_MS ?? 30_000);
const CONCURRENT_OPENS = Number(process.env.LOAD_CONCURRENT_OPENS ?? 10);
const CONCURRENT_SENDS = Number(process.env.LOAD_CONCURRENT_SENDS ?? 5);
const PILOT_SECRET_NAME =
  process.env.PILOT_USERS_SECRET_NAME ?? 'nava-zero/server-pilot/pilot-users';
const AWS_REGION = process.env.AWS_REGION ?? 'af-south-1';

type LatencyBucket = 'listThreads' | 'getThread' | 'send';

type Session = {
  index: number;
  userId: string;
  email: string;
  cookie: string;
};

type RequestStats = {
  latencies: Record<LatencyBucket, number[]>;
  statusCounts: Record<string, number>;
  fiveXx: number;
  listNon200: number;
  getNon200: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
}

function summarizeLatencies(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function parseSetCookie(headers: Headers): string {
  const cookies: string[] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      const part = value.split(';')[0]?.trim();
      if (part) cookies.push(part);
    }
  });
  // Node fetch may collapse multiple Set-Cookie; also try getSetCookie when present.
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  if (typeof getSetCookie === 'function') {
    const all = getSetCookie.call(headers);
    if (all.length > 0) {
      return all
        .map((c) => c.split(';')[0]?.trim())
        .filter(Boolean)
        .join('; ');
    }
  }
  return cookies.join('; ');
}

async function awsGetSecret(secretId: string): Promise<string> {
  const args = [
    'secretsmanager',
    'get-secret-value',
    '--region',
    AWS_REGION,
    '--secret-id',
    secretId,
    '--query',
    'SecretString',
    '--output',
    'text',
  ];
  return new Promise((resolve, reject) => {
    const p = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(
              `aws secretsmanager get-secret-value exit ${code}: ${stderr}`,
            ),
          ),
    );
  });
}

async function loadPasswords(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  const jsonEnv = process.env.PILOT_PASSWORDS_JSON?.trim();
  if (jsonEnv) {
    const parsed = JSON.parse(jsonEnv) as Record<
      string,
      { password: string } | string
    >;
    for (const [email, value] of Object.entries(parsed)) {
      out[email] = typeof value === 'string' ? value : value.password;
    }
    return out;
  }

  const filePath = process.env.PILOT_PASSWORDS_FILE?.trim();
  if (filePath) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
      string,
      { password: string } | string
    >;
    for (const [email, value] of Object.entries(parsed)) {
      out[email] = typeof value === 'string' ? value : value.password;
    }
    return out;
  }

  const shared = process.env.LOAD_TEST_PASSWORD?.trim();
  if (shared) {
    for (const user of PILOT_USERS) out[user.email] = shared;
    return out;
  }

  try {
    const secret = await awsGetSecret(PILOT_SECRET_NAME);
    const parsed = JSON.parse(secret) as Record<
      string,
      { password: string } | string
    >;
    for (const [email, value] of Object.entries(parsed)) {
      out[email] = typeof value === 'string' ? value : value.password;
    }
    if (Object.keys(out).length > 0) return out;
  } catch (err) {
    console.warn(
      'load-50-users: could not read pilot passwords from Secrets Manager:',
      err instanceof Error ? err.message : String(err),
    );
  }

  throw new Error(
    'pilot passwords required: set PILOT_PASSWORDS_JSON, PILOT_PASSWORDS_FILE, LOAD_TEST_PASSWORD, or seed Secrets Manager',
  );
}

async function signIn(
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sign-in failed for ${email}: HTTP ${res.status} ${body}`);
  }
  const cookie = parseSetCookie(res.headers);
  if (!cookie) {
    throw new Error(`sign-in for ${email} returned no session cookie`);
  }
  return cookie;
}

async function trpcCall(
  procedure: string,
  input: unknown,
  cookie: string,
  stats: RequestStats,
  bucket: LatencyBucket,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    cookie,
    'x-zero-active-transport': TRANSPORT_ID,
  };
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/api/trpc/${procedure}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ json: input }),
  });
  const elapsed = performance.now() - start;
  stats.latencies[bucket].push(elapsed);
  const statusKey = String(res.status);
  stats.statusCounts[statusKey] = (stats.statusCounts[statusKey] ?? 0) + 1;
  if (res.status >= 500) stats.fiveXx += 1;

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function createSessions(
  passwords: Record<string, string>,
): Promise<Session[]> {
  const sessions: Session[] = [];
  for (let i = 0; i < SESSION_COUNT; i += 1) {
    const spec = PILOT_USERS[i % PILOT_USERS.length]!;
    const password = passwords[spec.email];
    if (!password) {
      throw new Error(`no password for pilot user ${spec.email}`);
    }
    const cookie = await signIn(spec.email, password);
    sessions.push({
      index: i,
      userId: spec.id,
      email: spec.email,
      cookie,
    });
  }
  return sessions;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

function threadIdsFromListBody(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const result = (body as { result?: { data?: { json?: { threads?: { id: string }[] } } } })
    .result?.data?.json;
  const threads = result?.threads;
  if (!Array.isArray(threads)) return [];
  return threads.map((t) => t.id).filter(Boolean);
}

async function runCycle(
  sessions: Session[],
  stats: RequestStats,
  cycle: number,
): Promise<void> {
  console.log(`load-50-users: cycle ${cycle + 1}/${CYCLES} start`);

  const listResults = await Promise.all(
    sessions.map(async (session) => {
      const { status, body } = await trpcCall(
        'mail.listThreads',
        { folder: 'inbox', limit: 50 },
        session.cookie,
        stats,
        'listThreads',
      );
      return { session, status, threadIds: threadIdsFromListBody(body) };
    }),
  );

  const openTargets: { session: Session; threadId: string }[] = [];
  for (const row of listResults) {
    if (row.status !== 200) stats.listNon200 += 1;
    for (const threadId of row.threadIds.slice(0, 2)) {
      openTargets.push({ session: row.session, threadId });
      if (openTargets.length >= CONCURRENT_OPENS) break;
    }
    if (openTargets.length >= CONCURRENT_OPENS) break;
  }
  while (openTargets.length < CONCURRENT_OPENS) {
    const session = sessions[openTargets.length % sessions.length]!;
    openTargets.push({ session, threadId: 'missing-thread-placeholder' });
  }

  await runPool(openTargets.slice(0, CONCURRENT_OPENS), CONCURRENT_OPENS, async (target) => {
    const { status } = await trpcCall(
      'mail.get',
      { id: target.threadId },
      target.session.cookie,
      stats,
      'getThread',
    );
    if (status !== 200) stats.getNon200 += 1;
  });

  const sendSessions = sessions.slice(0, CONCURRENT_SENDS);
  await runPool(sendSessions, CONCURRENT_SENDS, async (session) => {
    await trpcCall(
      'mail.send',
      {
        to: ['load-test@example.com'],
        subject: `load test session ${session.index} cycle ${cycle + 1}`,
        text: `load test ${Date.now()}`,
        html: '<p>load test</p>',
      },
      session.cookie,
      stats,
      'send',
    );
  });
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE_URL}/health`);
  if (!health.ok) {
    throw new Error(`health check failed: HTTP ${health.status}`);
  }

  const passwords = await loadPasswords();
  console.log(
    `load-50-users: signing in ${SESSION_COUNT} sessions against ${BASE_URL}`,
  );
  const sessions = await createSessions(passwords);

  const stats: RequestStats = {
    latencies: { listThreads: [], getThread: [], send: [] },
    statusCounts: {},
    fiveXx: 0,
    listNon200: 0,
    getNon200: 0,
  };

  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const cycleStart = Date.now();
    await runCycle(sessions, stats, cycle);
    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(0, CYCLE_MS - elapsed);
    if (cycle < CYCLES - 1 && wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const report = {
    baseUrl: BASE_URL,
    sessions: SESSION_COUNT,
    cycles: CYCLES,
    cycleMs: CYCLE_MS,
    concurrentOpens: CONCURRENT_OPENS,
    concurrentSends: CONCURRENT_SENDS,
    fiveXx: stats.fiveXx,
    listNon200: stats.listNon200,
    getNon200: stats.getNon200,
    statusCounts: stats.statusCounts,
    latenciesMs: {
      listThreads: summarizeLatencies(stats.latencies.listThreads),
      getThread: summarizeLatencies(stats.latencies.getThread),
      send: summarizeLatencies(stats.latencies.send),
    },
    gate: {
      p95ListMs: summarizeLatencies(stats.latencies.listThreads).p95,
      p95GetMs: summarizeLatencies(stats.latencies.getThread).p95,
      p95TargetMs: 1000,
      fiveXxTarget: 0,
      listNon200Target: 0,
      getNon200Target: 0,
      pass:
        stats.fiveXx === 0 &&
        stats.listNon200 === 0 &&
        stats.getNon200 === 0 &&
        summarizeLatencies(stats.latencies.listThreads).p95 < 1000 &&
        summarizeLatencies(stats.latencies.getThread).p95 < 1000,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.gate.pass) process.exit(1);
}

main().catch((err) => {
  console.error('load-50-users failed:', err);
  process.exit(1);
});
