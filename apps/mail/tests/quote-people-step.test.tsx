/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuotePeopleStep } from '../components/quote-workflow/quote-people-step';
import type { ContactField, StoredContact } from '../lib/quote-workflow/backend-bind';
import type { PartyFindReply } from '../lib/quote-workflow/party-lookup';
import { emptyStaffQuoteHeader } from '../lib/quote-workflow/types';
import type { QuoteSession, StaffQuoteParty } from '../lib/quote-workflow/types';

afterEach(() => cleanup());

const agency: StaffQuoteParty = {
  kind: 'agency',
  nativeId: 'agency-profile-1',
  name: 'Example Agency',
};

const company: StaffQuoteParty = {
  kind: 'company',
  nativeId: 'company-profile-1',
  name: 'Example Company',
};

const contact: StoredContact = {
  name: 'Request contact',
  company: 'Request-side source',
  endClient: 'Request-side company',
  email: 'contact@example.invalid',
  phone: '000-000-0000',
};

describe('QuotePeopleStep', () => {
  it('keeps request contact edits separate from distinct HMS agency and company profiles', () => {
    const onContactEdit = vi.fn<(field: ContactField, value: string | null) => void>();
    const onPatchStaffHeader = vi.fn();
    const findParty = vi.fn(async (): Promise<PartyFindReply> => ({
      outcome: 'no_match',
      results: [],
      truncated: false,
    }));
    const props = {
      session: { staffSource: null } as QuoteSession,
      partyState: 'Done' as const,
      header: {
        ...emptyStaffQuoteHeader(),
        agency: agency.name,
        company: company.name,
        parties: { agency, company },
      },
      contact,
      contactEditorKey: 'request-1',
      onContactEdit,
      onPatchStaffHeader,
      findParty,
      scrollToStep: vi.fn(),
    } as unknown as Parameters<typeof QuotePeopleStep>[0];

    render(<QuotePeopleStep {...props} />);

    const people = screen.getByRole('region', { name: 'People' });
    const contactBlock = within(people).getByRole('group', {
      name: 'Quote contact — printed on the PDF',
    });
    expect(within(contactBlock).getByText('Corrections save to this request only. HMS is not changed.')).toBeDefined();

    const agencyPicker = within(people).getByLabelText('Agency from HMS');
    const companyPicker = within(people).getByLabelText('Company from HMS');
    const selectedAgency = within(agencyPicker).getByRole('option', { selected: true });
    const selectedCompany = within(companyPicker).getByRole('option', { selected: true });
    expect(selectedAgency.getAttribute('title')).toBe(agency.nativeId);
    expect(selectedCompany.getAttribute('title')).toBe(company.nativeId);
    expect(selectedAgency.getAttribute('title')).not.toBe(selectedCompany.getAttribute('title'));

    fireEvent.click(within(contactBlock).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(contactBlock).getByLabelText('Email'), {
      target: { value: 'updated@example.invalid' },
    });

    expect(onContactEdit).toHaveBeenLastCalledWith('email', 'updated@example.invalid');
    expect(onPatchStaffHeader).not.toHaveBeenCalled();
    expect(selectedAgency.getAttribute('title')).toBe(agency.nativeId);
    expect(selectedCompany.getAttribute('title')).toBe(company.nativeId);
  });

  it('asks for a guest name instead of using an agent sender when no guest was parsed', () => {
    const agentContact: StoredContact = {
      name: 'Agent sender',
      company: null,
      endClient: null,
      email: null,
      phone: null,
    };
    const props = {
      session: {
        staffSource: null,
        analysis: {
          luna: {
            party: { kind: 'agency' },
            groups: [{ guestNames: [] }],
          },
        },
      } as unknown as QuoteSession,
      partyState: 'Optional' as const,
      header: emptyStaffQuoteHeader(),
      contact: agentContact,
      contactEditorKey: 'agent-message',
      onContactEdit: vi.fn<(field: ContactField, value: string | null) => void>(),
      scrollToStep: vi.fn(),
    } as unknown as Parameters<typeof QuotePeopleStep>[0];

    render(<QuotePeopleStep {...props} />);

    const people = screen.getByRole('region', { name: 'People' });
    const guest = within(people).getByLabelText('Guest') as HTMLInputElement;
    expect(guest.value).toBe('');
    expect(guest.getAttribute('placeholder')).toBe('Guest name?');
    expect(within(people).getByText('Agent sender')).toBeDefined();
  });
});
