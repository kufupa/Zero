import { describe, expect, it } from 'vitest';
import {
  extractPropertyBindingFromDom,
  livePropertyNameSatisfied,
  waitForAuthenticatedShell,
  type HmsPage,
} from '../src/hms/runtime.js';
import {
  buildLiveGuestStayChromeGetRules,
} from '../src/hms/live-read-manifest.js';
import { evaluateObservedRequest } from '../src/hms/request-policy.js';
import { requestPolicyManifestSchema } from '../src/hms/contracts.js';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';

describe('extractPropertyBindingFromDom (live + fixture)', () => {
  it('prefers fixture data-* attrs', () => {
    const html =
      '<div data-tenant="THECENTURION_PRD" data-property-code="HRCEN" data-property-name="Centurion Hotel"></div>';
    expect(
      extractPropertyBindingFromDom({
        html,
        title: 'Other title',
      }),
    ).toEqual({
      tenant: 'THECENTURION_PRD',
      propertyCode: 'HRCEN',
      propertyName: 'Centurion Hotel',
    });
  });

  it('extracts live COMMON shell tenantid + title code', () => {
    const html =
      '{"isdesigner": "false", "tenantid": "THECENTURION_PRD", "property": "HRCEN", "userorg": "HRCEN"}' +
      '<div><b>Legacy - The Centurion Hotel&nbsp;</b></div>';
    const binding = extractPropertyBindingFromDom({
      html,
      title: 'Infor HMS - HRCEN',
      pageUrl: `${ORIGIN}/web/base/COMMON`,
    });
    expect(binding.tenant).toBe('THECENTURION_PRD');
    expect(binding.propertyCode).toBe('HRCEN');
    expect(binding.propertyName).toBeNull();
    expect(
      livePropertyNameSatisfied({
        html,
        title: 'Infor HMS - HRCEN',
        expectedPropertyCode: 'HRCEN',
        expectedPropertyName: 'Centurion Hotel',
        bindingPropertyName: binding.propertyName,
      }),
    ).toBe(true);
  });

  it('rejects live name fallback when title code wrong', () => {
    expect(
      livePropertyNameSatisfied({
        html: 'Centurion Hotel',
        title: 'Infor HMS - OTHER',
        expectedPropertyCode: 'HRCEN',
        expectedPropertyName: 'Centurion Hotel',
        bindingPropertyName: null,
      }),
    ).toBe(false);
  });

  it('waitForAuthenticatedShell retries navigation races then succeeds', async () => {
    let calls = 0;
    const page = {
      async content() {
        calls += 1;
        if (calls < 3) {
          throw new Error(
            'page.content: Unable to retrieve content because the page is navigating and changing the content.',
          );
        }
        return '<div data-tenant="THECENTURION_PRD" data-property-code="HRCEN" data-property-name="Centurion Hotel"></div>';
      },
      async title() {
        return 'Infor HMS - HRCEN';
      },
      url() {
        return 'https://example.test/web/base/COMMON';
      },
    } as unknown as HmsPage;
    await waitForAuthenticatedShell(
      page,
      {
        expectedTenant: 'THECENTURION_PRD',
        expectedPropertyCode: 'HRCEN',
        expectedPropertyName: 'Centurion Hotel',
      },
      5_000,
    );
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('waitForAuthenticatedShell waits for live banner name after tenantid', async () => {
    let calls = 0;
    const page = {
      async content() {
        calls += 1;
        if (calls < 3) {
          return '{"tenantid":"THECENTURION_PRD","property":"HRCEN"}';
        }
        return (
          '{"tenantid":"THECENTURION_PRD","property":"HRCEN"}' +
          '<b>Legacy - The Centurion Hotel&nbsp;</b>'
        );
      },
      async title() {
        return 'Infor HMS - HRCEN';
      },
      url() {
        return 'https://example.test/web/base/COMMON';
      },
    } as unknown as HmsPage;
    await waitForAuthenticatedShell(
      page,
      {
        expectedTenant: 'THECENTURION_PRD',
        expectedPropertyCode: 'HRCEN',
        expectedPropertyName: 'Centurion Hotel',
      },
      5_000,
    );
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe('COMMON chrome soft-capture allowlist', () => {
  const rules = buildLiveGuestStayChromeGetRules(ORIGIN);
  const manifest = requestPolicyManifestSchema.parse({ rules });

  it.each([
    '/web/resources/inforhms/images/toolbar/user.svg',
    '/web/resources/inforhms/images/toolbar/help.svg',
    '/web/resources/inforhms/images/toolbar/save.svg',
    '/web/resources/inforhms/images/toolbar/mingle-share.svg',
    '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Black.ttf',
    '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Bold.ttf',
  ])('allows GET %s', (path) => {
    const decision = evaluateObservedRequest(manifest, {
      method: 'GET',
      url: `${ORIGIN}${path}`,
      resourceType: path.endsWith('.ttf') ? 'font' : 'image',
    });
    expect(decision.action).toBe('allow');
  });

  it('allows interfaceStatusAlert.jsp with ExtJS _dc cache buster', () => {
    const decision = evaluateObservedRequest(manifest, {
      method: 'GET',
      url: `${ORIGIN}/web/jsp/interfaceStatusAlert.jsp?_dc=1234567890`,
      resourceType: 'xhr',
    });
    expect(decision.action).toBe('allow');
  });
});
