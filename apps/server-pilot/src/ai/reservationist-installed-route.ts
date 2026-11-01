import { AzureLunaModelAdapter } from './bedrock/luna.js';
import { createAzureDraftModelRoute, type DraftModelRouteConfig } from './draft-route-factory.js';
import { createInstalledReservationistProvider } from './reservationist-installed-provider.js';

/** The configured-route loader supplies the separately approved release. */
export function createDraftModelRoute(): DraftModelRouteConfig {
  const adapter = new AzureLunaModelAdapter();
  return { ...createAzureDraftModelRoute(adapter), reservationist: createInstalledReservationistProvider(adapter) };
}
