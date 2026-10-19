/**
 * Builds the extraction prompt for each exported selection with prod `buildInboundPrompt`, so eval input = prod input.
 * Thread context is cut to messages strictly before the target (leak-free). No database, no network.
 *
 *   pnpm exec tsx scripts/triage-dataset/build-prompts.ts <selections.jsonl.gz> <threads.jsonl.gz> <out.jsonl>
 * Also writes <out>.parts.json with the system prompt pieces and the response schema.
 */
import { createReadStream, writeFileSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ACTION_CLASSIFICATION_RULES,
  EXTRACTION_RULES,
  buildInboundPrompt,
} from '../../src/ai/extraction/extract.js';
import { CENTURION_HOTEL_RULES } from '../../src/ai/reservationist-decision.js';
import { mailExtractionSchema } from '../../src/ai/extraction/schema.js';
import type { SyncedQuoteSelection } from '../../src/ai/quote-workflow-synced-selection.js';

async function* lines(path: string) {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield JSON.parse(line);
}

async function main() {
  const [selPath, threadsPath, outPath] = process.argv.slice(2);
  if (!selPath || !threadsPath || !outPath) throw new Error('usage: build-prompts <sel> <threads> <out>');
  const meta = new Map<string, { from: string | null; mailbox: string | null }>();
  for await (const row of lines(threadsPath)) meta.set(row.id, { from: row.from_address, mailbox: row.mailbox });
  const out = createWriteStream(outPath);
  let n = 0;
  for await (const raw of lines(selPath)) {
    if (!raw.messageId || raw.missing || raw.error) continue;
    const selection = raw as SyncedQuoteSelection;
    const targetMs = Date.parse(selection.threadReferenceAt ?? selection.receivedAt ?? '');
    const all = selection.threadMessages ?? [];
    const prior = all.filter((m) => Number.isFinite(targetMs) && Date.parse(m.timestamp ?? '') < targetMs);
    const info = meta.get(selection.messageId!) ?? { from: selection.fromAddress ?? null, mailbox: null };
    const prompt = buildInboundPrompt({ ...selection, threadMessages: prior }, info.from, info.mailbox, {
      env: {},
    });
    out.write(
      `${JSON.stringify({
        id: selection.messageId,
        user: prompt.user,
        status: prompt.system.slice(prompt.system.lastIndexOf('Thread context status:')),
        priorCount: prior.length,
        droppedLater: all.length - prior.length,
      })}\n`,
    );
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
