import { and, asc, desc, eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { message } from '../../db/schema/mail.js';
import { mailExtraction } from '../../db/schema/work.js';
import { quoteDigest } from '../../quote-proposal/quote-revision.js';
import { captureCenturionExtractionSource, CENTURION_SOURCE_WITNESS_VERSION } from '../extraction/centurion-source-witness.js';
import { isWorkItemSourceBusy } from '../work-item-source-lock.js';
import { classifierInputFromSelection, parseStoredClassifier, type ClassifierResult, type classifyWorkflow } from './index.js';

type Read = typeof mailExtraction.$inferSelect;
type Scope = { transportId: string; threadId: string; messageId: string };
type SourceMode = 'legacy' | 'captured' | 'hold';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Unwitnessed and unsupported reads keep the existing classifier behavior. */
export function classifierSourceMode(usage: unknown): SourceMode {
  const metadata = record(usage);
  const witness = record(metadata?.sourceWitness);
  const proof = metadata?.classifierSourceProof;
  if (metadata?.sourceWitness === undefined && proof === undefined) return 'legacy';
  if (witness?.status === 'unproven' && witness.reason !== 'translation_retry' && proof === undefined) return 'legacy';
  if (witness?.version === CENTURION_SOURCE_WITNESS_VERSION && witness.status === 'captured' &&
      typeof witness.digest === 'string' && /^[a-f0-9]{64}$/.test(witness.digest)) return 'captured';
  return 'hold';
}

function sourceDigest(read: Read): string | null {
  if (classifierSourceMode(read.usage) !== 'captured') return null;
  return record(read.usage?.sourceWitness)?.digest as string;
}

/** Binds the classifier to all material fields of the extraction, without storing their contents in the receipt. */
export function classifierExtractionDigest(read: Read): string {
  return quoteDigest({
    domain: 'centurion-classifier-extraction', version: 1,
    id: read.id, messageId: read.messageId, extractorVersion: read.extractorVersion, status: read.status,
    kind: read.kind, language: read.language, payload: read.payload, translation: read.translation,
    attachments: read.attachments, createdAt: read.createdAt.toISOString(), sourceWitness: read.usage?.sourceWitness,
  });
}

function classifierDigest(result: ClassifierResult): string {
  return quoteDigest({ domain: 'centurion-classifier-result', version: 1, ...result });
}

/** A captured read can only use a classifier explicitly bound to that read and result. */
export function classifierForExtraction(read: Read): ClassifierResult | null {
  const result = parseStoredClassifier(read.usage);
  if (!result) return null;
  const mode = classifierSourceMode(read.usage);
  if (mode === 'legacy') return result;
  if (mode !== 'captured') return null;
  const proof = record(read.usage?.classifierSourceProof);
  return proof?.version === 1 && proof.extractionId === read.id && proof.sourceDigest === sourceDigest(read) &&
    proof.extractionDigest === classifierExtractionDigest(read) && proof.classifierDigest === classifierDigest(result)
    ? result : null;
}

/** Caller owns a short transaction. Lock source before reads, and every existing extraction before selecting latest. */
async function captureCurrentRead(db: DB, scope: Scope, readId: string) {
  const [before] = await db.select().from(mailExtraction)
    .where(and(eq(mailExtraction.id, readId), eq(mailExtraction.messageId, scope.messageId),
      eq(mailExtraction.status, 'succeeded'))).limit(1);
  const expectedSource = before && sourceDigest(before);
  if (!before || !expectedSource) return null;
  const source = await captureCenturionExtractionSource(db, scope, before.extractorVersion, process.env);
  if (source.status !== 'captured' || source.digest !== expectedSource) return null;
  // The message UPDATE lock prevents FK inserts. Existing rows can change status or chronology, so lock all of them.
  await db.select({ id: mailExtraction.id }).from(mailExtraction).where(eq(mailExtraction.messageId, scope.messageId))
    .orderBy(asc(mailExtraction.id)).for('update', { noWait: true });
  const [latest] = await db.select().from(mailExtraction)
    .where(and(eq(mailExtraction.messageId, scope.messageId), eq(mailExtraction.status, 'succeeded')))
    .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id)).limit(1);
  if (!latest || latest.id !== readId || latest.extractorVersion !== before.extractorVersion ||
      sourceDigest(latest) !== source.digest) return null;
  return { read: latest, source, extractionDigest: classifierExtractionDigest(latest) };
}

/** A previously bound classifier is only shown while its current source and extraction still match. */
export async function currentCapturedClassifier(
  db: DB, scope: Scope, readId: string, extractionDigest: string,
): Promise<ClassifierResult | null> {
  try {
    return await db.transaction(async (tx) => {
      const current = await captureCurrentRead(tx as unknown as DB, scope, readId);
      return current?.extractionDigest === extractionDigest ? classifierForExtraction(current.read) : null;
    });
  } catch {
    // A changed or busy source must not produce an unverified classifier in the pane.
    return null;
  }
}

/** Never hold database locks across the classifier/model call. */
export async function storeCapturedClassifier(
  db: DB, messageId: string, readId: string, classify: typeof classifyWorkflow, deadlineMs: number,
): Promise<void> {
  try {
    const [msg] = await db.select({ transportId: message.transportId, threadId: message.threadId })
      .from(message).where(eq(message.id, messageId)).limit(1);
    if (!msg) return;
    const scope = { ...msg, messageId };
    const initial = await db.transaction((tx) => captureCurrentRead(tx as unknown as DB, scope, readId));
    if (!initial || classifierForExtraction(initial.read)) return;
    const result = await classify(classifierInputFromSelection(initial.source.selection),
      { signal: AbortSignal.timeout(deadlineMs) });
    const normalized = parseStoredClassifier({ classifier: result });
    if (!normalized) return;
    await db.transaction(async (tx) => {
      const current = await captureCurrentRead(tx as unknown as DB, scope, readId);
      if (!current || current.extractionDigest !== initial.extractionDigest || classifierForExtraction(current.read)) return;
      const proof = {
        version: 1, extractionId: current.read.id, sourceDigest: current.source.digest,
        extractionDigest: current.extractionDigest, classifierDigest: classifierDigest(normalized),
      };
      await tx.update(mailExtraction).set({
        usage: { ...current.read.usage, classifier: normalized, classifierSourceProof: proof },
      }).where(eq(mailExtraction.id, current.read.id));
    });
  } catch (error) {
    if (!isWorkItemSourceBusy(error)) console.error('ingest_classifier_failed', messageId, 'classifier_unavailable');
  }
}
