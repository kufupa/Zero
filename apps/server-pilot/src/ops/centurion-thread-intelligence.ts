import {
  parsePersistedCenturionThreadStateCorpus,
  type CenturionThreadStateCorpus,
} from './centurion-thread-state-corpus.js';

export const CENTURION_THREAD_INTELLIGENCE_SCHEMA =
  'centurion_thread_intelligence_v1' as const;
export const CENTURION_THREAD_INTELLIGENCE_ROSTER_SCHEMA =
  'centurion_thread_intelligence_roster_v1' as const;
export const CENTURION_THREAD_INTELLIGENCE_SOURCE_COVERAGE_SCHEMA =
  'centurion_thread_intelligence_source_coverage_v1' as const;
export const CENTURION_THREAD_INTELLIGENCE_QUOTE_PARSER_COVERAGE_SCHEMA =
  'centurion_thread_intelligence_quote_parser_coverage_v1' as const;

const CENTURION_THREAD_STATE_CORPUS_SCHEMA =
  'centurion_thread_state_corpus_v1' as const;
const CENTURION_THREAD_STATE_SOURCE_SCHEMA_VERSION =
  'centurion_message_projection_v1' as const;

const MAX_QUOTE_CHARACTERS = 64 * 1024;
const MAX_QUOTE_LINES = 2_000;

const INTENTS = new Set([
  'actionable_request',
  'customer_acknowledgement_or_confirmation',
  'automated_or_non_actionable',
  'staff_response',
  'internal_handoff',
  'non_actionable',
  'ambiguous',
]);

const ACTIONABILITY = new Set([
  'actionable',
  'non_actionable',
  'ambiguous',
]);

export type CenturionThreadIntelligenceRoster = {
  schemaVersion: typeof CENTURION_THREAD_INTELLIGENCE_ROSTER_SCHEMA;
  identities: readonly string[];
  authorizedTransportIds: readonly string[];
};

export type CenturionThreadSourceCorpusCoverage = {
  schema: typeof CENTURION_THREAD_STATE_CORPUS_SCHEMA;
  sourceSchemaVersion: typeof CENTURION_THREAD_STATE_SOURCE_SCHEMA_VERSION;
  transportId: string;
  corpusSha256: string;
  eventCutoff: string;
  ingestCutoff: string;
};

export type CenturionThreadSourceCoverage = {
  schemaVersion: typeof CENTURION_THREAD_INTELLIGENCE_SOURCE_COVERAGE_SCHEMA;
  complete: boolean;
  authorizedTransportIds: readonly string[];
  corpora: readonly CenturionThreadSourceCorpusCoverage[];
};

export type CenturionThreadIntelligenceMessage = {
  id: string;
  threadId: string;
  transportId: string;
  direction: 'inbound' | 'outbound';
  timestamps: {
    createdAt: string | null;
    sentAt: string | null;
    receivedAt: string | null;
  };
  participants: {
    from: string;
    to: readonly string[];
    cc: readonly string[];
    bcc: readonly string[];
  };
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  headers: {
    messageId: string | null;
    inReplyTo: string | null;
    references: readonly string[];
    linkageConflict?: boolean;
    malformedReferences?: boolean;
  };
};

export type CenturionThreadTurnAnnotation = {
  messageId: string;
  intent:
    | 'actionable_request'
    | 'customer_acknowledgement_or_confirmation'
    | 'automated_or_non_actionable'
    | 'staff_response'
    | 'internal_handoff'
    | 'non_actionable'
    | 'ambiguous';
  actionability: 'actionable' | 'non_actionable' | 'ambiguous';
};

export type CenturionThreadQuoteCoverageAnnotation = {
  messageId: string;
  status: 'no_quote' | 'english_structural_complete' | 'limited';
};

export type CenturionThreadIntelligenceInput = {
  roster: CenturionThreadIntelligenceRoster;
  corpora?: readonly unknown[];
  quoteCoverage?: readonly CenturionThreadQuoteCoverageAnnotation[];
  annotations: readonly CenturionThreadTurnAnnotation[];
};

export type EventTimeSource =
  | 'received_at'
  | 'sent_at'
  | 'created_at'
  | 'missing';

export type EventTime = {
  value: string | null;
  source: EventTimeSource;
  quality: 'trustworthy' | 'missing';
};

export type HardGraphEdge = {
  kind:
    | 'same_persisted_thread'
    | 'unique_reply_header'
    | 'unique_quoted_message_id';
  sourceMessageId: string;
  targetMessageId: string;
};

export type QuotedEvidence = {
  sourceMessageId: string;
  senderIdentity: string;
  senderRole: 'internal';
  quotedMessageId: string | null;
  quotedTimestamp: string | null;
  provenance: {
    marker: 'on_wrote' | 'outlook_headers' | 'divider';
    startLine: number;
    endLine: number;
    depth: number;
  };
};

export type ThreadLimitation =
  | 'none'
  | 'quoted_only_evidence'
  | 'coverage_limited'
  | 'missing_event_time'
  | 'weak_subject_participant_correlation'
  | 'duplicate_persisted_message'
  | 'missing_or_ambiguous_annotation'
  | 'ambiguous_reply_header'
  | 'malformed_reply_header'
  | 'source_coverage_missing'
  | 'source_coverage_incomplete'
  | 'quote_text_truncated'
  | 'unsupported_quote_like'
  | 'html_only_quote_coverage'
  | 'quote_parser_coverage_missing'
  | 'quote_parser_coverage_limited'
  | 'no_actionable_external_turn';

export type ThreadEvidenceTier =
  | 'persisted_reply'
  | 'quoted_reply'
  | 'participant_subject_only_correlation'
  | 'no_evidence';

export type ThreadActionEvidence = {
  tier:
    | 'persisted_trusted_actionable_external'
    | 'annotated_actionable_missing_event_time'
    | 'no_actionable_evidence';
  messageId: string | null;
  actionRequiredEligible: boolean;
};

export type ThreadResponseEvidence = {
  tier: ThreadEvidenceTier;
  latestActionResponseMessageId: string | null;
};

export type ThreadState =
  | 'resolved'
  | 'action_required'
  | 'customer_acknowledgement_or_confirmation'
  | 'automated_or_non_actionable'
  | 'needs_manual_adjudication';

export type ThreadParticipantRole = {
  identity: string;
  role: 'internal' | 'external';
};

export type ThreadChronologyTurn = {
  messageId: string;
  persistedThreadId: string;
  transportId: string;
  direction: 'inbound' | 'outbound';
  senderRole: 'internal' | 'external';
  eventTime: EventTime;
  annotation: CenturionThreadTurnAnnotation | null;
};

