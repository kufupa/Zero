import { fireEvent, screen } from '@testing-library/react';

/** Drive the production pane HITL path: fixture search → allocation → PDF. */
export function prepareReviewedQuote(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Run next$/i }));
  const allocation = screen.getAllByRole('button').find((element) => {
    const text = element.textContent ?? '';
    return text.includes('Allocation') && !text.includes('Alternative');
  });
  if (!allocation) throw new Error('expected an allocation offer after Run next');
  fireEvent.click(allocation);
  fireEvent.click(screen.getByRole('button', { name: /Prepare quotation PDF/i }));
}
