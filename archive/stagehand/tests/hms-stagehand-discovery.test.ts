import {
  stagehandDiscoveryCommandSchema,
  discoveryTabLabel,
  createStagehandControlToken,
  stagehandBearerTokenMatches,
  confirmStagehandParentFromSearch,
  bindStagehandFolioRule,
  stagehandParentRowMatchesExactIdentity,
} from '../src/hms/stagehand-discovery.js';
import {
  extractOsressDetailOpenHints,
  parseAndCorrelateGuestStayHtml,
} from '../src/hms/live-guest-stay-driver.js';
import type { RequestRule } from '../src/hms/contracts.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const OWNER_MARKER = 'hms-stagehand-test-marker';
const CANDIDATE = {
  id: 'candidate-1',
  kind: 'surname_dates' as const,
  surname: 'Syntherson',
  arrivalDate: '2099-01-15',
  departureDate: '2099-01-18',
};

function liveSearchEnvelope(): string {
  return ` { pageData: ${JSON.stringify({
    fromCome: true,
    success: true,
    grid: {
      GRIDRESULT: {
        type: 'LIST.DATA_ONLY.STORED',
        DATASPY: { id: '1941', label: 'All' },
        GRID: {
          METADATA: { RECORDS: '1', GRIDNAME: 'OSRESS' },
          DATA: [
            {
              id: 'stay-1',
              confirmationnumber: 'CONF-1',
              externalconfirmation: 'EXT-1',
              lastname: 'Syntherson',
              firstname: 'Alpha',
              status: 'Confirmed',
              arrivaldate: '15-Jan-2099',
              departuredate: '18-Jan-2099',
            },
          ],
        },
      },
    },
  })} } `;
}

function parent(overrides: Record<string, unknown> = {}) {
  return {
    marker: OWNER_MARKER,
    candidate: CANDIDATE,
    hints: { confirmationNumber: null, externalReference: null, reservationStayId: null },
    incomingBodySha256: 'a'.repeat(64),
    goldAnswerUsed: false,
    manualIdUsed: false,
    ...overrides,
  };
}