export type VerifiedInternalEvidence = {
  tier: 'persisted_reply' | 'quoted_reply';
  sourceMessageId: string;
  observedAt: string | null;
  quoteProvenance: QuotedEvidence['provenance'] | null;
};

export type ResponseGap = {
  kind: 'first_response' | 'follow_up';
  actionableMessageId: string;
  responseMessageId: string | null;
  durationMs: number | null;
  reason: 'missing_event_time' | 'no_persisted_roster_response' | null;
};

export type ThreadConversationComponent = {
  id: string;
  persistedThreadIds: readonly string[];
  chronology: readonly ThreadChronologyTurn[];
  participantRoles: readonly ThreadParticipantRole[];
  responseGaps: readonly ResponseGap[];
  firstResponseLatencyMs: number | null;
  firstVerifiedInternalEvidence: VerifiedInternalEvidence | null;
  lastVerifiedInternalEvidence: VerifiedInternalEvidence | null;
  latestExternalActionableTurn: {
    messageId: string;
    eventTime: EventTime;
  } | null;
  elapsedDuration: {
    milliseconds: number | null;
    reason: 'missing_event_time' | null;
  };
  actionEvidence: ThreadActionEvidence;
  responseEvidence: ThreadResponseEvidence;
  evidenceTier: ThreadEvidenceTier;
  limitation: ThreadLimitation;
  limitations: readonly Exclude<ThreadLimitation, 'none'>[];
  weakCorrelationIndicators: {
    bucketCount: number;
    latestActionableTurnAffected: boolean;
  };
  quotedEvidence: readonly QuotedEvidence[];
  coverage: {
    complete: boolean;
    attestation: 'complete' | 'missing' | 'incomplete' | 'invalid';
    authorizedTransportIds: readonly string[];
    attestedTransportIds: readonly string[];
    missingRosterTransportIds: readonly string[];
    crossScopeTransportIds: readonly string[];
    observedTransportIds: readonly string[];
    unauthorizedTransportIds: readonly string[];
  };
  state: ThreadState;
};

export type CenturionThreadIntelligenceResult = {
  schema: typeof CENTURION_THREAD_INTELLIGENCE_SCHEMA;
  graph: {
    hardEdges: readonly HardGraphEdge[];
    weakCorrelation: {
      bucketCount: number;
      affectedComponentCount: number;
    };
  };
  components: readonly ThreadConversationComponent[];
};

type AnnotationStatus = 'valid' | 'missing' | 'ambiguous';

type IndexedMessage = {
  index: number;
  key: string;
  id: string;
  threadId: string;
  transportId: string;
  direction: 'inbound' | 'outbound';
  eventTime: EventTime;
  senderIdentity: string;
  senderRole: 'internal' | 'external';
  participantIdentities: readonly string[];
  subject: string;
  messageHeader: string | null;
  replyHeaders: readonly string[];
  annotation: CenturionThreadTurnAnnotation | null;
  annotationStatus: AnnotationStatus;
  quotedEvidence: readonly QuotedEvidence[];
  quoteCoverageLimitation:
    | 'quote_text_truncated'
    | 'unsupported_quote_like'
    | 'html_only_quote_coverage'
    | 'quote_parser_coverage_missing'
    | 'quote_parser_coverage_limited'
    | null;
  ambiguousReplyHeader: boolean;
  malformedReplyHeader: boolean;
};

type QuoteDraft = {
  marker: QuotedEvidence['provenance']['marker'];
  startLine: number;
  endLine: number;
  depth: number;
  sender: string | null;
  quotedMessageId: string | null;
  quotedTimestamp: string | null;
  hasOutlookContext: boolean;
};

type RosterLookup = {
  identities: ReadonlySet<string>;
  authorizedTransportIds: ReadonlySet<string>;
  orderedAuthorizedTransportIds: readonly string[];
};

type SourceCoverageCheck = {
  attestation: 'complete' | 'missing' | 'incomplete' | 'invalid';
  attestedTransportIds: readonly string[];
  missingRosterTransportIds: readonly string[];
  crossScopeTransportIds: readonly string[];
};

type WeakCorrelationSummary = {
  byRoot: ReadonlyMap<number, number>;
  affectedMessageIndexes: ReadonlySet<number>;
  bucketCount: number;
};

class DisjointSet {
  private readonly parents: number[];

  constructor(length: number) {
    this.parents = Array.from({ length }, (_, index) => index);
  }

  find(value: number): number {
    const parent = this.parents[value]!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parents[value] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parents[rightRoot] = leftRoot;
    }
  }
}

function fail(code: string): never {
  throw new Error(code);
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

function requiredIdentifier(value: string, code: string): string {
  const normalized = normalizedText(value);
  if (!normalized) fail(code);
  return normalized;
}

function normalizeIdentity(value: string): string {
  const normalized = normalizedText(value);
  const bracketed = normalized.match(/<([^<>\s]+)>/u)?.[1];
  const candidate = bracketed ?? normalized;
  const email = candidate.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  )?.[0];
  return (email ?? candidate).toLocaleLowerCase('en-US');
}

function normalizeHeader(value: string | null): string | null {
  if (value === null) return null;
  const normalized = normalizedText(value);
  if (!normalized) return null;
  const bracketed = normalized.match(/^<([^<>\s]+)>$/u)?.[1];
  if (bracketed) return bracketed;
  return /^[^<>\s]+$/u.test(normalized) ? normalized : null;
}

function isMalformedHeader(value: string | null): boolean {
  return value !== null && normalizeHeader(value) === null;
}

function normalizeSubject(value: string): string {
  return normalizedText(value)
    .toLocaleLowerCase('en-US')
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/iu, '')
    .replace(/\s+/gu, ' ');
}

function normalizeTrustedTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const match = normalizedText(value).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u,
  );
  if (!match || match[8] === '-00:00') return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0') || '0');
  const localUtc = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond),
  );
  if (
    localUtc.getUTCFullYear() !== year ||
    localUtc.getUTCMonth() !== month - 1 ||
    localUtc.getUTCDate() !== day ||
    localUtc.getUTCHours() !== hour ||
    localUtc.getUTCMinutes() !== minute ||
    localUtc.getUTCSeconds() !== second ||
    localUtc.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  const offset = match[8]!;
  const offsetSign = offset === 'Z' ? 1 : offset.startsWith('+') ? 1 : -1;
  const offsetHours = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const epoch =
    localUtc.getTime() -
    offsetSign * (offsetHours * 60 + offsetMinutes) * 60 * 1_000;
  return new Date(epoch).toISOString();
}

