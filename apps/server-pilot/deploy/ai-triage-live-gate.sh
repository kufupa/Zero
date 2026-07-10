#!/usr/bin/env bash
# Opt-in live AI triage gate: Mailpit -> ingest -> Bedrock triage -> category -> Playwright (no drafts).
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
cd "$REPO_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"
PLAYWRIGHT_ENV_FILE="${PLAYWRIGHT_ENV_FILE:-/tmp/ai-triage-playwright.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

export BEDROCK_TRIAGE_LIVE_TEST=1
export AI_ENABLED=true
export AI_WRITE_GATE_ENABLED=true
export AI_DRAFTS_ENABLED=false
export MAIL_TRANSPORT_MODE=wire
export SMTP_HOST=127.0.0.1
export SMTP_PORT=11025
export SMTP_SECURE=false
export POP3_HOST=127.0.0.1
export POP3_PORT=11110
export POP3_TLS=false
export POP3_USER=ingest@wire.test
export POP3_PASSWORD=wire-test-pass
export MAILPIT_HTTP_URL=http://127.0.0.1:18025
export ZERO_DEMO_FRONTEND_ONLY=0
export VITE_FRONTEND_ONLY=0

echo "== ai-triage-live-gate: drafts=${AI_DRAFTS_ENABLED} write=${AI_WRITE_GATE_ENABLED} ==" >&2

bash "${SCRIPT_DIR}/bedrock-live-gate.sh"
bash "${SCRIPT_DIR}/wire-gate.sh"

echo "== pm2: restart ai-worker with triage-only gates ==" >&2
pm2 restart ai-worker --update-env || pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env

echo "== centurion-live corpus: inject, ingest, triage assert ==" >&2
echo "== seed:prod (pilot mailbox transports) ==" >&2
(cd "$SERVER_PILOT" && pnpm seed:prod)
pm2 stop worker 2>/dev/null || true
pm2 stop ai-worker 2>/dev/null || true
cd "$SERVER_PILOT"
export PLAYWRIGHT_ENV_FILE
pnpm exec tsx <<'TS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { and, eq } from 'drizzle-orm';
import { ingestOnce } from './src/mail/ingest/worker.js';
import { createPop3Client } from './src/mail/ingest/pop3-client.js';
import { parseEnv } from './src/env.js';
import { getDb } from './src/db/client.js';
import {
  aiWorkflowRun,
  mailCategory,
  mailThread,
  mailThreadCategory,
  message,
} from './src/db/schema/mail.js';
import { runAiWorkerOnce } from './src/ai/worker.js';

const FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/centurion-live');
const manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8')) as {
  cases: Array<{
    id: string;
    file: string;
    kind: 'guest' | 'hotel_sent';
    expectedCategory: string | null;
    expectedUrgent: boolean;
  }>;
};

const PLAYWRIGHT_ENV_FILE = process.env.PLAYWRIGHT_ENV_FILE ?? '/tmp/ai-triage-playwright.env';
const INGEST_MAILBOX_ID = 'ingest-nava-legacy';
const ENVELOPE_TO = 'nava@legacyhotel.com';
const DEADLINE_MS = 180_000;
const PLAYWRIGHT_CASE_ID = 'group-kleinkaap';

function parseSubject(raw: Buffer): string {
  const head = raw.toString('utf8').split(/\r?\n\r?\n/)[0] ?? '';
  const match = head.match(/^Subject:\s*(.+)$/im);
  if (!match) throw new Error('fixture missing Subject header');
  return match[1]!.trim();
}

function log(msg: string) {
  console.error(msg);
}

async function injectRawEml(raw: Buffer): Promise<void> {
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: 11025,
    secure: false,
  });
  await transport.sendMail({
    envelope: { from: 'inject@wire.test', to: [ENVELOPE_TO] },
    raw,
  });
}

