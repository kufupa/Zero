import {
  createReservationDetailFacade,
  extractBoundOsresvLstRow,
  parseReservationDetailBody,
} from '../../../../../apps/server-pilot/src/hms/reservation-detail-facade.js';
import type { HmsPage, HmsReadSession } from '../../../../../apps/server-pilot/src/hms/runtime.js';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';

const NAMESPACE_COLLISION_BODY = JSON.stringify({
  pageData: {
    values: {
      confirmationnumber: 'CONF-42',
      balance: '0',
      balancecurr: 'USD',
      reservationnote: null,
      guestnotes: '',
    },
    attributes: {
      confirmationnumber: 'protected',
      balance: 'protected',
      balancecurr: 'protected',
      reservationnote: 'protected',
      guestnotes: 'hidden',
    },
  },
  layout: {
    balance: { attribute: 'hidden' },
    labels: { balance: { label: 'Balance' } },
  },
});

const MISMATCHED_DETAIL_BODY = JSON.stringify({
  pageData: {
    values: {
      confirmationnumber: 'OTHER-42',
      reservationstayid: 'STAY-9',
      arrivaldate: '01-SEP-2026',
      departuredate: '03-SEP-2026',
      guestname: 'Other guest',
      balance: '0',
    },
  },
});

const MATCHED_DETAIL_BODY = JSON.stringify({
  pageData: {
    values: {
      confirmationnumber: 'CONF-42',
      reservationstayid: 'STAY-9',
      arrivaldate: '01-SEP-2026',
      departuredate: '03-SEP-2026',
      guestname: 'Matched guest',
      balance: '0',
    },
  },
});

const LST_DETAIL_BODY = JSON.stringify({
  isListView: true,
  pageData: {
    fromCome: true,
    grid: {
      GRIDRESULT: {
        type: 'LIST.DATA_ONLY.STORED',
        GRID: {
          METADATA: { GRIDNAME: 'OSRESV' },
          DATA: [
            {
              id: 'OPAQUE-7',
              reservationstayid: 'ACTUAL-77',
              confirmationnumber: 'CONF-42',
              propertycode: 'HRCEN',
              guestfullname: 'Matched guest',
              account: 'ACCT-7',
              guestid: 'GUEST-7',
              hoteldate: '17-SEP-2026',
              lastname: 'Matched',
              firstname: 'Guest',
              twitterid: '*',
              facebookid: '',
              tripadvisorid: '*',
              bookingdotcomid: '*',
              room: '101',
            },
          ],
        },
      },
    },
  },
});

