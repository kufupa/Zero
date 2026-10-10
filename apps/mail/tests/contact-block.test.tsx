/**
 * @vitest-environment happy-dom
 */
import { useStoredWork, WORK_EVENT_DEBOUNCE_MS } from '@/lib/quote-workflow/use-work-item';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoredContact, StoredWork } from '@/lib/quote-workflow/backend-bind';
import { ContactBlock } from '@/components/nava-pane/blocks/contact-block';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => cleanup());

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
  it('shows the name, company, end client, email and phone from the read, each editable', () => {
    render(<ContactBlock contact={PRIYA} onEdit={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Contact' })).toBeDefined();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Priya Naidoo');
    expect((screen.getByLabelText('Company / agency') as HTMLInputElement).value).toBe(
      'New Frontiers Tours',
    );
    expect((screen.getByLabelText('End client') as HTMLInputElement).value).toBe(
      'Tailormade Africa',
    );
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('priya@example.com');
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('+27 11 000 0000');
    for (const label of ['Name', 'Company / agency', 'End client', 'Email', 'Phone']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(false);
    }
  });

  it('shows a missing phone as an empty field she can type into, and reports the change with its field', () => {
    const onEdit = vi.fn();
    render(<ContactBlock contact={{ ...PRIYA, phone: null }} onEdit={onEdit} />);
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
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '   ' } });
    expect(onEdit).toHaveBeenLastCalledWith('email', null);
  });

  it('is blank while the mail is still being read, and the fields are still editable', () => {
    render(<ContactBlock contact={null} onEdit={vi.fn()} />);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Company / agency') as HTMLInputElement).value).toBe('');
  });
});

describe('contact edits through the stored work', () => {
  it('logs an edit to the company as one contact.company event, after the quiet period', async () => {
    const { trpc, mutate } = fakeTrpc(READY);
    render(<Harness trpc={trpc} />);
    // The stored read lands and the block remounts with its values, so wait for them before typing.
    await waitFor(() =>
      expect((screen.getByLabelText('Company / agency') as HTMLInputElement).value).toBe(
        'New Frontiers Tours',
      ),
    );
    const company = screen.getByLabelText('Company / agency');
    fireEvent.change(company, { target: { value: 'Tailormade Africa Tours' } });
    fireEvent.change(company, { target: { value: 'Tailormade Africa Tours Ltd' } });
    expect(mutate).not.toHaveBeenCalled();
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1), {
      timeout: WORK_EVENT_DEBOUNCE_MS + 2000,
    });
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 'wi-1',
        type: 'field.edit',
        fieldPath: 'contact.company',
        value: 'Tailormade Africa Tours Ltd',
        msSinceOpen: expect.any(Number),
      }),
    );
  }, 10_000);

  it('keeps what she typed while the mail is read live, and logs nothing without a stored read', async () => {
    const { trpc, mutate } = fakeTrpc({ status: 'none' });
    render(<Harness trpc={trpc} />);
    // The lookup answers "none" at once, so the pane is reading live before she types.
    await waitFor(() => expect(screen.getByLabelText('Phone')).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+27 82 555 0100' } });
    await new Promise((resolve) => setTimeout(resolve, WORK_EVENT_DEBOUNCE_MS + 100));
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('+27 82 555 0100');
    expect(mutate).not.toHaveBeenCalled();
  }, 10_000);
});
