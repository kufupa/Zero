import { describe, expect, it } from 'vitest';
import {
  extractPropertyBindingFromDom,
  livePropertyNameSatisfied,
} from '../src/hms/runtime.js';
import {
  buildLiveGuestStayChromeGetRules,
} from '../src/hms/live-read-manifest.js';
import { evaluateObservedRequest } from '../src/hms/request-policy.js';
import { requestPolicyManifestSchema } from '../src/hms/contracts.js';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';

describe('extractPropertyBindingFromDom (live + fixture)', () => {
  it('prefers fixture data-* attrs', () => {
    const html =
      '<div data-tenant="HMS_LEGACY" data-property-code="HRCEN" data-property-name="Centurion Hotel"></div>';
    expect(
      extractPropertyBindingFromDom({
        html,
        title: 'Other title',
      }),
    ).toEqual({
      tenant: 'HMS_LEGACY',
      propertyCode: 'HRCEN',
      propertyName: 'Centurion Hotel',
    });
  });

  it('extracts live COMMON shell tenantid + title code', () => {
    const html =
      '{"isdesigner": "false", "tenantid": "HMS_LEGACY", "property": "HRCEN", "userorg": "HRCEN"}' +
      '<div><b>Legacy - The Centurion Hotel&nbsp;</b></div>';
    const binding = extractPropertyBindingFromDom({
      html,
      title: 'Infor HMS - HRCEN',
      pageUrl: `${ORIGIN}/web/base/COMMON`,
    });
    expect(binding.tenant).toBe('HMS_LEGACY');
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
});

describe('COMMON chrome soft-capture allowlist', () => {
  const rules = buildLiveGuestStayChromeGetRules(ORIGIN);
  const manifest = requestPolicyManifestSchema.parse({ rules });

  it.each([
    '/web/resources/inforhms/images/toolbar/user.svg',
    '/web/resources/inforhms/images/toolbar/help.svg',
    '/web/resources/inforhms/images/toolbar/save.svg',
    '/web/resources/shared/css/SourceSansPro-font/SourceSansPro-Black.ttf',
    '/web/jsp/interfaceStatusAlert.jsp',
  ])('allows GET %s', (path) => {
    const decision = evaluateObservedRequest(manifest, {
      method: 'GET',
      url: `${ORIGIN}${path}`,
      resourceType: path.endsWith('.ttf')
        ? 'font'
        : path.endsWith('.jsp')
          ? 'xhr'
          : 'image',
    });
    expect(decision.action).toBe('allow');
  });
});
