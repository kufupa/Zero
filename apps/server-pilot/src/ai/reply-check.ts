import { and, eq } from 'drizzle-orm';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';
import type { ModelAdapter } from './bedrock/adapter.js';
import { resolveModelAdapter } from './bedrock/factory.js';
import { enqueueAiRun, markAiRunSucceeded, type AiRunFence } from './run-ledger.js';
import { getDb, type DB } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import type { MailEnv } from '../env.js';

export const REPLY_CHECK_PROMPT_VERSION = 'reply-check/1';
export const REPLY_CHECK_MODEL_ID = 'gpt-6-luna';
export const REPLY_NEEDS_ACTION = 'reply_needs_action';
const BODY_CAP = 8 * 1024;
const REASON_CAP = 140;

class ReplyCheckClaimLostError extends Error {}

export type ReplyRecheckMode = 'off' | 'shadow' | 'on';
export type ReplyCheckOutcome = 'handled' | 'waiting_on_guest' | 'needs_more_action';

const OUTCOMES: readonly ReplyCheckOutcome[] = ['handled', 'waiting_on_guest', 'needs_more_action'];

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'reason'],
  properties: {
    outcome: { type: 'string', enum: [...OUTCOMES] },
    reason: { type: 'string' },
  },
} as const;

export function parseReplyRecheckMode(raw: string | undefined): ReplyRecheckMode {
  const value = raw?.trim().toLowerCase();
  if (value === 'shadow' || value === 'on') return value;
  return 'off';
}

export function replyCheckIdempotencyKey(workItemId: string, replyMessageId: string): string {
  return `reply-check:${workItemId}:${replyMessageId}`;
}

/** Staff-written part of a reply: drop quoted history and a `-- ` signature. */
export function staffReplyBody(text: string): string {
  const withoutHtml = text.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const cutQuote = withoutHtml.split(/\n(?:On .+ wrote:|From:\s)/i)[0] ?? withoutHtml;
  const cutSig = cutQuote.split(/\n-- \n/)[0] ?? cutQuote;
  return cutSig.replace(/[ \t]+\n/g, '\n').trim();
}

function oneLine(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, REASON_CAP);
}

function capBody(text: string): string {
  return text.length <= BODY_CAP ? text : text.slice(0, BODY_CAP);
}

function parseOutcome(output: Record<string, unknown>): { outcome: ReplyCheckOutcome; reason: string } | null {
  const outcome = output.outcome;
  if (outcome !== 'handled' && outcome !== 'waiting_on_guest' && outcome !== 'needs_more_action') return null;
  return { outcome, reason: oneLine(output.reason) };
}

function lunaAdapter(env: NodeJS.Dict<string>): ModelAdapter {
  return resolveModelAdapter({
    NODE_ENV: (env.NODE_ENV as MailEnv['NODE_ENV']) ?? 'development',
    AI_ENABLED: env.AI_ENABLED === 'true' || env.AI_ENABLED === '1',
    AI_MODEL_ID: env.AI_MODEL_ID,
    BEDROCK_REGION: env.BEDROCK_REGION,
    BEDROCK_GUARDRAIL_ID: env.BEDROCK_GUARDRAIL_ID,
    BEDROCK_GUARDRAIL_VERSION: env.BEDROCK_GUARDRAIL_VERSION,
    AI_TRIAGE_MODEL_PROFILE: 'gpt6_luna_max',
  });
}

export async function enqueueReplyCheckIfNeeded(
  db: DB,
  input: { transportId: string; threadId: string; workItemId: string; replyMessageId: string },
  env: NodeJS.Dict<string> = process.env,
): Promise<void> {
  if (parseReplyRecheckMode(env.REPLY_RECHECK) === 'off') return;
  if (resolvePropertyTransport(input.transportId).kind !== 'property') return;
  if (!input.threadId || !input.workItemId || !input.replyMessageId) return;
  try {
    await enqueueAiRun(
      {
        transportId: input.transportId,
        threadId: input.threadId,
        triggerMessageId: input.replyMessageId,
        runKind: 'reply_check',
        idempotencyKey: replyCheckIdempotencyKey(input.workItemId, input.replyMessageId),
        modelId: REPLY_CHECK_MODEL_ID,
        promptVersion: REPLY_CHECK_PROMPT_VERSION,
        workItemId: input.workItemId,
      },
      db,
    );
  } catch (error) {
    console.error('reply_check_enqueue_failed', error instanceof Error ? error.message : String(error));
  }
}

