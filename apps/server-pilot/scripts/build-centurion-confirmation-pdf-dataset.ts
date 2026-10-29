import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPdf, extractPagesMarkdownAsync } from '@firecrawl/pdf-inspector';
import {
  confirmationNumberCandidates,
  extractPdfFields,
  PDF_FIELD_NAMES,
  type ExtractedPdfFields,
  type PdfFieldKey,
} from './centurion-confirmation-pdf-fields.js';
import { linkRecord, loadMessages } from './centurion-confirmation-pdf-links.js';

const PDF_INSPECTOR_VERSION = '1.25.2';
const OUTPUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', '.private');

type JsonRecord = Record<string, unknown>;
type AttachmentSource = {
  schemaVersion: number;
  selection: JsonRecord;
  attachment: JsonRecord;
  parentMessage: JsonRecord;
  fromHeaderEvidence: {
    status: string;
    headerSha256?: string;
    initialStatus?: string;
    retryAttempted?: boolean;
  };
  file: JsonRecord;
};
type ExtractedPdf = {
  source: AttachmentSource;
  record: JsonRecord;
  fields: ExtractedPdfFields;
  confirmationNumbers: Array<{ value: string; pageNumber: number }>;
};
function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((item): item is string => item !== null) : [];
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function markLegacyNoMatchUnverified(
  evidence: AttachmentSource['fromHeaderEvidence'],
): AttachmentSource['fromHeaderEvidence'] {
  return evidence.status === 'no_match'
    ? { ...evidence, initialStatus: 'no_match', status: 'unverified' }
    : evidence;
}

