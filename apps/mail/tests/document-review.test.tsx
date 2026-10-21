/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentReview } from '../components/quote-workflow/document-review';
import { loadQuoteFixture } from '../lib/quote-workflow/fixtures';
import { canCreateNativeDraft, canCreatePdf, initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteSession } from '../lib/quote-workflow/types';

afterEach(() => cleanup());

const binding = {
  transportId: 't1',
  mailboxEmail: 'centurion@legacyhotels.co.za',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  selectionEpoch: 1,
  scopeEpoch: 1,
};
const source = { messageId: 'mail-1', threadId: 'thread-1', sourceHash: 'ab'.repeat(32) };

function readySession(): QuoteSession {
  const fixture = loadQuoteFixture('public-single');
  let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding });
  session = reduceQuoteSession(session, {
    type: 'analysis_ready',
    analysis: {
      intent: 'quote',
      groups: fixture.groups,
      secondaryAsks: fixture.secondaryAsks,
      alternatives: fixture.alternatives,
    },
  });
  session = reduceQuoteSession(session, { type: 'staff_source_ready', source });
  session = reduceQuoteSession(session, {
    type: 'results_ready',
    offers: fixture.offers,
    selectionEpoch: binding.selectionEpoch,
    inputRevision: session.inputRevision,
    reviewedReplyHtml: '<p>Thank you for your enquiry.</p>',
    provenance: {
      kind: 'authorised',
      selectionEpoch: binding.selectionEpoch,
      inputRevision: session.inputRevision,
    },
  });
  return { ...session, selectedOfferIds: [fixture.offers[0]!.id] };
}

describe('DocumentReview', () => {
  it('demotes the prepared PDF action so the reply draft stays primary', () => {
    const session = readySession();
    const onPreparePdf = vi.fn();
    expect(canCreatePdf(session)).toBe(true);
    const { rerender } = render(<DocumentReview session={session} onPreparePdf={onPreparePdf} />);

    const prepareBefore = screen.getByRole('button', { name: 'Prepare PDF' });
    expect(prepareBefore.className).toContain('h-[38px]');
    expect(prepareBefore.className).toContain('bg-[#0066cc]');

    const prepared = {
      ...session,
      pdf: {
        fileName: 'Quote - Standard King.pdf',
        bytesBase64: 'JVBERi0xLjQK',
        pdfHash: 'cd'.repeat(32),
        revisionId: 'quotes:public-single',
        totalMinor: 272000,
      },
    };
    expect(canCreatePdf(prepared)).toBe(true);
    expect(canCreateNativeDraft(prepared)).toBe(true);
    rerender(<DocumentReview session={prepared} onPreparePdf={onPreparePdf} />);

    const prepareAfter = screen.getByRole('button', { name: 'Prepare PDF' }) as HTMLButtonElement;
    expect(prepareAfter.disabled).toBe(false);
    expect(prepareAfter.className).toContain('h-8');
    expect(prepareAfter.className).toContain('border-[#0066cc]');
    expect(prepareAfter.className).toContain('bg-white');
    expect(prepareAfter.className).not.toContain('h-[38px]');
    expect(screen.getByText('Reply and PDF are ready. Next, create the Outlook draft. It is not sent.')).toBeDefined();
  });

  it('keeps the combined multi-date proposal as one Prepare quote action', () => {
    const fixture = loadQuoteFixture('public-single');
    const second = {
      ...fixture.groups[0]!,
      id: 'stay-b',
      arrivalDate: '2027-12-01',
      departureDate: '2027-12-03',
    };
    let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding });
    session = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: {
        intent: 'quote',
        groups: [fixture.groups[0]!, second],
        secondaryAsks: fixture.secondaryAsks,
        alternatives: fixture.alternatives,
      },
    });
    session = reduceQuoteSession(session, { type: 'staff_source_ready', source });
    expect(session.groups).toHaveLength(2);
    render(<DocumentReview session={{ ...session, pdf: null }} />);
    expect(screen.getByRole('button', { name: 'Prepare quote' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Prepare PDF' })).toBeNull();
  });

  it('shows the reviewed reply as formatted text, not raw HTML', () => {
    const session = {
      ...readySession(),
      reviewedReplyHtml: '<div style="font-family:Arial"><p>Thank you for your enquiry.</p></div>',
    };
    render(<DocumentReview session={session} />);
    const editor = screen.getByLabelText('Reviewed reply');
    expect(editor.textContent).toContain('Thank you for your enquiry.');
    expect(editor.textContent).not.toContain('<p>');
    expect(editor.tagName.toLowerCase()).not.toBe('textarea');
  });

  it('saves a cleared formatted reply as empty HTML', () => {
    const onReplyChange = vi.fn();
    render(<DocumentReview session={readySession()} onReplyChange={onReplyChange} />);
    const editor = screen.getByLabelText('Reviewed reply');
    editor.innerHTML = '<p><br></p>';
    fireEvent.input(editor);
    expect(onReplyChange).toHaveBeenCalledWith('');
  });
});