function deriveEventTime(message: CenturionThreadIntelligenceMessage): EventTime {
  const candidates =
    message.direction === 'inbound'
      ? [
          ['receivedAt', 'received_at'],
          ['createdAt', 'created_at'],
        ]
      : [
          ['sentAt', 'sent_at'],
          ['createdAt', 'created_at'],
        ];
  for (const [field, source] of candidates) {
    const timestamp = normalizeTrustedTimestamp(
      message.timestamps[field as keyof CenturionThreadIntelligenceMessage['timestamps']],
    );
    if (timestamp) {
      return {
        value: timestamp,
        source: source as Exclude<EventTimeSource, 'missing'>,
        quality: 'trustworthy',
      };
    }
  }
  return { value: null, source: 'missing', quality: 'missing' };
}

function normalizeRoster(roster: CenturionThreadIntelligenceRoster): RosterLookup {
  if (roster.schemaVersion !== CENTURION_THREAD_INTELLIGENCE_ROSTER_SCHEMA) {
    fail('CENTURION_THREAD_INTELLIGENCE_ROSTER_VERSION_INVALID');
  }
  const identities = new Set<string>();
  for (const identity of roster.identities) {
    const normalized = normalizeIdentity(identity);
    if (!normalized || identities.has(normalized)) {
      fail('CENTURION_THREAD_INTELLIGENCE_ROSTER_IDENTITY_INVALID');
    }
    identities.add(normalized);
  }
  const authorizedTransportIds = new Set<string>();
  for (const transportId of roster.authorizedTransportIds) {
    const normalized = requiredIdentifier(
      transportId,
      'CENTURION_THREAD_INTELLIGENCE_TRANSPORT_INVALID',
    );
    if (authorizedTransportIds.has(normalized)) {
      fail('CENTURION_THREAD_INTELLIGENCE_TRANSPORT_INVALID');
    }
    authorizedTransportIds.add(normalized);
  }
  if (identities.size === 0 || authorizedTransportIds.size === 0) {
    fail('CENTURION_THREAD_INTELLIGENCE_ROSTER_INCOMPLETE');
  }
  return {
    identities,
    authorizedTransportIds,
    orderedAuthorizedTransportIds: [...authorizedTransportIds].sort(),
  };
}

function sameIdentifiers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function checkSourceCoverage(
  corpora: readonly CenturionThreadStateCorpus[],
  roster: RosterLookup,
): SourceCoverageCheck {
  const attestedTransportIds = corpora
    .map((corpus) => corpus.source.transportId)
    .sort();
  const missingRosterTransportIds = roster.orderedAuthorizedTransportIds.filter(
    (transportId) => !attestedTransportIds.includes(transportId),
  );
  const crossScopeTransportIds = attestedTransportIds.filter(
    (transportId) => !roster.authorizedTransportIds.has(transportId),
  );
  return {
    attestation:
      sameIdentifiers(attestedTransportIds, roster.orderedAuthorizedTransportIds)
        ? 'complete'
        : 'incomplete',
    attestedTransportIds,
    missingRosterTransportIds,
    crossScopeTransportIds,
  };
}

function normalizeAnnotation(
  annotation: CenturionThreadTurnAnnotation,
): CenturionThreadTurnAnnotation {
  const messageId = requiredIdentifier(
    annotation.messageId,
    'CENTURION_THREAD_INTELLIGENCE_ANNOTATION_INVALID',
  );
  if (!INTENTS.has(annotation.intent) || !ACTIONABILITY.has(annotation.actionability)) {
    fail('CENTURION_THREAD_INTELLIGENCE_ANNOTATION_INVALID');
  }
  return { ...annotation, messageId };
}

function isAnnotationSemanticallyValid(
  annotation: CenturionThreadTurnAnnotation,
): boolean {
  if (annotation.intent === 'ambiguous' || annotation.actionability === 'ambiguous') {
    return false;
  }
  if (annotation.intent === 'actionable_request') {
    return annotation.actionability === 'actionable';
  }
  return annotation.actionability === 'non_actionable';
}

function createAnnotationLookup(
  messages: readonly CenturionThreadIntelligenceMessage[],
  annotations: readonly CenturionThreadTurnAnnotation[],
): ReadonlyMap<string, { annotation: CenturionThreadTurnAnnotation | null; status: AnnotationStatus }> {
  const knownMessageIds = new Set(messages.map((message) => requiredIdentifier(
    message.id,
    'CENTURION_THREAD_INTELLIGENCE_MESSAGE_ID_INVALID',
  )));
  const annotationsById = new Map<string, CenturionThreadTurnAnnotation | null>();
  for (const sourceAnnotation of annotations) {
    const annotation = normalizeAnnotation(sourceAnnotation);
    if (!knownMessageIds.has(annotation.messageId)) {
      fail('CENTURION_THREAD_INTELLIGENCE_ANNOTATION_MESSAGE_UNKNOWN');
    }
    if (annotationsById.has(annotation.messageId)) {
      annotationsById.set(annotation.messageId, null);
      continue;
    }
    annotationsById.set(annotation.messageId, annotation);
  }

  const lookup = new Map<
    string,
    { annotation: CenturionThreadTurnAnnotation | null; status: AnnotationStatus }
  >();
  for (const messageId of knownMessageIds) {
    const annotation = annotationsById.get(messageId);
    if (annotation === undefined) {
      lookup.set(messageId, { annotation: null, status: 'missing' });
    } else if (annotation === null || !isAnnotationSemanticallyValid(annotation)) {
      lookup.set(messageId, { annotation: null, status: 'ambiguous' });
    } else {
      lookup.set(messageId, { annotation, status: 'valid' });
    }
  }
  return lookup;
}

function createQuoteCoverageLookup(
  messages: readonly CenturionThreadIntelligenceMessage[],
  annotations: readonly CenturionThreadQuoteCoverageAnnotation[] | undefined,
): ReadonlyMap<string, CenturionThreadQuoteCoverageAnnotation['status'] | null> {
  const known = new Set(messages.map((message) => message.id));
  const lookup = new Map<
    string,
    CenturionThreadQuoteCoverageAnnotation['status'] | null
  >();
  for (const annotation of annotations ?? []) {
    if (
      !known.has(annotation.messageId) ||
      !['no_quote', 'english_structural_complete', 'limited'].includes(
        annotation.status,
      ) ||
      lookup.has(annotation.messageId)
    ) {
      lookup.set(annotation.messageId, null);
      continue;
    }
    lookup.set(annotation.messageId, annotation.status);
  }
  for (const message of messages) {
    if (!lookup.has(message.id)) lookup.set(message.id, null);
  }
  return lookup;
}

