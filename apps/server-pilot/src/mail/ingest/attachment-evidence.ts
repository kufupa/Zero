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
 *
 * Attachment roles are scoped to the observing lineage: `attachment:1` names a
 * manifest position inside one `(sourceId, sourceObservationId,
 * semanticVersion)` export, never a mailbox-global identity. Two linked
 * observations may reuse the same role for different parts, so a missing role
 * may resolve only against artifacts persisted under that same observation's
 * manifest, and an `attachment:unavailable` placeholder survives until that
 * same observation later enumerates concrete roles. Each lineage's newest
 * ingested version replaces its declared gaps; `linkedAttachmentScopes`
 * records that per-lineage state so later independent observations can never
 * erase it. Gap entries written before lineage scoping carry no scope and are
 * unresolvable: they remain unknown rather than reading as confirmed-empty.
 */

/** Keys `persistOutlookHistory` always stamps on a sync provenance. */
const SYNC_PROVENANCE_KEYS = [
  'evidence',
  'artifacts',
  'observationId',
  'sourceId',
  'sourceObservationId',
  'canonicalContentVersion',
] as const;

/** Canonical merged gap list written across linked observations. */
export const LINKED_OPTIONAL_MISSING_KEY = 'linkedOptionalMissing';
/** Per-lineage attachment evidence behind the canonical merged gap list. */
export const LINKED_ATTACHMENT_SCOPES_KEY = 'linkedAttachmentScopes';
/** Discovery placeholder for an observation that could not enumerate attachments. */
export const UNAVAILABLE_ROLE = 'attachment:unavailable';

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
 * Attachment evidence owned by one observation lineage. `semanticVersion`
 * orders versions of the same `(sourceId, sourceObservationId)` lineage only;
 * `missing` is that version's raw declared `optionalMissing` (kept verbatim so
 * malformed content stays unknown), `persisted` the `sourceAttachmentId`
 * suffixes verifiably persisted under that same version's manifest, and
 * `enumerated` whether that version's `requiredArtifactRoles` proved real
 * attachment enumeration (no discovery placeholder).
 */
export type AttachmentScopeEvidence = {
  sourceId: string;
  sourceObservationId: string;
  semanticVersion: string | null;
  enumerated: boolean;
  missing: unknown;
  persisted: string[];
};

const scopeKeyOf = (scope: { sourceId: string; sourceObservationId: string }) =>
  `${scope.sourceId.length}:${scope.sourceId}:${scope.sourceObservationId}`;

/** Parse the durable scope list; any malformed entry makes the whole record unknown. */
export function parseLinkedAttachmentScopes(value: unknown): {
  scopes: AttachmentScopeEvidence[];
  malformed: boolean;
} {
  if (!Array.isArray(value)) return { scopes: [], malformed: value != null };
  const scopes: AttachmentScopeEvidence[] = [];
  let malformed = false;
  for (const entry of value) {
    const record = entry as Record<string, unknown> | null;
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.sourceId !== 'string' ||
      typeof record.sourceObservationId !== 'string'
    ) {
      malformed = true;
      continue;
    }
    scopes.push({
      sourceId: record.sourceId,
      sourceObservationId: record.sourceObservationId,
      semanticVersion:
        typeof record.semanticVersion === 'string'
          ? record.semanticVersion
          : typeof record.semanticVersion === 'number' &&
              Number.isSafeInteger(record.semanticVersion)
            ? String(record.semanticVersion)
            : null,
      enumerated: record.enumerated === true,
      missing: record.missing,
      persisted: Array.isArray(record.persisted)
        ? record.persisted.filter((x): x is string => typeof x === 'string')
        : [],
    });
  }
  return { scopes, malformed };
}

/**
 * Suffixes the provenance's own observation verifiably persisted: each
 * artifact receipt names an `attachment:` role and a sealed key, and the
 * suffix counts only when a persisted row carries that exact key under the
 * same `sourceAttachmentId`. Rows from other linked observations can never
 * satisfy it because their sealed keys differ.
 */
export function persistedOwnAttachmentSuffixes(
  sourceProvenance: unknown,
  rows: { s3Key: string; sourceAttachmentId: string | null }[],
): string[] {
  const artifacts =
    sourceProvenance && typeof sourceProvenance === 'object'
      ? (sourceProvenance as Record<string, unknown>).artifacts
      : undefined;
  if (!Array.isArray(artifacts)) return [];
  const suffixes = new Set<string>();
  for (const entry of artifacts) {
    const record = entry as Record<string, unknown> | null;
    const role = record?.role;
    const key =
      record?.receipt && typeof record.receipt === 'object'
        ? (record.receipt as Record<string, unknown>).key
        : undefined;
    if (typeof role !== 'string' || !role.startsWith('attachment:') || typeof key !== 'string')
      continue;
    const suffix = role.slice(11);
    if (rows.some((row) => row.s3Key === key && row.sourceAttachmentId === suffix))
      suffixes.add(suffix);
  }
  return [...suffixes];
}

