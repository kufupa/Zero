import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AUTHORISED_REPLY_HTML } from './authorised-quote-evidence';

/**
 * The stay form once Nava's read has landed. While it reads, the form shows a blank stay that the read then replaces,
 * so these paths wait for the read (its type badge) and let that render finish before taking the Arrival field.
 */
export function setReviewedReply(html: string): void {
  const reply = screen.getByLabelText('Reviewed reply');
  reply.innerHTML = html;
  fireEvent.input(reply);
}

export function reviewedReplyHtml(): string {
  return screen.getByLabelText('Reviewed reply').innerHTML.replace(/<br>/gi, '<br />');
}

export async function findReadStayArrival(): Promise<HTMLElement> {
  await waitFor(() => {
    if (!screen.queryByText(/Nava reads this as/i) || screen.queryByText(/Nava is (re-)?reading/i)) {
      throw new Error('Nava is still reading the email');
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return screen.getByLabelText('Arrival');
}

export async function fillStayFactsMatchingAuthorisedOffer(roomCode = 'SKNG'): Promise<void> {
  fireEvent.change(await findReadStayArrival(), { target: { value: '2026-11-12' } });
  fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-11-14' } });
  // The Meal plan select only filters the rate cards now. The stay's board comes from the read.
  fireEvent.change(screen.getByLabelText('Meal plan'), { target: { value: 'bb' } });
  // Rooms has a visible stepper and a hidden number input with the same label. The input is the one to change.
  fireEvent.change(screen.getByLabelText('Rooms', { selector: 'input' }), { target: { value: '1' } });
  // Adults per room sits behind an edit button as a stepper. The read leaves it unset, so + sets it to 1.
  fireEvent.click(screen.getByRole('button', { name: 'Edit adults per room for stay 1, room 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'More: Adult guests per room for stay 1, room 1' }));
  fireEvent.change(screen.getByLabelText('Room type'), { target: { value: roomCode } });
}

/** Drive an authorised HITL path. Production unavailable path must not reach here. */
export async function prepareReviewedQuote(replyHtml: string | null = AUTHORISED_REPLY_HTML, roomCode = 'SKNG'): Promise<void> {
  await fillStayFactsMatchingAuthorisedOffer(roomCode);
  fireEvent.click(screen.getByRole('button', { name: /^Search availability$/i }));
  const allocation = await waitFor(() => {
    const match = screen.getAllByRole('button').find((element) => {
      const text = element.textContent ?? '';
      return text.includes('Counted in the total') && !text.includes('Alternative');
    });
    if (!match) throw new Error('expected an authorised allocation offer after Search availability');
    return match;
  });
  if (allocation.getAttribute('aria-pressed') !== 'true') fireEvent.click(allocation);
  if (replyHtml !== null) {
    setReviewedReply(replyHtml);
  }
  fireEvent.click(screen.getByRole('button', { name: /^Prepare PDF$/i }));
  await waitFor(() => {
    expectPreparedPdf();
  });
}

function expectPreparedPdf(): void {
  if (!screen.queryByText(/Prepared PDF/i)) {
    throw new Error('expected prepared authorised PDF');
  }
}