function participantIdentities(
  message: CenturionThreadIntelligenceMessage,
): readonly string[] {
  const identities = new Set<string>();
  for (const value of [
    message.participants.from,
    ...message.participants.to,
    ...message.participants.cc,
    ...message.participants.bcc,
  ]) {
    const identity = normalizeIdentity(value);
    if (identity) identities.add(identity);
  }
  return [...identities].sort();
}

function messageReplyHeaders(
  message: CenturionThreadIntelligenceMessage,
): { headers: readonly string[]; malformed: boolean; conflict: boolean } {
  const headers = new Set<string>();
  const inReplyTo = normalizeHeader(message.headers.inReplyTo);
  if (inReplyTo) headers.add(inReplyTo);
  let malformed = isMalformedHeader(message.headers.inReplyTo);
  for (const reference of message.headers.references) {
    const normalized = normalizeHeader(reference);
    if (normalized) headers.add(normalized);
    else if (isMalformedHeader(reference)) malformed = true;
  }
  const conflict = message.headers.linkageConflict === true;
  malformed ||= message.headers.malformedReferences === true;
  return {
    headers: conflict || malformed ? [] : [...headers],
    malformed,
    conflict,
  };
}

function prepareMessages(
  input: { messages: readonly CenturionThreadIntelligenceMessage[] },
  roster: RosterLookup,
  annotations: ReadonlyMap<
    string,
    { annotation: CenturionThreadTurnAnnotation | null; status: AnnotationStatus }
  >,
  quoteCoverage: ReadonlyMap<
    string,
    CenturionThreadQuoteCoverageAnnotation['status'] | null
  >,
): IndexedMessage[] {
  return input.messages.map((message, index) => {
    const id = requiredIdentifier(
      message.id,
      'CENTURION_THREAD_INTELLIGENCE_MESSAGE_ID_INVALID',
    );
    const threadId = requiredIdentifier(
      message.threadId,
      'CENTURION_THREAD_INTELLIGENCE_THREAD_ID_INVALID',
    );
    const transportId = requiredIdentifier(
      message.transportId,
      'CENTURION_THREAD_INTELLIGENCE_TRANSPORT_INVALID',
    );
    if (message.direction !== 'inbound' && message.direction !== 'outbound') {
      fail('CENTURION_THREAD_INTELLIGENCE_DIRECTION_INVALID');
    }
    const senderIdentity = normalizeIdentity(message.participants.from);
    if (!senderIdentity) {
      fail('CENTURION_THREAD_INTELLIGENCE_SENDER_INVALID');
    }
    const annotation = annotations.get(id);
    if (!annotation) fail('CENTURION_THREAD_INTELLIGENCE_ANNOTATION_INVALID');
    const replyHeaders = messageReplyHeaders(message);
    const quoteInspection = inspectQuotedText(
      id,
      message.textBody,
      message.htmlBody,
      roster.identities,
    );
    const coverageStatus = quoteCoverage.get(id) ?? null;
    const quoteCoverageLimitation =
      quoteInspection.limitation ??
      (coverageStatus === 'limited'
        ? 'quote_parser_coverage_limited'
        : coverageStatus === null
          ? 'quote_parser_coverage_missing'
          : quoteInspection.quoteLike
            ? 'unsupported_quote_like'
            : null);
    return {
      index,
      key: `${id}\u0000${index}`,
      id,
      threadId,
      transportId,
      direction: message.direction,
      eventTime: deriveEventTime(message),
      senderIdentity,
      senderRole: roster.identities.has(senderIdentity) ? 'internal' : 'external',
      participantIdentities: participantIdentities(message),
      subject: normalizeSubject(message.subject),
      messageHeader: normalizeHeader(message.headers.messageId),
      replyHeaders: replyHeaders.headers,
      annotation: annotation.annotation,
      annotationStatus: annotation.status,
      quotedEvidence: quoteInspection.evidence,
      quoteCoverageLimitation,
      ambiguousReplyHeader: replyHeaders.conflict,
      malformedReplyHeader:
        isMalformedHeader(message.headers.messageId) || replyHeaders.malformed,
    };
  });
}

function parseIdentityFromQuote(value: string): string | null {
  const normalized = normalizeIdentity(value);
  return normalized || null;
}

function parseQuoteHeader(
  line: string,
  header: 'from' | 'sent' | 'message-id',
): string | null {
  const match = line.match(
    new RegExp(`^\\s*${header.replace('-', '[- ]?')}\\s*:\\s*(.+?)\\s*$`, 'iu'),
  );
  return match?.[1] ? normalizedText(match[1]) : null;
}

function isOnWroteLine(line: string): string | null {
  const match = line.match(/^\s*On\s+(.+?)\s+wrote:\s*$/iu);
  return match?.[1] ? normalizedText(match[1]) : null;
}

function isDividerLine(line: string): boolean {
  return /^\s*(?:[-_]{3,}\s*)?(?:original|forwarded)\s+message\s*(?:[-_]{3,})?\s*$/iu.test(
    line,
  );
}

function hasQuoteLikeText(text: string): boolean {
  return /(?:^|\n)\s*>|(?:^|\n)\s*(?:from|sent|to|subject|message[- ]?id)\s*:|(?:^|\n)\s*on\s+.+\s+wrote:|(?:^|\n)\s*el\s+.+\s+escribió:|(?:^|\n)\s*(?:[-_]{3,}\s*)?(?:original|forwarded)\s+message/iu.test(
    text,
  );
}

