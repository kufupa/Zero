/**
 * @vitest-environment happy-dom
 *
 * Writes production QuoteWorkflowPanel markup for a 380px Playwright screenshot.
 * This file is not a substitute for the Chromium receipt; it is the source HTML.
 */
import { render } from '@testing-library/react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { fixtureResultsReady, loadQuoteFixture } from '../lib/quote-workflow/fixtures';
import { initialQuoteSession, reduceQuoteSession } from '../lib/quote-workflow/session';

describe('quote workflow narrow-pane HTML dump', () => {
  it('serializes the production panel at 380px for browser evidence', () => {
    const fixture = loadQuoteFixture('public-single');
    let session = reduceQuoteSession(initialQuoteSession(), {
      type: 'selection',
      binding: {
        transportId: 't1',
        mailboxEmail: 'centurion@legacyhotels.co.za',
        storeId: 'store',
        folderEntryId: 'inbox',
        entryId: 'e1',
        selectionEpoch: 1,
        scopeEpoch: 1,
      },
    });
    session = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: {
        intent: 'quote',
        groups: fixture.groups,
        secondaryAsks: fixture.secondaryAsks,
        alternatives: fixture.alternatives,
      },
    });
    session = reduceQuoteSession(session, { type: 'mailbox_status', status: 'unsynced' });
    session = reduceQuoteSession(session, fixtureResultsReady(fixture.offers, {
      reviewedReplyHtml: fixture.reviewedReplyHtml,
    }));
    const { container } = render(
      <div id="quote-workflow-narrow" style={{ width: 380, maxWidth: 380 }}>
        <QuoteWorkflowPanel session={session} />
      </div>,
    );
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Quote workflow 380px — production QuoteWorkflowPanel</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f1f5f9; font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
    #quote-workflow-narrow { width: 380px; max-width: 380px; overflow: auto; padding: 12px; background: #f8fafc; }
    .flex { display: flex; }
    .flex-col { flex-direction: column; }
    .items-center { align-items: center; }
    .justify-between { justify-content: space-between; }
    .justify-center { justify-content: center; }
    .self-start { align-self: flex-start; }
    .gap-1 { gap: 4px; }
    .gap-2 { gap: 8px; }
    .gap-3 { gap: 12px; }
    .w-full { width: 100%; }
    .min-h-28 { min-height: 7rem; }
    .h-7 { height: 1.75rem; }
    .h-8 { height: 2rem; }
    .h-9 { height: 2.25rem; }
    .h-16 { height: 4rem; }
    .p-3 { padding: 12px; }
    .p-2\\.5 { padding: 10px; }
    .px-2 { padding-left: 8px; padding-right: 8px; }
    .px-3 { padding-left: 12px; padding-right: 12px; }
    .py-1 { padding-top: 4px; padding-bottom: 4px; }
    .py-2 { padding-top: 8px; padding-bottom: 8px; }
    .pt-2 { padding-top: 8px; }
    .rounded-xs { border-radius: 2px; }
    .border { border: 1px solid #cbd5e1; }
    .border-t { border-top: 1px solid #e2e8f0; }
    .bg-white { background: #fff; }
    .text-xs { font-size: 12px; }
    .text-left { text-align: left; }
    .font-bold { font-weight: 700; }
    .font-semibold { font-weight: 600; }
    .uppercase { text-transform: uppercase; }
    input, select, textarea, button { max-width: 100%; }
  </style>
</head>
<body>${container.innerHTML}</body>
</html>
`;
    const outDir = path.join(process.cwd(), 'tests', 'browser-quote-workflow');
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'narrow-pane.html');
    writeFileSync(outFile, html);
    expect(container.querySelector('#quote-workflow-narrow')).not.toBeNull();
    expect(container.textContent).toMatch(/not finished syncing/i);
    expect(container.textContent).toMatch(/Get rates from HMS|Prepare PDF|Allocation/i);
  });
});
