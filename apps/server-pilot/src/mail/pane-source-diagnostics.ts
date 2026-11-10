import { createHash } from 'node:crypto';
import { canonicalMessageId } from './ingest/message-id.js';
import type { PaneSourceSelection } from './pane-source-selection.js';

const reportedAt = new Map<string, number>();
const label = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** Correlate pane failures with sync staff/store records without logging mail or credentials. */
export function logPaneSourceResolution(input: {
  userId: string; sessionId?: string; transportId: string; selection: PaneSourceSelection;
  internetMessageId?: string; matches: number;
  result: 'ready' | 'not_found' | 'ambiguous' | 'attention' | 'missing_arrival' | 'wrong_property' | 'content_mismatch';
  matchedBy?: 'web' | 'native' | 'mailbox-copy';
}) {
  const header = canonicalMessageId(input.internetMessageId);
  const event = {
    user: label(input.userId), session: input.sessionId ? label(input.sessionId) : undefined,
    mailbox: label(input.transportId), kind: input.selection.kind,
    store: input.selection.kind === 'outlook' ? label(input.selection.storeId) : undefined,
    item: label(input.selection.kind === 'outlook' ? input.selection.entryId : input.selection.messageId),
    header: header ? label(header) : undefined,
    headerNormalized: Boolean(header && header !== input.internetMessageId),
    matches: input.matches, result: input.result, matchedBy: input.matchedBy,
  };
  const key = JSON.stringify(event), now = Date.now();
  if (now - (reportedAt.get(key) ?? 0) < 60_000) return;
  if (reportedAt.size >= 1024 && !reportedAt.has(key)) reportedAt.delete(reportedAt.keys().next().value!);
  reportedAt.set(key, now);
  console.info('outlook_pane_source', JSON.stringify({ at: new Date(now).toISOString(), ...event }));
}