function inspectQuotedText(
  sourceMessageId: string,
  textBody: string | null,
  htmlBody: string | null,
  rosterIdentities: ReadonlySet<string>,
): {
  evidence: readonly QuotedEvidence[];
  limitation:
    | 'quote_text_truncated'
    | 'unsupported_quote_like'
    | 'html_only_quote_coverage'
    | 'quote_parser_coverage_missing'
    | 'quote_parser_coverage_limited'
    | null;
  quoteLike: boolean;
} {
  if (!textBody) {
    return {
      evidence: [],
      limitation: htmlBody ? 'html_only_quote_coverage' : null,
      quoteLike: Boolean(htmlBody),
    };
  }
  const wasCharacterTruncated = textBody.length > MAX_QUOTE_CHARACTERS;
  const bounded = textBody.slice(0, MAX_QUOTE_CHARACTERS);
  const rawLines = bounded.split('\n');
  const wasLineTruncated = rawLines.length > MAX_QUOTE_LINES;
  const lines = rawLines.slice(0, MAX_QUOTE_LINES);
  const evidence: QuotedEvidence[] = [];
  const seen = new Set<string>();
  let active: QuoteDraft | null = null;
  let depth = -1;

  const finish = (endLine: number) => {
    if (!active) return;
    active.endLine = endLine;
    const structured =
      active.marker !== 'outlook_headers' || active.hasOutlookContext;
    const senderIdentity = active.sender
      ? parseIdentityFromQuote(active.sender)
      : null;
    if (structured && senderIdentity && rosterIdentities.has(senderIdentity)) {
      const quotedMessageId = normalizeHeader(active.quotedMessageId);
      const key = [
        sourceMessageId,
        senderIdentity,
        quotedMessageId ?? '',
        active.quotedTimestamp ?? '',
        active.startLine,
      ].join('\u0000');
      if (!seen.has(key)) {
        seen.add(key);
        evidence.push({
          sourceMessageId,
          senderIdentity,
          senderRole: 'internal',
          quotedMessageId,
          quotedTimestamp: active.quotedTimestamp,
          provenance: {
            marker: active.marker,
            startLine: active.startLine,
            endLine: active.endLine,
            depth: active.depth,
          },
        });
      }
    }
    active = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const onWrote = isOnWroteLine(line);
    if (onWrote) {
      finish(index - 1);
      depth += 1;
      active = {
        marker: 'on_wrote',
        startLine: index,
        endLine: index,
        depth,
        sender: onWrote,
        quotedMessageId: null,
        quotedTimestamp: null,
        hasOutlookContext: false,
      };
      continue;
    }
    if (isDividerLine(line)) {
      if (
        active?.marker === 'on_wrote' &&
        active.sender !== null &&
        rosterIdentities.has(
          parseIdentityFromQuote(active.sender) ?? '',
        ) &&
        index - active.startLine <= 6 &&
        active.quotedMessageId === null
      ) {
        active.endLine = index;
        continue;
      }
      finish(index - 1);
      depth += 1;
      active = {
        marker: 'divider',
        startLine: index,
        endLine: index,
        depth,
        sender: null,
        quotedMessageId: null,
        quotedTimestamp: null,
        hasOutlookContext: false,
      };
      continue;
    }

    const from = parseQuoteHeader(line, 'from');
    if (from) {
      if (
        active &&
        ((active.marker === 'divider' && active.sender === null) ||
          (active.marker === 'on_wrote' &&
            index - active.startLine <= 6 &&
            active.quotedMessageId === null))
      ) {
        active.sender = from;
        if (active.marker === 'divider') active.marker = 'outlook_headers';
      } else {
        finish(index - 1);
        active = {
          marker: 'outlook_headers',
          startLine: index,
          endLine: index,
          depth: Math.max(depth, 0),
          sender: from,
          quotedMessageId: null,
          quotedTimestamp: null,
          hasOutlookContext: false,
        };
      }
      continue;
    }

    if (!active) continue;
    const sent = parseQuoteHeader(line, 'sent');
    if (sent) {
      active.quotedTimestamp = sent;
      active.endLine = index;
      active.hasOutlookContext = true;
      continue;
    }
    const messageId = parseQuoteHeader(line, 'message-id');
    if (messageId) {
      active.quotedMessageId = messageId;
      active.endLine = index;
      continue;
    }
    if (/^\s*(?:to|subject)\s*:/iu.test(line)) {
      active.endLine = index;
      active.hasOutlookContext = true;
    }
  }
  finish(lines.length - 1);
  return {
    evidence,
    quoteLike: hasQuoteLikeText(bounded),
    limitation:
      wasCharacterTruncated || wasLineTruncated
        ? 'quote_text_truncated'
        : evidence.length === 0 && hasQuoteLikeText(bounded)
          ? 'unsupported_quote_like'
          : null,
  };
}

export function extractCenturionQuotedEvidence(input: {
  sourceMessageId: string;
  textBody: string | null;
  roster: CenturionThreadIntelligenceRoster;
}): readonly QuotedEvidence[] {
  const roster = normalizeRoster(input.roster);
  return inspectQuotedText(
    requiredIdentifier(
      input.sourceMessageId,
      'CENTURION_THREAD_INTELLIGENCE_MESSAGE_ID_INVALID',
    ),
    input.textBody,
    null,
    roster.identities,
  ).evidence;
}

function buildHeaderIndex(
  messages: readonly IndexedMessage[],
): ReadonlyMap<string, readonly number[]> {
  const index = new Map<string, number[]>();
  for (const message of messages) {
    if (!message.messageHeader) continue;
    const key = `${message.transportId}\u0000${message.messageHeader}`;
    const candidates = index.get(key) ?? [];
    candidates.push(message.index);
    index.set(key, candidates);
  }
  return index;
}

function compareMessages(left: IndexedMessage, right: IndexedMessage): number {
  if (left.eventTime.value && right.eventTime.value) {
    const byTime = left.eventTime.value.localeCompare(right.eventTime.value);
    if (byTime !== 0) return byTime;
  } else if (left.eventTime.value) {
    return -1;
  } else if (right.eventTime.value) {
    return 1;
  }
  return left.key.localeCompare(right.key);
}

function addHardEdge(
  edges: HardGraphEdge[],
  edgeKeys: Set<string>,
  union: DisjointSet,
  messages: readonly IndexedMessage[],
  sourceIndex: number,
  targetIndex: number,
  kind: HardGraphEdge['kind'],
): void {
  if (sourceIndex === targetIndex) return;
  const edgeKey = `${kind}\u0000${sourceIndex}\u0000${targetIndex}`;
  if (edgeKeys.has(edgeKey)) return;
  edgeKeys.add(edgeKey);
  union.union(sourceIndex, targetIndex);
  edges.push({
    kind,
    sourceMessageId: messages[sourceIndex]!.id,
    targetMessageId: messages[targetIndex]!.id,
  });
}

