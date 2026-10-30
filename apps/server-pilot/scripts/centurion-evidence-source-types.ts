/** Private source contracts and pure original-address normalization. Never expose private evidence as model-safe output. */

export type HeaderCompleteness = 'complete' | 'incomplete' | 'unknown';
export interface HeaderFieldCompleteness {
  messageIds: HeaderCompleteness;
  inReplyTo: HeaderCompleteness;
  references: HeaderCompleteness;
}

/** `id` identifies a source-row occurrence; never reuse it for another row. */
export interface LinkerMessage {
  id: string;
  /** Attributable source identity; `verified` requires adapter reconciliation, not a guessed header. */
  sourceIdentity?: { source: string; messageId: string; verification?: 'verified' | 'unresolved' } | null;
  threadId?: string | null;
  /** Values are canonical mailboxes, not raw display-name address fields. */
  addressesByRole?: Readonly<Record<string, readonly string[] | undefined>>;
  addressCompleteness?: 'complete' | 'incomplete' | 'unknown';
  /** Backwards-compatible single Message-ID; combined with messageIds. */
  messageId?: string | null;
  messageIds?: readonly string[] | null;
  inReplyTo?: readonly string[] | null;
  references?: readonly string[] | null;
  /** Adapter attests field availability; absent declarations remain unknown. */
  headerCompleteness?: Partial<HeaderFieldCompleteness>;
}

type RecordValue = Record<string, unknown>;
export type SourceRef = { sourceId: string; versionId: string };
/** Private capture metadata supplied from the saved source manifest, when recorded. */
export type CaptureMetadata = { capturedAt?: string | null; sourceReference?: string | null };
export type SnapshotRef = SourceRef & { snapshotId: string };
export type SourceAvailability = 'available' | 'missing' | 'unreadable' | 'invalid';
export type SnapshotIntegrity = 'verified' | 'missing' | 'invalid' | 'unavailable';
export type AddressStatus = 'complete' | 'incomplete' | 'unknown';
export type HeaderFields = Record<'messageIds' | 'inReplyTo' | 'references', AddressStatus>;
export type SourceSnapshot = SnapshotRef & CaptureMetadata & {
  status: SourceAvailability;
  records: readonly unknown[];
  /** Only set when the saved schema independently guarantees that [] means known empty. */
  emptyAddresses?: 'known_empty' | 'unknown';
};
export type PdfInventory = SourceRef & CaptureMetadata & {
  status: SourceAvailability;
  /** Verified checksum of the saved source manifest used to build the extract. */
  sourceManifestSha256?: string | null;
  /** Explicit saved provenance linking this inventory to a snapshot, never inferred from an ID. */
  parentSnapshot: SnapshotRef | null;
  records: readonly unknown[];
};
export type PdfExtractSource = SourceRef & CaptureMetadata & {
  status: SourceAvailability;
  /** Values from the verified PDF dataset manifest. */
  sourceManifestSha256?: string | null;
  datasetSchemaVersion?: string | null;
  /** Exact selected inventory version from which this extract was built. */
  inventory: SourceRef;
  records: readonly unknown[];
};
export type HmsObservation = SourceRef & {
  observationId: string;
  observedAt: string;
  /** Private pointer into the saved HMS input. */
  sourceReference: string;
  association: ({ kind: 'attachment'; inventory: SourceRef; attachmentId: string } |
    { kind: 'source_row'; snapshot: SnapshotRef; sourceRowId: string }) & {
      /** Saved, attributable evidence for this exact association. */
      sourceReference: string;
    };
};
export type EvidenceSourceInput = {
  snapshots: readonly SourceSnapshot[];
  pdfInventories: readonly PdfInventory[];
  pdfExtracts?: readonly PdfExtractSource[];
  hmsObservations?: readonly unknown[];
};
export type SourceIssueCode = 'SOURCE_UNAVAILABLE' | 'MALFORMED_SNAPSHOT' | 'MALFORMED_MESSAGE' |
  'MALFORMED_SOURCE_ROW' | 'MALFORMED_PDF_ROW' | 'AMBIGUOUS_SOURCE_ROW_ID' |
  'AMBIGUOUS_ATTACHMENT_ID' | 'MISSING_ATTACHMENT_ID' | 'PARENT_UNAVAILABLE' |
  'PDF_FILE_UNAVAILABLE' | 'MALFORMED_EXTRACT' | 'UNLINKED_EXTRACT' | 'MISSING_EXTRACT' |
  'EXTRACTION_COVERAGE_UNKNOWN' | 'EXTRACT_PROVENANCE_MISMATCH' | 'EXTRACT_PROVENANCE_UNKNOWN' |
  'UNLINKED_HMS' | 'MALFORMED_HMS' | 'MALFORMED_HMS_TIMESTAMP' | 'SNAPSHOT_METADATA_MISSING' | 'SNAPSHOT_METADATA_INVALID';
