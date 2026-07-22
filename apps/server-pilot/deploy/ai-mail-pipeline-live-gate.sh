#!/usr/bin/env bash
# Opt-in live AI mail pipeline gate: Mailpit -> ingest -> Bedrock triage -> category -> draft -> Playwright.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
cd "$REPO_ROOT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

export BEDROCK_PIPELINE_LIVE_TEST=1
export AI_ENABLED=true
export AI_WRITE_GATE_ENABLED="${AI_WRITE_GATE_ENABLED:-true}"
export AI_DRAFTS_ENABLED="${AI_DRAFTS_ENABLED:-true}"
export MAIL_TRANSPORT_MODE=wire
export ZERO_DEMO_FRONTEND_ONLY=0
export VITE_FRONTEND_ONLY=0
export AI_PIPELINE_FIXTURE_SUBJECT="AI Pipeline Live Gate $(date -u +%Y%m%dT%H%M%SZ)"

echo "== ai-mail-pipeline-live-gate: subject=${AI_PIPELINE_FIXTURE_SUBJECT} =="
echo "== gates: write=${AI_WRITE_GATE_ENABLED} drafts=${AI_DRAFTS_ENABLED} =="

bash "${SCRIPT_DIR}/bedrock-live-gate.sh"
bash "${SCRIPT_DIR}/wire-gate.sh"

echo "== pm2: restart ai-worker with pipeline gates =="
pm2 restart ai-worker --update-env || pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env

echo "== inject fixture email via Mailpit SMTP =="
cd "$SERVER_PILOT"
pnpm exec tsx -e "
import nodemailer from 'nodemailer';
const subject = process.env.AI_PIPELINE_FIXTURE_SUBJECT!;
const transport = nodemailer.createTransport({
  host: '127.0.0.1',
  port: 11025,
  secure: false,
});
await transport.sendMail({
  from: 'Group Planner <group.planner@example.com>',
  to: 'navaai@legacyhotels.co.za',
  subject,
  text: 'Need 20 rooms for a group booking next month. Please quote availability.',
});
console.log('injected', subject);
"

echo "== ingest one POP3 cycle =="
pnpm exec tsx -e "
import { ingestOnce } from './src/mail/ingest/worker.js';
import { createPop3Client } from './src/mail/ingest/pop3-client.js';
import { parseEnv } from './src/env.js';
const env = parseEnv(process.env);
const pop3 = createPop3Client(env);
if (!pop3) throw new Error('POP3 client unavailable');
const result = await ingestOnce({
  pop3,
  ingestMailboxId: 'ingest-nava-legacy',
  maxMessages: 10,
});
console.log(JSON.stringify(result));
"

echo "== wait for AI pipeline DB predicates =="
pnpm exec tsx -e "
import { and, eq } from 'drizzle-orm';
import { getDb } from './src/db/client.js';
import { aiWorkflowRun, mailCategory, mailDraft, mailThread, mailThreadCategory, message } from './src/db/schema/mail.js';

const subject = process.env.AI_PIPELINE_FIXTURE_SUBJECT!;
const writeGate = process.env.AI_WRITE_GATE_ENABLED === 'true';
const draftsEnabled = process.env.AI_DRAFTS_ENABLED === 'true';
const deadline = Date.now() + 120_000;
const db = getDb();

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
    const draft = runs.find((run) => run.runKind === 'candidate_draft');

    const triageReady = triage?.state === 'succeeded';
    const draftReady = !draftsEnabled || draft?.state === 'succeeded';

    if (triageReady && draftReady) {
      let categorySlug = 'shadow';
      let draftId: string | undefined;
      if (writeGate) {
        const memberships = await db
          .select({ slug: mailCategory.slug })
          .from(mailThreadCategory)
          .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
          .where(eq(mailThreadCategory.threadId, threadId));
        categorySlug = memberships.find((row) => row.slug !== 'urgent')?.slug ?? 'unknown';
      }
      if (draftsEnabled) {
        const drafts = await db
          .select({ id: mailDraft.id })
          .from(mailDraft)
          .where(and(eq(mailDraft.threadId, threadId), eq(mailDraft.status, 'candidate')));
        draftId = drafts[0]?.id;
      }

      await import('./src/ai/worker.js').then(async ({ runAiWorkerOnce }) => {
        for (let i = 0; i < 5; i++) {
          const worked = await runAiWorkerOnce();
          if (!worked) break;
        }
      });

      console.log(
        JSON.stringify({
          threadId,
          messageId,
          triageRunId: triage?.id,
          draftRunId: draft?.id,
          categorySlug,
          draftId,
        }),
      );
      process.exit(0);
    }
  }

  await import('./src/ai/worker.js').then(async ({ runAiWorkerOnce }) => {
    await import('./src/mail/ingest/worker.js').then(async ({ ingestOnce }) => {
      const { createPop3Client } = await import('./src/mail/ingest/pop3-client.js');
      const { parseEnv } = await import('./src/env.js');
      const env = parseEnv(process.env);
      const pop3 = createPop3Client(env);
      if (pop3) {
        await ingestOnce({ pop3, ingestMailboxId: 'ingest-nava-legacy', maxMessages: 10 });
      }
    });
    for (let i = 0; i < 3; i++) {
      await runAiWorkerOnce();
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));
}

throw new Error('AI pipeline wait timed out for subject ' + subject);
"

if [ "${AI_DRAFTS_ENABLED}" = "true" ] && [ "${AI_WRITE_GATE_ENABLED}" = "true" ]; then
  echo "== playwright live pipeline spec =="
  export ZERO_DEMO_FRONTEND_ONLY=0
  export VITE_FRONTEND_ONLY=0
  cd "$REPO_ROOT"
  PLAYWRIGHT_INCLUDE_SPECS=ai-mail-pipeline.spec.ts bash "${SCRIPT_DIR}/playwright-ec2-gate.sh"
fi

echo "ai-mail-pipeline-live-gate: PASS subject=${AI_PIPELINE_FIXTURE_SUBJECT}"
