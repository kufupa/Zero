/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pickThumbnailIndex,
  QuoteAuditScreenshot,
} from '../components/quote-workflow/quote-audit-screenshot';
import { QuoteWorkflowPanel } from '../components/quote-workflow/quote-workflow-panel';
import { initialQuoteSession } from '../lib/quote-workflow/session';
import type {
  QuoteOffer,
  QuoteRunScreenshotResult,
  QuoteSession,
  StaffQuoteAllocation,
} from '../lib/quote-workflow/types';

const RUN_ID = '2026-10-08T10-15-30-125Z-0a1b2c3d';
const NAMES = ['01-search.png', '02-rates.png', '03-save.png'];
const UNAVAILABLE_COPY = /could not be loaded/i;

function readyShot(name: string): QuoteRunScreenshotResult {
  return {
    status: 'ready',
    name,
    mimeType: 'image/png',
    sizeBytes: 16,
    dataUrl: `data:image/png;base64,SHOT-${name}`,
  };
}

afterEach(() => cleanup());

describe('pickThumbnailIndex', () => {
  it('prefers a result or rates screen, otherwise the last capture', () => {
    expect(pickThumbnailIndex(NAMES)).toBe(1);
    expect(pickThumbnailIndex(['a-result.png', 'b-rates.png'])).toBe(0);
    expect(pickThumbnailIndex(['01-search.png', '02-save.png'])).toBe(1);
    expect(pickThumbnailIndex(['only.png'])).toBe(0);
    expect(pickThumbnailIndex([])).toBe(-1);
  });
});

