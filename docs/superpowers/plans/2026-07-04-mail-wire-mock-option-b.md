# Mail Wire Mock (Option B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `MAIL_TRANSPORT_MODE=wire` plus Mailpit-backed vitest E2E that exercises `RealPop3Client` / `RealSmtpTransport` over TCP, with a separate pre-IT EC2 gate — fixture loopback deploy gate stays fast and unchanged.

**Architecture:** Third transport mode `wire` routes factories to the same real TCP clients as `real`, but targets a localhost Mailpit sidecar (SMTP 11025, POP3 11110, HTTP 18025 on `127.0.0.1`). Vitest spawns Mailpit when `MAILPIT_HTTP_URL` is unset; EC2 reuses a PM2 sidecar installed once. Tests inject IT-style RFC822 via SMTP `raw` + nodemailer, poll via `createPop3Client` + `ingestOnce`, assert folders via tRPC — mirroring the four fixture-loopback E2E cases. **Option B cadence:** `fixture-loopback-gate.sh` on every deploy; `wire-gate.sh` not in deploy script but run autonomously once pre-IT (overnight wave below).

**Tech Stack:** TypeScript, Vitest, Mailpit static binary (`axllent/mailpit` v1.27.3), nodemailer, Drizzle/Postgres, PM2, AWS SSM.

**Spec:** [docs/brainstorms/2026-07-04-mail-wire-mock-requirements.md](../brainstorms/2026-07-04-mail-wire-mock-requirements.md)

**Branch:** `EC2-pilot`

## Global Constraints

- **Option B cadence:** `fixture-loopback-gate.sh` on every deploy; `wire-gate.sh` pre-IT only (not in `deploy-ec2.sh` — overnight run executes via SSM without asking).
- `MAIL_TRANSPORT_MODE` default stays `fixture` on EC2 production `.env.production`.
- Loopback (`maybeEnqueueLoopback`) disabled for `wire` and `real` — wire path must not use `FixtureLoopbackStore`.
- Mailpit binds **127.0.0.1 only** on EC2 — never expose SMTP/POP3/UI to the public interface.
- Wire tests use prod RDS via `withSeededTestDb` (transaction rollback) — same pattern as fixture E2E.
- No Playwright, no tier5 bug fixes, no IT Exchange/VPN creds.
- Pin Mailpit release **v1.27.3** (SMTP + POP3 + `/api/v1/send` + `DELETE /api/v1/messages`).
- Wire ports (non-default to avoid dev clashes): SMTP `11025`, POP3 `11110`, HTTP `18025`.
- Wire test creds (Mailpit POP3 requires auth): user `ingest@wire.test`, password `wire-test-pass`.
- `mail.ts` edits **serial only** if Task 1 touches it — no parallel subagents on `mail.ts`.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause. Goal = Tasks 1–6 implemented, committed, pushed, EC2 green on **both** gates, handoff report written.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Sync | `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` |
| Deploy | `apps/server-pilot/deploy/deploy-ec2.sh` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |

**Allowed:** bundle sync, deploy, migrate, seed (no `--rotate` unless fix requires), SSM remote test runs, PM2 start/stop (worker + mailpit), `install-mailpit.sh`, PM2 logs, health curl, RDS-backed vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, exposing Mailpit beyond `127.0.0.1`.

### Git rules (autonomous)

- Branch: `EC2-pilot`
- One atomic conventional commit per task (tests green before commit)
- Push `EC2-pilot` after each task (or after Task 1 batch if `mail.ts` untouched)
- RCA fixes: separate `fix(mail): <symptom>` commit, body cites `file:line`
- No amend, no force-push, no `--no-verify`
- Do not commit `.cursor/`, `.tmp-research/`, skill scaffolding, secrets

### RCA loop (mandatory on any red)

```text
FAIL → reproduce minimally → root cause (file:line + mechanism)
  → Exa/web if unfamiliar → enumerate fixes → smallest correct fix
  → test + commit → resume plan
```

Bar: 95% confident can explain what broke and why. Symptom patches without RCA = loop again. **Do not stop at first failure.**

### Divergence authority

Better path to wire-green → take it. Log divergence in handoff report (what, why).

### SSM stdout

Windows AWS CLI may choke on vitest unicode. Always use `apps/server-pilot/deploy/ssm-run-command.sh` (wraps `ssm-format-invocation.cjs`). See `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`.

### Overnight wave (execute without user prompts)

```text
Tasks 1–5: implement locally → vitest green → commit → push EC2-pilot

bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
→ SSM: source apps/server-pilot/.env.production
→ SSM: pnpm --filter @zero/server db:migrate
→ SSM: bash apps/server-pilot/deploy/deploy-ec2.sh
→ SSM: bash apps/server-pilot/deploy/fixture-loopback-gate.sh   # regression
→ SSM: bash apps/server-pilot/deploy/wire-gate.sh                # WIRE-1..4
→ Task 6: handoff report with both gate outputs
```

### Done criteria