function connectHardEdges(messages: IndexedMessage[]): {
  union: DisjointSet;
  hardEdges: HardGraphEdge[];
} {
  const union = new DisjointSet(messages.length);
  const hardEdges: HardGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const byThread = new Map<string, number[]>();
  for (const message of messages) {
    const threadKey = `${message.transportId}\u0000${message.threadId}`;
    const indexes = byThread.get(threadKey) ?? [];
    indexes.push(message.index);
    byThread.set(threadKey, indexes);
  }
  for (const indexes of byThread.values()) {
    const [first, ...rest] = indexes;
    for (const index of rest) {
      addHardEdge(
        hardEdges,
        edgeKeys,
        union,
        messages,
        first!,
        index,
        'same_persisted_thread',
      );
    }
  }

  const headerIndex = buildHeaderIndex(messages);
  for (const message of messages) {
    for (const header of message.replyHeaders) {
      const candidates =
        headerIndex.get(`${message.transportId}\u0000${header}`) ?? [];
      if (candidates.length === 1) {
        addHardEdge(
          hardEdges,
          edgeKeys,
          union,
          messages,
          message.index,
          candidates[0]!,
          'unique_reply_header',
        );
      } else if (candidates.length > 1) {
        message.ambiguousReplyHeader = true;
      }
    }
    for (const quote of message.quotedEvidence) {
      if (!quote.quotedMessageId) continue;
      const candidates =
        headerIndex.get(
          `${message.transportId}\u0000${quote.quotedMessageId}`,
        ) ?? [];
      if (candidates.length === 1) {
        const target = messages[candidates[0]!]!;
        if (
          target.senderRole === 'internal' &&
          target.senderIdentity === quote.senderIdentity
        ) {
          addHardEdge(
            hardEdges,
            edgeKeys,
            union,
            messages,
            message.index,
            target.index,
            'unique_quoted_message_id',
          );
        } else {
          message.ambiguousReplyHeader = true;
        }
      } else if (candidates.length > 1) {
        message.ambiguousReplyHeader = true;
      }
    }
  }
  return { union, hardEdges };
}

function buildWeakCorrelationSummary(
  messages: readonly IndexedMessage[],
  union: DisjointSet,
): WeakCorrelationSummary {
  const buckets = new Map<string, number[]>();
  for (const message of messages) {
    if (!message.subject) continue;
    for (const participant of message.participantIdentities) {
      if (
        participant === message.senderIdentity &&
        message.senderRole === 'internal'
      ) {
        continue;
      }
      const key = `${message.subject}\u0000${participant}`;
      const indexes = buckets.get(key) ?? [];
      indexes.push(message.index);
      buckets.set(key, indexes);
    }
  }
  const byRoot = new Map<number, number>();
  const affectedMessageIndexes = new Set<number>();
  let bucketCount = 0;
  for (const indexes of buckets.values()) {
    const roots = new Set(indexes.map((index) => union.find(index)));
    if (roots.size < 2) continue;
    bucketCount += 1;
    for (const root of roots) {
      byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
    }
    for (const index of indexes) affectedMessageIndexes.add(index);
  }
  return { byRoot, affectedMessageIndexes, bucketCount };
}

function limitationsForComponent(input: {
  messages: readonly IndexedMessage[];
  sourceCoverage: SourceCoverageCheck;
  observedCrossScopeTransportIds: readonly string[];
  latestActionable: IndexedMessage | null;
  latestActionResponseExists: boolean;
  latestActionWeaklyCorrelated: boolean;
  componentWeaklyCorrelated: boolean;
  quoteParserCoverageLimitation:
    | 'quote_parser_coverage_missing'
    | 'quote_parser_coverage_limited'
    | null;
  duplicateMessageIds: ReadonlySet<string>;
}): readonly Exclude<ThreadLimitation, 'none'>[] {
  const codes = new Set<Exclude<ThreadLimitation, 'none'>>();
  if (input.messages.some((message) => message.annotationStatus !== 'valid')) {
    codes.add('missing_or_ambiguous_annotation');
  }
  if (
    input.messages.some((message) =>
      input.duplicateMessageIds.has(message.id),
    )
  ) {
    codes.add('duplicate_persisted_message');
  }
  if (input.sourceCoverage.attestation === 'missing') {
    codes.add('source_coverage_missing');
  } else if (input.sourceCoverage.attestation !== 'complete') {
    codes.add('source_coverage_incomplete');
  }
  if (input.observedCrossScopeTransportIds.length > 0) {
    codes.add('coverage_limited');
  }
  if (input.messages.some((message) => message.eventTime.quality !== 'trustworthy')) {
    codes.add('missing_event_time');
  }
  if (input.componentWeaklyCorrelated) {
    codes.add('weak_subject_participant_correlation');
  }
  if (input.quoteParserCoverageLimitation) {
    codes.add(input.quoteParserCoverageLimitation);
  }
  if (
    input.latestActionable &&
    !input.latestActionResponseExists &&
    input.latestActionable.quotedEvidence.length > 0
  ) {
    codes.add('quoted_only_evidence');
  }
  if (input.messages.some((message) => message.ambiguousReplyHeader)) {
    codes.add('ambiguous_reply_header');
  }
  if (input.messages.some((message) => message.malformedReplyHeader)) {
    codes.add('malformed_reply_header');
  }
  if (input.latestActionable?.quoteCoverageLimitation) {
    codes.add(input.latestActionable.quoteCoverageLimitation);
  }
  if (!input.latestActionable) codes.add('no_actionable_external_turn');

  const ordered: Exclude<ThreadLimitation, 'none'>[] = [
    'missing_or_ambiguous_annotation',
    'duplicate_persisted_message',
    'source_coverage_missing',
    'source_coverage_incomplete',
    'coverage_limited',
    'missing_event_time',
    'weak_subject_participant_correlation',
    'quoted_only_evidence',
    'ambiguous_reply_header',
    'malformed_reply_header',
    'quote_text_truncated',
    'unsupported_quote_like',
    'html_only_quote_coverage',
    'quote_parser_coverage_missing',
    'quote_parser_coverage_limited',
    'no_actionable_external_turn',
  ];
  return ordered.filter((code) => codes.has(code));
}

function primaryLimitation(
  limitations: readonly Exclude<ThreadLimitation, 'none'>[],
): ThreadLimitation {
  return limitations[0] ?? 'none';
}

function evidenceTierForComponent(input: {
  responseExists: boolean;
  quotedEvidence: readonly QuotedEvidence[];
  weak: boolean;
}): ThreadEvidenceTier {
  if (input.responseExists) return 'persisted_reply';
  if (input.quotedEvidence.length > 0) return 'quoted_reply';
  if (input.weak) return 'participant_subject_only_correlation';
  return 'no_evidence';
}

