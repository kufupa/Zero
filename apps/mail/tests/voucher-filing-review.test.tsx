/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VoucherFilingReview } from '../components/quote-workflow/voucher-filing-review';

afterEach(cleanup);
const operation = { operationId: 'run-1', state: 'filed', review: null,
  evidence: { eventId: 'event-1', expired: false } } as const;
const evidenceScope = { workItemId: 'work', messageId: 'message', operationId: 'run-1', eventId: 'event-1' };
const makeClient = () => ({
  evidence: vi.fn(async () => ({ status: 'ok' as const, dataUrl: 'data:image/png;base64,aGVsbG8=', ...evidenceScope })),
  review: vi.fn(async () => undefined),
});
const props = () => ({ client: makeClient(), workItemId: 'work', messageId: 'message', operation,
  onRefresh: vi.fn(), scope: { signal: new AbortController().signal, isCurrent: () => true },
  reviewAttempts: { current: new Set<string>() } });

it('requires a successfully displayed screenshot before recording review', async () => {
  const p = props(); render(<VoucherFilingReview {...p} />);
  const image = await screen.findByAltText('HMS filing screenshot');
  expect(p.client.evidence).toHaveBeenCalledWith({ workItemId: 'work', messageId: 'message', operationId: 'run-1', eventId: 'event-1' });
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  fireEvent.load(image);
  const button = screen.getByRole('button', { name: 'Confirm review' });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(p.client.review).toHaveBeenCalledTimes(1));
  expect(p.client.review).toHaveBeenCalledWith({ workItemId: 'work', messageId: 'message', operationId: 'run-1', eventId: 'event-1', decision: 'ok' });
  expect(p.onRefresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(screen.getByText(/Checking whether your review was saved/)).toBeTruthy();
});

it('requires a note when flagging a problem', async () => {
  const p = props(); render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  fireEvent.click(screen.getByRole('button', { name: 'Flag a problem' }));
  expect(screen.getByText(/at least 3 characters/)).toBeTruthy();
  expect(p.client.review).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Note for a flagged review'), { target: { value: 'Wrong document' } });
  fireEvent.click(screen.getByRole('button', { name: 'Flag a problem' }));
  await waitFor(() => expect(p.client.review).toHaveBeenCalledWith({ workItemId: 'work', messageId: 'message',
    operationId: 'run-1', eventId: 'event-1', decision: 'flag', note: 'Wrong document' }));
});

