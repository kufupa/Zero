/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchBookingReview } from '../components/quote-workflow/batch-booking-review';
import type { BatchReview, BatchReviewChildInput, BatchReviewInput, PaneBatchClient } from '../lib/quote-workflow/pane-batch-booking';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('../lib/quote-workflow/pane-telemetry', async (original) => ({
  ...(await original<typeof import('../lib/quote-workflow/pane-telemetry')>()), trackPaneAction: vi.fn(),
}));
afterEach(cleanup);

function input(): BatchReviewInput {
  const stay = { firstName: 'Proof', lastName: 'Labtest', arrival: '2027-03-01', departure: '2027-03-03', adults: 1,
    childAges: [], roomType: 'STQN', ratePlan: 'BAR', track: 'BAR', sourceOfBusiness: 'Email', guestoptin4: false,
    guaranteeType: 'NGI', confirmationSendMail: false };
  return { propertyCode: 'HRCEN', source: { transportId: 'mailbox', threadId: 'thread', messageId: 'mail', workItemId: 'item' },
    rooms: [{ allocationId: 'g:1', identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 }, stay, amount: { minor: 120000, currency: null, basis: 'room_night', tax: 'unknown', status: 'unavailable' } },
      { allocationId: 'g:2', identity: { stayId: 's1', rowId: 'r2', roomIndex: 1 }, stay: { ...stay, roomType: 'STWN' }, amount: { minor: null, currency: null, basis: 'unknown', tax: 'unknown', status: 'unavailable' } }] };
}
function review(source = input()): BatchReview {
  return { reviewId: 'review', manifestDigest: 'digest', expiresAt: '2099-01-01T00:00:00Z', batchLimit: 2, blockers: [],
    propertyCode: source.propertyCode, source: source.source, rooms: source.rooms.map((room) => ({ allocationId: room.allocationId, identity: room.identity,
      roomType: room.stay.roomType, ratePlan: room.stay.ratePlan, guest: { firstName: room.stay.firstName, lastName: room.stay.lastName, profileId: '123' },
      stay: { arrival: room.stay.arrival, departure: room.stay.departure, adults: room.stay.adults, childAges: [] },
      agency: null, organization: null, guaranteeType: 'NGI', sourceOfBusiness: null, note: null,
      track: 'BAR', marketSegment: null, guestOptIn: false, booker: null, cmsSend: false, amount: room.amount })) };
}
const CHILD_A = 'a'.repeat(64);
const CHILD_B = 'b'.repeat(64);
const PNG = 'data:image/png;base64,aGVsbG8=';
function client(): PaneBatchClient {
  let persisted: { workItemId: string; runId: string; childId: string; evidenceVersion: string; decision: 'ok' | 'flag' } | null = null;
  return { prepare: vi.fn(async (request) => review(request)), approve: vi.fn(async () => ({ runId: 'run' })),
    read: vi.fn(async (scope) => ({ ...scope, complete: true, rooms: [{ allocationId: 'g:1', status: 'confirmed' as const,
      confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true, attempt: { runId: 'run', childId: CHILD_A }, reviewed: persisted },
      { allocationId: 'g:2', status: 'unattempted' as const }] })),
    evidence: vi.fn(async (scope) => ({ ...scope, status: 'available' as const, evidenceVersion: 'private-version', dataUrl: PNG })),
    reviewChild: vi.fn(async (request: BatchReviewChildInput) => {
      persisted = { workItemId: request.workItemId, runId: request.runId, childId: request.childId, evidenceVersion: request.evidenceVersion, decision: request.decision };
      return { ...request, status: 'recorded' as const };
    }) };
}

