'use client';

import { useEffect, useState } from 'react';
import { getQuoteOutput, quoteCoverHtml, type QuoteOutputResult } from '@/lib/reservation-workflow/quote-output';
import type { ReservationPaneSnapshot, ReservationSourceContext } from '@/lib/reservation-workflow/types';
import styles from './reservation-pane.module.css';

export type SaveQuoteOutput = (input: { snapshot: ReservationPaneSnapshot; requestId: string; html: string;
  isCurrentSnapshot: () => boolean }) => Promise<QuoteOutputResult>;

function failureMessage(code: string): string {
  switch (code) {
    case 'pdf_converter_unavailable': return 'PDF not created: the document converter is unavailable. You can use the other files below, or retry later.';
    case 'pdf_signer_unavailable': return 'PDF not created: staff signer details could not be loaded. You can use the other files below, or retry later.';
    case 'pdf_generation_failed': return 'PDF not created. You can use the other files below, or retry the quote.';
    case 'xlsx_signer_unavailable': return 'Excel file not created: staff signer details could not be loaded. You can use the other files below, or retry later.';
    case 'xlsx_generation_failed': return 'Excel file not created. You can use the other files below, or retry the quote.';
    case 'email_generation_failed': return 'Cover email not created. Download any available quote files below; no reply draft is ready.';
    case 'quote_artifact_generation_failed': return 'Quote outputs could not be completed. Check the files below and retry if needed.';
    case 'quote_artifact_receipt_invalid': return 'The saved quote files could not be verified. Generate the quote again before using them.';
    case 'quote_artifact_generation_incomplete': return 'Quote output generation did not finish. Check the files below and retry if needed.';
    default: return 'One requested quote output is unavailable. Only the files listed below are ready to use.';
  }
}

export function QuoteOutputPanel({ source, snapshot, requestId, save, latestSnapshot, readyForReply, blocked }: {
  source: ReservationSourceContext; snapshot: ReservationPaneSnapshot; requestId: string;
  save?: SaveQuoteOutput; latestSnapshot(): ReservationPaneSnapshot | null; readyForReply(): boolean; blocked: boolean;
}) {
  const output = getQuoteOutput(source, snapshot, requestId);
  const [body, setBody] = useState(output?.cover?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setBody(output?.cover?.body ?? ''); setMessage(null); }, [output?.operationId]);
  if (!output) return null;
  const saveReply = async () => {
    if (!save || busy || blocked || !readyForReply()) return;
    setBusy(true); setMessage(null);
    try {
      const result = await save({ snapshot, requestId, html: quoteCoverHtml(body), isCurrentSnapshot: () => {
        const current = latestSnapshot();
        return readyForReply() && current?.sourceMessageId === snapshot.sourceMessageId && current.session.seq === snapshot.session.seq
          && current.session.draft.generationId === snapshot.session.draft.generationId;
      } });
      setMessage(result.message);
    } catch { setMessage('The reply could not be confirmed. Check Drafts before trying again.'); }
    finally { setBusy(false); }
  };
  return <section className={styles.section}><h3>{output.inventoryDecline ? 'Unsent room-unavailability reply'
    : output.cover ? 'Unsent quote reply' : 'Quote files'}</h3>
    {output.issues.map(issue => <p className={styles.notice} key={issue}>{issue}</p>)}
    {output.inventoryDecline && <p className={styles.notice}>Infor confirmed the selected room and rate had no rooms available for every requested night. This is not a whole-hotel sold-out claim. No priced PDF or Excel quote was created; nothing has been sent.</p>}
    {output.failures.map(failure => <p className={styles.notice} key={failure}>{failureMessage(failure)}</p>)}
    {output.cover && <><p className={styles.small}>To: {output.cover.to}</p><label className={styles.field}>Cover reply<textarea aria-label="Quote cover reply" value={body} onChange={event => setBody(event.target.value)} rows={6} /></label></>}
    <div className={styles.sources}>{output.artifacts.map(artifact => <a key={artifact.sha256} download={artifact.fileName}
      href={`data:${artifact.mimeType};base64,${artifact.bytesBase64}`}>{artifact.fileName}</a>)}</div>
    {output.cover && <button type="button" disabled={!save || busy || blocked || output.issues.length > 0 || !body.trim()} onClick={() => { void saveReply(); }}>
      {busy ? 'Saving reply…' : output.inventoryDecline ? 'Save unsent decline reply'
        : output.failures.length && !output.artifacts.length ? 'Save unsent reply without quotation files'
        : output.failures.length ? 'Save unsent reply with available files' : 'Save unsent reply'}
    </button>}
    {message && <p role="status" className={styles.notice}>{message}</p>}
  </section>;
}
