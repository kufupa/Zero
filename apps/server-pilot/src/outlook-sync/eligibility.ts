import type { SyncObservationV1 } from './contracts.js';
import { SyncDeniedError } from './authorization.js';

/** Full-tree metadata discovery is broader than the frozen original-export window. */
export function isExportEligible(
  source: { historyFrom: Date | null; historyTo: Date | null },
  observation: { evidence: Record<string, unknown> },
): boolean {
  const evidence = observation.evidence as unknown as SyncObservationV1;
  if (evidence.semanticReady === false) return true;
  if (!evidence.timestamps) return true;
  const raw =
    evidence.direction === 'outbound'
      ? evidence.timestamps.sentAt
      : evidence.direction === 'inbound'
        ? evidence.timestamps.receivedAt
        : (evidence.timestamps.receivedAt ?? evidence.timestamps.sentAt);
  if (!raw || !Number.isFinite(Date.parse(raw))) return true;
  if (!source.historyFrom || !source.historyTo) return false;
  if (Date.parse(raw) >= source.historyFrom.getTime()) return true;
  const event = evidence.event;
  return (
    evidence.direction === 'inbound' &&
    event.kind === 'new-mail' &&
    !event.isUnsent &&
    event.receivedAt === evidence.timestamps.receivedAt &&
    Date.parse(event.receivedAt ?? '') >= source.historyTo.getTime()
  );
}

export function assertExportEligible(
  source: { historyFrom: Date | null; historyTo: Date | null },
  observation: { evidence: Record<string, unknown> },
): void {
  if (!isExportEligible(source, observation)) throw new SyncDeniedError();
}
