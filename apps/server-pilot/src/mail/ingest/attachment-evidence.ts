/**
 * File-attachment evidence is a tri-state for source classification.
 *
 * A persisted non-inline attachment row proves presence. Proving absence
 * needs a source that enumerated attachments: POP3 and fanout copies stream
 * every MIME part to S3 before the message row exists (any failure aborts
 * the whole ingest), so their row set is authoritative on its own. Outlook
 * sync instead declares attachment roles up front and records the ones it
 * could not persist in `sourceProvenance.optionalMissing`; an empty persisted
 * set under a non-empty gap list is unknown, never confirmed empty. A
 * sync-shaped provenance that predates the gap record cannot vouch either.
 */

/** Keys `persistOutlookHistory` always stamps on a sync provenance. */
const SYNC_PROVENANCE_KEYS = [
  'evidence',
  'artifacts',
  'observationId',
  'sourceId',
  'sourceObservationId',
] as const;

export function attachmentEvidenceUnknown(sourceProvenance: unknown): boolean {
  if (!sourceProvenance || typeof sourceProvenance !== 'object') return false;
  const record = sourceProvenance as Record<string, unknown>;
  if ('optionalMissing' in record) {
    return !Array.isArray(record.optionalMissing) || record.optionalMissing.length > 0;
  }
  return SYNC_PROVENANCE_KEYS.some((key) => key in record);
}

/**
 * Tri-state for `classifyMailSource`: true = a non-inline attachment is
 * persisted, false = the source fully enumerated attachments and none were
 * files, undefined = enumeration cannot be proven.
 */
export function fileAttachmentPresence(
  persistedFile: boolean,
  sourceProvenance: unknown,
): boolean | undefined {
  if (persistedFile) return true;
  return attachmentEvidenceUnknown(sourceProvenance) ? undefined : false;
}
