import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { WorkflowFolderNav } from '../components/mail/workflow-folder-nav';

describe('workflow folder navigation', () => {
  it('renders the workflow folders with counts and no legacy triage folders', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/mail/quotes']}>
        <WorkflowFolderNav
          summary={{ quotes: { threads: 4 }, 'new-bookings': { threads: 2 }, payments: { threads: 0 } }}
        />
      </MemoryRouter>,
    );
    const visibleMarkup = markup.replaceAll('&amp;', '&');

    for (const title of [
      'Quotes',
      'New bookings',
      'Amendments',
      'Cancellations',
      'Payments',
      'Billing',
      'Groups & events',
      'Other to do',
      'Not for Nava',
    ]) {
      expect(visibleMarkup).toContain(title);
    }
    expect(visibleMarkup).toContain('Inbox');
    expect(visibleMarkup).toContain('All mail');
    expect(visibleMarkup).toContain('Sent');
    expect(visibleMarkup).toContain('href="/mail/quotes"');
    expect(visibleMarkup).toContain('href="/mail/all"');
    expect(visibleMarkup).toContain('href="/mail/not-for-nava"');
    expect(visibleMarkup).toContain('>4</span>');
    expect(visibleMarkup).toContain('>0</span>');
    expect(visibleMarkup).not.toMatch(/Urgent|Manage stay|Confirm & reconcile|Documents & delivery|Guest experience/);
  });
});
