'use client';

import { useEffect, useMemo, useState } from 'react';
import { getQuoteOutput, quoteCoverHtml, type QuoteOutput, type QuoteOutputResult } from '@/lib/reservation-workflow/quote-output';
import { quoteOutputState } from '@/lib/reservation-workflow/views';
import type { ReservationPaneSnapshot, ReservationSourceContext } from '@/lib/reservation-workflow/types';
import styles from './reservation-pane.module.css';

export type SaveQuoteOutput = (input: { snapshot: ReservationPaneSnapshot; requestId: string; html: string;
  isCurrentSnapshot: () => boolean }) => Promise<QuoteOutputResult>;

function EarlierQuoteFiles({ outputs }: { outputs: QuoteOutput[] }) {
  if (!outputs.length) return null;
  return <div><strong>Earlier quote files</strong><p className={styles.small}>These files may be out of date. Check them before use.</p>
    <div className={styles.sources}>{outputs.flatMap(output => output.artifacts.map(artifact =>
      <a key={`${output.operationId}:${artifact.sha256}`} download={artifact.fileName}
        href={`data:${artifact.mimeType};base64,${artifact.bytesBase64}`}>{artifact.fileName}</a>))}</div>
  </div>;
}

export function QuoteOutputPanel({ source, snapshot, requestId, save, latestSnapshot, readyForReply, blocked }: {
  source: ReservationSourceContext; snapshot: ReservationPaneSnapshot; requestId: string;
  save?: SaveQuoteOutput; latestSnapshot(): ReservationPaneSnapshot | null; readyForReply(): boolean; blocked: boolean;
}) {
  const output = getQuoteOutput(source, snapshot, requestId);
  const earlier = useMemo(() => snapshot.session.draft.operationResults.flatMap(row => {
    if (row.workflow !== 'quote' || row.requestId !== requestId || row.id === output?.operationId ||
        row.generationId !== snapshot.session.draft.generationId || !['succeeded', 'failed'].includes(row.status)) return [];
    const result = getQuoteOutput(source, snapshot, requestId, row.id);
    return result?.artifacts.length ? [result] : [];
  }).reverse(), [source, snapshot, requestId, output?.operationId]);
  const [body, setBody] = useState(output?.cover?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setBody(output?.cover?.body ?? ''); setMessage(null); }, [output?.operationId]);
  if (!output) return earlier.length ? <section className={styles.section}><EarlierQuoteFiles outputs={earlier} /></section> : null;
  const hasFiles = output.artifacts.length > 0;
  const saveReply = async () => {
    if (!save || busy || blocked || hasFiles || !readyForReply()) return;
    setBusy(true); setMessage(null);
    try {
      const result = await save({ snapshot, requestId, html: quoteCoverHtml(body), isCurrentSnapshot: () => {
        const current = latestSnapshot();
        return Boolean(readyForReply() && current && !current.session.sourceChanged && quoteOutputState(current, requestId).textOnly &&
          current.sourceMessageId === snapshot.sourceMessageId && current.session.seq === snapshot.session.seq &&
          current.session.draft.generationId === snapshot.session.draft.generationId);
      } });
      setMessage(result.message);
    } catch { setMessage('The reply could not be confirmed. Check Drafts before trying again.'); }
    finally { setBusy(false); }
  };
  return <section className={styles.section}><h3>Unsent quote reply</h3>
    {hasFiles && <p className={styles.notice}>This earlier quote contains files. Generate a new text-only quote before saving the reply; handle any documents separately.</p>}
    {output.issues.map(issue => <p className={styles.notice} key={issue}>{issue}</p>)}
    {output.failures.map(failure => <p className={styles.notice} key={failure}>{failure.replaceAll('_', ' ')}.</p>)}
    {output.cover && <><p className={styles.small}>To: {output.cover.to}</p><label className={styles.field}>Cover reply<textarea aria-label="Quote cover reply" value={body} readOnly={hasFiles} onChange={event => setBody(event.target.value)} rows={6} /></label></>}
    <div className={styles.sources}>{output.artifacts.map(artifact => <a key={artifact.sha256} download={artifact.fileName}
      href={`data:${artifact.mimeType};base64,${artifact.bytesBase64}`}>{artifact.fileName}</a>)}</div>
    <button type="button" disabled={!save || busy || blocked || hasFiles || output.issues.length > 0 || !body.trim()} onClick={() => { void saveReply(); }}>{busy ? 'Saving reply…' : 'Save unsent reply'}</button>
    {message && <p role="status" className={styles.notice}>{message}</p>}
    <EarlierQuoteFiles outputs={earlier} />
  </section>;
}
