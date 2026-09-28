import { describe, expect, it, vi } from 'vitest';
import {
  NOTES_INQUIRY_READ_PATH,
  createNotesInquiryReadFacade,
  parseNotesInquiryResponse,
  type NotesInquiryResponseFixture,
} from '../src/hms/notes-inquiry-read-facade.js';
import { createFetchBrowserFactory, HmsRuntimeError } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { readFile } from 'node:fs/promises';

const parent = {
  propertyCode: 'HRCEN' as const,
  confirmationNumber: 'CONF-123',
  reservationStayId: 'STAY-456',
};

const row = (overrides: Partial<NotesInquiryResponseFixture['reservationNotes'][number]> = {}) => ({
  id: 1,
  note: 'synthetic-public-note',
  categoryCode: 'GEN',
  categoryDescription: 'Synthetic category',
  sourceCode: 'RES',
  sourceDescription: 'Reservation',
  propertyCode: 'HRCEN',
  propertyDescription: 'Synthetic property',
  displayOnCheckin: false,
  printOnConfirmation: true,
  printOnRegistration: false,
  printOnHouseKeeping: false,
  displayOnCheckout: false,
  displayOnCreateUpdateReservation: false,
  displayOnReservationRetrieval: true,
  private: false,
  ...overrides,
});

function payload(
  reservationNotes: NotesInquiryResponseFixture['reservationNotes'] = [row()],
): NotesInquiryResponseFixture {
  return {
    noteCategories: [{ code: 'GEN', description: 'Synthetic category' }],
    reservationNotes,
    guestProfileNotes: [],
    bookingAgencyNotes: [],
    organizationNotes: [],
    groupBookingNotes: null,
    reservationNote: 'synthetic aggregate is intentionally not projected',
  };
}