describe('Stagehand reviewed discovery commands', () => {
  it('accepts only fixed folio-all-view command and keeps action client reviewed', () => {
    expect(stagehandDiscoveryCommandSchema.parse({ action: 'folio_all_view' })).toEqual({
      action: 'folio_all_view',
    });
    expect(stagehandDiscoveryCommandSchema.parse({ action: 'folio_all_run' })).toEqual({
      action: 'folio_all_run',
    });
    expect(stagehandDiscoveryCommandSchema.parse({ action: 'folio_all_next' })).toEqual({
      action: 'folio_all_next',
    });
    expect(() => stagehandDiscoveryCommandSchema.parse({ action: 'unknown_action' })).toThrow();
    const actionSource = readFileSync(
      new URL('../scripts/hms-stagehand-action.mjs', import.meta.url),
      'utf8',
    );
    expect(actionSource).toContain("'folio_all_view'");
    expect(actionSource).toContain("'folio_all_run'");
    expect(actionSource).toContain("'folio_all_next'");
    expect(stagehandDiscoveryCommandSchema.parse({ action: 'property_ledger' })).toEqual({
      action: 'property_ledger',
    });
    expect(actionSource).toContain("'property_ledger'");
    expect(actionSource).toContain('body: JSON.stringify({ action:');
  });

  it('accepts only reviewed account deposit-read navigation commands', () => {
    for (const action of ['account', 'advance_deposit', 'deposit_schedule'] as const) {
      expect(stagehandDiscoveryCommandSchema.parse({ action })).toEqual({ action });
    }
    const actionSource = readFileSync(
      new URL('../scripts/hms-stagehand-action.mjs', import.meta.url),
      'utf8',
    );
    expect(actionSource).toContain("'account'");
    expect(actionSource).toContain("'advance_deposit'");
    expect(actionSource).toContain("'deposit_schedule'");
    const ownerSource = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    for (const action of ['account', 'advance_deposit', 'deposit_schedule'])
      expect(ownerSource).toContain(`action === '${action}'`);
  });

  it('uses the reviewed application-menu search before account navigation', () => {
    const ownerSource = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(ownerSource).toContain("input[name='appmenusearch']");
    expect(ownerSource).toContain('MENU_SEARCH_NOT_UNIQUE');
    expect(ownerSource).toContain('MENU_ITEM_SEARCH_NOT_UNIQUE');
  });

  it('records only API request header names and authorization presence', () => {
    const source = readFileSync(
      new URL('../src/hms/request-signature-projection.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('requestHeaderNames');
    expect(source).toContain('authorizationPresent');
    expect(source).not.toContain('requestHeaders:');
    expect(source).not.toContain('headerValues:');
  });

  it('persists blocked request signatures without request or query values', () => {
    const source = readFileSync(
      new URL('../src/hms/request-signature-projection.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('bodyFieldNames');
    expect(source).toContain('queryKeys');
    expect(source).toContain('bodyByteLength');
    expect(source).not.toContain('fields,\n            query,');
  });

  it('derives blocked request fields at the runtime policy seam without persisting postData', () => {
    const source = readFileSync(
      new URL('../src/hms/runtime.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('onRequestProjection');
    expect(source).toContain('buildNarrowRequestProjection');
    expect(source).not.toContain('newCDPSession(nativePage)');
    expect(source).not.toContain('Network.requestWillBeSent');
  });

  it('uses the runtime guard projection before fail-closed policy aborts dispatch', () => {
    const source = readFileSync(
      new URL('../src/hms/runtime.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('onRequestProjection');
    expect(source).toContain("kind: 'runtime-request-projection'");
    const ownerSource = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(ownerSource).toContain('appendRuntimeRequestProjection');
    expect(ownerSource).not.toContain(
      'if (!SIGNATURE_ONLY_CAPTURE || !captureEnabled || closing || captures.length >= 300) return;',
    );
    expect(ownerSource).not.toContain("nativePage!.route('**/*'");
    expect(ownerSource).not.toContain("kind: 'page-route-request-signature'");
  });

  it('retains safe projections for exact hotel-operation reads', () => {
    const ownerSource = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(ownerSource).toContain('/api/hotelOperation/');
  });

  it('supports a metadata-only owner mode that suppresses arbitrary captures', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('HMS_STAGEHAND_SIGNATURE_ONLY');
    expect(source).toContain('SIGNATURE_ONLY_CAPTURE');
    expect(source).toContain('PAGEERROR_SUPPRESSED_SIGNATURE_ONLY');
    expect(source).toContain("bodyRedaction = 'SIGNATURE_ONLY_CAPTURE'");
    expect(source).toContain('action-metadata');
  });

  it('persists the request projection when a guarded action aborts before success metadata', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    const commandCatch = source.indexOf(
      "    } catch (error) {\n      // A fail-closed request can abort the UI action",
    );
    expect(commandCatch).toBeGreaterThanOrEqual(0);
    const commandReply = source.indexOf('      return reply(422,', commandCatch);
    expect(commandReply).toBeGreaterThan(commandCatch);
    expect(source.slice(commandCatch, commandReply)).toContain(
      "await privateJson('network.json', captures);",
    );
  });

  it('keeps response provenance hashes and surfaces fail-closed persistence status', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('projectStagehandResponseRecord');
    expect(source).toContain('originalBodySha256');
    expect(source).toContain('storedBodySha256');
    expect(source).toContain('capturePersistence');
    expect(source).toContain('rejectedCount');
  });

  it('records page errors and request failures as code-only diagnostics', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("code: 'PAGEERROR_CAPTURED'");
    expect(source).toContain("code: 'REQUEST_FAILURE_CAPTURED'");
    expect(source).not.toContain('message: redacted.ok ? redacted.value');
  });

  it('declares only the captured Account open read shape when replaying the native action', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-osacct-open'");
    expect(source).toContain("path: '/web/base/OSACCT'");
    expect(source).toContain("queryKeySequence: ['USER_FUNCTION_NAME', 'FUNCTION_CLASS']");
    expect(source).toContain('bodyKeySequence: [');
    for (const key of [
      'USER_FUNCTION_NAME',
      'FUNCTION_CLASS',
      'SYSTEM_FUNCTION_NAME',
      'CURRENT_TAB_NAME',
      'MENU_MODULE_KEY',
      'removescreenflows',
    ])
      expect(source).toContain(`'${key}'`);
    expect(source).toContain("removescreenflows: 'yes'");
    expect(source).toContain('(?:OSACCT|OSRESS|');
    expect(source).not.toContain("path: '/web/base/OSACCT*'");
  });

  it('declares only the captured Account HDR/LST read shapes after the native open', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-osacct-hdr-read'");
    expect(source).toContain("path: '/web/base/OSACCT.HDR'");
    expect(source).toContain("id: 'live-account-osacct-lst-read'");
    expect(source).toContain("path: '/web/base/OSACCT.LST'");
    expect(source).toContain("bodyKeySequence: [");
    for (const key of ['account', 'propertycode', 'acctname', 'reference'])
      expect(source).toContain(`'${key}'`);
    expect(source).toContain("COMPONENT_INFO_TYPE: 'HEAD_ONLY'");
    expect(source).not.toContain("path: '/web/base/OSACCT.*'");
  });

  it('declares the exact All Guest Accounts native list refresh shape', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-osacct-lst-all-guest-read'");
    expect(source).toContain("path: '/web/base/OSACCT.LST'");
    expect(source).toContain("GRID_ID: '749'");
    expect(source).toContain("GRID_NAME: 'OSACCT'");
    expect(source).toContain("DATASPY_ID: '867'");
    expect(source).toContain("COMPONENT_INFO_TYPE: 'HEAD_ONLY'");
    expect(source).toContain("bodyKeySequence: [");
    expect(source).not.toContain("path: '/web/base/OSACCT.LST*'");
  });

  it('declares the exact All Guest Accounts native header refresh shape', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-osacct-hdr-all-guest-read'");
    expect(source).toContain("path: '/web/base/OSACCT.HDR'");
    expect(source).toContain("ONLY_DATA_REQUIRED: 'true'");
    expect(source).toContain("SCROLLROW: 'YES'");
    for (const key of [
      'SYSTEM_FUNCTION_NAME',
      'USER_FUNCTION_NAME',
      'CURRENT_TAB_NAME',
      'account',
      'propertycode',
      'acctname',
      'reference',
      'ONLY_DATA_REQUIRED',
      'SCROLLROW',
    ])
      expect(source).toContain(`'${key}'`);
    expect(source).not.toContain("path: '/web/base/OSACCT.HDR*'");
  });

  it('declares only the captured bound-account filter read shape', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-osacct-filter-read'");
    expect(source).toContain("path: '/web/base/OSACCT.xmlhttp'");
    expect(source).toContain("COMPONENT_INFO_TYPE: 'DATA_ONLY'");
    expect(source).toContain("filterfields: 'account'");
    expect(source).toContain("filteroperator: 'CONTAINS'");
    expect(source).toContain('filtervalue: boundAccount.account');
    for (const key of [
      'GRID_ID',
      'GRID_NAME',
      'DATASPY_ID',
      'USER_FUNCTION_NAME',
      'SYSTEM_FUNCTION_NAME',
      'CURRENT_TAB_NAME',
      'COMPONENT_INFO_TYPE',
      'filterfields',
      'filteroperator',
      'filtervalue',
    ])
      expect(source).toContain(`'${key}'`);
    expect(source).not.toContain("path: '/web/base/OSACCT*'");
  });

  it('declares only the captured bound-account HDR read shape', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-osacct-hdr-bound-read'");
    expect(source).toContain("path: '/web/base/OSACCT.HDR'");
    expect(source).toContain('account: boundAccount.account');
    expect(source).toContain('propertycode: boundAccount.propertycode');
    expect(source).toContain('acctname: boundAccount.acctname');
    expect(source).toContain('reference: boundAccount.reference');
    expect(source).toContain("ONLY_DATA_REQUIRED: 'true'");
    expect(source).toContain("SCROLLROW: 'YES'");
    for (const key of [
      'SYSTEM_FUNCTION_NAME',
      'USER_FUNCTION_NAME',
      'CURRENT_TAB_NAME',
      'account',
      'propertycode',
      'acctname',
      'reference',
      'SCROLLROW',
      'ONLY_DATA_REQUIRED',
    ])
      expect(source).toContain(`'${key}'`);
    expect(source).not.toContain("path: '/web/base/OSACCT.HDR*'");
  });

  it('declares only the captured bound-account Advance Deposit read shape', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-osacct-adp-bound-read'");
    expect(source).toContain("path: '/web/base/OSACCT.ADP'");
    expect(source).toContain("CURRENT_TAB_NAME: 'ADP'");
    expect(source).toContain('account: boundAccount.account');
    expect(source).toContain('propertycode: boundAccount.propertycode');
    expect(source).toContain('acctname: boundAccount.acctname');
    expect(source).toContain('reference: boundAccount.reference');
    for (const key of [
      'SYSTEM_FUNCTION_NAME',
      'USER_FUNCTION_NAME',
      'CURRENT_TAB_NAME',
      'account',
      'propertycode',
      'acctname',
      'reference',
    ])
      expect(source).toContain(`'${key}'`);
    expect(source).not.toContain("path: '/web/base/OSACCT.ADP*'");
  });

  it('declares only the captured bound Deposit Schedule read shape', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-osrsds-schedule-bound-read'");
    expect(source).toContain("path: '/web/base/OSRSDS'");
    expect(source).toContain('confirmationnumber: boundSchedule.confirmationnumber');
    expect(source).toContain('reservationstayid: boundSchedule.reservationstayid');
    expect(source).toContain('propertycode: boundSchedule.propertycode');
    expect(source).toContain('HMS_STAGEHAND_SCHEDULE_BINDING_PATH');
    for (const key of [
      'SYSTEM_FUNCTION_NAME',
      'USER_FUNCTION_NAME',
      'confirmationnumber',
      'reservationstayid',
      'propertycode',
    ])
      expect(source).toContain(`'${key}'`);
    expect(source).not.toContain("path: '/web/base/OSRSDS*'");
  });

  it('declares only the captured bound Deposit Schedule inquiry JSON read shape', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("id: 'live-account-hotel-operation-schedule-bound-read'");
    expect(source).toContain(
      'const boundScheduleInquiryPath =',
    );
    expect(source).toContain('path: boundScheduleInquiryPath');
    expect(source).toContain('url.pathname === boundScheduleInquiryPath');
    expect(source).toContain("contentType: 'application/json'");
    expect(source).toContain(
      'confirmationNumber: boundSchedule.confirmationnumber',
    );
    expect(source).toContain(
      'reservationStayID: boundSchedule.reservationstayid',
    );
    expect(source).toContain("bodyKeySequence: ['confirmationNumber', 'reservationStayID']");
    expect(source).not.toContain("path: '/api/hotelOperation/*'");
  });

  it('loads exact Account bindings from the private owner path only', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('HMS_STAGEHAND_ACCOUNT_BINDING_PATH');
    expect(source).toContain('ACCOUNT_BINDING_REQUIRED');
    expect(source).toContain('ACCOUNT_BINDING_INVALID');
    expect(source).toContain("path.startsWith('/opt/nava/stagehand-trial-20260917/')");
    expect(source).not.toContain("account: '51664'");
    expect(source).not.toContain("reference: '33387876-1'");
  });

  it('allows structured response capture with visual recording disabled', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('HMS_STAGEHAND_STRUCTURED_ONLY');
    expect(source).toContain('VISUAL_CAPTURE_ENABLED');
    expect(source).toContain('if (VISUAL_CAPTURE_ENABLED) await startScreencast()');
  });

  it('passes the pinned private Chromium executable to the owner browser', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('HMS_CHROMIUM_EXECUTABLE_PATH');
    expect(source).toContain('executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH');
  });

  it('targets the Account response-declared Advance Deposit tab label exactly', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("locator('.x-tab-inner')");
    expect(source).toContain('^Advance Deposit$');
    expect(source).toContain('xpath=ancestor::a');
    expect(source).toContain('OSACCT.ADP');
  });

  it('projects only reviewed transport values and hashes every other field', () => {
    const source = readFileSync(
      new URL('../src/hms/request-signature-projection.ts', import.meta.url),
      'utf8',
    );
    for (const key of [
      'SYSTEM_FUNCTION_NAME',
      'USER_FUNCTION_NAME',
      'FUNCTION_CLASS',
      'CURRENT_TAB_NAME',
      'MENU_MODULE_KEY',
      'removescreenflows',
    ])
      expect(source).toContain(key);
    expect(source).toContain('otherFieldHashes');
    expect(source).toContain('queryFieldHashes');
    expect(source).toContain("createHash('sha256')");
  });

  it('wires the shared redactor at every authenticated capture persistence site', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("from '../src/hms/stagehand-capture-redaction.js'");
    expect(source).toContain('redactStagehandCapture');
    expect(source).toContain('projectStagehandResponseRecord');
    expect(source).toContain('persistStagehandCapture');
    expect(source).toContain('onRequestProjection');
    expect(source).toContain('CAPTURE_REDACTION_REQUIRED');
    expect(source).toContain('RESPONSE_BODY_UNSAFE');
    expect(source).toContain("name === 'owner.json'");
  });

  it('installs the captured TRC shape only with the actual LST parent binding', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('buildBoundNotesTracesReadRule({');
    expect(source).toContain('detailValues: binding.hdrFields');
    expect(source).toContain("rule.id !== 'live-osresv-trc-read'");
  });
  it('binds FOL request identities without mutating broad template', () => {
    const template: RequestRule = {
      id: 'live-folio-osresv-fol',
      origin: 'https://pms.example.test',
      method: 'POST',
      path: '/web/base/OSRESV.FOL',
      resourceTypes: ['xhr'],
      contentType: 'application/x-www-form-urlencoded',
      fixedQuery: {},
      variableQuery: {},
      fixedBody: {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'FOL',
        propertycode: 'HRCEN',
      },
      variableBody: {
        confirmationnumber: { pattern: '.{1,64}', maxLength: 64 },
        reservationstayid: { pattern: '.{1,64}', maxLength: 64 },
        id: { pattern: '.{1,64}', maxLength: 64 },
      },
      maxBodyBytes: 16_384,
      redirectPolicy: 'same-reviewed-chain',
    };
    const bound = bindStagehandFolioRule(template, {
      confirmationNumber: 'CONF-42',
      reservationStayId: 'STAY-77',
    });

    expect(bound.fixedBody).toMatchObject({
      confirmationnumber: 'CONF-42',
      reservationstayid: 'STAY-77',
      id: 'STAY-77',
    });
    expect(bound.variableBody).toEqual({});
    expect(template.variableBody).toHaveProperty('confirmationnumber');
    expect(() =>
      bindStagehandFolioRule(template, {
        confirmationNumber: 'CONF-42',
        reservationStayId: '',
      }),
    ).toThrow('FOLIO_PARENT_BINDING_REQUIRED');

    const exact = bindStagehandFolioRule(template, {
      confirmationNumber: 'CONF-42',
      reservationStayId: 'STAY-77',
      hdrFields: {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'HDR',
        confirmationnumber: 'CONF-42',
        reservationstayid: 'STAY-77',
        propertycode: 'HRCEN',
        guestfullname: 'Alpha Syntherson',
        account: 'ACCT-1',
        guestid: 'G-1',
        hoteldate: '17-SEP-2026',
        lastname: 'Syntherson',
        firstname: 'Alpha',
        twitterid: '',
        facebookid: '',
        tripadvisorid: '',
        bookingdotcomid: '',
        room: '101',
      },
    });
    expect(() =>
      bindStagehandFolioRule(template, {
        confirmationNumber: 'CONF-42',
        reservationStayId: 'STAY-77',
        hdrFields: { ...exact.fixedBody, hoteldate: '31-FEB-2026' },
      }),
    ).toThrow();
    expect(exact.fixedBody).toEqual({
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'FOL',
      confirmationnumber: 'CONF-42',
      reservationstayid: 'STAY-77',
      propertycode: 'HRCEN',
      guestfullname: 'Alpha Syntherson',
      account: 'ACCT-1',
      guestid: 'G-1',
      hoteldate: '09/17/2026',
      lastname: 'Syntherson',
      firstname: 'Alpha',
      twitterid: '',
      facebookid: '',
      tripadvisorid: '',
      bookingdotcomid: '',
      room: '101',
    });
  });

  it('authorizes the notes inquiry only after an exact live search match', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('buildNotesInquiryReadRule(origin, confirmation)');
    expect(source).toContain("url.pathname === '/web/base/OSRESS.search'");
    expect(source).toContain('confirmStagehandParentFromSearch');
    expect(source).toContain("privateJson('effective-manifest.json', manifest)");
    expect(source).toContain('response.request().method()');
    expect(source).toContain('waitForSearchResponse');
    expect(source).toContain('readResponseBodyBounded');
    expect(source).toContain('extractBoundOsresvLstRow');
    expect(source).toContain('buildBoundFolioRefreshRule({');
    expect(source.includes('buildBoundFolioAllGridRule({')).toBe(true);
    expect(source.includes("path: '/web/base/OSRESV.NOT'")).toBe(true);
    expect(source.includes("rule.id !== 'live-osresv-not-read'")).toBe(true);
    expect(source.includes("rule.id !== 'live-folio-osresv-all-grid'")).toBe(true);
    expect(source).toContain("rule.id !== 'live-folio-osresv-fol-refresh'");
    expect(source).toContain("action === 'folio_all_view'");
    expect(source).toContain('Standard Folios');
    expect(source).toContain('.x-form-arrow-trigger');
    expect(source).toContain('.x-boundlist:visible .x-boundlist-item');
    expect(source.includes('hasText: /^All Folios$/')).toBe(true);
    expect(source).not.toContain('Ext.');
    expect(source).toContain('parent.json');
    expect(source).toContain('bindStagehandFolioRule');
    expect(source).toContain('manifest.rules = manifest.rules.filter');
    expect(source).not.toContain('manifest.rules.push(...buildLiveFolioFunctionalRules(origin)');
  });
  it('uses exact nested cell identity before opening parent', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('stagehandParentRowMatchesExactIdentity');
    expect(source).toContain('nestedTexts');
    expect(source).toContain('data-record-value');
    expect(source).not.toContain('cells.some((text) => text.trim() === confirmation)');
  });
  it('confirms one parent from a live OSRESS envelope and preserves source proof', () => {
    const body = liveSearchEnvelope();
    const search = parseAndCorrelateGuestStayHtml(body, CANDIDATE, undefined, {
      requireLiveEnvelope: true,
    });
    const hints = extractOsressDetailOpenHints(body, CANDIDATE);

    const confirmed = confirmStagehandParentFromSearch({
      parent: parent(),
      ownerMarker: OWNER_MARKER,
      search,
      hints,
    });

    expect(confirmed).toMatchObject({
      marker: OWNER_MARKER,
      candidate: CANDIDATE,
      manualIdUsed: false,
      goldAnswerUsed: false,
      hints: {
        confirmationNumber: 'CONF-1',
        externalReference: 'EXT-1',
        reservationStayId: 'stay-1',
      },
    });
  });

  it('checks the parent external candidate against the one correlated row, including the proven alias', () => {
    const candidate = {
      id: 'external-candidate',
      kind: 'external_reference' as const,
      value: 'LS-SYNTH-55',
    };
    const search = {
      outcome: 'matched' as const,
      capped: false as const,
      observations: [
        {
          confirmationNumber: 'CONF-1',
          externalReference: 'LS-SYNTH-55--2375',
          guestName: 'Syntherson, Alpha',
          arrivalDate: '2099-01-15',
          departureDate: '2099-01-18',
          reservationStatus: 'Reserved',
          roomType: null,
          ratePlan: null,
        },
      ],
    };
    const hints = {
      confirmationNumber: 'CONF-1',
      externalReference: 'LS-SYNTH-55--2375',
      reservationStayId: 'stay-1',
    };
    expect(
      confirmStagehandParentFromSearch({
        parent: parent({ candidate }),
        ownerMarker: OWNER_MARKER,
        search,
        hints,
      }).hints.externalReference,
    ).toBe('LS-SYNTH-55--2375');
    expect(() =>
      confirmStagehandParentFromSearch({
        parent: parent({
          candidate: { ...candidate, value: 'OTHER-SYNTH-55' },
        }),
        ownerMarker: OWNER_MARKER,
        search,
        hints,
      }),
    ).toThrow('CONNECTED_PARENT_IDENTITY_MISMATCH');
  });

  it('matches exact nested confirmation and external tokens without substring acceptance', () => {
    expect(
      stagehandParentRowMatchesExactIdentity({
        confirmationNumber: '90000001-1',
        externalReference: 'LS-DEMO1--1234',
        cells: [
          {
            text: '90000001-1 LS-DEMO1--1234',
            nestedTexts: ['90000001-1'],
          },
        ],
      }),
    ).toBe(true);
    expect(
      stagehandParentRowMatchesExactIdentity({
        confirmationNumber: '90000001-1',
        externalReference: 'LS-DEMO1--1234',
        cells: [
          { text: '90000001-1' },
          { text: 'LS-DEMO1--1234' },
        ],
      }),
    ).toBe(true);
    expect(
      stagehandParentRowMatchesExactIdentity({
        confirmationNumber: '90000001-1',
        externalReference: 'LS-DEMO1--1234',
        cells: [{ text: '90000001-10 LS-DEMO1--1234' }],
      }),
    ).toBe(false);
    expect(
      stagehandParentRowMatchesExactIdentity({
        confirmationNumber: '90000001-1',
        externalReference: 'LS-DEMO1--1234',
        cells: [{ text: '90000001-1 LS-DEMO1--123' }],
      }),
    ).toBe(false);
  });

  it('accepts only the exact whole-cell concatenation rendered without whitespace', () => {
    const parent = { confirmationNumber: '90000001-1', externalReference: 'LS-DEMO1--1234' };
    expect(stagehandParentRowMatchesExactIdentity({ ...parent, cells: [{ text: '90000001-1LS-DEMO1--1234', nestedTexts: ['', 'LS-DEMO1'] }] })).toBe(true);
    expect(stagehandParentRowMatchesExactIdentity({ ...parent, cells: [{ text: '90000001-10LS-DEMO1--1234' }] })).toBe(false);
    expect(stagehandParentRowMatchesExactIdentity({ ...parent, cells: [{ text: '90000001-1LS-DEMO1--123' }] })).toBe(false);
  });

  it('rejects marker, source-flag, non-matched, and identity drift', () => {
    const body = liveSearchEnvelope();
    const search = parseAndCorrelateGuestStayHtml(body, CANDIDATE, undefined, {
      requireLiveEnvelope: true,
    });
    const hints = extractOsressDetailOpenHints(body, CANDIDATE);
    const input = { parent: parent(), ownerMarker: OWNER_MARKER, search, hints };

    expect(() =>
      confirmStagehandParentFromSearch({ ...input, ownerMarker: 'other-marker' }),
    ).toThrow('CONNECTED_PARENT_MISMATCH');
    expect(() =>
      confirmStagehandParentFromSearch({
        ...input,
        parent: parent({ manualIdUsed: true }),
      }),
    ).toThrow('CONNECTED_PARENT_SOURCE_MISMATCH');
    expect(() =>
      confirmStagehandParentFromSearch({
        ...input,
        search: { outcome: 'not_found', observations: [], capped: false },
      }),
    ).toThrow('CONNECTED_SEARCH_NOT_UNIQUE');
    expect(() =>
      confirmStagehandParentFromSearch({
        ...input,
        hints: { ...hints, confirmationNumber: 'OTHER-1' },
      }),
    ).toThrow('CONNECTED_PARENT_IDENTITY_MISMATCH');
  });

  it('proxies navigation through the guarded owner; identity proof stays server-side', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-action.mjs', import.meta.url),
      'utf8',
    );
    expect(source).toContain('127.0.0.1:19224/command');
    expect(source).toContain('owner.controlToken');
    expect(source).toContain('OWNER_PAGE_MISMATCH');
    expect(source).toContain("action: action === 'dismiss_notes_popup' ? 'capture' : action");
    expect(source).not.toContain('parseAndCorrelateGuestStayHtml');
    expect(source).not.toContain('extractOsressDetailOpenHints');
  });
  it('keeps its exact discovery manifest instead of invoking find-only runtime replacement', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    const open = source.match(/runtime\.openReadSession\(\{([\s\S]*?)\}\)/)?.[1] ?? '';
    expect(open).toContain('allowUnstarted: true');
    expect(open).not.toMatch(/^\s*exactSearchCandidate:/m);
    expect(source).toContain('buildExactOsressSearchThenDetailManifest(origin, candidate)');
  });
  it('allows only fixed read tabs, capture and close; never arbitrary actions/selectors', () => {
    for (const action of [
      'folio',
      'traces',
      'notes',
      'capture',
      'close',
      'open_menu',
      'front_desk',
      'guest_stay',
      'search_parent',
      'open_parent',
      'folio_all_view',
    ]) {
      expect(stagehandDiscoveryCommandSchema.safeParse({ action }).success).toBe(true);
    }
    for (const value of [
      { action: 'save' },
      { action: 'folio', selector: '#save' },
      { script: 'x' },
    ]) {
      expect(stagehandDiscoveryCommandSchema.safeParse(value).success).toBe(false);
    }
    expect(discoveryTabLabel('folio')).toBe('Folio');
    expect(discoveryTabLabel('traces')).toBe('Traces');
    expect(discoveryTabLabel('notes')).toBe('Notes');
  });
  it('uses private per-run bearer tokens with constant-time exact matching', () => {
    const token = createStagehandControlToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(stagehandBearerTokenMatches(`Bearer ${token}`, token)).toBe(true);
    expect(stagehandBearerTokenMatches(undefined, token)).toBe(false);
    expect(stagehandBearerTokenMatches(token, token)).toBe(false);
    expect(stagehandBearerTokenMatches(`Bearer ${token}x`, token)).toBe(false);
    expect(stagehandBearerTokenMatches(`bearer ${token}`, token)).toBe(false);
  });
  it('keeps owner lifecycle and screencast requirements in runner source', () => {
    const source = readFileSync(
      new URL('../scripts/hms-stagehand-read-trial.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('process.umask(0o077)');
    expect(source).toContain('chmod(out, 0o700)');
    expect(source).toContain('chmod(videoDir, 0o700)');
    expect(source).toContain('screencast.start');
    expect(source).toContain('screencast.stop');
    expect(source).toContain('onBeforeContextClose');
    expect(source).toContain('capture-error.json');
    expect(source).not.toContain("recordVideo: { dir: join(out, 'video'");
    expect(source).toContain('stagehandBearerTokenMatches');
    expect(source).toContain('server.close');
    expect(source.indexOf("if (action === 'close')")).toBeLessThan(
      source.indexOf("if (phase !== 'ready'"),
    );
  });
});
