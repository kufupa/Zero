/**
 * @vitest-environment happy-dom
 */
import type { HmsApprovalClient, HmsReviewed, HmsWriteView } from '../lib/quote-workflow/hms-write';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReviewCard } from '../components/quote-workflow/review-card';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const WORK_ITEM = '3f8a2c1e-9b7d-4e6f-8a1b-2c3d4e5f6a7b';
const EVENT_ID = '7b1e2d3c-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const PNG = 'data:image/png;base64,SHOT-RESULT';

type Run = NonNullable<HmsWriteView['run']>;

function runWith(patch: Partial<Run> = {}): Run {
  return {
    runId: 'run-1',
    state: 'succeeded',
    failureClass: null,
    lastError: null,
    evidence: [{ eventId: EVENT_ID, name: '02-result.png', expired: false }],
    reviewed: null,
    ...patch,
  };
}

function fakeClient(reread: HmsReviewed['reread'] = null): HmsApprovalClient {
  return {
    writeState: vi.fn(async () => {
      throw new Error('not used here');
    }),
    approve: vi.fn(async () => {
      throw new Error('not used here');
    }),
    review: vi.fn(async () => ({ runId: 'run-1', status: 'needs_you' as const, reread })),
    resolveNeedsCheck: vi.fn(async () => ({})),
    evidence: vi.fn(async () => ({ status: 'ok' as const, dataUrl: PNG })),
  };
}

function renderReview(client: HmsApprovalClient, run: Run = runWith(), onChanged = vi.fn()) {
  render(<ReviewCard client={client} workItemId={WORK_ITEM} run={run} onChanged={onChanged} />);
  return onChanged;
}

afterEach(() => cleanup());

describe('ReviewCard screenshots', () => {
  it('shows the sealed screenshot, loaded by its event id through the audit viewer', async () => {
    const client = fakeClient();
    renderReview(client);
    const thumb = await screen.findByAltText('Thumbnail of the HMS screenshot for this quote');
    expect(thumb.getAttribute('src')).toBe(PNG);
    expect(client.evidence).toHaveBeenCalledWith({ workItemId: WORK_ITEM, eventId: EVENT_ID });
  });

  it('shows "screenshots expired" and loads nothing once every screenshot is past its keep window', async () => {
    const client = fakeClient();
    renderReview(
      client,
      runWith({ evidence: [{ eventId: EVENT_ID, name: '02-result.png', expired: true }] }),
    );
    expect(screen.getByText(/Screenshots expired\./)).toBeTruthy();
    expect(screen.queryByAltText('Thumbnail of the HMS screenshot for this quote')).toBeNull();
    expect(client.evidence).not.toHaveBeenCalled();
  });

  it('keeps the live screenshots and says some have expired', async () => {
    const client = fakeClient();
    renderReview(
      client,
      runWith({
        evidence: [
          { eventId: EVENT_ID, name: '01-search.png', expired: true },
          {
            eventId: '0c9d8e7f-6a5b-4c3d-9e8f-7a6b5c4d3e2f',
            name: '02-result.png',
            expired: false,
          },
        ],
      }),
    );
    expect(
      await screen.findByText(/Some screenshots expired and are no longer shown\./),
    ).toBeTruthy();
    await waitFor(() =>
      expect(client.evidence).toHaveBeenCalledWith({
        workItemId: WORK_ITEM,
        eventId: '0c9d8e7f-6a5b-4c3d-9e8f-7a6b5c4d3e2f',
      }),
    );
    expect(client.evidence).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewCard decision', () => {
  it('Review OK sends the decision with no note', async () => {
    const client = fakeClient();
    const onChanged = renderReview(client);
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    await waitFor(() =>
      expect(client.review).toHaveBeenCalledWith({ workItemId: WORK_ITEM, decision: 'ok' }),
    );
    expect(await screen.findByText('Reviewed OK. This item is done.')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
  });

  it('a flag without a note is blocked, and nothing is sent', async () => {
    const client = fakeClient();
    renderReview(client);
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(
      screen.getByText('Add a note saying what is wrong before you flag this write.'),
    ).toBeTruthy();
    expect(client.review).not.toHaveBeenCalled();
  });

  it('a flag with a note is sent, returns the item to Needs you, and says HMS was not read again', async () => {
    const client = fakeClient('not_wired');
    const onChanged = renderReview(client);
    fireEvent.change(screen.getByLabelText('What is wrong? A note is needed to flag.'), {
      target: { value: '  Room type is wrong  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    await waitFor(() =>
      expect(client.review).toHaveBeenCalledWith({
        workItemId: WORK_ITEM,
        decision: 'flag',
        note: 'Room type is wrong',
      }),
    );
    expect(await screen.findByText('Flagged. This item is back in Needs you.')).toBeTruthy();
    expect(
      screen.getByText('HMS was not read again. Re-read HMS before you approve.'),
    ).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('a flag that HMS re-read for does not show the not-read note', async () => {
    const client = fakeClient('hms_reread');
    renderReview(client);
    fireEvent.change(screen.getByLabelText('What is wrong? A note is needed to flag.'), {
      target: { value: 'Rate is off' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    expect(await screen.findByText('Flagged. This item is back in Needs you.')).toBeTruthy();
    expect(
      screen.queryByText('HMS was not read again. Re-read HMS before you approve.'),
    ).toBeNull();
  });

  it('a write already reviewed shows its decision and no review controls', () => {
    const client = fakeClient();
    renderReview(client, runWith({ reviewed: 'flag' }));
    expect(screen.getByText('Flagged. This item is back in Needs you.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Flag' })).toBeNull();
    expect(client.review).not.toHaveBeenCalled();
  });

  it('a refused review says why in words', async () => {
    const client = fakeClient();
    vi.mocked(client.review).mockRejectedValueOnce(new Error('already_reviewed'));
    renderReview(client);
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    expect(await screen.findByText('This write is already reviewed.')).toBeTruthy();
  });
});
