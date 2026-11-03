import {
  centurionBrowserIdentity,
  closeCenturionResources,
  prepareCenturionLaunch,
} from './centurion-stay360.mjs';

/** Use a private read-only quote browser if the configured Centurion CDP owner is absent. */
export function createQuoteBrowserConnector({ propertyCode, chromium, env = process.env,
  prepare = prepareCenturionLaunch, identify = centurionBrowserIdentity,
  closeOwned = closeCenturionResources }) {
  let owned;
  const close = async (context) => {
    if (!owned) return false;
    const resources = { ...owned, context };
    owned = undefined;
    await closeOwned(resources);
    return true;
  };
  return {
    async connect(href, options) {
      // The borrowed attach helper retries after it closes an unsuccessful
      // connection. Dispose its owned fallback before the next attempt.
      await close();
      try {
        return await chromium.connectOverCDP(href, options);
      } catch (error) {
        if (propertyCode !== 'HRCEN' || !/\bECONNREFUSED\b/.test(String(error?.message ?? ''))) throw error;
      }
      await prepare();
      const server = await chromium.launchServer({ headless: true, host: '127.0.0.1',
        executablePath: env.HMS_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined });
      // Retain even a partially opened server for the caller's finally block.
      owned = { server };
      owned.processIdentity = identify(server.process()?.pid);
      owned.processGroup = owned.processIdentity.pid;
      const browser = await chromium.connect(server.wsEndpoint(), { timeout: options?.timeout ?? 30_000 });
      owned.browser = browser;
      return browser;
    },
    close,
  };
}
