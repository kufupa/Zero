/** Raw-page seam for the tenant-discovered Hotel Availability screen. */
import type { QuoteRequest } from '../../../../../../apps/server-pilot/src/hms/quote-request-normalization.js';
import {
  buildHotelAvailabilitySearchBody,
  type HotelAvailabilitySurfaceManifest,
} from './hotel-availability-contract.js';
import { HmsRuntimeError, type HmsPage, type HmsReadSession } from '../../../../../../apps/server-pilot/src/hms/runtime.js';

export interface HotelAvailabilityFacade {
  navigate(): Promise<void>;
  search(request: QuoteRequest): Promise<string>;
}

export function createHotelAvailabilityFacade(
  session: HmsReadSession,
  manifest: HotelAvailabilitySurfaceManifest,
): HotelAvailabilityFacade {
  const page = session.page;
  const checked = manifest;
  return {
    async navigate() {
      // Exact path comes from the tenant discovery manifest.  No menu label,
      // selector or OSRRAV fallback is guessed here.
      if (checked.openMethod === 'GET') {
        await page.goto(`${session.origin}${checked.openPath}`);
      } else {
        await page.postForm(`${session.origin}${checked.openPath}`, checked.openBody);
      }
      if (session.terminal() || session.violation()) {
        throw new HmsRuntimeError('REQUEST_POLICY_BLOCK', 'Hotel Availability navigation blocked');
      }
    },
    async search(request) {
      const body = buildHotelAvailabilitySearchBody({ request, manifest: checked });
      const correlation = page.waitForCorrelatedResponse
        ? page.waitForCorrelatedResponse(checked.searchPath)
        : Promise.resolve('');
      const [posted, response] = await Promise.allSettled([
        page.postForm(`${session.origin}${checked.searchPath}`, body),
        correlation,
      ]);
      if (posted.status === 'rejected') throw posted.reason;
      if (response.status === 'rejected') {
        throw new HmsRuntimeError('SCHEMA_DRIFT', 'Hotel Availability search correlation failed');
      }
      if (session.terminal() || session.violation()) {
        throw new HmsRuntimeError('REQUEST_POLICY_BLOCK', 'Hotel Availability search blocked');
      }
      return posted.value || response.value || (await page.content());
    },
  };
}

/** Compile-time guard for callers that must not pass arbitrary page objects. */
export type HotelAvailabilityPage = Pick<HmsPage, 'goto' | 'postForm' | 'content'>;