describe('bounded notes inquiry parser', () => {
  it('projects only non-private printable reservation notes', () => {
    const result = parseNotesInquiryResponse(
      payload([
        row({ id: 1, note: 'synthetic-public-note' }),
        row({ id: 2, note: 'synthetic-private-note', private: true }),
        row({ id: 3, note: 'synthetic-not-printable', printOnConfirmation: false }),
      ]),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(1);
    expect(result.filteredCount).toBe(2);
    expect(result.reservationNote).toMatchObject({
      state: 'unavailable',
      reasonCode: 'NOT_APPLICABLE',
      text: null,
    });
    expect(result.reservationNote.sourceLength).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-note');
    expect(JSON.stringify(result)).not.toContain('synthetic-not-printable');
    expect(JSON.stringify(result)).not.toContain('synthetic aggregate');
  });

  it('staff keeps source rows and scalar while customer filter stays explicit', () => {
    const source = payload([
      row({ id: 11, note: 'synthetic-staff-visible', printOnConfirmation: false }),
      row({ id: 12, note: 'synthetic-private-staff-visible', private: true }),
    ]);
    source.reservationNote = 'synthetic-hdr-scalar';

    const staff = parseNotesInquiryResponse(source, { audience: 'staff' });
    const customer = parseNotesInquiryResponse(source, { audience: 'customer' });

    expect(staff.items.map((item) => item.id)).toEqual([11, 12]);
    expect(staff.filteredCount).toBe(0);
    expect(staff.reservationNote).toMatchObject({
      audience: 'staff',
      state: 'known',
      text: 'synthetic-hdr-scalar',
      customerPrintable: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
      status: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
      createdAt: { state: 'unknown', reasonCode: 'NOT_APPLICABLE' },
    });
    expect(customer.items).toEqual([]);
    expect(customer.filteredCount).toBe(2);
    expect(customer.reservationNote).toMatchObject({
      audience: 'customer',
      state: 'unavailable',
      text: null,
    });
    expect(JSON.stringify(customer)).not.toContain('synthetic-hdr-scalar');
  });

  it('rejects wrong property and unknown source fields', () => {
    expect(() => parseNotesInquiryResponse(payload([row({ propertyCode: 'OTHER' })]))).toThrowError(
      /PROPERTY_MISMATCH/,
    );
    expect(() =>
      parseNotesInquiryResponse(payload([row({ unexpected: 'drift' } as never)])),
    ).toThrowError(/INVALID_RESPONSE/);
  });

  it('rejects duplicate ids instead of silently merging rows', () => {
    expect(() =>
      parseNotesInquiryResponse(payload([row({ id: 7 }), row({ id: 7 })])),
    ).toThrowError(/DUPLICATE_NOTE_ID/);
  });

  it('does not let auxiliary collection ids block reservation-note parsing', () => {
    const source = payload([row({ id: 21 })]);
    source.guestProfileNotes = [row({ id: 21, note: 'synthetic-auxiliary' })];
    const result = parseNotesInquiryResponse(source, { audience: 'staff' });
    expect(result.items.map((item) => item.id)).toEqual([21]);
  });

  it('marks masked printable text partial without returning its value', () => {
    const result = parseNotesInquiryResponse(payload([row({ note: '[REDACTED]' })]));
    expect(result.items).toEqual([]);
    expect(result.completeness).toBe('partial');
    expect(result.issues.map((issue) => issue.code)).toContain('MASKED_NOTE');
    expect(JSON.stringify(result)).not.toContain('[REDACTED]');
  });

  it('marks empty printable text without treating source as absent', () => {
    const result = parseNotesInquiryResponse(payload([row({ note: '   ' })]));
    expect(result.items).toEqual([]);
    expect(result.sourceCount).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain('EMPTY_NOTE');
  });

  it('keeps an empty scalar explicitly absent while preserving masked semantics', () => {
    const empty = payload([]);
    empty.reservationNote = '   ';
    expect(parseNotesInquiryResponse(empty, { audience: 'staff' }).reservationNote).toMatchObject({
      state: 'unavailable',
      reasonCode: 'NOT_APPLICABLE',
      text: null,
    });

    const masked = payload([]);
    masked.reservationNote = 'protected';
    expect(parseNotesInquiryResponse(masked, { audience: 'staff' }).reservationNote).toMatchObject({
      state: 'unavailable',
      reasonCode: 'POLICY_UNAPPROVED',
      text: null,
    });
  });

  it('bounds customer paging and reports truncation without inventing a cursor', () => {
    const result = parseNotesInquiryResponse(
      payload([row({ id: 1 }), row({ id: 2, note: 'synthetic-public-note-2' })]),
      { limit: 1 },
    );
    expect(result.items).toHaveLength(1);
    expect(result.page).toEqual({ returnedCount: 1, hasMore: null, nextCursor: null });
    expect(result.issues.map((issue) => issue.code)).toContain('TRUNCATED');
  });

  it('hashes full validated source before audience/page projection or text truncation', () => {
    const source = payload([row({ id: 41, note: `${'x'.repeat(2_000)}A` })]);
    const staff = parseNotesInquiryResponse(source, { audience: 'staff', limit: 1 });
    const customer = parseNotesInquiryResponse(source, { audience: 'customer', limit: 1 });
    const changed = parseNotesInquiryResponse(
      payload([row({ id: 41, note: `${'x'.repeat(2_000)}B` })]),
      { audience: 'staff', limit: 1 },
    );

    expect(staff.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(staff.sourceHash).toBe(customer.sourceHash);
    expect(changed.sourceHash).not.toBe(staff.sourceHash);
  });

  it('marks long text as partial rather than silently complete', () => {
    const result = parseNotesInquiryResponse(payload([row({ note: 'x'.repeat(2_001) })]));
    expect(result.items[0]?.note).toHaveLength(2_000);
    expect(result.completeness).toBe('partial');
    expect(result.issues.map((issue) => issue.code)).toContain('TRUNCATED');
  });
});

describe('notes inquiry read facade', () => {
  it('posts exact bound confirmation and preserves HDR/LST parent proof', async () => {
    const postJson = vi.fn(async (url: string, body: Record<string, unknown>) => {
      expect(url).toBe(`https://hms.example${NOTES_INQUIRY_READ_PATH}`);
      expect(body).toEqual({ confirmationNumber: parent.confirmationNumber });
      return JSON.stringify(payload());
    });
    const session = {
      origin: 'https://hms.example',
      page: { postJson },
    } as never;

    const result = await createNotesInquiryReadFacade(session).read({ parentBinding: parent });
    expect(result.parentBinding).toEqual(parent);
    expect(result.items).toHaveLength(1);
  });

  it('passes explicit staff audience through facade', async () => {
    const source = payload([
      row({ id: 31, printOnConfirmation: false }),
      row({ id: 32, private: true }),
    ]);
    source.reservationNote = 'synthetic-staff-scalar';
    const postJson = vi.fn(async () => JSON.stringify(source));
    const session = { origin: 'https://hms.example', page: { postJson } } as never;

    const result = await createNotesInquiryReadFacade(session).read({
      parentBinding: parent,
      audience: 'staff',
    });
    expect(result.audience).toBe('staff');
    expect(result.items).toHaveLength(2);
    expect(result.reservationNote.state).toBe('known');
    expect(result.reservationNote.text).toBe('synthetic-staff-scalar');
  });

  it('rejects confirmation mismatch before page request', async () => {
    const postJson = vi.fn();
    const session = { origin: 'https://hms.example', page: { postJson } } as never;
    await expect(
      createNotesInquiryReadFacade(session).read({
        parentBinding: parent,
        confirmationNumber: 'OTHER-999',
      }),
    ).rejects.toMatchObject({ code: 'PARENT_MISMATCH' });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('fails closed when optional JSON adapter is unavailable', async () => {
    const session = { origin: 'https://hms.example', page: {} } as never;
    await expect(createNotesInquiryReadFacade(session).read({ parentBinding: parent })).rejects.toMatchObject(
      { code: 'SOURCE_UNAVAILABLE' },
    );
  });
});

describe('FetchPage optional JSON adapter', () => {
  it('sends one in-page JSON POST through route policy', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const browser = await createFetchBrowserFactory()({});
      const context = await browser.newContext({});
      const page = await context.newPage();
      const body = await page.postJson?.('https://hms.example/api/booking/HRCEN/notesInquiry', {
        confirmationNumber: 'CONF-123',
      });
      expect(body).toBe('{"ok":true}');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ confirmationNumber: 'CONF-123' }),
      });
      await context.close();
      await browser.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not fetch when route policy blocks JSON POST', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const browser = await createFetchBrowserFactory([
        async (route) => route.abort('blockedbyclient'),
      ])({});
      const context = await browser.newContext({});
      const page = await context.newPage();
      await expect(
        page.postJson?.('https://hms.example/api/booking/HRCEN/notesInquiry', {
          confirmationNumber: 'CONF-123',
        }),
      ).rejects.toMatchObject({ code: 'blockedbyclient' });
      expect(fetchMock).not.toHaveBeenCalled();
      await context.close();
      await browser.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects non-2xx JSON response before parser can claim success', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload()), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const browser = await createFetchBrowserFactory()({});
      const context = await browser.newContext({});
      const page = await context.newPage();
      await expect(
        page.postJson?.('https://hms.example/api/booking/HRCEN/notesInquiry', {
          confirmationNumber: 'CONF-123',
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await context.close();
      await browser.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps runtime error type available to facade callers', () => {
    expect(new HmsRuntimeError('SOURCE_UNAVAILABLE', 'bounded').code).toBe('SOURCE_UNAVAILABLE');
  });

  it('real adapter uses page.evaluate fetch without request fallback', async () => {
    const source = await readFile(new URL('../src/hms/runtime.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    async postJson(url, body) {');
    const end = source.indexOf('    async click(selector)', start);
    const adapter = source.slice(start, end);
    expect(adapter).toMatch(/page\.evaluate/);
    expect(adapter).toMatch(/credentials:\s*['"]same-origin['"]/);
    expect(adapter).toMatch(/status/);
    expect(adapter).toMatch(/responseType/);
    expect(adapter).toMatch(/opaqueredirect/);
    expect(adapter).not.toMatch(/page\.request/);
  });
});