function actionEvidenceForComponent(input: {
  latestActionable: IndexedMessage | null;
  limitations: readonly Exclude<ThreadLimitation, 'none'>[];
}): ThreadActionEvidence {
  if (!input.latestActionable) {
    return {
      tier: 'no_actionable_evidence',
      messageId: null,
      actionRequiredEligible: false,
    };
  }
  if (input.latestActionable.eventTime.quality !== 'trustworthy') {
    return {
      tier: 'annotated_actionable_missing_event_time',
      messageId: input.latestActionable.id,
      actionRequiredEligible: false,
    };
  }
  const blockingLimitations = input.limitations.filter(
    (limitation) => limitation !== 'no_actionable_external_turn',
  );
  return {
    tier: 'persisted_trusted_actionable_external',
    messageId: input.latestActionable.id,
    actionRequiredEligible: blockingLimitations.length === 0,
  };
}

function compareEvidence(
  left: VerifiedInternalEvidence,
  right: VerifiedInternalEvidence,
): number {
  if (left.observedAt && right.observedAt) {
    const byTime = left.observedAt.localeCompare(right.observedAt);
    if (byTime !== 0) return byTime;
  } else if (left.observedAt) {
    return -1;
  } else if (right.observedAt) {
    return 1;
  }
  return left.sourceMessageId.localeCompare(right.sourceMessageId);
}

function verifiedInternalEvidence(
  messages: readonly IndexedMessage[],
): readonly VerifiedInternalEvidence[] {
  const evidence: VerifiedInternalEvidence[] = [];
  for (const message of messages) {
    if (message.senderRole === 'internal') {
      evidence.push({
        tier: 'persisted_reply',
        sourceMessageId: message.id,
        observedAt: message.eventTime.value,
        quoteProvenance: null,
      });
    }
    for (const quote of message.quotedEvidence) {
      evidence.push({
        tier: 'quoted_reply',
        sourceMessageId: quote.sourceMessageId,
        observedAt: message.eventTime.value,
        quoteProvenance: quote.provenance,
      });
    }
  }
  return evidence.sort(compareEvidence);
}

function isActionableExternal(message: IndexedMessage): boolean {
  return (
    message.senderRole === 'external' &&
    message.annotationStatus === 'valid' &&
    message.annotation?.intent === 'actionable_request' &&
    message.annotation.actionability === 'actionable'
  );
}

function isPersistedRosterResponse(message: IndexedMessage): boolean {
  return (
    message.senderRole === 'internal' &&
    message.annotationStatus === 'valid' &&
    message.annotation?.intent === 'staff_response'
  );
}

function responseGapsForComponent(
  messages: readonly IndexedMessage[],
): {
  gaps: readonly ResponseGap[];
  latestActionable: IndexedMessage | null;
  responseExists: boolean;
  latestActionResponseExists: boolean;
} {
  const actionable = messages.filter(isActionableExternal).sort(compareMessages);
  const gaps = actionable.map((turn, index) => {
    if (!turn.eventTime.value) {
      return {
        kind: index === 0 ? 'first_response' : 'follow_up',
        actionableMessageId: turn.id,
        responseMessageId: null,
        durationMs: null,
        reason: 'missing_event_time',
      } satisfies ResponseGap;
    }
    const response = messages
      .filter(
        (candidate) =>
          isPersistedRosterResponse(candidate) &&
          candidate.eventTime.value !== null &&
          candidate.eventTime.value > turn.eventTime.value!,
      )
      .sort(compareMessages)[0];
    if (!response || !response.eventTime.value) {
      return {
        kind: index === 0 ? 'first_response' : 'follow_up',
        actionableMessageId: turn.id,
        responseMessageId: null,
        durationMs: null,
        reason: 'no_persisted_roster_response',
      } satisfies ResponseGap;
    }
    return {
      kind: index === 0 ? 'first_response' : 'follow_up',
      actionableMessageId: turn.id,
      responseMessageId: response.id,
      durationMs:
        new Date(response.eventTime.value).getTime() -
        new Date(turn.eventTime.value).getTime(),
      reason: null,
    } satisfies ResponseGap;
  });
  return {
    gaps,
    latestActionable: actionable.at(-1) ?? null,
    responseExists: gaps.some((gap) => gap.responseMessageId !== null),
    latestActionResponseExists:
      (gaps.at(-1)?.responseMessageId ?? null) !== null,
  };
}

function terminalStateForComponent(input: {
  chronology: readonly IndexedMessage[];
  limitations: readonly Exclude<ThreadLimitation, 'none'>[];
  latestActionable: IndexedMessage | null;
  latestActionResponseExists: boolean;
  actionEvidence: ThreadActionEvidence;
}): ThreadState {
  const blockingLimitations = input.limitations.filter(
    (limitation) => limitation !== 'no_actionable_external_turn',
  );
  if (blockingLimitations.length > 0) return 'needs_manual_adjudication';
  if (
    input.latestActionable &&
    input.actionEvidence.actionRequiredEligible &&
    !input.latestActionResponseExists
  ) {
    return 'action_required';
  }

  const stateBearingExternal = input.chronology.filter(
    (message) =>
      message.senderRole === 'external' &&
      message.annotationStatus === 'valid' &&
      (message.annotation?.intent === 'actionable_request' ||
        message.annotation?.intent ===
          'customer_acknowledgement_or_confirmation' ||
        message.annotation?.intent === 'automated_or_non_actionable'),
  );
  const latestStateBearing = stateBearingExternal.at(-1);
  if (
    latestStateBearing?.annotation?.intent ===
    'customer_acknowledgement_or_confirmation'
  ) {
    return 'customer_acknowledgement_or_confirmation';
  }
  if (
    latestStateBearing?.annotation?.intent === 'automated_or_non_actionable'
  ) {
    return 'automated_or_non_actionable';
  }
  if (!input.latestActionable) return 'needs_manual_adjudication';
  return 'resolved';
}

function elapsedDurationForComponent(messages: readonly IndexedMessage[]): {
  milliseconds: number | null;
  reason: 'missing_event_time' | null;
} {
  if (messages.some((message) => !message.eventTime.value)) {
    return { milliseconds: null, reason: 'missing_event_time' };
  }
  const chronology = [...messages].sort(compareMessages);
  const first = chronology[0]?.eventTime.value;
  const last = chronology.at(-1)?.eventTime.value;
  if (!first || !last) return { milliseconds: null, reason: 'missing_event_time' };
  return {
    milliseconds: new Date(last).getTime() - new Date(first).getTime(),
    reason: null,
  };
}

function participantRolesForComponent(
  messages: readonly IndexedMessage[],
  roster: RosterLookup,
): readonly ThreadParticipantRole[] {
  const identities = new Set<string>();
  for (const message of messages) {
    for (const identity of message.participantIdentities) identities.add(identity);
  }
  return [...identities]
    .sort()
    .map((identity) => ({
      identity,
      role: roster.identities.has(identity) ? 'internal' : 'external',
    }));
}