describe('QuoteAuditScreenshot', () => {
  it('says there is no HMS screenshot when the run has no runId, and does not query', () => {
    const loadScreenshot = vi.fn();
    render(<QuoteAuditScreenshot runId={null} screenshots={[]} loadScreenshot={loadScreenshot} />);
    expect(screen.getByText('No HMS screenshot for this quote.')).toBeDefined();
    expect(loadScreenshot).not.toHaveBeenCalled();
  });

  it('shows the rates screen as the thumbnail and opens a viewer over every screenshot', async () => {
    const loadScreenshot = vi.fn(async ({ name }: { runId: string; name: string }) => readyShot(name));
    render(<QuoteAuditScreenshot runId={RUN_ID} screenshots={NAMES} loadScreenshot={loadScreenshot} />);

    const thumbnail = await screen.findByRole('button', { name: 'See what Nava did in HMS' });
    expect(thumbnail.textContent).toContain('See what Nava did in HMS');
    expect(loadScreenshot).toHaveBeenCalledWith({ runId: RUN_ID, name: '02-rates.png' });
    expect(screen.getByRole('img', { name: /Thumbnail of the HMS screenshot/ }).getAttribute('src')).toBe(
      'data:image/png;base64,SHOT-02-rates.png',
    );

    fireEvent.click(thumbnail);
    expect(screen.getByRole('dialog', { name: 'HMS quote screenshots' })).toBeDefined();
    expect(await screen.findByRole('img', { name: 'HMS screenshot 2 of 3' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Previous screenshot' }));
    expect(await screen.findByRole('img', { name: 'HMS screenshot 1 of 3' })).toBeDefined();
    expect(loadScreenshot).toHaveBeenLastCalledWith({ runId: RUN_ID, name: '01-search.png' });
    expect((screen.getByRole('button', { name: 'Previous screenshot' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Next screenshot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next screenshot' }));
    expect(await screen.findByRole('img', { name: 'HMS screenshot 3 of 3' })).toBeDefined();
    expect(loadScreenshot).toHaveBeenLastCalledWith({ runId: RUN_ID, name: '03-save.png' });
    expect((screen.getByRole('button', { name: 'Next screenshot' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'See what Nava did in HMS' })).toBeDefined();
  });

  it('closes the viewer from the Close button', async () => {
    const loadScreenshot = vi.fn(async ({ name }: { runId: string; name: string }) => readyShot(name));
    render(<QuoteAuditScreenshot runId={RUN_ID} screenshots={NAMES} loadScreenshot={loadScreenshot} />);
    fireEvent.click(await screen.findByRole('button', { name: 'See what Nava did in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close screenshot' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an honest unavailable state and hides the raw reason', async () => {
    const loadScreenshot = vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'quote_run_unavailable',
    }));
    render(<QuoteAuditScreenshot runId={RUN_ID} screenshots={NAMES} loadScreenshot={loadScreenshot} />);
    expect(await screen.findByText(UNAVAILABLE_COPY)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'See what Nava did in HMS' })).toBeNull();
    expect(screen.queryByText(/quote_run_unavailable/)).toBeNull();
  });

  it('treats a failed screenshot read as unavailable', async () => {
    const loadScreenshot = vi.fn(async (): Promise<QuoteRunScreenshotResult> => {
      throw new Error('network down');
    });
    render(<QuoteAuditScreenshot runId={RUN_ID} screenshots={NAMES} loadScreenshot={loadScreenshot} />);
    expect(await screen.findByText(UNAVAILABLE_COPY)).toBeDefined();
  });

  it('shows the unavailable state in the viewer when a later screenshot cannot be loaded', async () => {
    const loadScreenshot = vi.fn(async ({ name }: { runId: string; name: string }) =>
      name === '01-search.png'
        ? ({ status: 'unavailable', reason: 'quote_run_unavailable' } as const)
        : readyShot(name),
    );
    render(<QuoteAuditScreenshot runId={RUN_ID} screenshots={NAMES} loadScreenshot={loadScreenshot} />);
    fireEvent.click(await screen.findByRole('button', { name: 'See what Nava did in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous screenshot' }));
    await waitFor(() => expect(screen.getAllByText(UNAVAILABLE_COPY).length).toBeGreaterThan(0));
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});

describe('QuoteWorkflowPanel HMS audit', () => {
  const offer: QuoteOffer = {
    id: 'rev-1',
    kind: 'allocation',
    roomCode: '',
    roomLabel: 'Superior room',
    board: 'bb',
    rateCode: '',
    currency: 'ZAR',
    nightly: [],
    stayTotalMinor: 272000,
    observedAt: '',
    sourceRef: 'rev-1',
    restrictions: [],
    combinable: true,
    quoteRequestKey: '2026-11-12:2026-11-14',
    coversGroupIds: ['g1'],
    quantity: 1,
  };

  function completedSession(runId: string | null | undefined, screenshots: string[] | undefined): QuoteSession {
    const staffQuote: StaffQuoteAllocation = {
      workflowRunId: 'wr-1',
      revisionRef: offer.id,
      factRefs: [],
      messageId: 'mail-1',
      threadId: 'thread-1',
      sourceHash: 'ab'.repeat(32),
      selectionEpoch: 1,
      inputRevision: 1,
      inputDigest: 'digest',
      totalMinor: offer.stayTotalMinor,
      currency: 'ZAR',
      quoteRequestKey: offer.quoteRequestKey,
      approvedHeader: {
        salesStrategy: 'BAR',
        company: '',
        agency: '',
        attention: '',
        clientEmail: '',
        clientTelephone: '',
      },
      runId,
      screenshots,
    };
    return {
      ...initialQuoteSession(),
      phase: 'results',
      offers: [offer],
      selectedOfferIds: [offer.id],
      selectedStayKey: offer.quoteRequestKey,
      staffQuote,
      staffQuotes: { [offer.quoteRequestKey]: staffQuote },
    };
  }

  it('loads the audit screenshot only once the staff quote is complete', async () => {
    const onLoadRunScreenshot = vi.fn(async ({ name }: { runId: string; name: string }) => readyShot(name));
    const { rerender } = render(
      <QuoteWorkflowPanel
        session={{ ...initialQuoteSession(), phase: 'results', offers: [] }}
        onLoadRunScreenshot={onLoadRunScreenshot}
      />,
    );
    expect(onLoadRunScreenshot).not.toHaveBeenCalled();
    rerender(
      <QuoteWorkflowPanel
        session={completedSession(RUN_ID, NAMES)}
        onLoadRunScreenshot={onLoadRunScreenshot}
      />,
    );
    expect(await screen.findByRole('button', { name: 'See what Nava did in HMS' })).toBeDefined();
    expect(onLoadRunScreenshot).toHaveBeenCalledTimes(1);
    expect(onLoadRunScreenshot).toHaveBeenCalledWith({ runId: RUN_ID, name: '02-rates.png' });
  });

  it('replaces the placeholder with the audit and states no screenshot when the runId is null', () => {
    const onLoadRunScreenshot = vi.fn();
    render(
      <QuoteWorkflowPanel
        session={completedSession(null, [])}
        onLoadRunScreenshot={onLoadRunScreenshot}
      />,
    );
    expect(screen.getByText('No HMS screenshot for this quote.')).toBeDefined();
    expect(screen.queryByText(/No screenshot is attached to this HMS search/)).toBeNull();
    expect(onLoadRunScreenshot).not.toHaveBeenCalled();
  });
});
