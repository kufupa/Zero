/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotePeopleStep, stayingGuestName } from '../components/quote-workflow/quote-people-step';
import type { ContactField, StoredContact } from '../lib/quote-workflow/backend-bind';
import { forgetGuestName, guestNameRevision, recalledGuestName, rememberGuestName, resetGuestNameCacheForTests } from '../lib/quote-workflow/guest-name-cache';
import type { PartyFindReply } from '../lib/quote-workflow/party-lookup';
import { emptyStaffQuoteHeader } from '../lib/quote-workflow/types';
import type { QuoteSession, StaffQuoteParty } from '../lib/quote-workflow/types';

beforeEach(() => resetGuestNameCacheForTests());
afterEach(() => {
  cleanup();
  resetGuestNameCacheForTests();
});

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
  it('discards only the captured guest edit and keeps the name visible if storage cannot remove it', () => {
    const key = 'discard-test';
    rememberGuestName(key, 'Ada Example');
    const firstRevision = guestNameRevision(key);
    rememberGuestName(key, 'Ada Example');
    expect(forgetGuestName(key, firstRevision)).toBe(false);
    expect(recalledGuestName(key)).toBe('Ada Example');

    const currentRevision = guestNameRevision(key);
    const storage = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      expect(forgetGuestName(key, currentRevision)).toBe(false);
      expect(recalledGuestName(key)).toBe('Ada Example');
    } finally {
      storage.mockRestore();
    }
    expect(forgetGuestName(key, currentRevision)).toBe(true);
    resetGuestNameCacheForTests({ keepSession: true });
    expect(recalledGuestName(key)).toBeNull();
  });

  it('keeps request contact edits separate from distinct HMS agency and company profiles', () => {
    const onContactEdit = vi.fn<(field: ContactField, value: string | null) => void>();
    const onPatchStaffHeader = vi.fn();
    const findParty = vi.fn(async (): Promise<PartyFindReply> => ({
      outcome: 'no_match',
      results: [],
      truncated: false,
    }));
    const props = {
      session: { staffSource: null, groups: [] } as unknown as QuoteSession,
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
        groups: [],
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
      scrollToStep: vi.fn(),
    } as unknown as Parameters<typeof QuotePeopleStep>[0];

    render(<QuotePeopleStep {...props} />);

    const people = screen.getByRole('region', { name: 'People' });
    const guest = within(people).getByLabelText('Guest') as HTMLInputElement;
    expect(guest.value).toBe('');
    expect(guest.getAttribute('placeholder')).toBe('Guest name?');

    fireEvent.change(guest, { target: { value: 'Staff-entered value' } });
    expect(guest.value).toBe('Staff-entered value');
  });

  it('prefills a stored guest only while the original single room remains selected', () => {
    const row = {
      id: 'r_1', stayId: 's_1', quantity: 1,
      guestNames: ['Ada Example'],
      stayGuests: [{ name: 'Ada Example', confirmationNumber: null }],
    };
    const session = {
      staffSource: null,
      groups: [row],
      analysis: { groups: [row], luna: { party: { kind: 'private' }, groups: [{ guestNames: [] }] } },
    } as unknown as QuoteSession;
    const props = {
      session, partyState: 'Optional' as const, header: emptyStaffQuoteHeader(),
      contact, contactEditorKey: 'single-stored-room', scrollToStep: vi.fn(),
    } as unknown as Parameters<typeof QuotePeopleStep>[0];
    const view = render(<QuotePeopleStep {...props} />);
    expect((screen.getByLabelText('Guest') as HTMLInputElement).value).toBe('Ada Example');
    expect(stayingGuestName(session, contact, 'single-stored-room')).toBe('Ada Example');

    const expanded = { ...session, groups: [row, { ...row, id: 'r_2' }] } as unknown as QuoteSession;
    view.rerender(<QuotePeopleStep {...props} session={expanded} />);
    expect((screen.getByLabelText('Guest') as HTMLInputElement).value).toBe('');
    expect(stayingGuestName(expanded, contact, 'single-stored-room')).toBe('');

    const replacement = { ...session, groups: [{ ...row, id: 'r_new' }] } as unknown as QuoteSession;
    expect(stayingGuestName(replacement, contact, 'single-stored-room')).toBe('');
    const moreRooms = { ...session, groups: [{ ...row, quantity: 2 }] } as unknown as QuoteSession;
    expect(stayingGuestName(moreRooms, contact, 'single-stored-room')).toBe('');
  });

  it('does not infer the contact or a single guest for an ambiguous stored roster', () => {
    const guests = [
      { name: 'Ada Example', confirmationNumber: null },
      { name: 'Bea Example', confirmationNumber: null },
    ];
    const row = { id: 'r_1', stayId: 's_1', quantity: 1, stayGuests: guests };
    const session = {
      staffSource: null, groups: [row],
      analysis: { groups: [row], luna: { party: { kind: 'private' }, groups: [{ guestNames: [] }] } },
    } as unknown as QuoteSession;
    expect(stayingGuestName(session, contact, 'ambiguous-stored-room')).toBe('');

    const oneNameTwoRooms = { ...row, quantity: 2, stayGuests: guests.slice(0, 1) };
    const multi = {
      ...session, groups: [oneNameTwoRooms],
      analysis: { ...session.analysis, groups: [oneNameTwoRooms] },
    } as unknown as QuoteSession;
    expect(stayingGuestName(multi, contact, 'ambiguous-stored-room')).toBe('');
  });

  it('keeps guest edits for the same message without leaking them to another message', () => {
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
        groups: [],
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
      contactEditorKey: 'agent-message-cache-test',
      scrollToStep: vi.fn(),
    } as unknown as Parameters<typeof QuotePeopleStep>[0];

    const firstRender = render(<QuotePeopleStep {...props} />);
    fireEvent.change(screen.getByLabelText('Guest'), { target: { value: 'Staff-entered value' } });
    firstRender.unmount();

    const otherMessage = render(
      <QuotePeopleStep {...props} contactEditorKey="different-agent-message" />,
    );
    const otherGuest = screen.getByLabelText('Guest') as HTMLInputElement;
    expect(otherGuest.value).toBe('');
    expect(otherGuest.getAttribute('placeholder')).toBe('Guest name?');
    otherMessage.unmount();

    resetGuestNameCacheForTests({ keepSession: true });
    render(<QuotePeopleStep {...props} />);
    const sameMessageGuest = screen.getByLabelText('Guest') as HTMLInputElement;
    expect(sameMessageGuest.value).toBe('Staff-entered value');
  });

  it('keeps a guest edit when the contact editor key changes for the same message', () => {
    const agentContact: StoredContact = {
      name: 'Agent sender',
      company: null,
      endClient: null,
      email: null,
      phone: null,
    };
    const props = {
      session: {
        binding: {
          transportId: 'mailbox-1',
          mailboxEmail: 'mailbox@example.invalid',
          storeId: 'store-1',
          folderEntryId: 'folder-entry-1',
          entryId: 'entry-1',
          internetMessageId: 'message-1',
          selectionEpoch: 1,
          scopeEpoch: 1,
        },
        staffSource: null,
        groups: [],
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
      contactEditorKey: 'mailbox-1::message-1|reading',
      scrollToStep: vi.fn(),
    } as unknown as Parameters<typeof QuotePeopleStep>[0];

    const readingRender = render(<QuotePeopleStep {...props} />);
    fireEvent.change(screen.getByLabelText('Guest'), { target: { value: 'Staff-entered value' } });
    readingRender.unmount();

    render(<QuotePeopleStep {...props} contactEditorKey="mailbox-1::message-1|ready:work-item-1" />);

    expect((screen.getByLabelText('Guest') as HTMLInputElement).value).toBe('Staff-entered value');
  });
});