function messagesFromCanonicalCorpora(
  corpora: readonly CenturionThreadStateCorpus[],
): CenturionThreadIntelligenceMessage[] {
  return corpora.flatMap((corpus) =>
    corpus.messages.map((message) => ({
      id: message.id,
      threadId: message.threadId,
      transportId: message.transportId,
      direction: message.direction,
      timestamps: message.timestamps,
      participants: message.participants,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      headers: message.headers,
    })),
  );
}

export function analyzeCenturionThreadIntelligence(
  input: CenturionThreadIntelligenceInput,
): CenturionThreadIntelligenceResult {
  const roster = normalizeRoster(input.roster);
  if (!input.corpora) {
    fail('CENTURION_THREAD_INTELLIGENCE_CANONICAL_CORPORA_REQUIRED');
  }
  const corpora = input.corpora.map(parsePersistedCenturionThreadStateCorpus);
  const rawMessages = messagesFromCanonicalCorpora(corpora);
  const sourceCoverage = checkSourceCoverage(corpora, roster);
  const annotations = createAnnotationLookup(rawMessages, input.annotations);
  const quoteCoverage = createQuoteCoverageLookup(
    rawMessages,
    input.quoteCoverage,
  );
  const messages = prepareMessages(
    { messages: rawMessages },
    roster,
    annotations,
    quoteCoverage,
  );
  const messageIdCounts = new Map<string, number>();
  for (const message of messages) {
    messageIdCounts.set(message.id, (messageIdCounts.get(message.id) ?? 0) + 1);
  }
  const duplicateMessageIds = new Set(
    [...messageIdCounts].flatMap(([messageId, count]) =>
      count > 1 ? [messageId] : [],
    ),
  );
  const { union, hardEdges } = connectHardEdges(messages);
  const weakCorrelation = buildWeakCorrelationSummary(messages, union);

  const groups = new Map<number, IndexedMessage[]>();
  for (const message of messages) {
    const root = union.find(message.index);
    const group = groups.get(root) ?? [];
    group.push(message);
    groups.set(root, group);
  }
  const orderedGroups = [...groups.entries()]
    .map(([root, group]) => ({ root, group: group.sort(compareMessages) }))
    .sort((left, right) => compareMessages(left.group[0]!, right.group[0]!));

  const components = orderedGroups.map(({ root, group }, index) => {
    const observedTransportIds = [...new Set(group.map((message) => message.transportId))].sort();
    const unauthorizedTransportIds = observedTransportIds.filter(
      (transportId) => !roster.authorizedTransportIds.has(transportId),
    );
    const coverageComplete =
      sourceCoverage.attestation === 'complete' &&
      unauthorizedTransportIds.length === 0;
    const response = responseGapsForComponent(group);
    const quotedEvidence = group.flatMap((message) => message.quotedEvidence);
    const weakBucketCount = weakCorrelation.byRoot.get(root) ?? 0;
    const latestActionWeaklyCorrelated =
      response.latestActionable !== null &&
      weakCorrelation.affectedMessageIndexes.has(response.latestActionable.index);
    const limitations = limitationsForComponent({
      messages: group,
      sourceCoverage,
      observedCrossScopeTransportIds: unauthorizedTransportIds,
      latestActionable: response.latestActionable,
      latestActionResponseExists: response.latestActionResponseExists,
      latestActionWeaklyCorrelated,
      componentWeaklyCorrelated: weakBucketCount > 0,
      quoteParserCoverageLimitation: null,
      duplicateMessageIds,
    });
    const actionEvidence = actionEvidenceForComponent({
      latestActionable: response.latestActionable,
      limitations,
    });
    const responseEvidenceTier = evidenceTierForComponent({
      responseExists: response.responseExists,
      quotedEvidence,
      weak: weakBucketCount > 0,
    });
    const internalEvidence = verifiedInternalEvidence(group);
    const chronology: ThreadChronologyTurn[] = group.map((message) => ({
      messageId: message.id,
      persistedThreadId: message.threadId,
      transportId: message.transportId,
      direction: message.direction,
      senderRole: message.senderRole,
      eventTime: message.eventTime,
      annotation: message.annotation,
    }));
    return {
      id: `component-${index + 1}`,
      persistedThreadIds: [...new Set(group.map((message) => message.threadId))].sort(),
      chronology,
      participantRoles: participantRolesForComponent(group, roster),
      responseGaps: response.gaps,
      firstResponseLatencyMs: response.gaps[0]?.durationMs ?? null,
      firstVerifiedInternalEvidence: internalEvidence[0] ?? null,
      lastVerifiedInternalEvidence: internalEvidence.at(-1) ?? null,
      latestExternalActionableTurn: response.latestActionable
        ? {
            messageId: response.latestActionable.id,
            eventTime: response.latestActionable.eventTime,
          }
        : null,
      elapsedDuration: elapsedDurationForComponent(group),
      actionEvidence,
      responseEvidence: {
        tier: responseEvidenceTier,
        latestActionResponseMessageId:
          response.gaps.at(-1)?.responseMessageId ?? null,
      },
      evidenceTier: responseEvidenceTier,
      limitation: primaryLimitation(limitations),
      limitations,
      weakCorrelationIndicators: {
        bucketCount: weakBucketCount,
        latestActionableTurnAffected: latestActionWeaklyCorrelated,
      },
      quotedEvidence,
      coverage: {
        complete: coverageComplete,
        attestation: sourceCoverage.attestation,
        authorizedTransportIds: roster.orderedAuthorizedTransportIds,
        attestedTransportIds: sourceCoverage.attestedTransportIds,
        missingRosterTransportIds: sourceCoverage.missingRosterTransportIds,
        crossScopeTransportIds: [
          ...new Set([
            ...sourceCoverage.crossScopeTransportIds,
            ...unauthorizedTransportIds,
          ]),
        ].sort(),
        observedTransportIds,
        unauthorizedTransportIds,
      },
      state: terminalStateForComponent({
        chronology: group,
        limitations,
        latestActionable: response.latestActionable,
        latestActionResponseExists: response.latestActionResponseExists,
        actionEvidence,
      }),
    } satisfies ThreadConversationComponent;
  });

  return {
    schema: CENTURION_THREAD_INTELLIGENCE_SCHEMA,
    graph: {
      hardEdges,
      weakCorrelation: {
        bucketCount: weakCorrelation.bucketCount,
        affectedComponentCount: weakCorrelation.byRoot.size,
      },
    },
    components,
  };
}
