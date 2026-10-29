import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { identifierValues } from './centurion-confirmation-pdf-fields.js';

type JsonRecord = Record<string, unknown>;
type MessageRow = {
  threadId: string | null;
  canonicalHeaders: Record<string, string[]>;
};
type LinkablePdf = {
  source: { attachment: JsonRecord; parentMessage: JsonRecord };
  record: JsonRecord;
  confirmationNumbers: Array<{ value: string; pageNumber: number }>;
};
type LinkEdge = {
  pdfAttachmentId: string;
  messageDbId: string;
  tier: 1 | 2;
  relations: Set<string>;
  evidence: JsonRecord[];
  reviewRequired: boolean;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<+|>+$/g, '').toLowerCase();
}

function messageIdTokens(value: string): string[] {
  const bracketed = [...value.matchAll(/<([^<>]+)>/g)].map((match) => match[1]!);
  const values = bracketed.length > 0 ? bracketed : value.trim().split(/\s+/);
  return values.map(normalizeMessageId).filter(Boolean);
}

function addToIndex(index: Map<string, Set<string>>, key: string, messageDbId: string): void {
  const ids = index.get(key) ?? new Set<string>();
  ids.add(messageDbId);
  index.set(key, ids);
}

function headerValues(headers: Record<string, string[]>, name: string): string[] {
  const key = Object.keys(headers).find((value) => value.toLowerCase() === name.toLowerCase());
  return key ? headers[key] ?? [] : [];
}

export async function loadMessages(corpusPath: string): Promise<{
  byDbId: Map<string, MessageRow>;
  byThreadId: Map<string, Set<string>>;
  byMessageId: Map<string, Set<string>>;
  referencedBy: Map<string, Set<string>>;
  byIdentifier: Map<string, Set<string>>;
  threadRecordCount: number;
  sourceRowCount: number;
  duplicateSourceRowCount: number;
}> {
  const byDbId = new Map<string, MessageRow>();
  const byThreadId = new Map<string, Set<string>>();
  const byMessageId = new Map<string, Set<string>>();
  const referencedBy = new Map<string, Set<string>>();
  const byIdentifier = new Map<string, Set<string>>();
  let threadRecordCount = 0;
  let sourceRowCount = 0;
  let duplicateSourceRowCount = 0;

  const lines = createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const record = asRecord(JSON.parse(line));
    if (record.recordType !== 'thread') continue;
    threadRecordCount += 1;
    const recordThreadId = asString(record.threadId);
    const logicalMessages = Array.isArray(record.messages) ? record.messages : [];
    for (const logicalValue of logicalMessages) {
      const logical = asRecord(logicalValue);
      const sourceRows = Array.isArray(logical.sourceRows) ? logical.sourceRows : [];
      for (const sourceValue of sourceRows) {
        const source = asRecord(sourceValue);
        const dbId = asString(source.sourceRowId);
        if (!dbId) continue;
        sourceRowCount += 1;
        if (byDbId.has(dbId)) duplicateSourceRowCount += 1;
        const privateMessage = asRecord(source.privateMessage);
        const threadId = asString(source.threadId) ?? recordThreadId;
        const messageId = asString(source.messageId);
        const body = typeof source.body === 'string' ? source.body : '';
        const subject = asString(privateMessage.subject) ?? '';
        const canonicalHeaders = asRecord(privateMessage.canonicalHeaders) as Record<string, string[]>;
        byDbId.set(dbId, { threadId, canonicalHeaders });
        if (threadId) addToIndex(byThreadId, threadId, dbId);
        const messageIds = [
          ...(messageId ? [messageId] : []),
          ...headerValues(canonicalHeaders, 'Message-ID'),
        ];
        for (const value of messageIds) {
          for (const normalized of messageIdTokens(value)) {
            addToIndex(byMessageId, normalized, dbId);
          }
        }
        for (const value of [
          ...headerValues(canonicalHeaders, 'In-Reply-To'),
          ...headerValues(canonicalHeaders, 'References'),
        ]) {
          for (const normalized of messageIdTokens(value)) {
            addToIndex(referencedBy, normalized, dbId);
          }
        }
        for (const value of identifierValues(`${subject}\n${body}`)) {
          addToIndex(byIdentifier, value, dbId);
        }
      }
    }
  }

  return {
    byDbId,
    byThreadId,
    byMessageId,
    referencedBy,
    byIdentifier,
    threadRecordCount,
    sourceRowCount,
    duplicateSourceRowCount,
  };
}