describe('reservation detail body parser', () => {
  it('reads native pageData.values without letting metadata overwrite it', () => {
    const body = NAMESPACE_COLLISION_BODY.replace('"values":', 'values:').replace(
      '"attributes":',
      'attributes:',
    );
    const dump = parseReservationDetailBody(body);

    expect(dump.keys).toEqual([
      'balance',
      'balancecurr',
      'confirmationnumber',
      'guestnotes',
      'reservationnote',
    ]);
    expect(dump.values).toEqual({
      balance: '0',
      balancecurr: 'USD',
      confirmationnumber: 'CONF-42',
    });
    expect(dump.values).not.toHaveProperty('attributes');
    expect(Object.values(dump.values)).not.toContain('protected');
  });

  it('fails closed when a native values object is malformed', () => {
    const body =
      '{"pageData": { values: { "balance": "0", }, attributes: {"balance":"protected"} }, ' +
      '"labels": {"balance":"protected"}}';

    const dump = parseReservationDetailBody(body);

    expect(dump.keys).toEqual([]);
    expect(dump.values).toEqual({});
  });

  it('does not treat a following attributes object as values when values is null', () => {
    const body = '{"pageData": { values: null, attributes: {"balance":"protected"} }}';

    const dump = parseReservationDetailBody(body);

    expect(dump.keys).toEqual([]);
    expect(dump.values).toEqual({});
  });

  it('binds LST rows by exact opaque id and approved property', () => {
    expect(extractBoundOsresvLstRow(LST_DETAIL_BODY, 'CONF-42', 'OPAQUE-7')).toMatchObject({
      opaqueRowId: 'OPAQUE-7',
      reservationStayId: 'ACTUAL-77',
    });
    expect(extractBoundOsresvLstRow(LST_DETAIL_BODY, 'CONF-42', 'opaque-7')).toBeNull();
    expect(
      extractBoundOsresvLstRow(LST_DETAIL_BODY.replace('HRCEN', 'OTHER'), 'CONF-42', 'OPAQUE-7'),
    ).toBeNull();
    expect(
      extractBoundOsresvLstRow(
        LST_DETAIL_BODY.replace('17-SEP-2026', '31-FEB-2026'),
        'CONF-42',
        'OPAQUE-7',
      ),
    ).toBeNull();
    expect(
      extractBoundOsresvLstRow(LST_DETAIL_BODY.replace('17-SEP-2026', ''), 'CONF-42', 'OPAQUE-7')
        ?.hdrFields.hoteldate,
    ).toBe('');
    const withoutHotelDate = JSON.parse(LST_DETAIL_BODY) as {
      pageData: { grid: { GRIDRESULT: { GRID: { DATA: Array<Record<string, unknown>> } } } };
    };
    delete withoutHotelDate.pageData.grid.GRIDRESULT.GRID.DATA[0]!.hoteldate;
    expect(
      extractBoundOsresvLstRow(JSON.stringify(withoutHotelDate), 'CONF-42', 'OPAQUE-7')?.hdrFields,
    ).not.toHaveProperty('hoteldate');
  });

  it('preserves an explicitly unassigned room as the observed empty HDR wire field', () => {
    const source = JSON.parse(LST_DETAIL_BODY);
    const row = source.pageData.grid.GRIDRESULT.GRID.DATA[0];
    row.room = null;
    row.account = 'ACCT-7';
    expect(extractBoundOsresvLstRow(JSON.stringify(source), 'CONF-42', 'OPAQUE-7')?.hdrFields.room).toBe('');
    delete row.room;
    expect(extractBoundOsresvLstRow(JSON.stringify(source), 'CONF-42', 'OPAQUE-7')?.hdrFields).not.toHaveProperty('room');
    row.room = { unexpected: true };
    expect(extractBoundOsresvLstRow(JSON.stringify(source), 'CONF-42', 'OPAQUE-7')?.hdrFields).not.toHaveProperty('room');
    row.room = null;
    row.reservationstayid = null;
    expect(extractBoundOsresvLstRow(JSON.stringify(source), 'CONF-42', 'OPAQUE-7')).toBeNull();
  });

  it('retains explicit empty room routing data without defaulting null identities or money', () => {
    for (const room of [null, '']) {
      const dump = parseReservationDetailBody(JSON.stringify({ pageData: { values: {
        room, confirmationnumber: 'CONF-42', account: null, depositreceived: null,
      } } }));
      expect(dump.values).toEqual({ room: '', confirmationnumber: 'CONF-42' });
    }
    expect(parseReservationDetailBody(JSON.stringify({ pageData: { values: { account: 'ACCT' } } })).values).not.toHaveProperty('room');
  });
});