- [ ] Tasks 1–5 implemented + committed + pushed
- [ ] `fixture-loopback-gate.sh` green on EC2 via SSM (regression)
- [ ] `wire-gate.sh` green on EC2 via SSM (WIRE-1..4)
- [ ] `MAIL_TRANSPORT_MODE=fixture` unchanged in `.env.production`
- [ ] PM2 `mailpit` sidecar on `127.0.0.1` only
- [ ] Handoff report: `docs/superpowers/plans/handoff-reports/2026-07-04-mail-wire-gate-report.md`
- [ ] No open blockers for pre-IT wire confidence goal

---

## Research Summary (95% confidence)

| Topic | Finding |
|-------|---------|
| Why Mailpit | Single static binary: SMTP + POP3 + REST; matches worker pull model; `RealPop3Client` already socket-tested |
| POP3 auth | Required — `MP_POP3_AUTH="ingest@wire.test:wire-test-pass"` |
| SMTP auth | Optional by default on port 1025; wire gate uses plain SMTP, no TLS |
| Inject headers | `/api/v1/send` `Headers` map for structured mail; raw `.eml` fixtures via nodemailer `sendMail({ raw })` over SMTP |
| Purge between tests | `DELETE http://127.0.0.1:18025/api/v1/messages` (no body = delete all) |
| EC2 hosting | PM2 sidecar + `install-mailpit.sh` tarball — no Docker required |
| Local vitest | Spawn `mailpit` subprocess in `beforeAll`; skip suite if binary missing and no `MAILPIT_HTTP_URL` |

---

## File Map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/env.ts` | Add `wire` to `MailTransportMode` |
| `apps/server-pilot/src/mail/ingest/pop3-client.ts` | `wire` → `RealPop3Client`, default `POP3_TLS=false` for wire |
| `apps/server-pilot/src/mail/send/smtp.ts` | `wire` → `RealSmtpTransport`, relaxed cred rules |
| `apps/server-pilot/src/mail/fixture-loopback.ts` | Skip enqueue when `mode === 'wire'` |
| `apps/server-pilot/src/trpc/routes/mail.ts` | Pass `wire` to loopback guard |
| `apps/server-pilot/src/mail/ingest/worker.ts` | Log `wire` mode in worker startup |
| `apps/server-pilot/tests/transport-mode.test.ts` | Wire factory assertions |
| `apps/server-pilot/tests/helpers/mailpit.ts` | Start/stop Mailpit, purge, inject raw `.eml` |
| `apps/server-pilot/tests/mail-wire-e2e.test.ts` | Four wire E2E cases (mirror fixture suite) |
| `apps/server-pilot/deploy/install-mailpit.sh` | One-time EC2 binary install (pinned version) |
| `apps/server-pilot/deploy/mailpit.ecosystem.cjs` | PM2 config for Mailpit sidecar |
| `apps/server-pilot/deploy/wire-gate.sh` | Pre-IT gate: ensure Mailpit up, run wire vitest |
| `apps/server-pilot/deploy/deferred-real-mail-readiness.md` | Document Option B cadence |
| `docs/solutions/architecture-patterns/mail-transport-mode-fixture-vs-real.md` | Extend with `wire` mode |
| `CONCEPTS.md` | Wire vs loopback vs real definitions |
| `docs/superpowers/plans/handoff-reports/2026-07-04-mail-wire-gate-report.md` | Post-gate report (Task 8) |

## Git Commit Strategy

| Task | Commit message | Scope |
|------|----------------|-------|
| 1 | `feat(mail): add wire transport mode to env and factories` | env, pop3-client, smtp, loopback, mail.ts, worker, transport-mode.test |
| 2 | `test(mail): add mailpit lifecycle helper` | helpers/mailpit.ts + unit smoke test |
| 3 | `test(mail): add wire E2E suite over Mailpit TCP` | mail-wire-e2e.test.ts |
| 4 | `feat(deploy): add mailpit sidecar and wire gate script` | install-mailpit, mailpit.ecosystem, wire-gate, deferred doc |
| 5 | `docs(mail): document wire transport and option B gate` | solutions doc, CONCEPTS |
| 6 | `docs(mail): wire gate handoff report` | handoff-reports (after EC2 green) |

---

### Task 1: Wire transport mode

