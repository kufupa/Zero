import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AUTHORISED_REPLY_HTML } from './authorised-quote-evidence';

/**
 * The stay form once Nava's read has landed. While it reads, the form shows a blank stay that the read then replaces,
 * so these paths wait for the read (its type badge) and let that render finish before taking the Arrival field.
 */
export async function findReadStayArrival(): Promise<HTMLElement> {
  await waitFor(() => {
    if (!screen.queryByText(/Nava reads this as/i) || screen.queryByText(/Nava is (re-)?reading/i)) {
      throw new Error('Nava is still reading the email');
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return screen.getByLabelText('Arrival');
}

export async function fillStayFactsMatchingAuthorisedOffer(): Promise<void> {
  fireEvent.change(await findReadStayArrival(), { target: { value: '2026-11-12' } });
  fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-11-14' } });
  fireEvent.change(screen.getByLabelText('Meal plan'), { target: { value: 'bb' } });
  fireEvent.change(screen.getByLabelText('Rooms'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Adults'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Room type'), { target: { value: 'SKNG' } });
}

/** Drive an authorised HITL path. Production unavailable path must not reach here. */
export async function prepareReviewedQuote(): Promise<void> {
  await fillStayFactsMatchingAuthorisedOffer();
  fireEvent.click(screen.getByRole('button', { name: /^Get rates from HMS$/i }));
  const allocation = await waitFor(() => {
    const match = screen.getAllByRole('button').find((element) => {
      const text = element.textContent ?? '';
      return text.includes('Counted in the total') && !text.includes('Alternative');
    });
    if (!match) throw new Error('expected an authorised allocation offer after Get rates from HMS');
    return match;
  });
  if (allocation.getAttribute('aria-pressed') !== 'true') fireEvent.click(allocation);
  const reply = screen.getByLabelText('Reviewed reply');
  fireEvent.change(reply, { target: { value: AUTHORISED_REPLY_HTML } });
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
