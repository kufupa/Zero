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
 *
 * Several devices observe one canonical message with distinct observation
 * identities, so each keeps its own `optionalMissing`. `persistOutlookHistory`
 * merges them into `linkedOptionalMissing`: once present, that union is the
 * canonical gap list and wins over the owning observation's own record.
 */

/** Keys `persistOutlookHistory` always stamps on a sync provenance. */
const SYNC_PROVENANCE_KEYS = [
  'evidence',
  'artifacts',
  'observationId',
  'sourceId',
  'sourceObservationId',
] as const;

/** Canonical merged gap list written across linked observations. */
export const LINKED_OPTIONAL_MISSING_KEY = 'linkedOptionalMissing';
/** Discovery placeholder for an observation that could not enumerate attachments. */
const UNAVAILABLE_ROLE = 'attachment:unavailable';

export type OptionalMissingItem = { role: string; fileName: string | null };
export const optionalMissingItems = (value: unknown): OptionalMissingItem[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        return typeof record.role === 'string'
          ? [
              {
                role: record.role,
                fileName: typeof record.fileName === 'string' ? record.fileName : null,
              },
            ]
          : [];
      })
    : [];

/**
 * Union the gap lists of every observation linked to one canonical message.
 * A role leaves the list only when an attachment row with the same
 * `sourceAttachmentId` is persisted; a discovery `attachment:unavailable`
 * placeholder drops once a linked observation enumerates concrete roles.
 */
export function mergeOptionalMissingGaps(input: {
  merged: unknown;
  own: unknown;
  incoming: unknown;
  persistedSourceIds: ReadonlySet<string>;
  incomingEnumerated: boolean;
}): OptionalMissingItem[] {
  const merged = new Map<string, OptionalMissingItem>();
  for (const gap of [
    ...optionalMissingItems(input.merged ?? input.own),
    ...optionalMissingItems(input.incoming),
  ]) {
    if (gap.role === UNAVAILABLE_ROLE && input.incomingEnumerated) continue;
    if (gap.role.startsWith('attachment:') && input.persistedSourceIds.has(gap.role.slice(11)))
      continue;
    const previous = merged.get(gap.role);
    if (!previous || previous.fileName === null) merged.set(gap.role, gap);
  }
  return [...merged.values()];
}

export function attachmentEvidenceUnknown(sourceProvenance: unknown): boolean {
  if (!sourceProvenance || typeof sourceProvenance !== 'object') return false;
  const record = sourceProvenance as Record<string, unknown>;
  if (LINKED_OPTIONAL_MISSING_KEY in record) {
    const merged = record[LINKED_OPTIONAL_MISSING_KEY];
    return !Array.isArray(merged) || merged.length > 0;
  }
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