async function ingestAndPump(): Promise<void> {
  const env = parseEnv(process.env);
  const pop3 = createPop3Client(env);
  if (!pop3) throw new Error('POP3 client unavailable');
  await ingestOnce({ pop3, ingestMailboxId: INGEST_MAILBOX_ID, maxMessages: 10 });
  for (let i = 0; i < 8; i++) {
    await runAiWorkerOnce();
  }
}

type MetricsShape = {
  category?: string;
  urgent?: boolean;
  applyMode?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    rateTableVersion?: string;
  };
};

function assertMetrics(metrics: MetricsShape, caseId: string): void {
  if (!metrics.applyMode) {
    throw new Error(`${caseId}: missing metrics.applyMode`);
  }
  const usage = metrics.usage;
  if (!usage) throw new Error(`${caseId}: missing metrics.usage`);
  if ((usage.inputTokens ?? 0) <= 0) throw new Error(`${caseId}: usage.inputTokens must be > 0`);
  if ((usage.outputTokens ?? 0) <= 0) throw new Error(`${caseId}: usage.outputTokens must be > 0`);
  if (usage.estimatedCostUsd == null) throw new Error(`${caseId}: missing usage.estimatedCostUsd`);
  if (!usage.rateTableVersion) throw new Error(`${caseId}: missing usage.rateTableVersion`);
}

async function waitForGuestTriage(subject: string, caseId: string, expectedCategory: string, expectedUrgent: boolean) {
  const db = getDb();
  const deadline = Date.now() + DEADLINE_MS;

  while (Date.now() < deadline) {
    const rows = await db
      .select({ threadId: mailThread.id, messageId: message.id })
      .from(message)
      .innerJoin(mailThread, eq(mailThread.id, message.threadId))
      .where(eq(message.subject, subject))
      .limit(1);

    if (rows[0]) {
      const { threadId, messageId } = rows[0];
      const runs = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.threadId, threadId));
      const triage = runs.find((run) => run.runKind === 'inbound_triage');
      const draftRuns = runs.filter((run) => run.runKind === 'candidate_draft');
      if (draftRuns.length > 0) {
        throw new Error(`${caseId}: candidate_draft runs present with AI_DRAFTS_ENABLED=false`);
      }

      if (triage?.state === 'succeeded') {
        const metrics = (triage.metrics ?? {}) as MetricsShape;
        assertMetrics(metrics, caseId);

        if (metrics.category !== expectedCategory) {
          throw new Error(
            `${caseId}: category mismatch expected=${expectedCategory} actual=${metrics.category ?? 'missing'}`,
          );
        }
        if (metrics.urgent !== expectedUrgent) {
          throw new Error(
            `${caseId}: urgent mismatch expected=${expectedUrgent} actual=${metrics.urgent ?? 'missing'}`,
          );
        }

        const memberships = await db
          .select({ slug: mailCategory.slug })
          .from(mailThreadCategory)
          .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
          .where(eq(mailThreadCategory.threadId, threadId));
        const slugs = memberships.map((row) => row.slug);
        const hasUrgent = slugs.includes('urgent');

        if (expectedUrgent !== hasUrgent) {
          throw new Error(
            `${caseId}: durable urgent mismatch expected=${expectedUrgent} slugs=${slugs.join(',')}`,
          );
        }

        if (expectedCategory === 'spam') {
          const [thread] = await db.select({ spamAt: mailThread.spamAt }).from(mailThread).where(eq(mailThread.id, threadId));
          if (!thread?.spamAt) {
            throw new Error(`${caseId}: expected spamAt set for spam category`);
          }
        } else if (!slugs.includes(expectedCategory)) {
          throw new Error(
            `${caseId}: durable category mismatch expected=${expectedCategory} slugs=${slugs.join(',')}`,
          );
        }

        return {
          caseId,
          subject,
          threadId,
          messageId,
          triageRunId: triage.id,
          category: metrics.category,
          urgent: metrics.urgent,
          applyMode: metrics.applyMode,
        };
      }
    }

    await ingestAndPump();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`${caseId}: triage wait timed out for subject ${subject}`);
}

