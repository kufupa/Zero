/** Build a fail-closed request-policy manifest from a live-discovered surface. */
import {
  buildLiveGuestStayChromeGetRules,
  buildLiveHmsAuthenticationRules,
} from '../../../../../../apps/server-pilot/src/hms/live-read-manifest.js';
import {
  buildHotelAvailabilitySearchBody,
  hotelAvailabilitySurfaceManifestSchema,
  type HotelAvailabilitySurfaceManifest,
} from './hotel-availability-contract.js';
import type { QuoteRequest } from '../../../../../../apps/server-pilot/src/hms/quote-request-normalization.js';
import { requestPolicyManifestSchema, type RequestPolicyManifest, type RequestRule } from '../../../../../../apps/server-pilot/src/hms/contracts.js';

function openRule(
  origin: string,
  surface: HotelAvailabilitySurfaceManifest,
): RequestRule {
  const rule: RequestRule = {
    id: 'live-hotel-availability-open',
    origin,
    method: surface.openMethod,
    path: surface.openPath,
    resourceTypes: surface.openMethod === 'GET' ? ['document', 'xhr', 'fetch'] : ['xhr', 'fetch'],
    fixedQuery: {},
    variableQuery: {},
    fixedBody: surface.openMethod === 'POST' ? surface.openBody : {},
    variableBody: {},
    maxBodyBytes: 16_384,
    redirectPolicy: 'same-reviewed-chain',
  };
  if (surface.openMethod === 'POST') rule.contentType = surface.contentType;
  return rule;
}

/**
 * Exact-bound search manifest.  The request body is fixed to this connected
 * case, so a guessed room/rate/date/body cannot pass the runtime firewall.
 */
export function buildHotelAvailabilityRequestManifest(input: {
  origin: string;
  request: QuoteRequest;
  surface: HotelAvailabilitySurfaceManifest;
}): RequestPolicyManifest {
  const surface = hotelAvailabilitySurfaceManifestSchema.parse(input.surface);
  const body = buildHotelAvailabilitySearchBody({ request: input.request, manifest: surface });
  // Hotel Availability does not need Guest Stay toolbar assets whose names
  // imply save/send/submit actions. Exclude them from this surface manifest so
  // the policy is visibly read-only as well as method/path constrained.
  const chrome = buildLiveGuestStayChromeGetRules(input.origin).filter(
    (rule) => !/(?:reserve|save|submit|cancel)/i.test(rule.path),
  );
  const search: RequestRule = {
    id: 'live-hotel-availability-search-exact',
    origin: input.origin,
    method: 'POST',
    path: surface.searchPath,
    resourceTypes: ['xhr', 'fetch'],
    contentType: surface.contentType,
    fixedQuery: {},
    variableQuery: {},
    fixedBody: body,
    variableBody: {},
    maxBodyBytes: 32_768,
    redirectPolicy: 'same-reviewed-chain',
  };
  return requestPolicyManifestSchema.parse({
    rules: [
      ...chrome,
      ...buildLiveHmsAuthenticationRules(input.origin),
      openRule(input.origin, surface),
      search,
    ],
  });
}
