/**
 * Builds the extraction prompt for each exported selection with prod `buildInboundPrompt`, so eval input = prod input.
 * Thread context is cut to messages strictly before the target that do not reply to it (leak-free). Prompt limits come
 * from process.env, as in prod. No database, no network.
 *
 *   pnpm exec tsx scripts/triage-dataset/build-prompts.ts <selections.jsonl.gz> <threads.jsonl.gz> <out.jsonl>
 * Also writes <out>.parts.json with the system prompt pieces and the response schema.
 */
import {
  ACTION_CLASSIFICATION_RULES,
  EXTRACTION_RULES,
  buildInboundPrompt,
} from '../../src/ai/extraction/extract.js';
import type { SyncedQuoteSelection } from '../../src/ai/quote-workflow-synced-selection.js';
import { CENTURION_HOTEL_RULES } from '../../src/ai/reservationist-decision.js';
import { createReadStream, writeFileSync, createWriteStream } from 'node:fs';
import { mailExtractionSchema } from '../../src/ai/extraction/schema.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

async function* lines(path: string) {
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

async function main() {
  const [selPath, threadsPath, outPath] = process.argv.slice(2);
  if (!selPath || !threadsPath || !outPath)
    throw new Error('usage: build-prompts <sel> <threads> <out>');
  const meta = new Map<
    string,
    { from: string | null; mailbox: string | null; header: string | null }
  >();
  const repliesTo = new Map<string, Set<string>>();
  for await (const row of lines(threadsPath)) {
    meta.set(row.id, {
      from: row.from_address,
      mailbox: row.mailbox,
      header: row.message_id_header,
    });
    if (row.in_reply_to) {
      const set = repliesTo.get(row.thread_id) ?? new Set<string>();
      set.add(`${row.in_reply_to}\u0000${row.subject ?? ''}\u0000${row.text_body ?? ''}`);
      repliesTo.set(row.thread_id, set);
    }
  }
  const out = createWriteStream(outPath);
  let n = 0;
  for await (const raw of lines(selPath)) {
    if (!raw.messageId || raw.missing || raw.error) continue;
    const selection = raw as SyncedQuoteSelection;
    const targetMs = Date.parse(selection.threadReferenceAt ?? selection.receivedAt ?? '');
    const all = selection.threadMessages ?? [];
    const info = meta.get(selection.messageId!) ?? {
      from: selection.fromAddress ?? null,
      mailbox: null,
      header: null,
    };
    // Stored times can be the sender's Date header, so a reply can look earlier than the mail it answers.
    const answers = repliesTo.get(selection.threadId ?? '');
    const repliesToTarget = (m: { subject: string; bodyText: string }) =>
      Boolean(info.header && answers?.has(`${info.header}\u0000${m.subject}\u0000${m.bodyText}`));
    const prior = all.filter(
      (m) =>
        Number.isFinite(targetMs) &&
        Date.parse(m.timestamp ?? '') < targetMs &&
        !repliesToTarget(m),
    );
    const prompt = buildInboundPrompt(
      { ...selection, threadMessages: prior },
      info.from,
      info.mailbox,
      {
        env: process.env,
      },
    );
    if (
      !out.write(
        `${JSON.stringify({
          id: selection.messageId,
          user: prompt.user,
          status: prompt.system.slice(prompt.system.lastIndexOf('Thread context status:')),
          priorCount: prior.length,
          droppedLater: all.length - prior.length,
        })}\n`,
      )
    )
      await new Promise((resolve) => out.once('drain', resolve));
    n += 1;
  }
  out.end();
  writeFileSync(
    `${outPath}.parts.json`,
    JSON.stringify({
      hotel: CENTURION_HOTEL_RULES,
      extraction: EXTRACTION_RULES,
      action: ACTION_CLASSIFICATION_RULES,
      schema: zodToJsonSchema(mailExtractionSchema, { $refStrategy: 'none' }),
    }),
  );
  console.log(JSON.stringify({ prompts: n }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