export async function executeReplyCheckRun(input: {
  run: {
    id: string;
    transportId: string;
    threadId: string | null;
    triggerMessageId: string;
    workItemId: string | null;
    attempts: number;
  };
  fence: AiRunFence;
  db?: DB;
  env?: NodeJS.Dict<string>;
  adapter?: ModelAdapter;
}): Promise<{ runId: string; state: 'succeeded' | 'retry_wait' }> {
  const db = input.db ?? getDb();
  const env = input.env ?? process.env;
  const mode = parseReplyRecheckMode(env.REPLY_RECHECK);
  const claim = {
    runId: input.run.id,
    claimOwner: input.fence.claimOwner,
    claimToken: input.fence.claimToken,
    expectedStates: ['running' as const],
  };

  const succeed = async (metrics: Record<string, unknown>) => {
    const marked = await markAiRunSucceeded({ ...claim, metrics }, db);
    if (!marked) return { runId: input.run.id, state: 'retry_wait' as const };
    return { runId: input.run.id, state: 'succeeded' as const };
  };

  if (mode === 'off' || !input.run.workItemId) {
    return succeed({ replyCheck: { skipped: mode === 'off' ? 'off' : 'missing_work_item' } });
  }

  const [item] = await db
    .select()
    .from(workItem)
    .where(and(eq(workItem.id, input.run.workItemId), eq(workItem.transportId, input.run.transportId)))
    .limit(1);
  if (!item) {
    return succeed({ replyCheck: { skipped: 'missing_work_item' } });
  }
  if (item.sentMessageId !== input.run.triggerMessageId) {
    return succeed({ replyCheck: { skipped: 'superseded' } });
  }
  if (item.status !== 'done') {
    return succeed({ replyCheck: { skipped: 'not_done' } });
  }

  const [reply] = await db
    .select({ textBody: message.textBody, htmlBody: message.htmlBody })
    .from(message)
    .where(and(eq(message.id, input.run.triggerMessageId), eq(message.transportId, input.run.transportId)))
    .limit(1);
  const [source] = item.sourceMessageId
    ? await db
        .select({ textBody: message.textBody, htmlBody: message.htmlBody })
        .from(message)
        .where(and(eq(message.id, item.sourceMessageId), eq(message.transportId, input.run.transportId)))
        .limit(1)
    : [];

  const replyBody = capBody(staffReplyBody(reply?.textBody || reply?.htmlBody || ''));
  const sourceBody = capBody(staffReplyBody(source?.textBody || source?.htmlBody || ''));

  let parsed: { outcome: ReplyCheckOutcome; reason: string } | null = null;
  try {
    const adapter = input.adapter ?? lunaAdapter(env);
    const model = await adapter.invoke({
      modelId: REPLY_CHECK_MODEL_ID,
      systemPrompt: `You re-read a hotel staff reply to a guest request.
Pick exactly one outcome:
- handled: the reply fully answers the request (a complete quote, confirmation, or clear decline).
- waiting_on_guest: the staff asked the guest a question or told them the hotel will wait on them.
- needs_more_action: the staff deferred, answered only part, or said they would come back later (for example with rates).
Output JSON only. reason is one short staff-facing line, no guest names.`,
      userPrompt: `Work kind: ${item.kind}\nSource request:\n${sourceBody}\n\nStaff reply:\n${replyBody}`,
      responseSchema: RESPONSE_SCHEMA,
    });
    parsed = parseOutcome(model.output ?? {});
  } catch (error) {
    console.error('reply_check_failed', {
      runId: input.run.id,
      workItemId: item.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return succeed({ replyCheck: { failed: true } });
  }

  if (!parsed) {
    console.error('reply_check_failed', { runId: input.run.id, workItemId: item.id, error: 'invalid_outcome' });
    return succeed({ replyCheck: { failed: true } });
  }

  const shouldReopen = mode === 'on' && parsed.outcome === 'needs_more_action';
  if (!shouldReopen) {
    return succeed({
      replyCheck: {
        outcome: parsed.outcome,
        mode,
        applied: false,
        reasonLine: parsed.reason || null,
      },
    });
  }

  try {
    return await db.transaction(async (tx) => {
      const reasonLine = parsed.reason || 'Needs more action';
      const [reopened] = await tx
        .update(workItem)
        .set({
          status: 'needs_you',
          sentAt: null,
          sentMessageId: null,
          followUpDueAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workItem.id, item.id),
            eq(workItem.transportId, input.run.transportId),
            eq(workItem.status, 'done'),
            eq(workItem.sentMessageId, input.run.triggerMessageId),
          ),
        )
        .returning({ id: workItem.id });
      if (reopened) {
        await tx.insert(workEvent).values({
          workItemId: item.id,
          actorKind: 'system',
          type: 'status.changed',
          value: {
            from: 'done',
            to: 'needs_you',
            reason: REPLY_NEEDS_ACTION,
            reasonLine,
            replyMessageId: input.run.triggerMessageId,
          },
        });
      }
      const marked = await markAiRunSucceeded(
        {
          ...claim,
          metrics: {
            replyCheck: {
              outcome: parsed.outcome,
              mode,
              applied: Boolean(reopened),
              reasonLine: parsed.reason || null,
            },
          },
        },
        tx as unknown as DB,
      );
      if (!marked) throw new ReplyCheckClaimLostError();
      return { runId: input.run.id, state: 'succeeded' as const };
    });
  } catch (error) {
    if (error instanceof ReplyCheckClaimLostError) {
      return { runId: input.run.id, state: 'retry_wait' };
    }
    throw error;
  }
}