**Files:**
- Modify: `apps/server-pilot/src/env.ts`
- Modify: `apps/server-pilot/src/mail/ingest/pop3-client.ts:498-529`
- Modify: `apps/server-pilot/src/mail/send/smtp.ts:162-210`
- Modify: `apps/server-pilot/src/mail/fixture-loopback.ts:74-80`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts` (loopback mode arg)
- Modify: `apps/server-pilot/src/mail/ingest/worker.ts:126,293,328`
- Test: `apps/server-pilot/tests/transport-mode.test.ts`

**Interfaces:**
- Consumes: existing `MailTransportMode`, `createPop3Client`, `createSmtpTransport`
- Produces: `MailTransportMode = 'fixture' | 'wire' | 'real'`; factories return real TCP clients when mode is `wire`

- [ ] **Step 1: Write the failing tests**

Add to `apps/server-pilot/tests/transport-mode.test.ts`:

```typescript
it('parseEnv accepts MAIL_TRANSPORT_MODE=wire', () => {
  const env = parseEnv({
    PORT: '8788',
    DATABASE_URL: 'postgres://x',
    BETTER_AUTH_URL: 'http://localhost',
    BETTER_AUTH_SECRET: 'secret',
    AWS_REGION: 'af-south-1',
    S3_BUCKET: 'bucket',
    POP3_POLL_INTERVAL_MS: '30000',
    POP3_MAX_MESSAGES_PER_CYCLE: '50',
    MAIL_TRANSPORT_MODE: 'wire',
  });
  expect(env.MAIL_TRANSPORT_MODE).toBe('wire');
});

it('createPop3Client returns RealPop3Client in wire mode', () => {
  const client = createPop3Client({
    MAIL_TRANSPORT_MODE: 'wire',
    POP3_HOST: '127.0.0.1',
    POP3_PORT: 11110,
    POP3_USER: 'ingest@wire.test',
    POP3_PASSWORD: 'wire-test-pass',
    POP3_TLS: false,
  });
  expect(client).toBeInstanceOf(RealPop3Client);
});