function addEdge(
  edges: Map<string, LinkEdge>,
  pdfAttachmentId: string,
  messageDbId: string,
  tier: 1 | 2,
  relation: string,
  evidence: JsonRecord,
  reviewRequired = false,
): void {
  const key = `${pdfAttachmentId}\u0000${messageDbId}`;
  const existing = edges.get(key);
  if (existing) {
    existing.tier = Math.min(existing.tier, tier) as 1 | 2;
    existing.relations.add(relation);
    existing.evidence.push(evidence);
    existing.reviewRequired = existing.reviewRequired && reviewRequired;
    return;
  }
  edges.set(key, {
    pdfAttachmentId,
    messageDbId,
    tier,
    relations: new Set([relation]),
    evidence: [evidence],
    reviewRequired,
  });
}

export function linkRecord(
  item: LinkablePdf,
  indexes: Awaited<ReturnType<typeof loadMessages>>,
): JsonRecord[] {
  const attachment = item.source.attachment;
  const pdfId = asString(attachment.attachmentId) ?? 'unknown';
  const parentDbId = asString(item.source.parentMessage.messageDbId);
  if (!parentDbId) return [];
  const parent = indexes.byDbId.get(parentDbId);
  const edges = new Map<string, LinkEdge>();
  addEdge(edges, pdfId, parentDbId, 1, 'attachment_parent_message_id', {
    evidence: 'attachment.message_id equals message.id',
  });

  if (parent?.threadId) {
    for (const messageDbId of indexes.byThreadId.get(parent.threadId) ?? []) {
      addEdge(edges, pdfId, messageDbId, 1, 'same_thread_id', {
        threadId: parent.threadId,
      });
    }
  }

  if (parent) {
    const parentMessageIds = headerValues(parent.canonicalHeaders, 'Message-ID')
      .flatMap(messageIdTokens);
    const parentReferences = [
      ...headerValues(parent.canonicalHeaders, 'In-Reply-To'),
      ...headerValues(parent.canonicalHeaders, 'References'),
    ].flatMap(messageIdTokens);
    for (const messageId of parentReferences) {
      for (const linkedDbId of indexes.byMessageId.get(messageId) ?? []) {
        addEdge(edges, pdfId, linkedDbId, 1, 'message_id_header_reference', {
          matchedHeaderMessageId: messageId,
        });
      }
    }
    for (const messageId of parentMessageIds) {
      for (const linkedDbId of indexes.referencedBy.get(messageId) ?? []) {
        addEdge(edges, pdfId, linkedDbId, 1, 'referenced_by_message_id_header', {
          matchedHeaderMessageId: messageId,
        });
      }
    }
    for (const confirmation of item.confirmationNumbers) {
      for (const linkedDbId of indexes.byIdentifier.get(confirmation.value) ?? []) {
        const linked = indexes.byDbId.get(linkedDbId);
        if (!linked || linkedDbId === parentDbId || (parent.threadId !== null && linked.threadId === parent.threadId)) continue;
        addEdge(edges, pdfId, linkedDbId, 2, 'confirmation_number_body_match', {
          confirmationNumber: confirmation.value,
          pdfPageNumber: confirmation.pageNumber,
          matchedIn: 'message_subject_or_body',
        }, true);
      }
    }
  }

  const sameThreadMessageDbIds = new Set<string>();
  const headerLinkedDbIds = new Set<string>();
  const confirmationLinkedDbIds = new Set<string>();
  for (const edge of edges.values()) {
    if (edge.relations.has('same_thread_id')) sameThreadMessageDbIds.add(edge.messageDbId);
    if (edge.relations.has('message_id_header_reference') || edge.relations.has('referenced_by_message_id_header')) {
      headerLinkedDbIds.add(edge.messageDbId);
    }
    if (edge.relations.has('confirmation_number_body_match')) confirmationLinkedDbIds.add(edge.messageDbId);
  }

  const record = item.record;
  const links = asRecord(record.links);
  links.sameThreadMessageDbIds = [...sameThreadMessageDbIds].sort();
  links.messageHeaderLinkedDbIds = [...headerLinkedDbIds].sort();
  links.confirmationNumberCandidateLinkedDbIds = [...confirmationLinkedDbIds].sort();
  record.links = links;

  return [...edges.values()].map((edge) => ({
    schemaVersion: 1,
    pdfAttachmentId: edge.pdfAttachmentId,
    messageDbId: edge.messageDbId,
    tier: edge.tier,
    relations: [...edge.relations].sort(),
    evidence: edge.evidence,
    reviewRequired: edge.reviewRequired,
  }));
}
