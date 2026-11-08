'use client';

import { useEffect, useState } from 'react';
import { getQuoteOutput, quoteCoverHtml, type QuoteOutputResult } from '@/lib/reservation-workflow/quote-output';
import type { ReservationPaneSnapshot, ReservationSourceContext } from '@/lib/reservation-workflow/types';
import styles from './reservation-pane.module.css';

export type SaveQuoteOutput = (input: { snapshot: ReservationPaneSnapshot; requestId: string; html: string;
  isCurrentSnapshot: () => boolean }) => Promise<QuoteOutputResult>;

export function QuoteOutputPanel({ source, snapshot, requestId, save, latestSnapshot }: {
  source: ReservationSourceContext; snapshot: ReservationPaneSnapshot; requestId: string;
  save?: SaveQuoteOutput; latestSnapshot(): ReservationPaneSnapshot | null;
}) {
  const output = getQuoteOutput(source, snapshot, requestId);
  const [body, setBody] = useState(output?.cover?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setBody(output?.cover?.body ?? ''); setMessage(null); }, [output?.operationId]);
  if (!output) return null;
  const saveReply = async () => {
    if (!save || busy) return;
    setBusy(true); setMessage(null);
    try {
      const result = await save({ snapshot, requestId, html: quoteCoverHtml(body), isCurrentSnapshot: () => {
        const current = latestSnapshot();
        return current?.sourceMessageId === snapshot.sourceMessageId && current.session.seq === snapshot.session.seq
          && current.session.draft.generationId === snapshot.session.draft.generationId;
      } });
      setMessage(result.message);
    } catch { setMessage('The reply could not be confirmed. Check Drafts before trying again.'); }
    finally { setBusy(false); }
  };
  return <section className={styles.section}><h3>Unsent quote reply</h3>
    {output.issues.map(issue => <p className={styles.notice} key={issue}>{issue}</p>)}
    {output.failures.map(failure => <p className={styles.notice} key={failure}>{failure.replaceAll('_', ' ')}. Only the available files below can be attached.</p>)}
    {output.cover && <><p className={styles.small}>To: {output.cover.to}</p><label className={styles.field}>Cover reply<textarea aria-label="Quote cover reply" value={body} onChange={event => setBody(event.target.value)} rows={6} /></label></>}
    <div className={styles.sources}>{output.artifacts.map(artifact => <a key={artifact.sha256} download={artifact.fileName}
      href={`data:${artifact.mimeType};base64,${artifact.bytesBase64}`}>{artifact.fileName}</a>)}</div>
    <button type="button" disabled={!save || busy || output.issues.length > 0 || !body.trim()} onClick={() => { void saveReply(); }}>{busy ? 'Saving reply…' : output.failures.length ? 'Save unsent reply with available files' : 'Save unsent reply + PDF + Excel'}</button>
    {message && <p role="status" className={styles.notice}>{message}</p>}
  </section>;
}