function requiredArgument(name: string): string {
  const prefix = `${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error('configuration_missing');
  return path.resolve(value);
}

function optionalArgument(name: string): string | null {
  const prefix = `${name}=`;
  const value = process.argv.slice(2).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  return value ? path.resolve(value) : null;
}

export async function safeInputPath(root: string, relativePath: string): Promise<string> {
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('input_path_invalid');
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error('input_path_invalid');
  return realTarget;
}

export async function extractPdf(source: AttachmentSource, inputDir: string): Promise<ExtractedPdf> {
  const attachment = source.attachment;
  const file = source.file;
  const attachmentId = asString(attachment.attachmentId) ?? 'unknown';
  const relativePath = asString(file.path);
  const fileStatus = asString(file.status) ?? 'unknown';
  let extraction: JsonRecord;
  let fields: ExtractedPdfFields = {
    guestName: [],
    confirmationNumber: [],
    arrivalDate: [],
    departureDate: [],
    accommodationType: [],
    occupancy: [],
    averageDailyRate: [],
    rateIncludes: [],
    totalAccommodation: [],
  };
  let confirmations: Array<{ value: string; pageNumber: number }> = [];

  if (fileStatus !== 'available' || !relativePath) {
    extraction = { status: 'not_available', errorClass: null };
  } else {
    try {
      const pdfPath = await safeInputPath(inputDir, relativePath);
      const bytes = await readFile(pdfPath);
      const detected = detectPdf(bytes);
      const parsed = await extractPagesMarkdownAsync(bytes);
      const pages = parsed.pages.map((page) => ({
        pageIndex: page.page,
        pageNumber: page.page + 1,
        markdown: page.markdown,
        needsOcr: page.needsOcr,
        ocrReason: page.ocrReason ?? null,
      }));
      fields = extractPdfFields(parsed.pages);
      confirmations = confirmationNumberCandidates(fields);
      extraction = {
        status: 'native_text_extracted',
        pdfInspectorVersion: PDF_INSPECTOR_VERSION,
        classification: {
          pdfType: detected.pdfType,
          pageCount: detected.pageCount,
          confidence: detected.confidence,
          pagesNeedingOcrOneBased: detected.pagesNeedingOcr,
        },
        documentInfo: {
          title: detected.title ?? null,
          author: detected.author ?? null,
          subject: detected.subject ?? null,
          keywords: detected.keywords ?? null,
          creator: detected.creator ?? null,
          producer: detected.producer ?? null,
          creationDate: detected.creationDate ?? null,
          modDate: detected.modDate ?? null,
        },
        quality: {
          pagesNeedingOcrOneBased: parsed.pagesNeedingOcr,
          ocrReasonsByPage: parsed.ocrReasonsByPage,
          pagesWithTables: parsed.pagesWithTables,
          pagesWithColumns: parsed.pagesWithColumns,
          isComplex: parsed.isComplex,
          hasEncodingIssues: detected.hasEncodingIssues,
          cmapGaps: detected.cmapGaps,
        },
        extractedFields: fields,
        confirmationNumberCandidates: confirmations,
        textSha256: sha256(pages.map((page) => page.markdown).join('\n\n')),
        pages,
      };
    } catch (error) {
      extraction = {
        status: 'parser_failure',
        errorClass: error instanceof Error ? error.name : 'Error',
      };
    }
  }

  const parent = source.parentMessage;
  const parentMessageDbId = asString(parent.messageDbId);
  const fileHash = asString(file.sha256);
  return {
    source,
    fields,
    confirmationNumbers: confirmations,
    record: {
      schemaVersion: 'centurion-confirmation-pdf/v1',
      recordId: attachmentId,
      candidateOnly: true,
      qualification: {
        transportId: 'transport-centurion',
        direction: 'outbound',
        filenamePatternMatch: true,
        fromHeaderPrefix: source.fromHeaderEvidence.status === 'match'
          ? true
          : source.fromHeaderEvidence.status === 'no_match'
            ? false
            : null,
        fromHeaderEvidence: source.fromHeaderEvidence,
        includedInSourceCandidateSet: true,
      },
      source: {
        snapshotId: null,
        attachmentId,
        attachmentS3Key: asString(attachment.s3Key),
        sourceFilePath: relativePath,
      },
      attachment: {
        filename: asString(attachment.filename),
        mimeType: asString(attachment.mimeType),
        declaredBytes: typeof attachment.byteSize === 'number' ? attachment.byteSize : null,
        storedBytes: typeof file.bytes === 'number' ? file.bytes : null,
        sha256: fileHash,
        pdfMagicValid: file.pdfMagicValid === true,
        sizeMatchesMetadata: file.sizeMatchesMetadata === true,
        status: fileStatus,
      },
      parentMessage: {
        messageDbId: parentMessageDbId,
        threadId: asString(parent.threadId),
        messageIdHeader: asString(parent.messageIdHeader),
        subject: asString(parent.subject),
        direction: 'outbound',
        storedFromAddress: asString(parent.storedFromAddress),
        to: asStringArray(parent.toAddresses),
        cc: asStringArray(parent.ccAddresses),
        bcc: asStringArray(parent.bccAddresses),
        sentAt: parent.sentAt ?? null,
        receivedAt: parent.receivedAt ?? null,
        createdAt: parent.createdAt ?? null,
        inReplyTo: asString(parent.inReplyTo),
        references: Array.isArray(parent.references) ? parent.references : [],
      },
      pdfExtraction: extraction,
      links: {
        parentMessageDbId,
        sameThreadMessageDbIds: [],
        messageHeaderLinkedDbIds: [],
        confirmationNumberCandidateLinkedDbIds: [],
      },
      duplicateContent: null,
    },
  };
}

async function main(): Promise<void> {
  const inputDir = requiredArgument('--input-dir');
  const outputDir = requiredArgument('--output-dir');
  const senderEvidenceOverridePath = optionalArgument('--sender-evidence-override');
  const legacyNoMatchUnverified = process.argv.slice(2).includes('--legacy-no-match-unverified');
  if (!outputDir.startsWith(`${OUTPUT_ROOT}${path.sep}`)) throw new Error('output_path_invalid');
  const [realOutputRoot, realOutputParent] = await Promise.all([
    realpath(OUTPUT_ROOT), realpath(path.dirname(outputDir)),
  ]);
  if (realOutputParent !== realOutputRoot && !realOutputParent.startsWith(`${realOutputRoot}${path.sep}`)) {
    throw new Error('output_path_invalid');
  }
  const attachmentsPath = path.join(inputDir, 'attachments.jsonl');
  const corpusPath = path.join(inputDir, 'corpus.jsonl');
  const sourceManifestPath = path.join(inputDir, 'source-manifest.json');
  const sourceManifestBytes = await readFile(sourceManifestPath);
  const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8')) as JsonRecord;
  const attachments = (await readFile(attachmentsPath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AttachmentSource);
  const senderEvidenceRetries = new Map<string, { status: string; headerSha256?: string }>();
  let senderEvidenceOverrideSha256: string | null = null;
  if (senderEvidenceOverridePath) {
    const senderEvidenceOverrideBytes = await readFile(senderEvidenceOverridePath);
    senderEvidenceOverrideSha256 = sha256(senderEvidenceOverrideBytes);
    for (const line of senderEvidenceOverrideBytes.toString('utf8').split('\n').filter(Boolean)) {
      const row = asRecord(JSON.parse(line));
      const messageDbId = asString(row.messageDbId);
      const status = asString(row.status);
      if (!messageDbId || !status) throw new Error('sender_evidence_override_invalid');
      if (!['match', 'no_match', 'missing', 'not_stored', 'unreadable', 'read_failed'].includes(status)) {
        throw new Error('sender_evidence_override_invalid');
      }
      senderEvidenceRetries.set(messageDbId, {
        status,
        ...(asString(row.headerSha256) ? { headerSha256: asString(row.headerSha256)! } : {}),
      });
    }
  }
  let senderEvidenceRetryAppliedRecords = 0;
  const senderEvidenceRetryAppliedMessages = new Set<string>();
  for (const source of attachments) {
    if (legacyNoMatchUnverified) {
      source.fromHeaderEvidence = markLegacyNoMatchUnverified(source.fromHeaderEvidence);
    }
    const messageDbId = asString(source.parentMessage.messageDbId);
    const retry = messageDbId ? senderEvidenceRetries.get(messageDbId) : undefined;
    if (!messageDbId || !retry || source.fromHeaderEvidence.status !== 'missing') continue;
    source.fromHeaderEvidence = { ...retry, initialStatus: 'missing', retryAttempted: true };
    senderEvidenceRetryAppliedRecords += 1;
    senderEvidenceRetryAppliedMessages.add(messageDbId);
  }
  const indexes = await loadMessages(corpusPath);
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  await chmod(outputDir, 0o700);

  const extracted = await mapWithConcurrency(attachments, 4, (source) => extractPdf(source, inputDir));
  const sourceSnapshotId = asString(sourceManifest.snapshotId);
  for (const item of extracted) {
    const source = asRecord(item.record.source);
    source.snapshotId = sourceSnapshotId;
    item.record.source = source;
  }
  const idsByHash = new Map<string, string[]>();
  for (const item of extracted) {
    const hash = asString(item.source.file.sha256);
    const id = asString(item.source.attachment.attachmentId);
    if (!hash || !id) continue;
    const ids = idsByHash.get(hash) ?? [];
    ids.push(id);
    idsByHash.set(hash, ids);
  }
  for (const item of extracted) {
    const hash = asString(item.source.file.sha256);
    const ids = hash ? idsByHash.get(hash) ?? [] : [];
    item.record.duplicateContent = ids.length > 1
      ? { exactSha256: hash, sourceAttachmentIds: ids.sort(), groupSize: ids.length }
      : null;
  }

  const links = extracted.flatMap((item) => linkRecord(item, indexes));
  const records = extracted.map((item) => item.record);
  const recordsPath = path.join(outputDir, 'records.jsonl');
  const linksPath = path.join(outputDir, 'links.jsonl');
  await writeFile(recordsPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(linksPath, links.length ? `${links.map((link) => JSON.stringify(link)).join('\n')}\n` : '', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(recordsPath, 0o600);
  await chmod(linksPath, 0o600);

  const fromHeaderCounts: Record<string, number> = {};
  const senderEvidenceRetryCounts: Record<string, number> = {};
  for (const retry of senderEvidenceRetries.values()) {
    senderEvidenceRetryCounts[retry.status] = (senderEvidenceRetryCounts[retry.status] ?? 0) + 1;
  }
  const fileStatusCounts: Record<string, number> = {};
  const extractionStatusCounts: Record<string, number> = {};
  const pdfTypeCounts: Record<string, number> = {};
  const fieldCoverageCounts = Object.fromEntries(
    PDF_FIELD_NAMES.map((field) => [field, 0]),
  ) as Record<PdfFieldKey, number>;
  let confirmationNumberCandidateValues = 0;
  let confirmationNumberCandidateRecords = 0;
  let pagesNeedingOcr = 0;
  let parentMessagesMissing = 0;
  let exactDuplicateGroups = 0;
  let exactDuplicateRecords = 0;
  let tierOneEdges = 0;
  let tierTwoEdges = 0;
  for (const item of extracted) {
    const fromStatus = item.source.fromHeaderEvidence.status;
    fromHeaderCounts[fromStatus] = (fromHeaderCounts[fromStatus] ?? 0) + 1;
    const fileStatus = asString(item.source.file.status) ?? 'unknown';
    fileStatusCounts[fileStatus] = (fileStatusCounts[fileStatus] ?? 0) + 1;
    const extraction = asRecord(item.record.pdfExtraction);
    const extractionStatus = asString(extraction.status) ?? 'unknown';
    extractionStatusCounts[extractionStatus] = (extractionStatusCounts[extractionStatus] ?? 0) + 1;
    const classification = asRecord(extraction.classification);
    const pdfType = asString(classification.pdfType);
    if (pdfType) pdfTypeCounts[pdfType] = (pdfTypeCounts[pdfType] ?? 0) + 1;
    const quality = asRecord(extraction.quality);
    if (Array.isArray(quality.pagesNeedingOcrOneBased)) pagesNeedingOcr += quality.pagesNeedingOcrOneBased.length;
    for (const field of PDF_FIELD_NAMES) {
      if (item.fields[field].length > 0) fieldCoverageCounts[field] += 1;
    }
    if (item.confirmationNumbers.length > 0) confirmationNumberCandidateRecords += 1;
    confirmationNumberCandidateValues += item.confirmationNumbers.length;
    const parentId = asString(item.source.parentMessage.messageDbId);
    if (parentId && !indexes.byDbId.has(parentId)) parentMessagesMissing += 1;
    const duplicate = asRecord(item.record.duplicateContent);
    if (typeof duplicate.groupSize === 'number' && duplicate.groupSize > 1) exactDuplicateRecords += 1;
  }
  exactDuplicateGroups = [...idsByHash.values()].filter((ids) => ids.length > 1).length;
  for (const link of links) {
    if (link.tier === 1) tierOneEdges += 1;
    else tierTwoEdges += 1;
  }

  const manifest = {
    schemaVersion: 'centurion-confirmation-pdf-dataset/v1',
    generatedAt: new Date().toISOString(),
    datasetKind: 'private_source_candidate_set_not_gold_labels',
    sourceSnapshotId: asString(sourceManifest.snapshotId),
    sourceManifestSha256: sha256(sourceManifestBytes),
    pdfInspector: { package: '@firecrawl/pdf-inspector', version: PDF_INSPECTOR_VERSION, processing: 'native_local_no_ocr_no_hosted_calls' },
    selection: {
      transportId: 'transport-centurion',
      direction: 'outbound',
      filenameRegex: '^HRCEN_Confirmation_Letter_.*[.]pdf$',
      fromHeaderPrefix: 'Centurion at',
      fromHeaderRuleAppliedToDecodedRawMimeDisplayName: true,
      fromHeaderRuleUsedAsQualification: false,
      reason: 'All filename-matched rows retained as candidates; unmatched and unavailable From evidence remain explicit.',
    },
    counts: {
      pdfRecords: records.length,
      uniqueParentMessages: new Set(attachments.map((source) => asString(source.parentMessage.messageDbId)).filter(Boolean)).size,
      sourceThreadRecords: indexes.threadRecordCount,
      sourceRows: indexes.sourceRowCount,
      indexedSourceMessages: indexes.byDbId.size,
      duplicateSourceRowIds: indexes.duplicateSourceRowCount,
      parentMessagesMissingFromCorpus: parentMessagesMissing,
      fileStatusCounts,
      fromHeaderEvidenceCounts: fromHeaderCounts,
      senderEvidenceRetryMessages: senderEvidenceRetryAppliedMessages.size,
      senderEvidenceRetryUnmatchedMessages: senderEvidenceRetries.size - senderEvidenceRetryAppliedMessages.size,
      senderEvidenceRetryAppliedRecords,
      senderEvidenceRetryStatusCounts: senderEvidenceRetryCounts,
      extractionStatusCounts,
      pdfTypeCounts,
      pagesNeedingOcr,
      exactDuplicateContentGroups: exactDuplicateGroups,
      exactDuplicateRecords,
      structuredFieldCoverageCounts: fieldCoverageCounts,
      confirmationNumberCandidateRecords,
      confirmationNumberCandidateValues,
      links: { total: links.length, tierOne: tierOneEdges, tierTwoReviewCandidates: tierTwoEdges },
    },
    provenance: {
      sourceCorpusFile: 'corpus.jsonl',
      sourceAttachmentMetadataFile: 'attachments.jsonl',
      senderEvidenceRetryFile: senderEvidenceOverridePath ? path.basename(senderEvidenceOverridePath) : null,
      senderEvidenceRetrySha256: senderEvidenceOverrideSha256,
      legacyNoMatchUnverified,
      linkedMessagesBy: ['attachment.message_id=message.id', 'exact thread_id', 'Message-ID/In-Reply-To/References', 'PDF-labeled confirmation number exact occurrence in message subject/body'],
      heuristicDomainTimeOnlyLinks: false,
      originalPdfBytesPreservedInInputDirectory: true,
    },
  };
  const manifestPath = path.join(outputDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(manifestPath, 0o600);
  process.stdout.write(`${JSON.stringify({ outputDir, ...manifest.counts })}\n`);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = items.length;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await operation(items[index]!);
      }
    }),
  );
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    process.stderr.write(`${JSON.stringify({ event: 'centurion_pdf_dataset_build.failed', error: name })}\n`);
    process.exitCode = 1;
  });
}