export type SourceIssue = { code: SourceIssueCode; source: SourceRef; occurrence?: string };
export type InventoryCoverage = { inventory: SourceRef; status: 'complete' | 'partial' | 'unavailable'; selectedRows: number | null; mappedCases: number | null; omittedRows: number | null };
export type MessageOccurrence = {
  key: string;
  snapshot: SnapshotRef;
  sourceRowId: string | null;
  row: RecordValue;
  /** Distinct source header fields, before the linker's narrower projection. */
  headers: { messageIds: string[]; inReplyTo: string[]; references: string[] };
  headerFields: HeaderFields;
  linkerMessage: LinkerMessage;
  addressFields: Record<'from' | 'to' | 'cc' | 'bcc', AddressStatus>;
  originalAddressFields: Record<'from' | 'to' | 'cc' | 'bcc', AddressStatus>;
};
export type PdfCase = {
  key: string;
  inventory: SourceRef;
  rowIndex: number;
  attachmentId: string | null;
  identity: 'resolved' | 'missing' | 'ambiguous';
  fileStatus: SourceAvailability | 'unknown';
  /** The complete saved inventory record, including parent metadata and file version. */
  record: RecordValue;
  parent: { status: 'available' | 'missing' | 'ambiguous' | 'unavailable'; occurrenceKeys: string[] };
  /** Search anchor; an inventory-only parent is explicitly unresolved and remains outside the snapshot index. */
  anchor: { message: LinkerMessage; headerFields: HeaderFields } | null;
  extractionStatus: 'available' | 'incomplete' | 'missing' | 'unavailable' | 'ambiguous' | 'unknown' | 'mismatch';
  extractions: Array<{ source: SourceRef; rowIndex: number; record: RecordValue }>;
  unverifiedExtractions: Array<{ source: SourceRef; rowIndex: number; record: RecordValue; status: 'unknown' | 'mismatch' }>;
  hms: HmsObservation[];
};
export type EvidenceSources = {
  snapshots: SnapshotRef[];
  snapshotIntegrity: Array<{ snapshot: SnapshotRef; status: SnapshotIntegrity }>;
  sources: Array<CaptureMetadata & { kind: 'mail_snapshot' | 'pdf_inventory' | 'pdf_extract'; source: SourceRef; status: SourceAvailability }>;
  inventoryCoverage: InventoryCoverage[];
  messages: MessageOccurrence[];
  /** One linker entry per saved occurrence; verified source identity is carried separately. */
  linkerMessages: LinkerMessage[];
  cases: PdfCase[];
  /** Includes unlinked and malformed extract records for private accounting. */
  pdfExtracts: readonly PdfExtractSource[];
  /** All observations, including malformed and unlinked ones, remain separate private items. */
  hmsObservations: readonly unknown[];
  issues: SourceIssue[];
  state: 'complete' | 'partial';
  addressCounts: { complete: number; incomplete: number; unknown: number; missingFields: number };
};

/** Validate a mailbox without rewriting aliases or deriving an alternative address. */
export function isCanonicalMailbox(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  const atom = (part: string): boolean => {
    if (!part || part.startsWith('.') || part.endsWith('.') || part.includes('..')) return false;
    return [...part].every((character) => {
      if (character === '.') return true;
      const code = character.codePointAt(0)!;
      return code < 128 ? /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]$/.test(character)
        : !/[\s\p{Cc}\p{Cs}]/u.test(character);
    });
  };
  let at: number;
  if (value.startsWith('"')) {
    let index = 1, closed = false;
    while (index < value.length) {
      const code = value.charCodeAt(index), character = value[index]!;
      if ((code < 32 && code !== 9) || code === 127) return false;
      if (character === '\\') {
        index++;
        if (index >= value.length) return false;
        const escaped = value.charCodeAt(index);
        if (escaped < 32 || escaped === 127) return false;
      } else if (character === '"') { closed = true; index++; break; }
      index++;
    }
    if (!closed || value[index] !== '@') return false;
    at = index;
  } else {
    at = value.indexOf('@');
    if (at < 1 || !atom(value.slice(0, at))) return false;
  }
  const domain = value.slice(at + 1);
  if (domain.startsWith('[') && domain.endsWith(']')) {
    const inner = domain.slice(1, -1);
    if (!inner) return false;
    for (let index = 0; index < inner.length; index++) {
      const character = inner[index]!, code = inner.charCodeAt(index);
      if (character === '\\') {
        index++;
        if (index >= inner.length || inner.charCodeAt(index) < 33 || inner.charCodeAt(index) > 126) return false;
      } else if (code < 33 || code > 126 || character === '[' || character === ']') return false;
    }
    return true;
  }
  return atom(domain);
}

function normalizeOriginalMailbox(raw: string): string | null {
  const trimmed = raw.trim();
  const bracketed = trimmed.match(/^([^<>]*)<([^<>]+)>$/);
  const display = bracketed?.[1]?.trim() ?? '';
  for (const character of display) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9) || code === 127) return null;
  }
  if (display.startsWith('"')) {
    if (!/^"(?:[^"\\\r\n]|\\[^\r\n])*"$/.test(display)) return null;
  } else if (/["@,:;]/.test(display)) return null;
  const candidate = (bracketed ? bracketed[2]! : trimmed).trim();
  return isCanonicalMailbox(candidate) ? candidate.toLowerCase() : null;
}

/** Split only unambiguous RFC-style comma lists; no aliases or guessed partial list. */
export function normalizeOriginal(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts: string[] = [];
  let quoted = false, escaped = false, angled = false, start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (escaped) { escaped = false; continue; }
    if (quoted && ch === '\\') { escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch === '<') { if (angled) return null; angled = true; continue; }
    if (ch === '>') { if (!angled) return null; angled = false; continue; }
    if (ch === ',' && !angled) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  if (quoted || angled || escaped) return null;
  parts.push(value.slice(start));
  const normalized = parts.map(normalizeOriginalMailbox);
  return normalized.some((item) => item === null) ? null : normalized as string[];
}
