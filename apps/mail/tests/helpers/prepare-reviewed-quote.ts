import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AUTHORISED_REPLY_HTML } from './authorised-quote-evidence';

export async function fillStayFactsMatchingAuthorisedOffer(): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Arrival'), { target: { value: '2026-11-12' } });
  fireEvent.change(screen.getByLabelText('Departure'), { target: { value: '2026-11-14' } });
  fireEvent.change(screen.getByLabelText('Meal plan'), { target: { value: 'bb' } });
  fireEvent.change(screen.getByLabelText('Rooms'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Adults'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Room type'), { target: { value: 'SKNG' } });
}

/** Drive an authorised HITL path. Production unavailable path must not reach here. */
export async function prepareReviewedQuote(): Promise<void> {
  await fillStayFactsMatchingAuthorisedOffer();
  fireEvent.click(screen.getByRole('button', { name: /^Run next$/i }));
  const allocation = await waitFor(() => {
    const match = screen.getAllByRole('button').find((element) => {
      const text = element.textContent ?? '';
      return text.includes('Counted in the total') && !text.includes('Alternative');
    });
    if (!match) throw new Error('expected an authorised allocation offer after Run next');
    return match;
  });
  if (allocation.getAttribute('aria-pressed') !== 'true') fireEvent.click(allocation);
  const reply = screen.getByLabelText('Reviewed reply');
  fireEvent.change(reply, { target: { value: AUTHORISED_REPLY_HTML } });
  fireEvent.click(screen.getByRole('button', { name: /Prepare quotation PDF/i }));
  await waitFor(() => {
    expectPreparedPdf();
  });
}

function expectPreparedPdf(): void {
  if (!screen.queryByText(/Prepared PDF/i)) {
    throw new Error('expected prepared authorised PDF');
  }
}