/** Order two versions of one lineage; non-numeric or absent versions cannot be ordered. */
const versionOrder = (
  incoming: string | null,
  recorded: string | null,
): 'newer' | 'equal' | 'older' | 'unknown' => {
  if (incoming === recorded) return 'equal';
  if (incoming !== null && recorded !== null && /^\d+$/.test(incoming) && /^\d+$/.test(recorded))
    return BigInt(incoming) > BigInt(recorded) ? 'newer' : 'older';
  return 'unknown';
};

/**
 * Reconcile per-lineage attachment evidence for one canonical message.
 *
 * The own lineage is rebuilt from the live provenance each merge; linked
 * lineages keep only their newest recorded version. An incoming export newer
 * than (or equal to) its lineage's recorded version replaces that state; a
 * provably older one is `stale` and must be discarded whole — older manifests
 * can renumber roles, so its rows and gaps must neither be added nor resolved.
 * Unordered versions conservatively union the declared gaps instead of
 * dropping either.
 *
 * The merged `gaps` list keeps each lineage's currently declared missing
 * roles except suffixes that lineage itself persisted under the same version,
 * emits one `attachment:unavailable` marker while any lineage cannot prove
 * enumeration, and carries every unscoped legacy gap verbatim — unscoped gaps
 * predate lineage identity, so nothing may resolve them.
 */
export function mergeLinkedAttachmentEvidence(input: {
  scopes: unknown;
  legacyLinked: unknown;
  own: AttachmentScopeEvidence | null;
  incoming: AttachmentScopeEvidence | null;
  /** Declared gaps from an input that cannot name its lineage stay unscoped. */
  incomingMissing?: unknown;
}): {
  scopes: AttachmentScopeEvidence[];
  gaps: unknown[];
  scopesChanged: boolean;
  stale: boolean;
} {
  const stored = parseLinkedAttachmentScopes(input.scopes);
  const byKey = new Map<string, AttachmentScopeEvidence>();
  for (const scope of stored.scopes) byKey.set(scopeKeyOf(scope), scope);
  if (input.own) {
    const key = scopeKeyOf(input.own),
      recorded = byKey.get(key);
    byKey.set(key, {
      ...input.own,
      persisted: [...new Set([...(recorded?.persisted ?? []), ...input.own.persisted])],
    });
  }
  let stale = false;
  if (input.incoming) {
    const key = scopeKeyOf(input.incoming),
      recorded = byKey.get(key);
    const order = recorded
      ? versionOrder(input.incoming.semanticVersion, recorded.semanticVersion)
      : 'newer';
    if (order === 'older') stale = true;
    else if (!recorded || order === 'newer') byKey.set(key, input.incoming);
    else if (order === 'equal')
      byKey.set(key, {
        ...input.incoming,
        persisted: [...new Set([...input.incoming.persisted, ...recorded.persisted])],
      });
    else
      byKey.set(key, {
        ...recorded,
        enumerated: recorded.enumerated && input.incoming.enumerated,
        missing: [
          ...(Array.isArray(recorded.missing) ? recorded.missing : []),
          ...(Array.isArray(input.incoming.missing) ? input.incoming.missing : []),
        ],
        persisted: [...new Set([...recorded.persisted, ...input.incoming.persisted])],
      });
  }
  const scopes = [...byKey.values()];
  const gaps: unknown[] = [];
  const indexByKey = new Map<string, number>();
  const put = (dedupeKey: string, item: unknown, fileName: string | null) => {
    const index = indexByKey.get(dedupeKey);
    if (index === undefined) {
      indexByKey.set(dedupeKey, gaps.length);
      gaps.push(item);
    } else if (fileName !== null && optionalMissingItems([gaps[index]])[0]?.fileName === null)
      gaps[index] = item;
  };
  const unavailable = stored.malformed;
  for (const scope of scopes) {
    const scopeRef = { sourceId: scope.sourceId, sourceObservationId: scope.sourceObservationId };
    const putScopedUnavailable = () =>
      put(`${scopeKeyOf(scope)}${UNAVAILABLE_ROLE}`, {
        role: UNAVAILABLE_ROLE,
        fileName: null,
        scope: scopeRef,
      }, null);
    const items = optionalMissingItems(scope.missing);
    if (scope.missing != null && (!Array.isArray(scope.missing) || scope.missing.length !== items.length))
      putScopedUnavailable();
    for (const item of items) {
      if (item.role === UNAVAILABLE_ROLE) {
        putScopedUnavailable();
        continue;
      }
      if (item.role.startsWith('attachment:') && scope.persisted.includes(item.role.slice(11)))
        continue;
      put(`${scopeKeyOf(scope)}${item.role}`, {
        ...item,
        scope: scopeRef,
      }, item.fileName);
    }
    if (!scope.enumerated) putScopedUnavailable();
  }
  const scoped = (entry: unknown) => {
    const scope = (entry as Record<string, unknown> | null)?.scope;
    return (
      !!scope &&
      typeof scope === 'object' &&
      typeof (scope as Record<string, unknown>).sourceId === 'string' &&
      typeof (scope as Record<string, unknown>).sourceObservationId === 'string'
    );
  };
  const residue = [
    ...(Array.isArray(input.legacyLinked) ? input.legacyLinked : []),
    ...(Array.isArray(input.incomingMissing) ? input.incomingMissing : []),
  ];
  for (const entry of residue) {
    if (scoped(entry)) continue;
    const [item] = optionalMissingItems([entry]);
    item
      ? put(`u${item.role}`, entry, item.fileName)
      : put(`x${indexByKey.size}`, entry, null);
  }
  if (unavailable) put(`u${UNAVAILABLE_ROLE}`, { role: UNAVAILABLE_ROLE, fileName: null }, null);
  return {
    scopes,
    gaps,
    scopesChanged: JSON.stringify(scopes) !== JSON.stringify(stored.scopes),
    stale,
  };
}

