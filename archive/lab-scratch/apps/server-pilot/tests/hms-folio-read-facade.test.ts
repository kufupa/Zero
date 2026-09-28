import {
  buildBoundFolioReadFields,
  createFolioReadFacade,
  type ValidatedFolioDetailValues,
} from '../../../../../apps/server-pilot/src/hms/folio-read-facade.js';
import {
  FOLIO_READ_MAX_BYTES,
  FOLIO_READ_MAX_DURATION_MS,
} from '../../../../../apps/server-pilot/src/hms/folio-read-contract.js';
import type { HmsPage, HmsReadSession } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';

const DETAIL_VALUES: ValidatedFolioDetailValues = {
  confirmationnumber: 'CONF-42',
  reservationstayid: 'ACTUAL-77',
  propertycode: 'HRCEN',
  guestfullname: 'Synthetic Guest',
  account: 'ACCT-7',
  guestid: 'GUEST-7',
  hoteldate: '09/17/2026',
  lastname: 'Guest',
  firstname: 'Synthetic',
  twitterid: '',
  facebookid: '',
  tripadvisorid: '',
  bookingdotcomid: '',
  room: '101',
  unreviewedfield: 'must-not-escape',
};

const EXPECTED_FIELDS = {
  SYSTEM_FUNCTION_NAME: 'OSRESV',
  USER_FUNCTION_NAME: 'OSRESV',
  CURRENT_TAB_NAME: 'FOL',
  confirmationnumber: 'CONF-42',
  reservationstayid: 'ACTUAL-77',
  propertycode: 'HRCEN',
  guestfullname: 'Synthetic Guest',
  account: 'ACCT-7',
  guestid: 'GUEST-7',
  hoteldate: '09/17/2026',
  lastname: 'Guest',
  firstname: 'Synthetic',
  twitterid: '',
  facebookid: '',
  tripadvisorid: '',
  bookingdotcomid: '',
  room: '101',
};

