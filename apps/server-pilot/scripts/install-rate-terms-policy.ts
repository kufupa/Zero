/**
 * Install one hotel_rate_terms document from an outbound HMS confirmation letter.
 * Read-only DB + S3 GET. Writes only under .private/ (0600). Never commits.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { and, desc, eq } from 'drizzle-orm';
import { letterIdentity } from '../src/ai/reservationist-rate-policy-source.js';
import {
  readInstalledStaffQuoteConfiguration,
  resolveStaffQuoteRatePolicyPath,
} from '../src/ai/staff-quote-installation.js';
import { closeDb, getDb, type DB } from '../src/db/client.js';
import { attachment, message } from '../src/db/schema/mail.js';
import { ownerRefBelongsToProperty } from '../src/hms/hms-read-target.js';
import { isCliEntry } from '../src/lib/is-cli-entry.js';
import {
  ARTIFACT_MAX_INPUT_BYTES,
  extractEmbeddedPdfText,
} from '../src/mail/artifacts/read-artifact.js';
import { getS3Storage } from '../src/storage/s3.js';

const repoRootDefault = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const VAT =
  /\b1\. All rates are quoted in ZAR and include Value Added Tax \(VAT\) at the prevailing rate\./;
const LEVY = /\b2\. Average Rate per night includes the 1% Tourism Levy per room per night\./;
const CONFLICT =
  /\b(?:VAT|Value Added Tax|Tourism Levy|taxes|levies)[^.\n]{0,100}\bexclud(?:e|ed|es|ing)\b|\bexclud(?:e|ed|es|ing)\b[^.\n]{0,100}\b(?:VAT|Value Added Tax|Tourism Levy|taxes|levies)\b/i;

export type OutboundPdfCandidate = {
  id: string;
  transportId: string;
  threadId: string;
  direction: string;
  eventAt: string;
  attachmentId: string;
  s3Key: string;
  contentType: string;
  byteSize: number;
  inline: boolean;
};

export type LetterClauseVariant = {
  score: number;
  confirmation: string | null;
  vat: string | null;
  levy: string | null;
};

export type InstallRateTermsResult = {
  apply: boolean;
  propertyCode: string;
  scanned: number;
  matched: number;
  installed: string[];
  skipped: Array<{ ownerRef: string; reason: 'no_letter_from_transport' }>;
  sourceHash?: string;
  receiptHash?: string;
  corpusHash?: string;
};

export type InstallRateTermsDependencies = {
  propertyCode: string;
  ownerRef: string;
  alsoOwnerRefs: readonly string[];
  apply: boolean;
  repoRoot: string;
  outputDir?: string;
  policyPathForOwnerRef?: (ownerRef: string) => Promise<string>;
  listOutboundPdfs: (ownerRef: string) => Promise<readonly OutboundPdfCandidate[]>;
  getPdfBytes: (s3Key: string) => Promise<Buffer | null>;
  extractText: (body: Buffer, attachmentId: string) => Promise<string | null>;
  now: () => Date;
};

export class RateTermsLetterNotFoundError extends Error {
  constructor(readonly closest: LetterClauseVariant[]) {
    super('rate_terms_letter_not_found');
    this.name = 'RateTermsLetterNotFoundError';
  }
}

export function parseInstallRateTermsArgs(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      property: { type: 'string' },
      'owner-ref': { type: 'string' },
      'also-owner-refs': { type: 'string' },
      apply: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.apply && values['dry-run']) throw new Error('conflicting run modes');
  if (!values.apply && !values['dry-run']) throw new Error('need --dry-run or --apply');
  const propertyCode = values.property?.trim() ?? '';
  const ownerRef = values['owner-ref']?.trim() ?? '';
  if (!propertyCode) throw new Error('need --property');
  if (!ownerRef) throw new Error('need --owner-ref');
  return {
    propertyCode,
    ownerRef,
    alsoOwnerRefs: (values['also-owner-refs'] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value && value !== ownerRef),
    apply: values.apply === true,
  };
}

export function scoreHotelRateTermsLetter(propertyCode: string, text: string): LetterClauseVariant {
  const letter = letterIdentity(propertyCode);
  const flat = text.replace(/\s+/g, ' ').trim();
  const confirmation = letter ? (flat.match(letter.confirmation)?.[0] ?? null) : null;
  const vat = flat.match(VAT)?.[0] ?? null;
  const levy = flat.match(LEVY)?.[0] ?? null;
  return {
    score:
      Number(Boolean(letter?.hotel.test(text))) +
      Number(Boolean(confirmation)) +
      Number(Boolean(vat)) +
      Number(Boolean(levy)) +
      Number(!CONFLICT.test(text)),
    confirmation,
    vat,
    levy,
  };
}

function insidePrivate(repoRoot: string, path: string) {
  const rel = relative(resolve(repoRoot, '.private'), path);
  return isAbsolute(path) && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function repoRelative(repoRoot: string, path: string) {
  const rel = relative(repoRoot, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('rate_terms_path_invalid');
  return rel;
}

async function writePrivateAtomic(path: string, bytes: Buffer | string) {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(tmp, bytes, { mode: 0o600 });
  await rename(tmp, path);
}

export async function listOutboundPdfCandidates(db: DB, ownerRef: string) {
  const rows = await db
    .select({
      id: message.id,
      transportId: message.transportId,
      threadId: message.threadId,
      direction: message.direction,
      sentAt: message.sentAt,
      createdAt: message.createdAt,
      attachmentId: attachment.id,
      s3Key: attachment.s3Key,
      contentType: attachment.mimeType,
      byteSize: attachment.sizeBytes,
      inline: attachment.isInline,
    })
    .from(message)
    .innerJoin(attachment, eq(attachment.messageId, message.id))
    .where(
      and(
        eq(message.transportId, ownerRef),
        eq(message.direction, 'outbound'),
        eq(attachment.mimeType, 'application/pdf'),
      ),
    )
    .orderBy(desc(message.sentAt), desc(message.createdAt), desc(attachment.id))
    .limit(80);
  return rows.flatMap((row) => {
    const eventAt = (row.sentAt ?? row.createdAt)?.toISOString();
    if (!eventAt || row.direction !== 'outbound' || row.byteSize < 1) return [];
    return [{ ...row, eventAt }];
  });
}

async function findMatchingLetter(deps: InstallRateTermsDependencies, ownerRef: string) {
  const nowMs = deps.now().getTime();
  const closest: LetterClauseVariant[] = [];
  let scanned = 0;
  for (const row of await deps.listOutboundPdfs(ownerRef)) {
    scanned += 1;
    if (
      row.transportId !== ownerRef ||
      row.direction !== 'outbound' ||
      row.contentType !== 'application/pdf' ||
      row.byteSize < 1 ||
      row.byteSize > ARTIFACT_MAX_INPUT_BYTES ||
      Date.parse(row.eventAt) >= nowMs
    )
      continue;
    const body = await deps.getPdfBytes(row.s3Key);
    if (!body || body.length !== row.byteSize) continue;
    const text = await deps.extractText(body, row.attachmentId);
    if (!text) continue;
    const scored = scoreHotelRateTermsLetter(deps.propertyCode, text);
    closest.push(scored);
    if (scored.score === 5)
      return { match: { row, body, sourceHash: sha(body) }, scanned, closest };
  }
  closest.sort((a, b) => b.score - a.score);
  return { match: null, scanned, closest: closest.slice(0, 3) };
}

export async function installRateTermsPolicy(deps: InstallRateTermsDependencies) {
  if (!letterIdentity(deps.propertyCode)) throw new Error('rate_terms_property_unknown');
  const ownerRefs = [deps.ownerRef, ...deps.alsoOwnerRefs];
  if (new Set(ownerRefs).size !== ownerRefs.length) throw new Error('rate_terms_owner_duplicate');
  for (const ownerRef of ownerRefs) {
    if (!ownerRefBelongsToProperty(ownerRef, deps.propertyCode))
      throw new Error('rate_terms_owner_scope_invalid');
  }
  const outputDir =
    deps.outputDir ?? join(deps.repoRoot, '.private', `${deps.propertyCode}-rate-terms`);
  if (!insidePrivate(deps.repoRoot, outputDir)) throw new Error('rate_terms_path_invalid');

  let scanned = 0;
  const installed: string[] = [];
  const skipped: InstallRateTermsResult['skipped'] = [];
  let sourceHash: string | undefined;
  let receiptHash: string | undefined;
  let corpusHash: string | undefined;
  let primaryClosest: LetterClauseVariant[] = [];

  for (const ownerRef of ownerRefs) {
    const found = await findMatchingLetter(deps, ownerRef);
    scanned += found.scanned;
    if (ownerRef === deps.ownerRef) primaryClosest = found.closest;
    const match = found.match;
    if (!match || !(Date.parse(match.row.eventAt) < Date.parse(deps.now().toISOString()))) {
      skipped.push({ ownerRef, reason: 'no_letter_from_transport' });
      continue;
    }
    const { row, body, sourceHash: letterHash } = match;
    const requestAt = deps.now().toISOString();
    const pdfPath = join(outputDir, `${row.attachmentId}.pdf`);
    const corpusPath = join(outputDir, `${ownerRef}-corpus.jsonl`);
    const receiptPath = join(outputDir, `${row.attachmentId}.receipts.json`);
    const corpusBytes = `${JSON.stringify({
      id: row.id,
      transportId: row.transportId,
      direction: 'outbound',
      threadId: row.threadId,
      eventAt: row.eventAt,
      attachmentDescriptors: [
        {
          id: row.attachmentId,
          messageId: row.id,
          s3Key: row.s3Key,
          contentType: 'application/pdf',
          byteSize: row.byteSize,
          inline: row.inline,
        },
      ],
    })}\n`;
    const snapshotHash = sha(corpusBytes);
    const receiptBytes = `${JSON.stringify([
      {
        status: 'acquired',
        authority: 'authorized_corpus_read',
        localPath: pdfPath,
        locator: { s3Key: row.s3Key },
        sourceSnapshotHash: snapshotHash,
        metadata: {
          attachmentId: row.attachmentId,
          messageId: row.id,
          messageAt: row.eventAt,
          threadId: row.threadId,
          ownerRef: row.transportId,
          mimeType: row.contentType,
          sizeBytes: row.byteSize,
          sourceHash: letterHash,
          inline: row.inline,
          disclosure: 'staff_only',
        },
        scopeBinding: {
          ownerRef: row.transportId,
          threadId: row.threadId,
          requestAt,
          sourceSnapshotHash: snapshotHash,
          disclosure: 'staff_only',
        },
      },
    ])}\n`;
    sourceHash = letterHash;
    receiptHash = sha(receiptBytes);
    corpusHash = snapshotHash;
    if (deps.apply) {
      const policyPath = deps.policyPathForOwnerRef
        ? await deps.policyPathForOwnerRef(ownerRef)
        : resolveStaffQuoteRatePolicyPath(
            readInstalledStaffQuoteConfiguration(deps.propertyCode),
            ownerRef,
          );
      if (!insidePrivate(deps.repoRoot, policyPath) || !insidePrivate(deps.repoRoot, pdfPath))
        throw new Error('rate_terms_path_invalid');
      await writePrivateAtomic(pdfPath, body);
      await writePrivateAtomic(corpusPath, corpusBytes);
      await writePrivateAtomic(receiptPath, receiptBytes);
      if (existsSync(policyPath)) {
        await copyFile(policyPath, `${policyPath}.bak`);
        chmodSync(`${policyPath}.bak`, 0o600);
      }
      const policy = JSON.parse(await readFile(policyPath, 'utf8')) as {
        ownerRef: string;
        propertyCode: string;
        documents: Array<Record<string, unknown>>;
        corpusPaths?: string[];
      };
      if (policy.ownerRef !== ownerRef || policy.propertyCode !== deps.propertyCode)
        throw new Error('rate_terms_policy_scope_invalid');
      policy.documents = [
        ...policy.documents.filter(
          (item) => !(item.kind === 'hotel_rate_terms' && item.attachmentId === row.attachmentId),
        ),
        {
          kind: 'hotel_rate_terms',
          ref: `hotel_rate_terms:${deps.propertyCode}:${row.attachmentId}`,
          propertyCode: deps.propertyCode,
          ownerRef,
          messageId: row.id,
          threadId: row.threadId,
          messageAt: row.eventAt,
          publicationAt: row.eventAt,
          direction: 'outbound',
          attachmentId: row.attachmentId,
          locator: { s3Key: row.s3Key, byteSize: row.byteSize },
          path: repoRelative(deps.repoRoot, pdfPath),
          sourceHash: letterHash,
          acquisitionReceiptPath: repoRelative(deps.repoRoot, receiptPath),
          acquisitionReceiptSHA256: receiptHash,
        },
      ];
      policy.corpusPaths = [repoRelative(deps.repoRoot, corpusPath)];
      await writePrivateAtomic(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    }
    installed.push(ownerRef);
  }

  if (!installed.includes(deps.ownerRef)) throw new RateTermsLetterNotFoundError(primaryClosest);
  return {
    apply: deps.apply,
    propertyCode: deps.propertyCode,
    scanned,
    matched: installed.length,
    installed: deps.apply ? installed : [],
    skipped,
    sourceHash,
    receiptHash,
    corpusHash,
  };
}

export async function runInstallRateTermsPolicyCli(argv: readonly string[]) {
  let args: ReturnType<typeof parseInstallRateTermsArgs>;
  try {
    args = parseInstallRateTermsArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'invalid_args');
    return 2;
  }
  const storage = getS3Storage();
  try {
    const result = await installRateTermsPolicy({
      propertyCode: args.propertyCode,
      ownerRef: args.ownerRef,
      alsoOwnerRefs: args.alsoOwnerRefs,
      apply: args.apply,
      repoRoot: repoRootDefault,
      listOutboundPdfs: (ownerRef) => listOutboundPdfCandidates(getDb(), ownerRef),
      getPdfBytes: async (s3Key) =>
        (await storage.getObjectBounded(s3Key, ARTIFACT_MAX_INPUT_BYTES))?.body ?? null,
      extractText: async (body, attachmentId) => {
        const extracted = await extractEmbeddedPdfText(
          {
            body,
            declaredSize: body.length,
            declaredMime: 'application/pdf',
            objectMime: 'application/pdf',
          },
          { attachmentId },
        );
        return extracted.data.reason === 'text' ? extracted.data.text : null;
      },
      now: () => new Date(),
    });
    console.log(
      JSON.stringify({
        apply: result.apply,
        propertyCode: result.propertyCode,
        scanned: result.scanned,
        matched: result.matched,
        installed: result.installed.length,
        skipped: result.skipped.length,
        sourceHash: result.sourceHash,
        receiptHash: result.receiptHash,
        corpusHash: result.corpusHash,
      }),
    );
    return 0;
  } catch (error) {
    if (error instanceof RateTermsLetterNotFoundError) {
      console.log(
        JSON.stringify({
          error: 'rate_terms_letter_not_found',
          propertyCode: args.propertyCode,
          closest: error.closest,
        }),
      );
      return 3;
    }
    const code = error instanceof Error ? error.message : 'error';
    console.log(JSON.stringify({ error: /^[a-z0-9_]{2,60}$/i.test(code) ? code : 'error' }));
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

if (isCliEntry(import.meta.url)) {
  void runInstallRateTermsPolicyCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
