import type { DraftModelRouteConfig } from './draft-route-factory.js';
import {
  createReservationistProvider,
  type ReservationistProviderOptions,
} from './reservationist-provider.js';

/**
 * Shared composition for an explicitly installed draft-route module.
 *
 * The existing loader invokes the installation's zero-argument
 * createDraftModelRoute export. That export supplies its authorized options
 * here; this function supplies no route, release, policy, service or credentials.
 * The normal staff worker and replay therefore use the same guarded provider.
 */
export function createInstalledReservationistDraftModelRoute(
  options: ReservationistProviderOptions,
): DraftModelRouteConfig {
  return {
    ...options.routeConfig,
    reservationist: createReservationistProvider(options),
  };
}
