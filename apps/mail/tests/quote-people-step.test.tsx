/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guestEditorKeyFor, QuotePeopleStep, stayingGuestName } from '../components/quote-workflow/quote-people-step';
import type { ContactField, StoredContact } from '../lib/quote-workflow/backend-bind';
import { forgetGuestName, guestNameRevision, recalledGuestName, rememberGuestName, resetGuestNameCacheForTests } from '../lib/quote-workflow/guest-name-cache';
import type { PartyFindReply } from '../lib/quote-workflow/party-lookup';
import { emptyStaffQuoteHeader, HRCEN_PROPERTY_CODE, HRDAV_PROPERTY_CODE } from '../lib/quote-workflow/types';
import type { QuoteSession, StaffQuoteParty } from '../lib/quote-workflow/types';

beforeEach(() => resetGuestNameCacheForTests());
afterEach(() => {
  cleanup();
  resetGuestNameCacheForTests();
  sessionStorage.removeItem('nava.guest-name.v1:mailbox-1::message-1');
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
      guestEditorKey: 'request-1',
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
      guestEditorKey: 'agent-message',
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

  it.each([null, HRCEN_PROPERTY_CODE])('does not treat a private contact as the staying guest for property %s', (propertyCode) => {
    const row = { id: 'r_1', stayId: 's_1', quantity: 1 };
    const session = { staffSource: null, groups: [row], quotePropertyCode: HRDAV_PROPERTY_CODE,
      analysis: { groups: [row], luna: { party: { kind: 'private' }, groups: [] } } } as unknown as QuoteSession;
    const props = { session, partyState: 'Optional' as const, header: emptyStaffQuoteHeader(),
      contact, propertyCode, contactEditorKey: 'private-contact-only', guestEditorKey: 'private-contact-only', scrollToStep: vi.fn() };

    render(<QuotePeopleStep {...props} />);
    const guest = screen.getByLabelText('Guest') as HTMLInputElement;
    expect(guest.value).toBe('');
    expect(guest.getAttribute('placeholder')).toBe('Guest name?');
    expect(stayingGuestName(session, contact, 'private-contact-only', propertyCode)).toBe('');
  });

  it('keeps the existing private-contact prefill for HRDAV', () => {
    const row = { id: 'r_1', stayId: 's_1', quantity: 1 };
    const session = { staffSource: null, groups: [row],
      analysis: { groups: [row], luna: { party: { kind: 'private' }, groups: [] } } } as unknown as QuoteSession;
    render(<QuotePeopleStep session={session} partyState="Optional" header={emptyStaffQuoteHeader()}
      contact={contact} propertyCode={HRDAV_PROPERTY_CODE} guestEditorKey="hrdav-contact" scrollToStep={vi.fn()} />);
    expect((screen.getByLabelText('Guest') as HTMLInputElement).value).toBe('Request contact');
    expect(stayingGuestName(session, contact, 'hrdav-contact', HRDAV_PROPERTY_CODE)).toBe('Request contact');
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
      contact, contactEditorKey: 'single-stored-room', guestEditorKey: 'single-stored-room', scrollToStep: vi.fn(),
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
      guestEditorKey: 'agent-message-cache-test',
      scrollToStep: vi.fn(),
    } as unknown as Parameters<typeof QuotePeopleStep>[0];

    const firstRender = render(<QuotePeopleStep {...props} />);
    fireEvent.change(screen.getByLabelText('Guest'), { target: { value: 'Staff-entered value' } });
    firstRender.unmount();

    const otherMessage = render(
      <QuotePeopleStep {...props} contactEditorKey="different-agent-message" guestEditorKey="different-agent-message" />,
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
      guestEditorKey: 'user-1:mailbox-1:message-1',
      scrollToStep: vi.fn(),
    } as unknown as Parameters<typeof QuotePeopleStep>[0];

    const readingRender = render(<QuotePeopleStep {...props} />);
    fireEvent.change(screen.getByLabelText('Guest'), { target: { value: 'Staff-entered value' } });
    readingRender.unmount();

    render(<QuotePeopleStep {...props} contactEditorKey="mailbox-1::message-1|ready:work-item-1" />);

    expect((screen.getByLabelText('Guest') as HTMLInputElement).value).toBe('Staff-entered value');
  });

  it('isolates users and messages, refuses unscoped legacy values, and keeps each user’s edits after remount', () => {
    const binding = { transportId: 'mailbox-1', mailboxEmail: 'mailbox@example.invalid', storeId: 'store-1',
      folderEntryId: 'folder-1', entryId: 'entry-1', internetMessageId: 'message-1', selectionEpoch: 1, scopeEpoch: 1 };
    const session = { binding, staffSource: null, groups: [], analysis: { groups: [], luna: { groups: [] } } } as unknown as QuoteSession;
    const first = guestEditorKeyFor(session, 'user-1')!;
    const second = guestEditorKeyFor(session, 'user-2')!;
    const other = guestEditorKeyFor({ ...session, binding: { ...binding, entryId: 'entry-2' } }, 'user-1')!;
    expect(first).not.toBe(second);
    expect(first).not.toBe(other); // Two selected messages can share the same Internet Message-ID.
    expect(guestEditorKeyFor(session, null)).toBeNull();
    expect(guestEditorKeyFor({ ...session, binding: { ...binding, storeId: '' } }, 'user-1')).toBeNull();
    const withoutStore = { ...session, binding: { ...binding, storeId: '' } };
    expect(guestEditorKeyFor(withoutStore, 'user-1', HRCEN_PROPERTY_CODE)).toBeNull();
    expect(guestEditorKeyFor(withoutStore, 'user-1', null)).toBeNull();
    expect(guestEditorKeyFor({ ...withoutStore, quotePropertyCode: HRDAV_PROPERTY_CODE }, 'user-1', null)).toBeNull();
    const hrdavKey = guestEditorKeyFor(withoutStore, 'user-1', HRDAV_PROPERTY_CODE);
    expect(hrdavKey).toBeTruthy();
    expect(hrdavKey).not.toBe(guestEditorKeyFor(withoutStore, 'user-2', HRDAV_PROPERTY_CODE));
    expect(hrdavKey).not.toBe(guestEditorKeyFor({ ...withoutStore, binding: { ...withoutStore.binding, entryId: 'entry-2' } },
      'user-1', HRDAV_PROPERTY_CODE));
    sessionStorage.setItem('nava.guest-name.v1:mailbox-1::message-1', 'Legacy Guest');

    const props = { session, partyState: 'Optional' as const, header: emptyStaffQuoteHeader(), scrollToStep: vi.fn() };
    const view = render(<QuotePeopleStep {...props} guestEditorKey={first} />);
    const guest = () => screen.getByLabelText('Guest') as HTMLInputElement;
    expect(guest().value).toBe('');
    fireEvent.change(guest(), { target: { value: 'First User Guest' } });
    view.rerender(<QuotePeopleStep {...props} guestEditorKey={null} />);
    expect(guest().disabled).toBe(true);
    expect(guest().value).toBe('');
    view.rerender(<QuotePeopleStep {...props} guestEditorKey={second} />);
    expect(guest().value).toBe('');
    fireEvent.change(guest(), { target: { value: 'Second User Guest' } });
    view.rerender(<QuotePeopleStep {...props} guestEditorKey={other} />);
    expect(guest().value).toBe('');
    view.unmount();
    resetGuestNameCacheForTests({ keepSession: true });
    const again = render(<QuotePeopleStep {...props} guestEditorKey={first} />);
    expect(guest().value).toBe('First User Guest');
    again.rerender(<QuotePeopleStep {...props} guestEditorKey={second} />);
    expect(guest().value).toBe('Second User Guest');
  });
});
