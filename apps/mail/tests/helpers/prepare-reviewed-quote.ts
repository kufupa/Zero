import { fireEvent, screen, waitFor } from '@testing-library/react';

/** Drive an authorised HITL path. Production unavailable path must not reach here. */
export async function prepareReviewedQuote(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /^Run next$/i }));
  const allocation = await waitFor(() => {
    const match = screen.getAllByRole('button').find((element) => {
      const text = element.textContent ?? '';
      return text.includes('Allocation') && !text.includes('Alternative');
    });
    if (!match) throw new Error('expected an authorised allocation offer after Run next');
    return match;
  });
  fireEvent.click(allocation);
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