/**
 * The gap list a provenance stands on. Once `linkedOptionalMissing` exists it
 * is the canonical union across linked observations and wins over the owning
 * observation's own `optionalMissing` — an empty list included, since links
 * may resolve every gap. A recorded list with entries it cannot parse keeps
 * one `attachment:unavailable` placeholder so the evidence stays unknown
 * instead of reading as confirmed-empty.
 */
export function effectiveOptionalMissing(sourceProvenance: unknown): OptionalMissingItem[] {
  if (!sourceProvenance || typeof sourceProvenance !== 'object') return [];
  const record = sourceProvenance as Record<string, unknown>;
  if (!(LINKED_OPTIONAL_MISSING_KEY in record) && !('optionalMissing' in record)) return [];
  const gaps =
    LINKED_OPTIONAL_MISSING_KEY in record
      ? record[LINKED_OPTIONAL_MISSING_KEY]
      : record.optionalMissing;
  const items = optionalMissingItems(gaps);
  return Array.isArray(gaps) && gaps.length === items.length
    ? items
    : [...items, { role: UNAVAILABLE_ROLE, fileName: null }];
}

export function attachmentEvidenceUnknown(sourceProvenance: unknown): boolean {
  if (!sourceProvenance || typeof sourceProvenance !== 'object') return false;
  const record = sourceProvenance as Record<string, unknown>;
  if (LINKED_OPTIONAL_MISSING_KEY in record || 'optionalMissing' in record)
    return effectiveOptionalMissing(record).length > 0;
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

/** Completeness of the attachment evidence available to the reservation pane. */
export function paneAttachmentStatus(persistedFile: boolean, provenance: Record<string, unknown> | null) {
  if (persistedFile) return 'has_unread';
  const evidence = provenance?.evidence;
  const requiredRoles = evidence && typeof evidence === 'object' && 'requiredArtifactRoles' in evidence
    ? evidence.requiredArtifactRoles : undefined;
  const scopes = provenance?.linkedAttachmentScopes;
  const enumerated = Array.isArray(scopes) && scopes.length > 0
    ? scopes.every(scope => scope && typeof scope === 'object' && scope.enumerated === true)
    : typeof provenance?.sourceId === 'string' && typeof provenance.sourceObservationId === 'string' &&
      Array.isArray(requiredRoles) && !requiredRoles.includes(UNAVAILABLE_ROLE) &&
      (Array.isArray(provenance.linkedOptionalMissing) || Array.isArray(provenance.optionalMissing));
  return enumerated && !attachmentEvidenceUnknown(provenance) ? 'complete' : 'unknown';
}