describe('reservation detail facade', () => {
  it('rejects a detail whose identity differs from the requested token', async () => {
    vi.useFakeTimers();
    try {
      let domReads = 0;
      const page = {
        async postForm() {
          return MISMATCHED_DETAIL_BODY;
        },
        async evaluateStableDom() {
          domReads += 1;
          if (domReads === 1) {
            return {
              keys: ['confirmationnumber', 'arrivaldate', 'departuredate', 'guestname'],
              values: {
                confirmationnumber: 'OTHER-42',
                arrivaldate: '01-SEP-2026',
                departuredate: '03-SEP-2026',
                guestname: 'Other guest',
              },
              searchChrome: false,
              filledNonSearch: 4,
            };
          }
          return false;
        },
      } as unknown as HmsPage;

      const facade = createReservationDetailFacade({
        session: { origin: ORIGIN, page } as unknown as HmsReadSession,
      });
      const result = facade.openMatchedRowAndDump({
        captureValues: true,
        matchToken: 'CONF-42',
        reservationStayId: 'STAY-9',
      });

      const rejection = expect(result).rejects.toThrow(
        /row binding|detail identity mismatch|no grid row/i,
      );
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts body-only detail only when both requested identities echo', async () => {
    vi.useFakeTimers();
    try {
      const page = {
        async postForm(url: string) {
          if (url.endsWith('/OSRESV.LST')) return LST_DETAIL_BODY;
          if (url.endsWith('/OSRESV.HDR')) {
            return MATCHED_DETAIL_BODY.replace('STAY-9', 'ACTUAL-77');
          }
          return '';
        },
        async evaluateStableDom() {
          return false;
        },
      } as unknown as HmsPage;

      const facade = createReservationDetailFacade({
        session: { origin: ORIGIN, page } as unknown as HmsReadSession,
      });
      const result = facade.openMatchedRowAndDump({
        captureValues: true,
        matchToken: 'CONF-42',
        reservationStayId: 'OPAQUE-7',
      });

      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({
        values: {
          confirmationnumber: 'CONF-42',
          reservationstayid: 'ACTUAL-77',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['101', null])('hydrates the bound HDR from the matched LST row with room %s, not the opaque OSRESS id', async (room) => {
    vi.useFakeTimers();
    try {
      const posted: Array<{ url: string; fields: Record<string, string> }> = [];
      const page = {
        async postForm(url: string, fields: Record<string, string>) {
          posted.push({ url, fields });
          if (url.endsWith('/OSRESV.LST')) {
            const source = JSON.parse(LST_DETAIL_BODY);
            source.pageData.grid.GRIDRESULT.GRID.DATA[0].room = room;
            return JSON.stringify(source);
          }
          if (url.endsWith('/OSRESV.HDR'))
            return MATCHED_DETAIL_BODY.replace('STAY-9', 'ACTUAL-77');
          return '';
        },
        async evaluateStableDom() {
          return false;
        },
      } as unknown as HmsPage;

      const facade = createReservationDetailFacade({
        session: { origin: ORIGIN, page } as unknown as HmsReadSession,
      });
      const result = facade.openMatchedRowAndDump({
        captureValues: true,
        matchToken: 'CONF-42',
        reservationStayId: 'OPAQUE-7',
      });

      const resolved = expect(result).resolves.toMatchObject({
        values: { confirmationnumber: 'CONF-42', reservationstayid: 'ACTUAL-77' },
      });
      await vi.runAllTimersAsync();
      await resolved;

      expect(posted.map(({ url }) => url)).toEqual([
        `${ORIGIN}/web/base/OSRESV?USER_FUNCTION_NAME=OSRESV`,
        `${ORIGIN}/web/base/OSRESV.LST`,
        `${ORIGIN}/web/base/OSRESV.HDR`,
      ]);
      expect(posted[0]?.fields).toMatchObject({
        CURRENT_TAB_NAME: 'HDR',
        DEFAULT_VIEW: 'HDR',
        SAVE_FOR_HEADER: 'true',
        startUpView: 'right',
        GRIDPARAM_ADDON_SORT_ELEMENT_ALIAS_NAME: 'primaryguest',
        GRIDPARAM_ADDON_SORT_ELEMENT_TYPE: 'DESC',
        confirmationnumber: 'CONF-42',
      });
      expect(Object.keys(posted[0]?.fields || {}).sort()).toEqual(
        [
          'SYSTEM_FUNCTION_NAME',
          'USER_FUNCTION_NAME',
          'CURRENT_TAB_NAME',
          'MENU_MODULE_KEY',
          'removescreenflows',
          'DEFAULT_VIEW',
          'SAVE_FOR_HEADER',
          'startUpView',
          'GRIDPARAM_ADDON_SORT_ELEMENT_ALIAS_NAME',
          'GRIDPARAM_ADDON_SORT_ELEMENT_TYPE',
          'confirmationnumber',
        ].sort(),
      );
      expect(posted[1]?.fields).toMatchObject({
        CURRENT_TAB_NAME: 'LST',
        ADDONS_REQUIRED: 'true',
        RUN_DS: 'false',
        filterfields: 'confirmationnumber',
        filteroperator: '=',
        filtervalue: 'CONF-42',
        ADDON_SORT_ELEMENT_ALIAS_NAME: 'primaryguest',
        ADDON_SORT_ELEMENT_TYPE: 'DESC',
      });
      expect(Object.keys(posted[1]?.fields || {}).sort()).toEqual(
        [
          'SYSTEM_FUNCTION_NAME',
          'USER_FUNCTION_NAME',
          'CURRENT_TAB_NAME',
          'MENU_MODULE_KEY',
          'removescreenflows',
          'ADDONS_REQUIRED',
          'RUN_DS',
          'filterfields',
          'filteroperator',
          'filtervalue',
          'ADDON_SORT_ELEMENT_ALIAS_NAME',
          'ADDON_SORT_ELEMENT_TYPE',
        ].sort(),
      );
      expect(posted[2]?.fields).toMatchObject({
        CURRENT_TAB_NAME: 'HDR',
        confirmationnumber: 'CONF-42',
        reservationstayid: 'ACTUAL-77',
        propertycode: 'HRCEN',
        account: 'ACCT-7',
        guestid: 'GUEST-7',
        hoteldate: '09/17/2026',
        facebookid: '',
        room: room ?? '',
      });
      expect(Object.keys(posted[2]?.fields || {}).sort()).toEqual(
        [
          'SYSTEM_FUNCTION_NAME',
          'USER_FUNCTION_NAME',
          'CURRENT_TAB_NAME',
          'confirmationnumber',
          'reservationstayid',
          'propertycode',
          'guestfullname',
          'account',
          'guestid',
          'hoteldate',
          'lastname',
          'firstname',
          'twitterid',
          'facebookid',
          'tripadvisorid',
          'bookingdotcomid',
          'room',
        ].sort(),
      );
      expect(posted[2]?.fields.facebookid).toBe('');
      expect(posted[2]?.fields).not.toHaveProperty('id');
      expect(posted[2]?.fields.reservationstayid).not.toBe('OPAQUE-7');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when OSRESV.LST cannot bind the opaque row id and confirmation', async () => {
    vi.useFakeTimers();
    try {
      const page = {
        async postForm(url: string) {
          if (url.endsWith('/OSRESV.LST')) {
            return LST_DETAIL_BODY.replace('OPAQUE-7', 'OTHER-ROW');
          }
          return '';
        },
        async evaluateStableDom() {
          return false;
        },
      } as unknown as HmsPage;
      const facade = createReservationDetailFacade({
        session: { origin: ORIGIN, page } as unknown as HmsReadSession,
      });
      const result = facade.openMatchedRowAndDump({
        matchToken: 'CONF-42',
        reservationStayId: 'OPAQUE-7',
      });
      const rejection = expect(result).rejects.toThrow(
        /row binding|identity mismatch|no grid row/i,
      );
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the bound HDR body before stale DOM and never clicks stale rate details', async () => {
    let domReads = 0;
    let clicks = 0;
    const page = {
      async postForm(url: string) {
        if (url.endsWith('/OSRESV.LST')) return LST_DETAIL_BODY;
        if (url.endsWith('/OSRESV.HDR')) return MATCHED_DETAIL_BODY.replace('STAY-9', 'ACTUAL-77');
        return '';
      },
      async evaluateStableDom() {
        domReads += 1;
        return {
          keys: ['confirmationnumber', 'reservationstayid'],
          values: { confirmationnumber: 'CONF-42', reservationstayid: 'OTHER-ROW' },
          searchChrome: false,
          filledNonSearch: 3,
        };
      },
      async click() {
        clicks += 1;
      },
    } as unknown as HmsPage;

    const facade = createReservationDetailFacade({
      session: { origin: ORIGIN, page } as unknown as HmsReadSession,
    });
    const result = await facade.openMatchedRowAndDump({
      captureValues: true,
      matchToken: 'CONF-42',
      reservationStayId: 'OPAQUE-7',
    });

    expect(result.values).toMatchObject({
      confirmationnumber: 'CONF-42',
      reservationstayid: 'ACTUAL-77',
      rateDetailsClicked: 'false',
    });
    expect(domReads).toBe(0);
    expect(clicks).toBe(0);
  });

  it('replays the reviewed OSRESV row-open POST when the XHR grid is not painted', async () => {
    const posted: Array<{ url: string; fields: Record<string, string> }> = [];
    let rendered = false;
    let domReads = 0;
    const page = {
      async dblclickRowContaining() {
        throw new Error('XHR grid is not painted');
      },
      async dblclick() {
        throw new Error('XHR grid is not painted');
      },
      async click() {
        throw new Error('XHR grid is not painted');
      },
      async postForm(url: string, fields: Record<string, string>) {
        posted.push({ url, fields });
        rendered = true;
        if (url.endsWith('/OSRESV.LST')) return LST_DETAIL_BODY;
        if (url.endsWith('/OSRESV.HDR')) return MATCHED_DETAIL_BODY.replace('STAY-9', 'ACTUAL-77');
        return '';
      },
      async evaluateStableDom() {
        domReads += 1;
        if (!rendered) {
          return { keys: [], values: {}, searchChrome: false, filledNonSearch: 0 };
        }
        // First read is the detail form; the next read is the optional rate
        // details click probe and deliberately reports no matching control.
        if (domReads === 1) {
          return {
            keys: ['confirmationnumber', 'arrivaldate', 'departuredate'],
            values: {
              confirmationnumber: 'CONF-42',
              arrivaldate: '01-SEP-2026',
              departuredate: '03-SEP-2026',
            },
            searchChrome: false,
            filledNonSearch: 3,
          };
        }
        return false;
      },
    } as unknown as HmsPage;

    const facade = createReservationDetailFacade({
      session: { origin: ORIGIN, page } as unknown as HmsReadSession,
    });
    const dump = await facade.openMatchedRowAndDump({
      captureValues: true,
      matchToken: 'CONF-42',
    });

    expect(posted).toHaveLength(3);
    expect(posted[0]).toMatchObject({
      url: `${ORIGIN}/web/base/OSRESV?USER_FUNCTION_NAME=OSRESV`,
      fields: {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'HDR',
        DEFAULT_VIEW: 'HDR',
        SAVE_FOR_HEADER: 'true',
        startUpView: 'right',
        GRIDPARAM_ADDON_SORT_ELEMENT_ALIAS_NAME: 'primaryguest',
        GRIDPARAM_ADDON_SORT_ELEMENT_TYPE: 'DESC',
        confirmationnumber: 'CONF-42',
      },
    });
    expect(dump).toMatchObject({
      surface: 'guest_stay_detail',
      keys: expect.arrayContaining(['confirmationnumber', 'arrivaldate', 'departuredate']),
      values: {
        confirmationnumber: 'CONF-42',
        rateDetailsClicked: 'false',
      },
    });
  });

  it('uses the verified row chain before touching the grid when an opaque id is returned', async () => {
    const posted: Array<{ url: string; fields: Record<string, string> }> = [];
    let rendered = false;
    let domReads = 0;
    let gridTouches = 0;
    const page = {
      async dblclickRowContaining() {
        gridTouches += 1;
        throw new Error('grid must not be touched when stay id is bound');
      },
      async dblclick() {
        gridTouches += 1;
        throw new Error('grid must not be touched when stay id is bound');
      },
      async click() {
        gridTouches += 1;
        throw new Error('grid must not be touched when stay id is bound');
      },
      async postForm(url: string, fields: Record<string, string>) {
        posted.push({ url, fields });
        rendered = true;
        if (url.endsWith('/OSRESV.LST')) return LST_DETAIL_BODY;
        if (url.endsWith('/OSRESV.HDR')) return MATCHED_DETAIL_BODY.replace('STAY-9', 'ACTUAL-77');
        return '';
      },
      async evaluateStableDom() {
        domReads += 1;
        if (rendered && domReads === 1) {
          return {
            keys: ['confirmationnumber', 'reservationstayid', 'arrivaldate', 'departuredate'],
            values: {
              confirmationnumber: 'CONF-42',
              reservationstayid: 'STAY-9',
              arrivaldate: '01-SEP-2026',
              departuredate: '03-SEP-2026',
            },
            searchChrome: false,
            filledNonSearch: 3,
          };
        }
        return false;
      },
    } as unknown as HmsPage;

    const facade = createReservationDetailFacade({
      session: { origin: ORIGIN, page } as unknown as HmsReadSession,
    });
    const dump = await facade.openMatchedRowAndDump({
      captureValues: true,
      matchToken: 'CONF-42',
      reservationStayId: 'OPAQUE-7',
    });

    expect(gridTouches).toBe(0);
    expect(posted).toHaveLength(3);
    expect(posted[0]).toMatchObject({
      url: `${ORIGIN}/web/base/OSRESV?USER_FUNCTION_NAME=OSRESV`,
      fields: {
        CURRENT_TAB_NAME: 'HDR',
        confirmationnumber: 'CONF-42',
        startUpView: 'right',
        GRIDPARAM_ADDON_SORT_ELEMENT_ALIAS_NAME: 'primaryguest',
        GRIDPARAM_ADDON_SORT_ELEMENT_TYPE: 'DESC',
      },
    });
    expect(posted[2]?.fields).toMatchObject({
      CURRENT_TAB_NAME: 'HDR',
      confirmationnumber: 'CONF-42',
      reservationstayid: 'ACTUAL-77',
      propertycode: 'HRCEN',
    });
    expect(posted[2]?.fields).not.toHaveProperty('id');
    expect(dump).toMatchObject({
      surface: 'guest_stay_detail',
      values: {
        confirmationnumber: 'CONF-42',
        reservationstayid: 'ACTUAL-77',
        rateDetailsClicked: 'false',
      },
    });
  });
});
