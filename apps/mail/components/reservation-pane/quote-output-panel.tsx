'use client';

import { useEffect, useRef, useState } from 'react';
import { completeQuotePackage, quoteCoverHtml, type QuoteOutput, type QuoteOutputResult } from '@/lib/reservation-workflow/quote-output';
import { quoteReplyLabel } from '@/lib/reservation-workflow/pane-stage';
import type { ReservationPaneSnapshot } from '@/lib/reservation-workflow/types';
import styles from './reservation-pane.module.css';

export type SaveQuoteOutput = (input: { snapshot: ReservationPaneSnapshot; requestId: string; html: string;
  isCurrentSnapshot: () => boolean }) => Promise<QuoteOutputResult>;

function failureMessage(code: string): string {
  switch (code) {
    case 'pdf_converter_unavailable': return 'PDF not created: the document converter is unavailable. Try again later.';
    case 'pdf_signer_unavailable': return 'PDF not created: staff signer details could not be loaded. Try again later.';
    case 'pdf_generation_failed': return 'PDF not created. Try generating the quote again.';
    case 'xlsx_signer_unavailable': return 'Excel file not created: staff signer details could not be loaded. Try again later.';
    case 'xlsx_generation_failed': return 'Excel file not created. Try generating the quote again.';
    case 'email_generation_failed': return 'Cover email not created. Try generating the quote again; no reply draft is ready.';
    case 'quote_artifact_generation_failed': return 'Quote outputs could not be completed. Try generating the quote again.';
    case 'quote_artifact_receipt_invalid': return 'The saved quote files could not be verified. Generate the quote again before using them.';
    case 'quote_artifact_generation_incomplete': return 'Quote output generation did not finish. Try generating the quote again.';
    default: return 'One requested quote output is unavailable. Try generating the quote again.';
  }
}

export function QuoteOutputPanel({ output, snapshot, requestId, save, latestSnapshot, readyForReply, onSaved, blocked, saved }: {
  output: QuoteOutput | null; snapshot: ReservationPaneSnapshot; requestId: string;
  save?: SaveQuoteOutput; latestSnapshot(): ReservationPaneSnapshot | null; readyForReply(): boolean; onSaved(operationId: string | null): void; blocked: boolean; saved: boolean;
}) {
  const [body, setBody] = useState(output?.cover?.body ?? '');
  const [busy, setBusy] = useState(false);
  // Success text is cleared by later edits; failure or uncertain-outcome warnings stay until the next save.
  const [message, setMessage] = useState<{ text: string; saved: boolean } | null>(null);
  const bodyVersion = useRef(0);
  useEffect(() => { bodyVersion.current += 1; setBody(output?.cover?.body ?? ''); setMessage(null);
    return () => { bodyVersion.current += 1; };
  }, [output?.operationId, onSaved]);
  if (!output) return null;
  const saveReply = async () => {
    if (!save || busy || blocked || !readyForReply()) return;
    const version = bodyVersion.current;
    onSaved(null); setBusy(true); setMessage(null);
    try {
      const result = await save({ snapshot, requestId, html: quoteCoverHtml(body), isCurrentSnapshot: () => {
        const current = latestSnapshot();
        return readyForReply() && current?.sourceMessageId === snapshot.sourceMessageId && current.session.seq === snapshot.session.seq
          && current.session.draft.generationId === snapshot.session.draft.generationId;
      } });
      const saved = result.status === 'saved' || result.status === 'created';
      if (!saved) setMessage({ text: result.message, saved: false });
      else if (version === bodyVersion.current) { setMessage({ text: result.message, saved: true }); onSaved(output.operationId); }
      else setMessage({ text: 'An earlier version was saved. Save the edited reply when ready.', saved: false });
    } catch { setMessage({ text: 'The reply could not be confirmed. Check Drafts before trying again.', saved: false }); }
    finally { setBusy(false); }
  };
  return <section className={styles.section}><h3>{output.inventoryDecline ? 'Unsent room-unavailability reply'
    : output.cover ? 'Quote files and unsent reply' : 'Quote result'}</h3>
    <p className={styles.small}>{saved ? 'Saved in Drafts. Open the draft to review and send it.' : completeQuotePackage(output)
      ? `${quoteReplyLabel(output)} puts ${output.inventoryDecline ? 'the reply' : 'the reply and quote files'} in Drafts. Nothing is sent until you send it from your mail.`
      : 'The quote is incomplete. Generate it again before creating a draft.'}</p>
    {output.issues.map(issue => <p className={styles.notice} key={issue}>{issue}</p>)}
    {output.inventoryDecline && <p className={styles.notice}>Infor confirmed the selected room and rate had no rooms available for every requested night. This is not a whole-hotel sold-out claim. No priced PDF or Excel quote was created; nothing has been sent.</p>}
    {output.failures.map(failure => <p className={styles.notice} key={failure}>{failureMessage(failure)}</p>)}
    {output.cover && !saved && <><p className={styles.small}>To: {output.cover.to}</p><label className={styles.field}>Cover reply<textarea aria-label="Quote cover reply" disabled={blocked} value={body} onChange={event => { bodyVersion.current += 1; onSaved(null); setMessage(current => current?.saved ? null : current); setBody(event.target.value); }} rows={6} /></label></>}
    {output.artifacts.length > 0 && <p className={styles.small}>Files: {output.artifacts.map(artifact => artifact.fileName).join(', ')}</p>}
    {output.cover && !saved && completeQuotePackage(output) && <button type="button" disabled={!save || busy || blocked || !body.trim()} onClick={() => { void saveReply(); }}>
      {busy ? 'Saving reply…' : quoteReplyLabel(output)}
    </button>}
    {message && <p role="status" className={styles.notice}>{message.text}</p>}
  </section>;
}