describe('batch booking review', () => {
  it('reviews exact rooms without linked or atomic claims and reports partial outcomes', async () => {
    const api = client(), onLock = vi.fn();
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={onLock} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    expect(await screen.findByText(/confirmation email is off/)).toBeTruthy();
    expect(screen.getByText(/booked separately and are not linked in HMS/)).toBeTruthy();
    expect(screen.getByText(/Amount unavailable \(quoted currency unknown 1200.00\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and book these rooms' }));
    expect(await screen.findByText(/Booked · confirmation C1/)).toBeTruthy();
    expect(screen.getByText('Not attempted')).toBeTruthy();
    expect(onLock).toHaveBeenCalledWith(true);
    expect(api.approve).toHaveBeenCalledWith({ workItemId: 'item', reviewId: 'review', manifestDigest: 'digest' });
  });
  it('offers a new review when the approval expires', async () => {
    const api = client();
    api.prepare = vi.fn(async (request) => ({ ...review(request), expiresAt: new Date(Date.now() + 400).toISOString() }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    await screen.findByRole('button', { name: 'Approve and book these rooms' });
    expect(await screen.findByText('Review expired. Review these rooms again.', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review these rooms' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
    expect(api.approve).not.toHaveBeenCalled();
  });
  it('invalidates review when any room changes', async () => {
    const api = client(), original = input(), { rerender } = render(<BatchBookingReview client={api} input={original} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    await screen.findByRole('button', { name: 'Approve and book these rooms' });
    const changed = structuredClone(original); changed.rooms[1]!.stay.adults = 2;
    rerender(<BatchBookingReview client={api} input={changed} missing={[]} onLock={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
    expect(screen.getByText(/Booking details changed/)).toBeTruthy();
  });
  it('invalidates an old review even when an excluded room is re-included', async () => {
    const api = client(), source = input();
    source.rooms.push({ ...source.rooms[1]!, allocationId: 'g:3', identity: { stayId: 's1', rowId: 'r2', roomIndex: 2 } });
    api.prepare = vi.fn(async (request) => ({ ...review(request), batchLimit: 3 }));
    render(<BatchBookingReview client={api} input={source} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    await screen.findByRole('button', { name: 'Approve and book these rooms' });
    const third = screen.getAllByRole('checkbox')[2]!;
    fireEvent.click(third);
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
    fireEvent.click(third);
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
    expect(screen.getByText(/Booking details changed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    await screen.findByRole('button', { name: 'Approve and book these rooms' });
    expect(api.prepare).toHaveBeenCalledTimes(2);
  });
  it('invalidates a review when excluded room details change, even if restored', async () => {
    const api = client(), original = input();
    original.rooms.push({ ...original.rooms[1]!, allocationId: 'g:3', identity: { stayId: 's1', rowId: 'r2', roomIndex: 2 } });
    const { rerender } = render(<BatchBookingReview client={api} input={original} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getAllByRole('checkbox')[2]!);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    await screen.findByRole('button', { name: 'Approve and book these rooms' });
    const changed = structuredClone(original); changed.rooms[2]!.stay.adults = 2;
    rerender(<BatchBookingReview client={api} input={changed} missing={[]} onLock={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
    rerender(<BatchBookingReview client={api} input={original} missing={[]} onLock={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
  });
  it('invalidates a review when missing details change and are restored', async () => {
    const api = client(), source = input();
    const { rerender } = render(<BatchBookingReview client={api} input={source} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    await screen.findByRole('button', { name: 'Approve and book these rooms' });
    rerender(<BatchBookingReview client={api} input={source} missing={['Guest']} onLock={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
    rerender(<BatchBookingReview client={api} input={source} missing={[]} onLock={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
  });
  it('sends only included rooms, in source order, and refuses an undersized selection', async () => {
    const api = client(), source = input();
    source.rooms.push({ ...source.rooms[1]!, allocationId: 'g:3', identity: { stayId: 's1', rowId: 'r2', roomIndex: 2 } });
    render(<BatchBookingReview client={api} input={source} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    await screen.findByRole('button', { name: 'Approve and book these rooms' });
    expect(vi.mocked(api.prepare).mock.calls[0]![0].rooms.map((room) => room.allocationId)).toEqual(['g:1', 'g:3']);
    fireEvent.click(screen.getAllByRole('checkbox')[2]!);
    expect(screen.getByText(/Select between 2 and 8 rooms/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
  });
  it('allows review of valid selected rooms when an excluded room lacks a source identity', async () => {
    const api = client(), source = input();
    source.rooms.push({ ...source.rooms[1]!, allocationId: 'g:3', identity: { stayId: 's1', rowId: '', roomIndex: 1 } });
    render(<BatchBookingReview client={api} input={source} missing={[]} onLock={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Review these rooms' })).toBeNull();
    fireEvent.click(screen.getAllByRole('checkbox')[2]!);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    await screen.findByRole('button', { name: 'Approve and book these rooms' });
    expect(vi.mocked(api.prepare).mock.calls[0]![0].rooms.map((room) => room.allocationId)).toEqual(['g:1', 'g:2']);
  });
  it('holds duplicate source-room identities even with different allocation IDs', () => {
    const api = client(), source = input();
    source.rooms[1]!.identity = structuredClone(source.rooms[0]!.identity);
    render(<BatchBookingReview client={api} input={source} missing={[]} onLock={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Room details need checking/);
    expect(screen.queryByRole('button', { name: 'Review these rooms' })).toBeNull();
    expect(api.prepare).not.toHaveBeenCalled();
  });
  it('rejects a prepared review whose source-room identity differs', async () => {
    const api = client(); api.prepare = vi.fn(async (request) => {
      const result = review(request); result.rooms[0]!.identity = { ...result.rooms[0]!.identity, rowId: 'wrong' }; return result;
    });
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not prepare/);
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
  });
  it('does not offer repeat approval after a lost response', async () => {
    const api = client(); api.approve = vi.fn(async () => { throw new Error('lost'); });
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    expect((await screen.findByRole('alert')).textContent).toContain('outcome needs checking');
    expect(screen.queryByRole('button', { name: /Approve|Review these rooms/ })).toBeNull();
  });
  it('holds unmeasured limits and real guests, regardless of single-create mode', async () => {
    const api = client(); api.prepare = vi.fn(async (request) => ({ ...review(request), batchLimit: null }));
    const { rerender } = render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    expect(await screen.findByText(/Booking time is not yet known/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve and book these rooms' }) as HTMLButtonElement).disabled).toBe(true);
    const real = input(); real.rooms[1]!.stay.lastName = 'Person';
    rerender(<BatchBookingReview client={api} input={real} missing={[]} onLock={() => {}} />);
    expect(screen.getByText(/available for test bookings only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and book these rooms' })).toBeNull();
  });
  it('fetches and reviews only the confirmed child and its originating run', async () => {
    const api = client();
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    await screen.findByText(/Booked · confirmation C1/);
    fireEvent.click(screen.getByRole('button', { name: 'View HMS screenshot' }));
    const image = await screen.findByRole('img', { name: 'Saved booking in HMS' });
    expect(image.getAttribute('src')).toBe(PNG);
    expect(api.evidence).toHaveBeenCalledWith({ workItemId: 'item', runId: 'run', childId: CHILD_A });
    expect((screen.getByRole('button', { name: 'Review OK' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.load(image);
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    expect(await screen.findByText('HMS booking reviewed.')).toBeTruthy();
    expect(api.reviewChild).toHaveBeenCalledWith({ workItemId: 'item', runId: 'run', childId: CHILD_A,
      evidenceVersion: 'private-version', decision: 'ok' });
    expect(document.body.textContent).not.toContain('private/shot');
    expect(document.body.textContent).not.toContain('private-version');
    expect(document.body.textContent).not.toContain(CHILD_A);
  });
  it('shows missing child results as needing checks even if the read says complete', async () => {
    const api = client();
    api.read = vi.fn(async (scope) => ({ ...scope, complete: true, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true, attempt: { runId: 'run', childId: CHILD_A } },
    ] }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    await waitFor(() => expect(screen.getAllByText('Outcome needs checking in HMS')).toHaveLength(2));
    expect(screen.queryByText(/Booked · confirmation/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/results are incomplete/);
  });
  it('holds duplicate result rows and warns about an unexpected allocation', async () => {
    const api = client();
    api.read = vi.fn(async (scope) => ({ ...scope, complete: true, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true, attempt: { runId: 'run', childId: CHILD_A } },
      { allocationId: 'g:1', status: 'unattempted' as const },
      { allocationId: 'g:2', status: 'unattempted' as const },
      { allocationId: 'unreviewed', status: 'unattempted' as const },
    ] }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    await waitFor(() => expect(screen.getAllByText('Outcome needs checking in HMS')).toHaveLength(2));
    expect(screen.queryByText(/Booked · confirmation/)).toBeNull();
    expect(screen.queryByText('Not attempted')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/results are incomplete/);
  });
  it.each(['extra', 'reordered'] as const)('holds every child for a complete but %s result', async (mismatch) => {
    const api = client(), originalRead = api.read;
    api.read = vi.fn(async (scope) => {
      const result = await originalRead(scope);
      return { ...result, rooms: mismatch === 'extra'
        ? [...result.rooms, { allocationId: 'unreviewed', status: 'unattempted' as const }]
        : [...result.rooms].reverse() };
    });
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    await waitFor(() => expect(screen.getAllByText('Outcome needs checking in HMS')).toHaveLength(2));
    expect(screen.queryByText(/Booked · confirmation/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'View HMS screenshot' })).toBeNull();
  });
  it('does not assert an unattempted child when the result read is incomplete', async () => {
    const api = client();
    api.read = vi.fn(async (scope) => ({ ...scope, complete: false, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true, attempt: { runId: 'run', childId: CHILD_A } },
      { allocationId: 'g:2', status: 'unattempted' as const },
    ] }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    expect(await screen.findByText(/Booked · confirmation C1/)).toBeTruthy();
    expect(screen.getByText('Outcome needs checking in HMS')).toBeTruthy();
    expect(screen.queryByText('Not attempted')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/results are incomplete/);
  });
  it('uses a confirmed child’s original run when a later batch continues', async () => {
    const api = client();
    api.read = vi.fn(async (scope) => ({ ...scope, complete: true, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true, attempt: { runId: 'earlier-run', childId: CHILD_A } },
      { allocationId: 'g:2', status: 'confirmed' as const, confirmation: 'C2', screenshotRecorded: true, readbackRecorded: true, attempt: { runId: 'run', childId: CHILD_B } },
    ] }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    await screen.findByText(/Booked · confirmation C1/);
    const buttons = screen.getAllByRole('button', { name: 'View HMS screenshot' });
    fireEvent.click(buttons[0]!); fireEvent.click(buttons[1]!);
    await waitFor(() => expect(api.evidence).toHaveBeenCalledTimes(2));
    expect(api.evidence).toHaveBeenCalledWith({ workItemId: 'item', runId: 'earlier-run', childId: CHILD_A });
    expect(api.evidence).toHaveBeenCalledWith({ workItemId: 'item', runId: 'run', childId: CHILD_B });
  });
  it.each(['confirmation', 'childId'] as const)('holds both results when confirmed rooms share a %s', async (conflict) => {
    const api = client();
    api.read = vi.fn(async (scope) => ({ ...scope, complete: true, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true, attempt: { runId: 'earlier-run', childId: CHILD_A } },
      { allocationId: 'g:2', status: 'confirmed' as const, confirmation: conflict === 'confirmation' ? 'C1' : 'C2', screenshotRecorded: true, readbackRecorded: true, attempt: { runId: 'run', childId: conflict === 'childId' ? CHILD_A : CHILD_B } },
    ] }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    await waitFor(() => expect(screen.getAllByText('Outcome needs checking in HMS')).toHaveLength(2));
    expect(screen.queryByText(/Booked · confirmation/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'View HMS screenshot' })).toBeNull();
  });
  it.each(['workItemId', 'runId', 'childId'] as const)('does not display evidence with a different %s', async (field) => {
    const api = client();
    api.evidence = vi.fn(async (scope) => ({ ...scope, [field]: 'wrong', status: 'available' as const, evidenceVersion: 'v', dataUrl: PNG }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    expect(await screen.findByText(/could not show the HMS screenshot/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
  });
  it('reports expired screenshots without implying a review was saved', async () => {
    const api = client(); api.evidence = vi.fn(async (scope) => ({ ...scope, status: 'expired' as const }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    expect(await screen.findByText(/screenshot has expired/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(api.reviewChild).not.toHaveBeenCalled();
  });
  it('does not mark review complete from an acknowledgement when fresh read lacks its matching decision', async () => {
    const api = client();
    api.reviewChild = vi.fn(async (request: BatchReviewChildInput) => ({ ...request, status: 'recorded' as const }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    fireEvent.load(await screen.findByRole('img', { name: 'Saved booking in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    expect(await screen.findByText(/Review may have been saved/)).toBeTruthy();
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('HMS booking reviewed.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh booking results' }));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
    expect(screen.getByText(/Review may have been saved/)).toBeTruthy();
    expect(api.reviewChild).toHaveBeenCalledTimes(1);
  });
  it.each(['workItemId', 'runId', 'childId', 'evidenceVersion', 'decision'] as const)('holds an acknowledgement when the persisted review has a different %s', async (field) => {
    const api = client(); let reads = 0;
    api.read = vi.fn(async (scope) => ({ ...scope, complete: true, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true,
        attempt: { runId: 'run', childId: CHILD_A }, reviewed: ++reads === 1 ? null : {
          workItemId: 'item', runId: 'run', childId: CHILD_A, evidenceVersion: 'private-version', decision: 'ok' as const,
          [field]: field === 'decision' ? 'flag' : 'wrong',
        } },
      { allocationId: 'g:2', status: 'unattempted' as const },
    ] }));
    api.reviewChild = vi.fn(async (request: BatchReviewChildInput) => ({ ...request, status: 'recorded' as const }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    fireEvent.load(await screen.findByRole('img', { name: 'Saved booking in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Review may have been saved/)).toBeTruthy();
    expect(screen.queryByText('HMS booking reviewed.')).toBeNull();
    expect(screen.queryByText('Flagged for follow-up.')).toBeNull();
  });
  it('keeps an ambiguous review locked until a fresh durable read confirms its outcome', async () => {
    const api = client();
    api.reviewChild = vi.fn(async (request: BatchReviewChildInput) => ({ ...request, status: 'recorded' as const, runId: 'other-run' }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    fireEvent.load(await screen.findByRole('img', { name: 'Saved booking in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    expect(await screen.findByText(/Review may have been saved/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
    api.read = vi.fn(async (scope) => ({ ...scope, complete: true, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true,
        attempt: { runId: 'run', childId: CHILD_A }, reviewed: { workItemId: 'item', runId: 'run', childId: CHILD_A, evidenceVersion: 'private-version', decision: 'ok' as const } },
      { allocationId: 'g:2', status: 'unattempted' as const },
    ] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh booking results' }));
    expect(await screen.findByText('HMS booking reviewed.')).toBeTruthy();
    expect(api.reviewChild).toHaveBeenCalledTimes(1);
  });
  it('does not confirm a pending review from an incomplete manual refresh', async () => {
    const api = client();
    api.reviewChild = vi.fn(async (request: BatchReviewChildInput) => ({ ...request, status: 'recorded' as const, runId: 'other-run' }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    fireEvent.load(await screen.findByRole('img', { name: 'Saved booking in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    expect(await screen.findByText(/Review may have been saved/)).toBeTruthy();
    api.read = vi.fn(async (scope) => ({ ...scope, complete: false, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true,
        attempt: { runId: 'run', childId: CHILD_A }, reviewed: { workItemId: 'item', runId: 'run', childId: CHILD_A, evidenceVersion: 'private-version', decision: 'ok' as const } },
      { allocationId: 'g:2', status: 'unattempted' as const },
    ] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh booking results' }));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(1));
    await screen.findByText('Some booking results are incomplete. Check HMS before trying again.');
    expect(screen.getByText(/Review may have been saved/)).toBeTruthy();
    expect(screen.queryByText('HMS booking reviewed.')).toBeNull();
    expect(api.reviewChild).toHaveBeenCalledTimes(1);
  });
  it.each(['unavailable', 'error'] as const)('shows a plain-language %s evidence state without leaking errors', async (kind) => {
    const api = client();
    api.evidence = kind === 'unavailable'
      ? vi.fn(async (scope) => ({ ...scope, status: 'unavailable' as const }))
      : vi.fn(async () => { throw new Error('secret/private/storage-path'); });
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    expect(await screen.findByText(/could not show the HMS screenshot/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('secret/private/storage-path');
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
  });
  it('reports an unavailable screenshot capability without a dead control', async () => {
    const api = client(); delete api.evidence;
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    expect(await screen.findByText(/Screenshot review is not available/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View HMS screenshot' })).toBeNull();
  });
  it('shows a previously persisted flag only for its matching child attempt', async () => {
    const api = client();
    api.read = vi.fn(async (scope) => ({ ...scope, complete: true, rooms: [
      { allocationId: 'g:1', status: 'confirmed' as const, confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true,
        attempt: { runId: 'run', childId: CHILD_A }, reviewed: { workItemId: 'item', runId: 'run', childId: CHILD_A, evidenceVersion: 'v1', decision: 'flag' as const } },
      { allocationId: 'g:2', status: 'confirmed' as const, confirmation: 'C2', screenshotRecorded: true, readbackRecorded: true,
        attempt: { runId: 'run', childId: CHILD_B }, reviewed: { workItemId: 'item', runId: 'run', childId: CHILD_A, evidenceVersion: 'v1', decision: 'flag' as const } },
    ] }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    expect((await screen.findAllByText('Flagged for follow-up.')).length).toBe(1);
  });
  it('reports an unavailable review capability after showing evidence', async () => {
    const api = client(); delete api.reviewChild;
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    expect(await screen.findByText(/Screenshot review is not available/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review OK' })).toBeNull();
  });
  it('does not treat a result read started before submission as fresh confirmation', async () => {
    const api = client(); const originalRead = api.read;
    let reads = 0, releaseOld: (() => void) | undefined;
    api.read = vi.fn(async (scope) => {
      if (++reads !== 2) return originalRead(scope);
      return new Promise<Awaited<ReturnType<PaneBatchClient['read']>>>((resolve) => {
        releaseOld = () => resolve({ ...scope, complete: true, rooms: [
          { allocationId: 'g:1', status: 'confirmed', confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true,
            attempt: { runId: 'run', childId: CHILD_A }, reviewed: { workItemId: 'item', runId: 'run', childId: CHILD_A, evidenceVersion: 'private-version', decision: 'ok' } },
          { allocationId: 'g:2', status: 'unattempted' },
        ] });
      });
    });
    api.reviewChild = vi.fn(async (request: BatchReviewChildInput) => ({ ...request, status: 'recorded' as const }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    fireEvent.load(await screen.findByRole('img', { name: 'Saved booking in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh booking results' }));
    await waitFor(() => expect(releaseOld).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(3));
    releaseOld!();
    await waitFor(() => expect(screen.queryByText('Nava is checking HMS. This can take more than 30 seconds.')).toBeNull());
    expect(screen.queryByText('HMS booking reviewed.')).toBeNull();
    expect(screen.getByText(/Review may have been saved/)).toBeTruthy();
  });
  it('does not confirm a screenshot review from an incomplete fresh read', async () => {
    const api = client(), initialRead = api.read; let reads = 0;
    api.read = vi.fn(async (scope) => ({ ...(await initialRead(scope)), complete: ++reads === 1 }));
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    fireEvent.load(await screen.findByRole('img', { name: 'Saved booking in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Review may have been saved/)).toBeTruthy();
    expect(screen.queryByText('HMS booking reviewed.')).toBeNull();
  });
  it.each(['extra', 'reordered'] as const)('does not confirm screenshot review from a %s fresh result', async (mismatch) => {
    const api = client(), originalRead = api.read; let reads = 0;
    api.read = vi.fn(async (scope) => {
      const result = await originalRead(scope);
      if (++reads === 1) return result;
      return { ...result, rooms: mismatch === 'extra'
        ? [...result.rooms, { allocationId: 'unreviewed', status: 'unattempted' as const }]
        : [...result.rooms].reverse() };
    });
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    fireEvent.load(await screen.findByRole('img', { name: 'Saved booking in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review OK' }));
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Review may have been saved/)).toBeTruthy();
    expect(screen.queryByText('HMS booking reviewed.')).toBeNull();
  });
  it('records a flagged child review only with a note after viewing the screenshot', async () => {
    const api = client();
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and book these rooms' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View HMS screenshot' }));
    fireEvent.load(await screen.findByRole('img', { name: 'Saved booking in HMS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flag a problem' }));
    expect((screen.getByRole('button', { name: 'Save flag' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What needs attention?'), { target: { value: 'Wrong occupancy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save flag' }));
    expect(await screen.findByText('Flagged for follow-up.')).toBeTruthy();
    expect(api.reviewChild).toHaveBeenCalledWith({ workItemId: 'item', runId: 'run', childId: CHILD_A,
      evidenceVersion: 'private-version', decision: 'flag', note: 'Wrong occupancy' });
  });
  it.each([
    ['estimate', null], ['estimate', undefined], ['confirmed', null], ['confirmed', undefined],
  ] as const)('blocks a %s amount with missing minor units', async (status, minor) => {
    const api = client(); api.prepare = vi.fn(async (request) => {
      const result = review(request);
      result.rooms[0]!.amount = { status, minor, currency: 'ZAR', basis: 'room_night', tax: 'unknown' };
      return result;
    });
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    expect(await screen.findByText('Amount unavailable. Check the price before approving.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('ZAR 0.00');
    expect((screen.getByRole('button', { name: 'Approve and book these rooms' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.approve).not.toHaveBeenCalled();
  });
  it('preserves an actual zero amount instead of treating it as missing', async () => {
    const api = client(); api.prepare = vi.fn(async (request) => {
      const result = review(request);
      result.rooms[0]!.amount = { status: 'estimate', minor: 0, currency: 'ZAR', basis: 'room_night', tax: 'unknown' };
      return result;
    });
    render(<BatchBookingReview client={api} input={input()} missing={[]} onLock={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review these rooms' }));
    expect(await screen.findByText(/Estimate ZAR 0\.00/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve and book these rooms' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
