/**
 * @vitest-environment happy-dom
 */
import { useStoredWork, WORK_EVENT_DEBOUNCE_MS } from '@/lib/quote-workflow/use-work-item';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoredContact, StoredWork } from '@/lib/quote-workflow/backend-bind';
import { ContactBlock } from '@/components/nava-pane/blocks/contact-block';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectedEmailBlock } from '@/components/nava-pane/blocks/selected-email';
import { unmaskedPii } from './helpers/pii-marks';

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setClipboard(undefined);
});

const PRIYA: StoredContact = {
  name: 'Priya Naidoo',
  company: 'New Frontiers Tours',
  endClient: 'Tailormade Africa',
  email: 'priya@example.com',
  phone: '+27 11 000 0000',
};

const READY: StoredWork = {
  status: 'ready',
  workItemId: 'wi-1',
  workItemStatus: 'needs_you',
  extractionId: 'ex-1',
  refs: {},
  analysis: { intent: 'quote', groups: [], secondaryAsks: [], alternatives: [] } as never,
  contact: PRIYA,
  language: null,
  translation: null,
};

/** The pane's wiring for the block: the stored read's values, and the stored work's contact logging. */
function Harness({ trpc }: { trpc: unknown }) {
  const storedWork = useStoredWork({ trpc, internetMessageId: 'm-1' });
  return (
    <ContactBlock
      key={`m-1|${storedWork.pane.state === 'ready' ? storedWork.pane.workItemId : ''}`}
      contact={storedWork.pane.state === 'ready' ? storedWork.pane.contact : null}
      onEdit={storedWork.recordContact}
    />
  );
}

function fakeTrpc(lookup: StoredWork) {
  const mutate = vi.fn(async (_input: unknown) => ({ aiValue: null, value: null }));
  return {
    trpc: { workItems: { getByMessage: { query: async () => lookup }, recordEvent: { mutate } } },
    mutate,
  };
}

describe('ContactBlock', () => {
  it('shows guest and company details as read-only text until Correct reveals the fields', () => {
    render(<ContactBlock contact={PRIYA} onEdit={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Guest & contact' })).toBeDefined();
    for (const value of ['Priya Naidoo', 'priya@example.com', '+27 11 000 0000', 'New Frontiers Tours', 'Tailormade Africa']) {
      expect(screen.getByText(value)).toBeDefined();
    }
    expect(screen.getByText('Corrections save to this request only. HMS is not changed.')).toBeDefined();
    for (const label of ['Name', 'Email', 'Phone', 'Company', 'End client']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    for (const label of ['Name', 'Email', 'Phone', 'Company', 'End client']) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
  });

  it('copies a company value without saving a correction', async () => {
    const writeText = vi.fn(async () => {});
    const onEdit = vi.fn();
    setClipboard({ writeText });
    render(<ContactBlock contact={PRIYA} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy company' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('New Frontiers Tours'));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('copies a populated contact value with one click', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(<ContactBlock contact={PRIYA} onEdit={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy email' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('priya@example.com'));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('resets successful copy feedback after two seconds', async () => {
    vi.useFakeTimers();
    setClipboard({ writeText: vi.fn(async () => {}) });
    render(<ContactBlock contact={PRIYA} onEdit={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy email' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Copied email' })).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: 'Copy email' })).toBeDefined();
  });

  it('shows a missing phone as an empty field she can type into, and reports the change with its field', () => {
    const onEdit = vi.fn();
    render(<ContactBlock contact={{ ...PRIYA, phone: null }} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    const phone = screen.getByLabelText('Phone') as HTMLInputElement;
    expect(phone.value).toBe('');
    expect(phone.disabled).toBe(false);
    fireEvent.change(phone, { target: { value: '+27 82 555 0100' } });
    expect(phone.value).toBe('+27 82 555 0100');
    expect(onEdit).toHaveBeenCalledWith('phone', '+27 82 555 0100');
  });

  it('reports a cleared field as null, and a blank one as null too', () => {
    const onEdit = vi.fn();
    render(<ContactBlock contact={PRIYA} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '   ' } });
    expect(onEdit).toHaveBeenLastCalledWith('email', null);
  });

  it('is blank while the mail is still being read', () => {
    render(<ContactBlock contact={null} onEdit={vi.fn()} />);
    expect(screen.getAllByText('—').length).toBe(5);
    expect(screen.queryByLabelText('Name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });
});

describe('contact edits through the stored work', () => {
  it('does not offer a duplicate editable company field in the contact block', async () => {
    const { trpc, mutate } = fakeTrpc(READY);
    render(<Harness trpc={trpc} />);
    await waitFor(() => {
      expect(screen.getByText('New Frontiers Tours')).toBeDefined();
    });
    expect(screen.queryByLabelText('Company')).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  }, 10_000);

  it('keeps what she typed while the mail is read live, and logs nothing without a stored read', async () => {
    const { trpc, mutate } = fakeTrpc({ status: 'none' });
    render(<Harness trpc={trpc} />);
    // The lookup answers "none" at once, so the pane is reading live before she types.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Correct' })).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+27 82 555 0100' } });
    await new Promise((resolve) => setTimeout(resolve, WORK_EVENT_DEBOUNCE_MS + 100));
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('+27 82 555 0100');
    expect(mutate).not.toHaveBeenCalled();
  }, 10_000);
});

describe('contact and selected email mark guest details for the preview gate (H6b)', () => {
  it('marks the guest contact fields, and leaves the company or agency unmarked', () => {
    const { container } = render(<ContactBlock contact={PRIYA} onEdit={vi.fn()} />);
    expect(unmaskedPii(container, ['Priya', 'Tailormade', 'priya@example.com', '+27 11 000 0000'])).toEqual([]);
    expect(container.querySelector('[data-contact-field="company"]')?.hasAttribute('data-pii')).toBe(false);
  });

  it('marks the selected email subject and sender', () => {
    const { container } = render(
      <SelectedEmailBlock
        activeEmail={{ subject: 'Booking for Mr Fixturemann', senderName: 'Priya Naidoo', senderEmail: 'priya@example.com' } as never}
      />,
    );
    expect(unmaskedPii(container, ['Fixturemann', 'Priya', 'priya@example.com'])).toEqual([]);
  });
});
