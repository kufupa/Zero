/**
 * @vitest-environment happy-dom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PaneStatusLine, paneStatusLine } from '../components/quote-workflow/pane-status-line';
import { initialQuoteSession } from '../lib/quote-workflow/session';
import type { QuoteSession } from '../lib/quote-workflow/types';

const session = (patch: Partial<QuoteSession>): QuoteSession => ({ ...initialQuoteSession(), ...patch });

afterEach(cleanup);

describe('PaneStatusLine', () => {
  it('shows one line when a failed lookup also reports the mailbox as unavailable', () => {
    const failed = session({
      phase: 'failed',
      errorMessage: 'Nava cannot read emails in this pane yet. Refresh the pane and try again.',
      mailboxStatus: 'unavailable',
    });
    const { container } = render(<PaneStatusLine session={failed} />);
    expect(container.querySelectorAll('p[aria-live]')).toHaveLength(1);
    expect(container.textContent).toBe(
      'Nava cannot read emails in this pane yet. Refresh the pane and try again.',
    );
  });

  it('falls back to the connection line only when there is no specific reason', () => {
    expect(paneStatusLine(session({ mailboxStatus: 'unavailable' }))).toBe(
      'Nava is not connected to this pane yet. Refresh the pane and try again.',
    );
  });

  it('names the missing attachment once, without a second mailbox banner', () => {
    const missing = session({
      phase: 'missing_source',
      missing: ['rates.pdf'],
      mailboxStatus: 'missing_source',
    });
    expect(paneStatusLine(missing)).toBe(
      'Nava could not read the attachment contents. Open the attachment in Outlook and check it by hand. Could not read: rates.pdf.',
    );
  });

  it('renders nothing when nothing needs saying', () => {
    expect(paneStatusLine(session({ mailboxStatus: 'ready' }))).toBeNull();
  });
});