it('does not offer review for missing, expired or invalid screenshot evidence', async () => {
  for (const evidence of [null, { eventId: 'event-1', expired: true }]) {
    const p = props(); const view = render(<VoucherFilingReview {...p} operation={{ ...operation, evidence }} />);
    expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
    expect(p.client.evidence).not.toHaveBeenCalled();
    view.unmount();
  }
  const p = props();
  p.client.evidence.mockResolvedValue({ status: 'ok', dataUrl: 'https://example.invalid/screenshot.png', ...evidenceScope });
  render(<VoucherFilingReview {...p} />);
  expect(await screen.findByText(/screenshot could not be loaded/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
});

it('preserves the review latch when the view is remounted after an uncertain submission', async () => {
  const p = props(); p.client.review.mockRejectedValue(new Error('private detail'));
  const view = render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm review' }));
  expect(await screen.findByText(/Could not confirm that your review was saved/)).toBeTruthy();
  expect(screen.queryByText(/private detail/)).toBeNull();
  view.unmount();
  render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(p.client.review).toHaveBeenCalledTimes(1);
});


it('does not display a delayed screenshot after the review is unmounted', async () => {
  const p = props();
  let resolveOld!: (value: { status: 'ok'; dataUrl: string } & typeof evidenceScope) => void;
  p.client.evidence.mockImplementation(() => new Promise((resolve) => { resolveOld = resolve; }));
  const view = render(<VoucherFilingReview {...p} />);
  await waitFor(() => expect(p.client.evidence).toHaveBeenCalledTimes(1));
  view.unmount();
  resolveOld({ status: 'ok', dataUrl: 'data:image/png;base64,b2xk', ...evidenceScope });
  await Promise.resolve();
  expect(screen.queryByAltText('HMS filing screenshot')).toBeNull();
  expect(p.client.review).not.toHaveBeenCalled();
});


it('requires the new operation screenshot to load after a change', async () => {
  const p = props();
  const view = render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  expect(screen.getByRole('button', { name: 'Confirm review' })).toBeTruthy();
  let resolveNew!: (value: { status: 'ok'; dataUrl: string } & typeof evidenceScope) => void;
  p.client.evidence.mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
  view.rerender(<VoucherFilingReview {...p} operation={{ ...operation, operationId: 'run-2', evidence: { eventId: 'event-2', expired: false } }} />);
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  await waitFor(() => expect(p.client.evidence).toHaveBeenCalledTimes(2));
  resolveNew({ status: 'ok', dataUrl: 'data:image/png;base64,bmV3', ...evidenceScope, operationId: 'run-2', eventId: 'event-2' });
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm review' }));
  await waitFor(() => expect(p.client.review).toHaveBeenCalledWith({ workItemId: 'work', messageId: 'message', operationId: 'run-2', eventId: 'event-2', decision: 'ok' }));
});

it('hides the previous screenshot when the evidence client changes', async () => {
  const p = props();
  const view = render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  const next = makeClient();
  next.evidence.mockImplementation(() => new Promise(() => {}));
  view.rerender(<VoucherFilingReview {...p} client={next} />);
  expect(screen.queryByAltText('HMS filing screenshot')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(next.review).not.toHaveBeenCalled();
});

it('never offers review for a non-filed operation', async () => {
  const p = props();
  render(<VoucherFilingReview {...p} operation={{ ...operation, state: 'needs_check' }} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(p.client.review).not.toHaveBeenCalled();
});


it('rejects a screenshot returned for another evidence scope', async () => {
  for (const mismatch of [{ workItemId: 'other' }, { messageId: 'other' }, { operationId: 'other' }, { eventId: 'other' }]) {
    const p = props();
    p.client.evidence.mockResolvedValue({ status: 'ok', dataUrl: 'data:image/png;base64,aGVsbG8=', ...evidenceScope, ...mismatch });
    const view = render(<VoucherFilingReview {...p} />);
    expect(await screen.findByText(/screenshot could not be loaded/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
    expect(p.client.review).not.toHaveBeenCalled();
    view.unmount();
  }
});

it('withdraws review controls when previously shown evidence expires', async () => {
  const p = props();
  const view = render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  expect(screen.getByRole('button', { name: 'Confirm review' })).toBeTruthy();
  view.rerender(<VoucherFilingReview {...p} operation={{ ...operation, evidence: { eventId: 'event-1', expired: true } }} />);
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(screen.queryByAltText('HMS filing screenshot')).toBeNull();
  expect(p.client.review).not.toHaveBeenCalled();
});

it('ignores a delayed screenshot from the previous evidence client', async () => {
  const p = props();
  let resolveOld!: (value: { status: 'ok'; dataUrl: string } & typeof evidenceScope) => void;
  p.client.evidence.mockImplementation(() => new Promise((resolve) => { resolveOld = resolve; }));
  const view = render(<VoucherFilingReview {...p} />);
  await waitFor(() => expect(p.client.evidence).toHaveBeenCalledTimes(1));
  const next = makeClient();
  next.evidence.mockResolvedValue({ status: 'ok', dataUrl: 'data:image/png;base64,bmV3', ...evidenceScope });
  view.rerender(<VoucherFilingReview {...p} client={next} />);
  const image = await screen.findByAltText('HMS filing screenshot');
  fireEvent.load(image);
  resolveOld({ status: 'ok', dataUrl: 'data:image/png;base64,b2xk', ...evidenceScope });
  await waitFor(() => expect(screen.getByAltText('HMS filing screenshot').getAttribute('src')).toBe('data:image/png;base64,bmV3'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm review' }));
  await waitFor(() => expect(next.review).toHaveBeenCalledTimes(1));
  expect(p.client.review).not.toHaveBeenCalled();
});


it('fails closed on malformed evidence responses', async () => {
  for (const reply of [null, {}, { status: 'ok', ...evidenceScope, dataUrl: null }]) {
    const p = props();
    p.client.evidence.mockResolvedValue(reply as never);
    const view = render(<VoucherFilingReview {...p} />);
    expect(await screen.findByText(/screenshot could not be loaded/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
    view.unmount();
  }
});

it('does not let an old image load or error authorize or hide a replacement client image', async () => {
  const p = props();
  const view = render(<VoucherFilingReview {...p} />);
  const oldImage = await screen.findByAltText('HMS filing screenshot');
  const next = makeClient();
  next.evidence.mockResolvedValue({ status: 'ok', dataUrl: 'data:image/png;base64,bmV3', ...evidenceScope });
  view.rerender(<VoucherFilingReview {...p} client={next} />);
  const newImage = await screen.findByAltText('HMS filing screenshot');
  expect(newImage.getAttribute('src')).toBe('data:image/png;base64,bmV3');
  expect(newImage).not.toBe(oldImage);
  fireEvent.load(oldImage);
  fireEvent.error(oldImage);
  expect(screen.getByAltText('HMS filing screenshot')).toBe(newImage);
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  fireEvent.load(newImage);
  expect(screen.getByRole('button', { name: 'Confirm review' })).toBeTruthy();
});

it('ignores a late load for an earlier operation before enabling review of the new evidence', async () => {
  const p = props();
  const view = render(<VoucherFilingReview {...p} />);
  const oldImage = await screen.findByAltText('HMS filing screenshot');
  p.client.evidence.mockResolvedValueOnce({ status: 'ok', dataUrl: 'data:image/png;base64,bmV3', ...evidenceScope,
    operationId: 'run-2', eventId: 'event-2' });
  view.rerender(<VoucherFilingReview {...p} operation={{ ...operation, operationId: 'run-2', evidence: { eventId: 'event-2', expired: false } }} />);
  const newImage = await screen.findByAltText('HMS filing screenshot');
  expect(newImage.getAttribute('src')).toBe('data:image/png;base64,bmV3');
  expect(newImage).not.toBe(oldImage);
  fireEvent.load(oldImage);
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  fireEvent.load(newImage);
  expect(screen.getByRole('button', { name: 'Confirm review' })).toBeTruthy();
});

it('ignores stale image events after a client A-to-B-to-A transition with identical evidence', async () => {
  const p = props();
  const view = render(<VoucherFilingReview {...p} />);
  const oldImage = await screen.findByAltText('HMS filing screenshot');
  const alternate = makeClient();
  alternate.evidence.mockResolvedValue({ status: 'ok', dataUrl: 'data:image/png;base64,Yg==', ...evidenceScope });
  view.rerender(<VoucherFilingReview {...p} client={alternate} />);
  expect((await screen.findByAltText('HMS filing screenshot')).getAttribute('src')).toBe('data:image/png;base64,Yg==');
  view.rerender(<VoucherFilingReview {...p} client={p.client} />);
  const currentImage = await screen.findByAltText('HMS filing screenshot');
  expect(currentImage).not.toBe(oldImage);
  expect(currentImage.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
  fireEvent.load(oldImage);
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  fireEvent.load(currentImage);
  fireEvent.error(oldImage);
  expect(screen.getByAltText('HMS filing screenshot')).toBe(currentImage);
  expect(screen.getByRole('button', { name: 'Confirm review' })).toBeTruthy();
});


it('shows a recorded review only for its exact screenshot event', () => {
  const p = props();
  const view = render(<VoucherFilingReview {...p} operation={{ ...operation,
    review: { eventId: 'event-1', decision: 'ok' } }} />);
  expect(screen.getByText('Screenshot review confirmed.')).toBeTruthy();
  view.rerender(<VoucherFilingReview {...p} operation={{ ...operation,
    evidence: { eventId: 'event-2', expired: false }, review: { eventId: 'event-1', decision: 'ok' } }} />);
  expect(screen.queryByText('Screenshot review confirmed.')).toBeNull();
  expect(screen.getByText(/Review does not match this screenshot/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(p.client.review).not.toHaveBeenCalled();
});

it('does not treat a run-only or malformed review status as evidence review', () => {
  for (const review of ['ok', { eventId: 'event-1', decision: 'unknown' }, { decision: 'ok' }]) {
    const p = props();
    const view = render(<VoucherFilingReview {...p} operation={{ ...operation, review: review as never }} />);
    expect(screen.queryByText('Screenshot review confirmed.')).toBeNull();
    expect(screen.getByText(/Review does not match this screenshot/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
    view.unmount();
  }
});


it('does not confirm an expired reviewed screenshot', () => {
  const p = props();
  render(<VoucherFilingReview {...p} operation={{ ...operation,
    evidence: { eventId: 'event-1', expired: true }, review: { eventId: 'event-1', decision: 'ok' } }} />);
  expect(screen.queryByText('Screenshot review confirmed.')).toBeNull();
  expect(screen.getByText(/screenshot has expired/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
});

it('hides screenshot and disables review when actor or selection lifetime aborts', async () => {
  const p = props(); const controller = new AbortController();
  p.scope = { signal: controller.signal, isCurrent: () => true };
  render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  const button = screen.getByRole('button', { name: 'Confirm review' });
  act(() => controller.abort());
  expect(screen.queryByAltText('HMS filing screenshot')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(screen.getByText(/selected message changed/i)).toBeTruthy();
  fireEvent.click(button);
  expect(p.client.review).not.toHaveBeenCalled();
});

it('drops an evidence response after actor or selection lifetime aborts', async () => {
  const p = props(); const controller = new AbortController();
  p.scope = { signal: controller.signal, isCurrent: () => true };
  let resolveEvidence!: (value: { status: 'ok'; dataUrl: string } & typeof evidenceScope) => void;
  p.client.evidence.mockImplementation(() => new Promise((resolve) => { resolveEvidence = resolve; }));
  render(<VoucherFilingReview {...p} />);
  await waitFor(() => expect(p.client.evidence).toHaveBeenCalledTimes(1));
  act(() => controller.abort());
  await act(async () => { resolveEvidence({ status: 'ok', dataUrl: 'data:image/png;base64,YQ==', ...evidenceScope }); });
  expect(screen.queryByAltText('HMS filing screenshot')).toBeNull();
  expect(p.client.review).not.toHaveBeenCalled();
});

it('rechecks selection ownership when a review is clicked', async () => {
  const p = props(); let current = true;
  p.scope = { ...p.scope, isCurrent: () => current };
  render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  const button = screen.getByRole('button', { name: 'Confirm review' });
  current = false;
  fireEvent.click(button);
  expect(p.client.review).not.toHaveBeenCalled();
});


it('requires the new selection lifetime to load its own screenshot', async () => {
  const p = props(); const first = new AbortController();
  p.scope = { signal: first.signal, isCurrent: () => true };
  const view = render(<VoucherFilingReview {...p} />);
  const oldImage = await screen.findByAltText('HMS filing screenshot');
  fireEvent.load(oldImage);
  expect(screen.getByRole('button', { name: 'Confirm review' })).toBeTruthy();
  act(() => first.abort());
  const next = new AbortController();
  view.rerender(<VoucherFilingReview {...p} scope={{ signal: next.signal, isCurrent: () => true }} />);
  const newImage = await screen.findByAltText('HMS filing screenshot');
  expect(newImage).not.toBe(oldImage);
  fireEvent.load(oldImage);
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  fireEvent.load(newImage);
  expect(screen.getByRole('button', { name: 'Confirm review' })).toBeTruthy();
  view.rerender(<VoucherFilingReview {...p} />);
  expect(screen.queryByAltText('HMS filing screenshot')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(screen.getByText(/selected message changed/i)).toBeTruthy();
});

it('keeps a sent review latched after its selection lifetime is invalidated', async () => {
  const p = props(); const first = new AbortController();
  p.scope = { signal: first.signal, isCurrent: () => true };
  let resolveReview!: () => void;
  p.client.review.mockImplementation(() => new Promise((resolve) => { resolveReview = resolve; }));
  const view = render(<VoucherFilingReview {...p} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm review' }));
  expect(p.client.review).toHaveBeenCalledTimes(1);
  act(() => first.abort());
  await act(async () => { resolveReview(); });
  expect(p.onRefresh).not.toHaveBeenCalled();
  view.unmount();
  const next = new AbortController();
  render(<VoucherFilingReview {...p} scope={{ signal: next.signal, isCurrent: () => true }} />);
  fireEvent.load(await screen.findByAltText('HMS filing screenshot'));
  expect(screen.queryByRole('button', { name: 'Confirm review' })).toBeNull();
  expect(p.client.review).toHaveBeenCalledTimes(1);
});