it('createSmtpTransport returns RealSmtpTransport in wire mode without secret ARN', () => {
  const transport = createSmtpTransport({
    mode: 'wire',
    host: '127.0.0.1',
    port: 11025,
    secure: false,
  });
  expect(transport).toBeInstanceOf(RealSmtpTransport);
});
```

Add to `apps/server-pilot/tests/fixture-loopback.test.ts`:

```typescript
it('maybeEnqueueLoopback does not enqueue in wire mode', () => {
  maybeEnqueueLoopback(
    {
      from: 'nava@legacyhotel.com',
      to: ['nava@legacyhotel.com'],
      cc: [],
      bcc: [],
      subject: 'wire-skip',
      html: '<p>x</p>',
      text: 'x',
    },
    { messageId: 'wire-1', accepted: ['nava@legacyhotel.com'] },
    'wire',
  );
  const fake = new FakePop3Client();
  await fake.connect();
  expect(await fake.listUidl()).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server-pilot && pnpm test tests/transport-mode.test.ts tests/fixture-loopback.test.ts -t "wire"`

Expected: FAIL — `wire` not in `TRANSPORT_MODES` or factories return fake

- [ ] **Step 3: Implement wire mode**

`apps/server-pilot/src/env.ts` — change type and allowlist:

```typescript
/** `fixture` (default) in-memory fake; `wire` TCP to Mailpit; `real` Exchange. */
export type MailTransportMode = 'fixture' | 'wire' | 'real';

const TRANSPORT_MODES: readonly MailTransportMode[] = ['fixture', 'wire', 'real'];
```

`apps/server-pilot/src/mail/ingest/pop3-client.ts` — replace factory branch:

```typescript
function usesRealPop3(mode: MailTransportMode | undefined): boolean {
  return mode === 'real' || mode === 'wire';
}

export function createPop3Client(env: { /* unchanged */ }): Pop3Client | null {
  const mode = env.MAIL_TRANSPORT_MODE ?? 'fixture';

  if (!usesRealPop3(mode)) {
    const messages = loadFixtureMessagesFromDir(env.INGEST_FIXTURE_DIR);
    return new FakePop3Client({ messages });
  }

  if (!env.POP3_HOST || !env.POP3_PORT || !env.POP3_USER) {
    return null;
  }
  if (mode === 'real' && !env.POP3_PASSWORD && !env.POP3_SECRET_ARN) {
    return null;
  }

  return new RealPop3Client({
    host: env.POP3_HOST,
    port: env.POP3_PORT,
    user: env.POP3_USER,
    password: env.POP3_PASSWORD ?? (mode === 'wire' ? 'wire-test-pass' : undefined),
    tls: env.POP3_TLS ?? mode === 'real',
    secretArn: env.POP3_SECRET_ARN,
  });
}
```

`apps/server-pilot/src/mail/send/smtp.ts`:

```typescript
function resolveTransportMode(opts: SmtpTransportOptions): MailTransportMode {
  if (opts.mode) return opts.mode;
  const raw = process.env.MAIL_TRANSPORT_MODE ?? 'fixture';
  if (raw === 'real' || raw === 'wire') return raw;
  return 'fixture';
}

function usesRealSmtp(mode: MailTransportMode): boolean {
  return mode === 'real' || mode === 'wire';
}

export function createSmtpTransport(opts: SmtpTransportOptions = {}): SmtpTransport {
  if (opts.forceFake) return new FakeSmtpTransport();

  const mode = resolveTransportMode(opts);
  if (!usesRealSmtp(mode)) return new FakeSmtpTransport();

  const host = opts.host ?? process.env.SMTP_HOST;
  const port = opts.port ?? Number(process.env.SMTP_PORT ?? (mode === 'wire' ? '11025' : '587'));
  if (!host) {
    throw new Error(`SMTP_HOST required when MAIL_TRANSPORT_MODE=${mode}`);
  }

  const user = opts.user ?? process.env.SMTP_USER;
  const secretArn = opts.secretArn ?? process.env.SMTP_SECRET_ARN;
  const password = opts.password ?? process.env.SMTP_PASSWORD;

  if (mode === 'real' && !password && !secretArn) {
    throw new Error('SMTP_PASSWORD or SMTP_SECRET_ARN required when MAIL_TRANSPORT_MODE=real');
  }

  const secureRaw = process.env.SMTP_SECURE;
  const secure =
    opts.secure ??
    (secureRaw === 'true' || secureRaw === '1'
      ? true
      : secureRaw === 'false' || secureRaw === '0'
        ? false
        : mode === 'wire'
          ? false
          : port === 465);

  return new RealSmtpTransport({
    host,
    port,
    secure,
    user,
    password: password ?? (mode === 'wire' ? undefined : undefined),
    secretArn,
  });
}
```

`apps/server-pilot/src/mail/fixture-loopback.ts`:

```typescript
if (mode === 'real' || mode === 'wire') return;
```

`apps/server-pilot/src/trpc/routes/mail.ts` — update loopback mode (search `maybeEnqueueLoopback`):

```typescript
const transportMode =
  process.env.MAIL_TRANSPORT_MODE === 'real' || process.env.MAIL_TRANSPORT_MODE === 'wire'
    ? process.env.MAIL_TRANSPORT_MODE
    : 'fixture';
maybeEnqueueLoopback(payload, smtpResult, transportMode, extraHeaders);
```

`apps/server-pilot/src/mail/ingest/worker.ts` — treat wire like real for skip logging:

```typescript
mode === 'real' || mode === 'wire'
  ? 'worker: real/wire mode but POP3_HOST/PORT/USER unset, skipping ingest'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server-pilot && pnpm test tests/transport-mode.test.ts tests/fixture-loopback.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/env.ts \
  apps/server-pilot/src/mail/ingest/pop3-client.ts \
  apps/server-pilot/src/mail/send/smtp.ts \
  apps/server-pilot/src/mail/fixture-loopback.ts \
  apps/server-pilot/src/trpc/routes/mail.ts \
  apps/server-pilot/src/mail/ingest/worker.ts \
  apps/server-pilot/tests/transport-mode.test.ts \
  apps/server-pilot/tests/fixture-loopback.test.ts
git commit -m "$(cat <<'EOF'
feat(mail): add wire transport mode to env and factories

Introduce MAIL_TRANSPORT_MODE=wire for Mailpit TCP clients without
changing fixture default or real IT handoff semantics.
EOF
)"
```

---

### Task 2: Mailpit lifecycle helper

**Files:**
- Create: `apps/server-pilot/tests/helpers/mailpit.ts`
- Create: `apps/server-pilot/tests/mailpit-lifecycle.test.ts`
- Modify: `apps/server-pilot/vitest.config.ts` (optional: longer timeout for wire suite only via per-file timeout)

**Interfaces:**
- Produces: `MailpitContext` with `{ httpUrl, smtpHost, smtpPort, pop3Host, pop3Port, pop3User, pop3Password, clearAll(), injectRawEml(raw: Buffer), stop() }`
- Produces: `startMailpitForTests(): Promise<MailpitContext | null>` — returns `null` when Mailpit unavailable (skip wire E2E)

- [ ] **Step 1: Write the failing test**

Create `apps/server-pilot/tests/mailpit-lifecycle.test.ts`:

```typescript
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { startMailpitForTests, type MailpitContext } from './helpers/mailpit.js';
import nodemailer from 'nodemailer';

const mailpitAvailable = !!(process.env.MAILPIT_HTTP_URL || process.env.MAILPIT_BINARY || process.env.PATH);

describe.skipIf(!mailpitAvailable)('mailpit lifecycle helper', () => {
  let ctx: MailpitContext;

  beforeAll(async () => {
    const started = await startMailpitForTests();
    if (!started) throw new Error('expected mailpit');
    ctx = started;
  }, 30_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  it('accepts SMTP inject and purge via HTTP API', async () => {
    await ctx.clearAll();
    const transport = nodemailer.createTransport({
      host: ctx.smtpHost,
      port: ctx.smtpPort,
      secure: false,
    });
    await transport.sendMail({
      from: 'probe@wire.test',
      to: 'nava@legacyhotel.com',
      subject: 'mailpit-probe',
      text: 'probe',
    });
    const res = await fetch(`${ctx.httpUrl}/api/v1/messages`);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBeGreaterThan(0);
    await ctx.clearAll();
    const after = await fetch(`${ctx.httpUrl}/api/v1/messages`);
    const empty = (await after.json()) as { total: number };
    expect(empty.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server-pilot && pnpm test tests/mailpit-lifecycle.test.ts`

Expected: FAIL — module `./helpers/mailpit.js` not found

- [ ] **Step 3: Implement helper**

Create `apps/server-pilot/tests/helpers/mailpit.ts`:

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

export const WIRE_SMTP_PORT = 11_025;
export const WIRE_POP3_PORT = 11_110;
export const WIRE_HTTP_PORT = 18_025;
export const WIRE_POP3_USER = 'ingest@wire.test';
export const WIRE_POP3_PASSWORD = 'wire-test-pass';

export type MailpitContext = {
  httpUrl: string;
  smtpHost: string;
  smtpPort: number;
  pop3Host: string;
  pop3Port: number;
  pop3User: string;
  pop3Password: string;
  clearAll(): Promise<void>;
  injectRawEml(raw: Buffer, envelopeTo?: string): Promise<void>;
  stop(): Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}/api/v1/info`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`mailpit not ready at ${url}`);
}

/** Reuse EC2 sidecar when MAILPIT_HTTP_URL set; else spawn local binary. */
export async function startMailpitForTests(): Promise<MailpitContext | null> {
  const external = process.env.MAILPIT_HTTP_URL;
  if (external) {
    return buildContext(external, null);
  }

  const binary = process.env.MAILPIT_BINARY ?? 'mailpit';
  const child = spawn(
    binary,
    [
      `--smtp=127.0.0.1:${WIRE_SMTP_PORT}`,
      `--pop3=127.0.0.1:${WIRE_POP3_PORT}`,
      `--listen=127.0.0.1:${WIRE_HTTP_PORT}`,
    ],
    {
      env: {
        ...process.env,
        MP_POP3_AUTH: `${WIRE_POP3_USER}:${WIRE_POP3_PASSWORD}`,
      },
      stdio: 'ignore',
    },
  );

  const httpUrl = `http://127.0.0.1:${WIRE_HTTP_PORT}`;
  try {
    await waitForHttp(httpUrl);
  } catch (err) {
    child.kill();
    return null;
  }

  return buildContext(httpUrl, child);
}

function buildContext(httpUrl: string, child: ChildProcess | null): MailpitContext {
  const u = new URL(httpUrl);
  return {
    httpUrl,
    smtpHost: u.hostname,
    smtpPort: WIRE_SMTP_PORT,
    pop3Host: u.hostname,
    pop3Port: WIRE_POP3_PORT,
    pop3User: WIRE_POP3_USER,
    pop3Password: WIRE_POP3_PASSWORD,
    async clearAll() {
      await fetch(`${httpUrl}/api/v1/messages`, { method: 'DELETE' });
    },
    async injectRawEml(raw: Buffer, envelopeTo = 'nava@legacyhotel.com') {
      const transport = nodemailer.createTransport({
        host: u.hostname,
        port: WIRE_SMTP_PORT,
        secure: false,
      });
      await transport.sendMail({
        envelope: { from: 'inject@wire.test', to: [envelopeTo] },
        raw,
      });
    },
    async stop() {
      if (!child) return;
      child.kill('SIGTERM');
      await sleep(500);
    },
  };
}

/** Wire env block for createPop3Client / process.env in tests. */
export function wireMailEnv(ctx: MailpitContext): NodeJS.ProcessEnv {
  return {
    MAIL_TRANSPORT_MODE: 'wire',
    SMTP_HOST: ctx.smtpHost,
    SMTP_PORT: String(ctx.smtpPort),
    SMTP_SECURE: 'false',
    POP3_HOST: ctx.pop3Host,
    POP3_PORT: String(ctx.pop3Port),
    POP3_TLS: 'false',
    POP3_USER: ctx.pop3User,
    POP3_PASSWORD: ctx.pop3Password,
  };
}

export function readFixtureEml(name: string): Buffer {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(path);
}
```

- [ ] **Step 4: Run test (requires mailpit binary on PATH or MAILPIT_HTTP_URL)**

Run: `cd apps/server-pilot && pnpm test tests/mailpit-lifecycle.test.ts`

Expected: PASS when `mailpit` installed; suite skipped otherwise

Install locally if needed: `brew install mailpit` (Mac) or run `bash apps/server-pilot/deploy/install-mailpit.sh` (Linux).

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/tests/helpers/mailpit.ts apps/server-pilot/tests/mailpit-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
test(mail): add mailpit lifecycle helper

Spawn or attach Mailpit for wire tests with purge and raw EML inject.
EOF
)"
```

---

### Task 3: Wire E2E suite

**Files:**
- Create: `apps/server-pilot/tests/mail-wire-e2e.test.ts`

**Interfaces:**
- Consumes: `startMailpitForTests`, `wireMailEnv`, `readFixtureEml` from Task 2
- Consumes: `createPop3Client`, `ingestOnce`, `callerFor`, `withSeededTestDb`, `__setSmtpTransportForTests`
- Produces: four passing wire E2E tests runnable on laptop + EC2

- [ ] **Step 1: Write the failing tests**

Create `apps/server-pilot/tests/mail-wire-e2e.test.ts`:

```typescript
/**
 * Wire E2E — SMTP/POP3 over Mailpit TCP (RealPop3Client + RealSmtpTransport).
 * Mirrors fixture-loopback-e2e.test.ts scenarios.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { ingestOnce } from '../src/mail/ingest/worker.js';
import { createPop3Client } from '../src/mail/ingest/pop3-client.js';
import { __setSmtpTransportForTests } from '../src/mail/send/smtp.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';
import {
  startMailpitForTests,
  wireMailEnv,
  readFixtureEml,
  type MailpitContext,
} from './helpers/mailpit.js';

const reachable = await probeTestDb();
const mailpitMaybe = process.env.MAILPIT_HTTP_URL || process.env.MAILPIT_BINARY || process.env.PATH;

describe.skipIf(!TEST_DB_AVAILABLE || !reachable || !mailpitMaybe)(
  'mail wire e2e (mailpit tcp)',
  () => {
    let ctx: MailpitContext;

    beforeAll(async () => {
      const started = await startMailpitForTests();
      if (!started) throw new Error('mailpit required for wire e2e');
      ctx = started;
    }, 60_000);

    afterAll(async () => {
      await ctx?.stop();
    });

    beforeEach(async () => {
      await ctx.clearAll();
      resetS3Storage();
      setS3Storage(new FakeS3Storage('wire-e2e-bucket'));
      __setSmtpTransportForTests(null);
      Object.assign(process.env, wireMailEnv(ctx));
    });

    function wirePop3() {
      return createPop3Client({
        MAIL_TRANSPORT_MODE: 'wire',
        POP3_HOST: ctx.pop3Host,
        POP3_PORT: ctx.pop3Port,
        POP3_USER: ctx.pop3User,
        POP3_PASSWORD: ctx.pop3Password,
        POP3_TLS: false,
      })!;
    }

    it('WIRE-1 IT-style BCC: centurion stamp → ingest → centurion inbox', async () => {
      await withSeededTestDb(async (db) => {
        await ctx.injectRawEml(readFixtureEml('centurion-stamped.eml'));
        const pop3 = wirePop3();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const centurion = await callerFor('user-manager', {
          db,
          requestedTransportId: 'transport-centurion',
        });
        const inbox = await centurion.mail.listThreads({ folder: 'inbox' });
        expect(
          inbox.threads.some((t) => t.subject.includes('Centurion booking')),
        ).toBe(true);
      });
    }, 60_000);

    it('WIRE-2 missing X-Zero-Mailbox → Nava spam', async () => {
      await withSeededTestDb(async (db) => {
        await ctx.injectRawEml(readFixtureEml('missing-owner.eml'));
        const pop3 = wirePop3();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const nava = await callerFor('user-nava', {
          db,
          requestedTransportId: 'transport-nava',
        });
        const spam = await nava.mail.listThreads({ folder: 'spam' });
        expect(spam.threads.length).toBeGreaterThan(0);
      });
    }, 60_000);

    it('WIRE-3 app send external → sent only (real SMTP, no loopback)', async () => {
      await withSeededTestDb(async (db) => {
        const nava = await callerFor('user-nava', {
          db,
          requestedTransportId: 'transport-nava',
        });
        await nava.mail.send({
          to: ['external@example.com'],
          subject: 'wire-outbound',
          html: '<p>out</p>',
          text: 'out',
        });
        const pop3 = wirePop3();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const sent = await nava.mail.listThreads({ folder: 'sent' });
        expect(sent.threads.some((t) => t.subject === 'wire-outbound')).toBe(true);
        const inbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(inbox.threads.filter((t) => t.subject === 'wire-outbound')).toHaveLength(0);
      });
    }, 60_000);

    it('WIRE-4 isolation: Centurion cannot see Nava wire thread', async () => {
      await withSeededTestDb(async (db) => {
        const nava = await callerFor('user-nava', {
          db,
          requestedTransportId: 'transport-nava',
        });
        await nava.mail.send({
          to: ['nava@legacyhotel.com'],
          subject: 'wire-nava-private',
          html: '<p>nava</p>',
          text: 'nava',
        });
        const pop3 = wirePop3();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const centurion = await callerFor('user-manager', {
          db,
          requestedTransportId: 'transport-centurion',
        });
        const inbox = await centurion.mail.listThreads({ folder: 'inbox' });
        expect(inbox.threads.filter((t) => t.subject === 'wire-nava-private')).toHaveLength(0);
        const navaInbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(navaInbox.threads.some((t) => t.subject === 'wire-nava-private')).toBe(true);
      });
    }, 60_000);
  },
);
```

- [ ] **Step 2: Run tests to verify they fail (then pass after Task 1)**

Run: `cd apps/server-pilot && pnpm test tests/mail-wire-e2e.test.ts`

Expected: PASS (4 tests) with Mailpit + DATABASE_URL

- [ ] **Step 3: Fix any WIRE-3/WIRE-4 routing gaps**

If WIRE-4 fails (Nava self-send not in Mailpit POP3): confirm `mail.send` uses `getSmtpTransport()` → real SMTP in wire mode and recipient `nava@` delivers to Mailpit inbox. If loopback still fires, re-check Task 1 `mail.ts` guard.

If WIRE-1 fails on owner routing: inspect `store.ts` `ownerHeaderValue` parse — fixture path already green; wire should match.

- [ ] **Step 4: Re-run full wire + transport suite**

Run: `cd apps/server-pilot && pnpm test tests/mail-wire-e2e.test.ts tests/transport-mode.test.ts tests/fixture-loopback-e2e.test.ts`

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/tests/mail-wire-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(mail): add wire E2E suite over Mailpit TCP

Mirror fixture loopback scenarios using RealPop3/RealSmtp against Mailpit.
EOF
)"
```

---

### Task 4: EC2 Mailpit sidecar + wire gate

**Files:**
- Create: `apps/server-pilot/deploy/install-mailpit.sh`
- Create: `apps/server-pilot/deploy/mailpit.ecosystem.cjs`
- Create: `apps/server-pilot/deploy/wire-gate.sh`
- Modify: `apps/server-pilot/deploy/deferred-real-mail-readiness.md`

**Interfaces:**
- Produces: `wire-gate.sh` exit 0 with `wire-gate: PASS`; requires Mailpit PM2 app `mailpit` running

- [ ] **Step 1: Create install script**

`apps/server-pilot/deploy/install-mailpit.sh`:

```bash
#!/usr/bin/env bash
# Install pinned Mailpit static binary to /usr/local/bin/mailpit (idempotent).
set -euo pipefail
VERSION="${MAILPIT_VERSION:-v1.27.3}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ASSET="mailpit-linux-amd64.tar.gz" ;;
  aarch64|arm64) ASSET="mailpit-linux-arm64.tar.gz" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac
URL="https://github.com/axllent/mailpit/releases/download/${VERSION}/${ASSET}"
TMP="$(mktemp -d)"
curl -fsSL "$URL" -o "$TMP/mailpit.tgz"
sudo tar -xzf "$TMP/mailpit.tgz" -C /usr/local/bin mailpit
/usr/local/bin/mailpit --version
echo "install-mailpit: OK ${VERSION}"
```

- [ ] **Step 2: Create PM2 ecosystem**

`apps/server-pilot/deploy/mailpit.ecosystem.cjs`:

```javascript
/** Mailpit sidecar — localhost only, for wire-gate pre-IT runs. */
module.exports = {
  apps: [
    {
      name: 'mailpit',
      script: '/usr/local/bin/mailpit',
      args: [
        '--smtp=127.0.0.1:11025',
        '--pop3=127.0.0.1:11110',
        '--listen=127.0.0.1:18025',
      ],
      env: {
        MP_POP3_AUTH: 'ingest@wire.test:wire-test-pass',
      },
      autorestart: true,
      max_restarts: 5,
    },
  ],
};
```

- [ ] **Step 3: Create wire gate script**

`apps/server-pilot/deploy/wire-gate.sh`:

```bash
#!/usr/bin/env bash
# Pre-IT wire gate: Mailpit TCP + wire vitest on prod RDS. NOT run every deploy.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

echo "== wire-gate: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

if ! command -v mailpit >/dev/null 2>&1; then
  echo "== install mailpit =="
  bash "${SCRIPT_DIR}/install-mailpit.sh"
fi

echo "== pm2: ensure mailpit sidecar =="
pm2 start "${SCRIPT_DIR}/mailpit.ecosystem.cjs" || pm2 restart mailpit || true
pm2 save || true

export MAILPIT_HTTP_URL="http://127.0.0.1:18025"
export NODE_ENV=test
export MAIL_TRANSPORT_MODE=wire
export SMTP_HOST=127.0.0.1
export SMTP_PORT=11025
export SMTP_SECURE=false
export POP3_HOST=127.0.0.1
export POP3_PORT=11110
export POP3_TLS=false
export POP3_USER=ingest@wire.test
export POP3_PASSWORD=wire-test-pass

echo "== pm2: stop worker (avoid POP3 race) =="
pm2 stop worker || true

echo "== vitest: wire suite =="
cd "$SERVER_PILOT"
pnpm test tests/mailpit-lifecycle.test.ts \
  tests/mail-wire-e2e.test.ts \
  tests/transport-mode.test.ts \
  --reporter=dot

echo "== pm2: start worker =="
pm2 start worker

echo "wire-gate: PASS"
```

- [ ] **Step 4: Update deferred-real-mail-readiness.md**

Add section after fixture gate:

```markdown
## Wire gate (pre–IT only, Option B)

Runs `RealPop3Client` / `RealSmtpTransport` against localhost Mailpit — not every deploy.

**One-time on EC2:** `bash apps/server-pilot/deploy/install-mailpit.sh`

**Pre-IT SSM:**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/wire-gate.sh'
```

Production `.env.production` stays `MAIL_TRANSPORT_MODE=fixture`. Wire env is forced only inside `wire-gate.sh`.
```

- [ ] **Step 5: Run wire gate on EC2 via SSM**

From laptop:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/wire-gate.sh'
```

Expected: `Status: Success`, stdout contains `wire-gate: PASS`

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/deploy/install-mailpit.sh \
  apps/server-pilot/deploy/mailpit.ecosystem.cjs \
  apps/server-pilot/deploy/wire-gate.sh \
  apps/server-pilot/deploy/deferred-real-mail-readiness.md
git commit -m "$(cat <<'EOF'
feat(deploy): add mailpit sidecar and wire gate script

Pre-IT gate exercises TCP mail clients without changing fixture deploy cadence.
EOF
)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/solutions/architecture-patterns/mail-transport-mode-fixture-vs-real.md`
- Modify: `CONCEPTS.md`

- [ ] **Step 1: Extend architecture doc**

Add section **Wire mode (Mailpit)**:

- `MAIL_TRANSPORT_MODE=wire` — real TCP clients, localhost Mailpit, no loopback
- Gate: `wire-gate.sh` pre-IT; `fixture-loopback-gate.sh` every deploy
- IT handoff still flips to `real`, not `wire`

- [ ] **Step 2: Update CONCEPTS.md**

Add under MAIL_TRANSPORT_MODE:

```markdown
### Wire transport
`MAIL_TRANSPORT_MODE=wire` — `RealPop3Client` + `RealSmtpTransport` against Mailpit on 127.0.0.1. Pre-IT confidence for protocol path. Distinct from fixture loopback (in-process) and real (Exchange).
```

- [ ] **Step 3: Commit**

```bash
git add docs/solutions/architecture-patterns/mail-transport-mode-fixture-vs-real.md CONCEPTS.md
git commit -m "$(cat <<'EOF'
docs(mail): document wire transport and option B gate

Clarify wire vs fixture loopback vs real IT handoff.
EOF
)"
```

---

### Task 6: Wire gate handoff report

**Files:**
- Create: `docs/superpowers/plans/handoff-reports/2026-07-04-mail-wire-gate-report.md`

- [ ] **Step 1: Run EC2 wire gate and capture output**

SSM command from Task 4 Step 5. Record: deployed SHA, test count, duration, Mailpit version.

- [ ] **Step 2: Write report**

Template:

```markdown
# Mail Wire Gate Report — 2026-07-04

**Gate:** `wire-gate.sh` (Option B — pre-IT only)
**Deployed SHA:** `<git rev-parse HEAD>`
**EC2:** i-008f737974a9ba9b3 (af-south-1)

## Results

| Check | Status |
|-------|--------|
| Mailpit sidecar | PM2 `mailpit` on 127.0.0.1:11025/11110/18025 |
| WIRE-1 centurion inbox | PASS |
| WIRE-2 Nava spam | PASS |
| WIRE-3 sent only | PASS |
| WIRE-4 isolation | PASS |

## Cadence

- Every deploy: `fixture-loopback-gate.sh` (unchanged)
- Pre-IT: `wire-gate.sh` (this report)

## Next

- IT handoff: `activate-real-mail.sh` after wire green
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/handoff-reports/2026-07-04-mail-wire-gate-report.md
git commit -m "$(cat <<'EOF'
docs(mail): wire gate handoff report after EC2 green
EOF
)"
```

---

## Self-Review

| Check | Status |
|-------|--------|
| Spec coverage: wire mode, cross-mailbox suite, EC2 gate Option B, fixture unchanged | Tasks 1–6 |
| Placeholder scan | No TBD/TODO steps |
| Type consistency: `MailTransportMode` includes `wire` everywhere loopback checks mode | Task 1 |
| WIRE-4 uses real SMTP not loopback | Task 1 + 3 |
| Mailpit POP3 auth documented | Task 2 env `MP_POP3_AUTH` |

## Test Matrix Reference

| ID | Scenario | Inject path | Assert |
|----|----------|-------------|--------|
| WIRE-1 | IT BCC + `X-Zero-Mailbox: centurion@` | `centurion-stamped.eml` → SMTP raw | Centurion inbox |
| WIRE-2 | Missing owner header | `missing-owner.eml` → SMTP raw | Nava spam |
| WIRE-3 | App outbound external | `mail.send` → Real SMTP | Sent only, not inbox |
| WIRE-4 | Nava self-send isolation | `mail.send` → Real SMTP → POP3 | Nava inbox; Centurion blind |

---

## Execution Mode

**Autonomous overnight — no user checkpoint.**

REQUIRED SUB-SKILL: superpowers:subagent-driven-development — one subagent per task, orchestrator reviews between tasks, continues until all Done criteria checked.

Do not ask "which approach?" Resume on any red via RCA loop until both EC2 gates green.