describe('bound OSRESV.FOL request facade', () => {
  it('emits only the reviewed constants and 14 validated detail fields', () => {
    const fields = buildBoundFolioReadFields({
      confirmationNumber: 'CONF-42',
      reservationStayId: 'ACTUAL-77',
      expectedPropertyCode: 'HRCEN',
      detailValues: DETAIL_VALUES,
    });

    expect(fields).toEqual(EXPECTED_FIELDS);
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('MENU_MODULE_KEY');
    expect(fields).not.toHaveProperty('removescreenflows');
    expect(fields).not.toHaveProperty('unreviewedfield');
  });

  it.each([
    ['wrong confirmation', { confirmationNumber: 'OTHER-42' }, /confirmation mismatch/i],
    ['wrong actual stay', { reservationStayId: 'OTHER-77' }, /reservationstayid mismatch/i],
    ['wrong property', { expectedPropertyCode: 'OTHER' }, /property mismatch/i],
  ])('rejects %s parent binding', (_label, override, expected) => {
    expect(() =>
      buildBoundFolioReadFields({
        confirmationNumber: 'CONF-42',
        reservationStayId: 'ACTUAL-77',
        expectedPropertyCode: 'HRCEN',
        detailValues: DETAIL_VALUES,
        ...override,
      }),
    ).toThrow(expected);
  });

  it('rejects missing reviewed detail fields instead of filling them', () => {
    const missing = { ...DETAIL_VALUES };
    delete missing.account;

    expect(() =>
      buildBoundFolioReadFields({
        confirmationNumber: 'CONF-42',
        reservationStayId: 'ACTUAL-77',
        expectedPropertyCode: 'HRCEN',
        detailValues: missing,
      }),
    ).toThrow(/detail field missing: account/i);
  });

  it('canonicalizes the observed D[D]-MON-YYYY hotel date', () => {
    const fields = buildBoundFolioReadFields({
      confirmationNumber: 'CONF-42',
      reservationStayId: 'ACTUAL-77',
      expectedPropertyCode: 'HRCEN',
      detailValues: { ...DETAIL_VALUES, hoteldate: '17-SEP-2026' },
    });

    expect(fields.hoteldate).toBe('09/17/2026');
  });

  it.each(['31-APR-2026', '29-FEB-2026', '02/30/2026', '13/01/2026'])(
    'rejects invalid calendar hotel date %s',
    (hoteldate) => {
      expect(() =>
        buildBoundFolioReadFields({
          confirmationNumber: 'CONF-42',
          reservationStayId: 'ACTUAL-77',
          expectedPropertyCode: 'HRCEN',
          detailValues: { ...DETAIL_VALUES, hoteldate },
        }),
      ).toThrow(/hoteldate/i);
    },
  );

  it('posts the exact bound body through the new method', async () => {
    const postForm = vi.fn(async () => 'FOL-BODY');
    const page = { postForm } as unknown as HmsPage;
    const facade = createFolioReadFacade({
      origin: ORIGIN,
      page,
    } as unknown as HmsReadSession);

    await expect(
      facade.openBoundOsresvFol({
        confirmationNumber: 'CONF-42',
        reservationStayId: 'ACTUAL-77',
        detailValues: DETAIL_VALUES,
      }),
    ).resolves.toBe('FOL-BODY');
    expect(postForm).toHaveBeenCalledWith(`${ORIGIN}/web/base/OSRESV.FOL`, EXPECTED_FIELDS, {
      maxBytes: FOLIO_READ_MAX_BYTES,
      timeoutMs: FOLIO_READ_MAX_DURATION_MS,
    });
  });

  it('posts the exact reviewed All Folios DATA_ONLY body', async () => {
    const postForm = vi.fn(async () => 'ALL-DATA-BODY');
    const page = { postForm } as unknown as HmsPage;
    const facade = createFolioReadFacade({
      origin: ORIGIN,
      page,
    } as unknown as HmsReadSession);

    await expect(
      facade.openBoundFolioAllData({
        confirmationNumber: 'CONF-42',
        reservationStayId: 'ACTUAL-77',
        detailValues: DETAIL_VALUES,
      }),
    ).resolves.toBe('ALL-DATA-BODY');
    expect(postForm).toHaveBeenCalledWith(
      `${ORIGIN}/web/base/OSRESV.FOL.xmlhttp`,
      {
        ...EXPECTED_FIELDS,
        GRID_ID: '780',
        GRID_NAME: 'OSFOLO',
        DATASPY_ID: '836',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
      },
      {
        maxBytes: FOLIO_READ_MAX_BYTES,
        timeoutMs: FOLIO_READ_MAX_DURATION_MS,
      },
    );
  });

  it('posts only the eleven reviewed fields for an allowed cache cursor', async () => {
    const postForm = vi.fn(async () => 'CACHE-BODY');
    const page = { postForm } as unknown as HmsPage;
    const facade = createFolioReadFacade({
      origin: ORIGIN,
      page,
    } as unknown as HmsReadSession);

    await facade.openBoundFolioAllData({
      confirmationNumber: 'CONF-42',
      reservationStayId: 'ACTUAL-77',
      detailValues: DETAIL_VALUES,
    });
    await expect(facade.readBoundFolioCache(51)).resolves.toBe('CACHE-BODY');
    expect(postForm).toHaveBeenCalledWith(
      `${ORIGIN}/web/base/GETCACHE`,
      {
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        COMPONENT_INFO_TYPE_MODE: 'CACHE',
        GRID_ID: '780',
        GRID_NAME: 'OSFOLO',
        DATASPY_ID: '836',
        NUMBER_OF_ROWS_FIRST_RETURNED: '50',
        CACHE_REQUEST: 'false',
        CURSOR_POSITION: '51',
        CURRENT_TAB_NAME: 'FOL',
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
      },
      {
        maxBytes: FOLIO_READ_MAX_BYTES,
        timeoutMs: FOLIO_READ_MAX_DURATION_MS,
      },
    );
  });

  it('does not permit a cache request before the initial All Folios read', async () => {
    const postForm = vi.fn(async () => 'CACHE-BODY');
    const facade = createFolioReadFacade({
      origin: ORIGIN,
      page: { postForm } as unknown as HmsPage,
    } as unknown as HmsReadSession);

    await expect(facade.readBoundFolioCache(51)).rejects.toThrow(/initial DATA_ONLY/i);
    expect(postForm).not.toHaveBeenCalled();
  });

  it.each([0, 50, 52, 201])('rejects an unreviewed cache cursor %s', async (cursor) => {
    const postForm = vi.fn(async () => 'CACHE-BODY');
    const facade = createFolioReadFacade({
      origin: ORIGIN,
      page: { postForm } as unknown as HmsPage,
    } as unknown as HmsReadSession);

    await facade.openBoundFolioAllData({
      confirmationNumber: 'CONF-42',
      reservationStayId: 'ACTUAL-77',
      detailValues: DETAIL_VALUES,
    });
    await expect(facade.readBoundFolioCache(cursor)).rejects.toThrow(/cache cursor/i);
    expect(postForm).toHaveBeenCalledTimes(1);
  });
});
