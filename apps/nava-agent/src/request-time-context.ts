/**
 * Agent-side wiring for server-attested request-time context.
 * Pure linker lives in server-pilot; this module accepts, freezes, and projects.
 */
import {
  acceptRequestTimeContext,
  deliveryEnvelopeKey,
  selectedDeliveryRevision,
  type RequestTimeContextPacket,
  type RequestTimeScope,
} from '../../server-pilot/src/mail/request-time-context.js';

export {
  acceptRequestTimeContext,
  deliveryEnvelopeKey,
  projectRequestTimeContext,
  projectRequestTimeContextFromExport,
  selectedDeliveryRevision,
  REQUEST_TIME_CONTEXT_VERSION,
  type RequestTimeContextPacket,
  type RequestTimeEarlier,
  type RequestTimeContextResult,
} from '../../server-pilot/src/mail/request-time-context.js';

export type StoredRequestTimeContext =
  | { state: 'observed'; packet: RequestTimeContextPacket }
  | { state: 'unobserved'; reason: string; contextDigest: string };

/** Strip enrichment from identity / filing hash inputs. */
export function withoutRequestTimeContext<T extends { request_time_context?: unknown }>(input: T): Omit<T, 'request_time_context'> {
  const { request_time_context: _drop, ...rest } = input;
  return rest;
}

export function parseImportRequestTimeContext(
  raw: unknown,
  expected: { property: string | null; mailbox: string; selectedId: string },
): StoredRequestTimeContext | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.state === 'unobserved') {
    if (typeof row.reason !== 'string' || typeof row.contextDigest !== 'string') return null;
    return { state: 'unobserved', reason: row.reason, contextDigest: row.contextDigest };
  }
  if (!expected.property) return null;
  const scope: RequestTimeScope = { property: expected.property, mailbox: expected.mailbox };
  const packet = acceptRequestTimeContext(raw, {
    scope,
    selectedId: expected.selectedId,
    allowedAttestations: ['nava_gateway', 'nava_arrival', 'offline'],
  });
  return packet ? { state: 'observed', packet } : null;
}

export function deliveryKeyForSelected(
  property: string | null,
  mailbox: string,
  selected: Parameters<typeof selectedDeliveryRevision>[0],
): string | null {
  if (!property) return null;
  return deliveryEnvelopeKey({
    property,
    mailbox,
    selectedId: selected.id,
    revision: selectedDeliveryRevision(selected),
  });
}

/** Same packet for sessionMailPrompt and mail_read_thread. */
export function projectStoredRequestTimeContext(stored: StoredRequestTimeContext | null | undefined): unknown {
  if (!stored) return undefined;
  if (stored.state === 'unobserved') {
    return { state: 'unobserved', reason: stored.reason, contextDigest: stored.contextDigest, earlier: [] };
  }
  const { packet } = stored;
  return {
    version: packet.version,
    selectedId: packet.selectedId,
    cutoff: packet.cutoff,
    contextDigest: packet.contextDigest,
    scope: packet.scope,
    attested_by: packet.attested_by,
    earlier: packet.earlier.map((item) => ({
      sourceMessageId: item.sourceMessageId,
      threadId: item.threadId,
      relation: item.relation,
      evidenceRefs: item.evidenceRefs,
      bodyRef: item.bodyRef,
      body_text: item.bodyText,
      attachmentRefs: item.attachmentRefs.map((file) => ({
        id: file.id,
        contentDigest: file.contentDigest ?? null,
        // Read-only extracts only — never file handles.
        extracted_text: file.extractedText,
      })),
    })),
  };
}
