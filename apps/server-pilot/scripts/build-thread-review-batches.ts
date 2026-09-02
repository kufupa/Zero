#!/usr/bin/env node
/**
 * Build size-packed review batches from the connected-mailbox Markdown dump.
 *
 * Reads the gitignored private dump, groups message blocks by thread, projects
 * each message onto a compact semantic form (text body preferred, stripped
 * HTML fallback when the text body is empty), packs whole threads into byte-
 * capped batch files, and writes a manifest describing every batch.
 *
 * Output lives under the gitignored `.private/connected-mailbox-corpus/batches/`
 * root. This script never talks to a database and never prints message content.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

export type ThreadReviewBatchDescriptor = {
  batchId: string;
  file: string;
  threadIds: string[];
  messageCount: number;
  bytes: number;
  sha256: string;
  oversize: boolean;
};

export type ThreadReviewBatchManifest = {
  schemaVersion: 1;
  asOf: string | null;
  sourceDumpName: string;
  threadCount: number;
  messageCount: number;
  batchByteTarget: number;
  divergenceThreadCount: number;
  batches: ThreadReviewBatchDescriptor[];
};

export type ThreadReviewBatchBuilderResult = {
  threadCount: number;
  batchCount: number;
  manifest: ThreadReviewBatchManifest;
};

export type ThreadReviewBatchBuilderRequest = {
  dumpPath: string;
  outputRoot: string;
  batchByteTarget: number;
  overwrite?: boolean;
  expectedThreadCount?: number;
};

type ParsedMessage = {
  messageId: string;
  subject: string;
  threadId: string;
  direction: string;
  received: string;
  fromAddress: string;
  textBody: string;
  htmlBody: string;
};

const MESSAGE_HEADER_PATTERN = /^## Message \d+: (.*)$/m;

function extractMetadataField(block: string, label: string): string {
  const pattern = new RegExp('- \\*\\*' + label + ':\\*\\* `?([^`\n]+)`?');
  const match = pattern.exec(block);
  return match ? match[1].trim() : '';
}

function extractFencedBodyAlternative(block: string, heading: string): string {
  const headingIndex = block.indexOf(`### ${heading}`);
  if (headingIndex === -1) return '';
  const rest = block.slice(headingIndex);
  // Confine to this section: stop at the next '### ' heading if present.
  const nextHeadingOffset = rest.slice(1).indexOf('\n### ');
  const section = nextHeadingOffset === -1 ? rest : rest.slice(0, nextHeadingOffset + 1);
  const fenceStart = section.indexOf('```');
  if (fenceStart === -1) return '';
  const afterFence = section.slice(fenceStart + 3);
  const newlineIndex = afterFence.indexOf('\n');
  if (newlineIndex === -1) return '';
  const bodyStart = afterFence.slice(newlineIndex + 1);
  const fenceEnd = bodyStart.indexOf('\n```');
  if (fenceEnd === -1) return bodyStart.replace(/\s+$/, '');
  return bodyStart.slice(0, fenceEnd);
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

function normalizeForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseDump(markdown: string): {
  asOf: string | null;
  messages: ParsedMessage[];
} {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const asOfMatch = /- Snapshot as of: (\S+)/.exec(normalized);
  const chunks = normalized.split(/\n(?=## Message \d+: )/);
  const messages: ParsedMessage[] = [];
  for (const chunk of chunks) {
    const headerMatch = MESSAGE_HEADER_PATTERN.exec(chunk);
    if (!headerMatch) continue;
    const threadId = extractMetadataField(chunk, 'Thread ID');
    if (!threadId) {
      throw new Error('Connected mailbox dump contains a message block without Thread ID');
    }
    messages.push({
      subject: headerMatch[1].trim(),
      messageId: extractMetadataField(chunk, 'Message ID'),
      threadId,
      direction: extractMetadataField(chunk, 'Direction') || 'unknown',
      received: extractMetadataField(chunk, 'Received'),
      fromAddress: extractMetadataField(chunk, 'From'),
      textBody: extractFencedBodyAlternative(chunk, 'Text body'),
      htmlBody: extractFencedBodyAlternative(chunk, 'HTML body'),
    });
  }
  const markerCount = (normalized.match(/^## Message \d+:/gm) ?? []).length;
  if (markerCount !== messages.length) {
    throw new Error(
      `Connected mailbox dump message count ${markerCount} does not match parsed messages ${messages.length}`,
    );
  }
  return { asOf: asOfMatch ? asOfMatch[1] : null, messages };
}

function renderThread(
  threadId: string,
  messages: ParsedMessage[],
): {
  text: string;
  divergent: boolean;
} {
  let divergent = false;
  const lines: string[] = [`=== THREAD ${threadId} ===`];
  for (const message of messages) {
    lines.push(
      `-- MSG ${message.messageId} | ${message.direction} | ${message.received} | from ${message.fromAddress} | subj: ${message.subject}`,
    );
    let body = message.textBody;
    if (body.trim() === '' && message.htmlBody.trim() !== '') {
      body = stripHtmlToText(message.htmlBody);
    }
    if (
      message.textBody.trim() !== '' &&
      message.htmlBody.trim() !== '' &&
      normalizeForComparison(stripHtmlToText(message.htmlBody)) !==
        normalizeForComparison(message.textBody)
    ) {
      divergent = true;
      lines.push('[note: html body diverges from text body; consult raw dump for full html]');
    }
    lines.push(body.trim() === '' ? '(no body)' : body);
    lines.push('');
  }
  return { text: `${lines.join('\n')}\n`, divergent };
}

async function directoryHasOutputs(outputRoot: string): Promise<boolean> {
  try {
    const entries = await readdir(outputRoot);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export function createThreadReviewBatchBuilder(): (
  request: ThreadReviewBatchBuilderRequest,
) => Promise<ThreadReviewBatchBuilderResult> {
  return async function buildThreadReviewBatches(
    request: ThreadReviewBatchBuilderRequest,
  ): Promise<ThreadReviewBatchBuilderResult> {
    const { dumpPath, outputRoot, batchByteTarget, overwrite = false } = request;

    let markdown: string;
    try {
      markdown = await readFile(dumpPath, 'utf8');
    } catch {
      throw new Error(`Connected mailbox dump not readable at ${dumpPath}`);
    }
    if (!markdown.includes('Connected mailbox')) {
      throw new Error(`File at ${dumpPath} is not a connected mailbox dump`);
    }
    if (!Number.isInteger(batchByteTarget) || batchByteTarget <= 0) {
      throw new Error('batchByteTarget must be a positive integer');
    }

    if (!overwrite && (await directoryHasOutputs(outputRoot))) {
      throw new Error(`Output root already exists and is not empty: ${outputRoot}`);
    }

    const { asOf, messages } = parseDump(markdown);

    // Preserve first-appearance thread order; group messages by thread.
    const threadOrder: string[] = [];
    const threads = new Map<string, ParsedMessage[]>();
    for (const message of messages) {
      const existing = threads.get(message.threadId);
      if (!existing) {
        threadOrder.push(message.threadId);
        threads.set(message.threadId, [message]);
      } else {
        existing.push(message);
      }
    }

    if (messages.length === 0 || threadOrder.length === 0) {
      throw new Error('Connected mailbox dump contains no messages');
    }
    if (
      request.expectedThreadCount !== undefined &&
      threadOrder.length !== request.expectedThreadCount
    ) {
      throw new Error(
        `Connected mailbox thread count ${threadOrder.length} does not match expected ${request.expectedThreadCount}`,
      );
    }

    await mkdir(outputRoot, { recursive: true });

    const batches: ThreadReviewBatchDescriptor[] = [];
    let currentThreads: string[] = [];
    let currentSections: string[] = [];
    let currentBytes = 0;
    let currentMessages = 0;
    let divergenceThreadCount = 0;
    let batchSequence = 0;

    const flushCurrentBatch = async (oversize: boolean): Promise<void> => {
      if (currentThreads.length === 0) return;
      batchSequence += 1;
      const batchId = `batch-${String(batchSequence).padStart(3, '0')}`;
      const fileName = `${batchId}.txt`;
      const content = currentSections.join('');
      const bytes = Buffer.byteLength(content, 'utf8');
      const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
      const tempPath = path.join(outputRoot, `${fileName}.tmp`);
      const finalPath = path.join(outputRoot, fileName);
      await writeFile(tempPath, content, 'utf8');
      await rename(tempPath, finalPath);
      batches.push({
        batchId,
        file: fileName,
        threadIds: currentThreads,
        messageCount: currentMessages,
        bytes,
        sha256,
        oversize,
      });
      currentThreads = [];
      currentSections = [];
      currentBytes = 0;
      currentMessages = 0;
    };

    for (const threadId of threadOrder) {
      const threadMessages = threads.get(threadId) ?? [];
      const rendered = renderThread(threadId, threadMessages);
      if (rendered.divergent) divergenceThreadCount += 1;
      const sectionBytes = Buffer.byteLength(rendered.text, 'utf8');

      if (sectionBytes > batchByteTarget) {
        // Oversize thread solos its own batch rather than being truncated.
        await flushCurrentBatch(false);
        currentThreads = [threadId];
        currentSections = [rendered.text];
        currentMessages = threadMessages.length;
        await flushCurrentBatch(true);
        continue;
      }

      if (currentBytes + sectionBytes > batchByteTarget) {
        await flushCurrentBatch(false);
      }
      currentThreads.push(threadId);
      currentSections.push(rendered.text);
      currentBytes += sectionBytes;
      currentMessages += threadMessages.length;
    }
    await flushCurrentBatch(false);

    const manifest: ThreadReviewBatchManifest = {
      schemaVersion: 1,
      asOf,
      sourceDumpName: path.basename(dumpPath),
      threadCount: threadOrder.length,
      messageCount: messages.length,
      batchByteTarget,
      divergenceThreadCount,
      batches,
    };
    const manifestTemp = path.join(outputRoot, 'manifest.json.tmp');
    const manifestFinal = path.join(outputRoot, 'manifest.json');
    await writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(manifestTemp, manifestFinal);

    return {
      threadCount: threadOrder.length,
      batchCount: batches.length,
      manifest,
    };
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  function requireValue(flag: string): string {
    const index = args.indexOf(flag);
    if (index === -1 || index + 1 >= args.length) {
      throw new Error(`Missing required argument ${flag} <value>`);
    }
    return args[index + 1];
  }
  const dumpPath = path.resolve(requireValue('--dump'));
  const outputRoot = path.resolve(requireValue('--out'));
  const batchByteTarget = Number.parseInt(requireValue('--target-bytes'), 10);
  const overwrite = args.includes('--overwrite');
  const build = createThreadReviewBatchBuilder();
  const result = await build({
    dumpPath,
    outputRoot,
    batchByteTarget,
    overwrite,
    expectedThreadCount: 2403,
  });
  console.log(
    JSON.stringify({
      threadCount: result.threadCount,
      batchCount: result.batchCount,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

void fileURLToPath;
void stat;