async function assertHotelSent(subject: string, caseId: string) {
  const db = getDb();
  const deadline = Date.now() + DEADLINE_MS;

  while (Date.now() < deadline) {
    const rows = await db
      .select({ messageId: message.id, direction: message.direction })
      .from(message)
      .where(eq(message.subject, subject))
      .limit(1);

    if (rows[0]) {
      if (rows[0].direction !== 'outbound') {
        throw new Error(`${caseId}: expected direction=outbound got ${rows[0].direction}`);
      }
      const runs = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.triggerMessageId, rows[0].messageId));
      if (runs.length > 0) {
        throw new Error(`${caseId}: expected zero triage runs got ${runs.length}`);
      }
      return { caseId, subject, direction: rows[0].direction, triageRuns: 0 };
    }

    await ingestAndPump();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`${caseId}: hotel-sent ingest timed out for subject ${subject}`);
}

const results: Array<Record<string, unknown>> = [];

for (const testCase of manifest.cases) {
  const raw = readFileSync(join(FIXTURE_ROOT, testCase.file));
  const subject = parseSubject(raw);
  log(`== case ${testCase.id}: inject ${testCase.file} subject="${subject}" ==`);

  await injectRawEml(raw);
  await ingestAndPump();

  if (testCase.kind === 'hotel_sent') {
    results.push(await assertHotelSent(subject, testCase.id));
    continue;
  }

  if (!testCase.expectedCategory) {
    throw new Error(`${testCase.id}: guest case missing expectedCategory`);
  }

  results.push(
    await waitForGuestTriage(
      subject,
      testCase.id,
      testCase.expectedCategory,
      testCase.expectedUrgent,
    ),
  );
}

const playwrightCase = manifest.cases.find((c) => c.id === PLAYWRIGHT_CASE_ID);
if (!playwrightCase?.expectedCategory) {
  throw new Error(`playwright fixture case missing: ${PLAYWRIGHT_CASE_ID}`);
}
const playwrightRaw = readFileSync(join(FIXTURE_ROOT, playwrightCase.file));
const playwrightSubject = parseSubject(playwrightRaw);
const playwrightFolder = playwrightCase.expectedCategory;

writeFileSync(
  PLAYWRIGHT_ENV_FILE,
  `AI_TRIAGE_FIXTURE_SUBJECT=${JSON.stringify(playwrightSubject)}\nAI_TRIAGE_FIXTURE_FOLDER=${playwrightFolder}\n`,
);

const summary = {
  gate: 'ai-triage-live-gate',
  cases: results,
  playwrightFixture: {
    caseId: PLAYWRIGHT_CASE_ID,
    subject: playwrightSubject,
    folder: playwrightFolder,
  },
};

console.log(JSON.stringify(summary));
TS

# shellcheck disable=SC1090
source "$PLAYWRIGHT_ENV_FILE"
export AI_TRIAGE_FIXTURE_SUBJECT
export AI_TRIAGE_FIXTURE_FOLDER

echo "== playwright live triage spec (no draft card) ==" >&2
export ZERO_DEMO_FRONTEND_ONLY=0
export VITE_FRONTEND_ONLY=0
cd "$REPO_ROOT"
PLAYWRIGHT_INCLUDE_SPECS=ai-triage-live.spec.ts bash "${SCRIPT_DIR}/playwright-ec2-gate.sh"

pm2 start "${SCRIPT_DIR}/pm2.config.cjs" --only ai-worker --update-env 2>/dev/null || pm2 restart ai-worker --update-env || true
echo "ai-triage-live-gate: PASS subject=${AI_TRIAGE_FIXTURE_SUBJECT} folder=${AI_TRIAGE_FIXTURE_FOLDER}"
