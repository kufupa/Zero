/** Development-only persistent browser composition; HMS retains all guards. */
import { createPlaywrightBrowserFactory, type BrowserFactory } from './runtime.js';
import type { BrowserContext, BrowserType } from 'playwright';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

export type StagehandBrowserFactoryOptions = {
  profileRoot: string;
  extensionDir: string;
  /** Exact unpacked extension ID used by the v4 CDP/WebSocket client. */
  extensionId: string;
  cdpPort: number;
  /** Supply the isolated pinned Playwright build, never an implicit global upgrade. */
  launchPersistentContext?: BrowserType['launchPersistentContext'];
  /** Trusted owner may inspect extension identity after setting up the proof lease. */
  onContextCreated?: (context: BrowserContext) => void;
  /** Flush post-login recording before policy teardown destroys the page. Bounded to 5s. */
  onBeforeContextClose?: (context: BrowserContext) => Promise<void>;
};

export function createStagehandBrowserFactory(
  options: StagehandBrowserFactoryOptions,
): BrowserFactory {
  if (
    !isAbsolute(options.profileRoot) ||
    resolve(options.profileRoot) === parse(options.profileRoot).root
  ) {
    throw new Error('STAGEHAND_PROFILE_ROOT');
  }
  if (!isAbsolute(options.extensionDir)) throw new Error('STAGEHAND_EXTENSION_DIR');
  if (!Number.isInteger(options.cdpPort) || options.cdpPort < 1024 || options.cdpPort > 65535) {
    throw new Error('STAGEHAND_CDP_PORT');
  }
  if (!/^[a-p]{32}$/.test(options.extensionId)) throw new Error('STAGEHAND_EXTENSION_ID');
  if (!options.launchPersistentContext) throw new Error('STAGEHAND_LAUNCHER_REQUIRED');
  const launchPersistentContext = options.launchPersistentContext;

  return async (input) => {
    input.signal?.throwIfAborted();
    let ownerClosed = false;
    let occupied = false;
    let active: BrowserContext | null = null;
    let pendingSetup: Promise<void> | null = null;

    return createPlaywrightBrowserFactory({
      launchBrowser: async (browserOptions) => ({
        async newContext(contextOptions = {}) {
          input.signal?.throwIfAborted();
          if (ownerClosed) throw new Error('STAGEHAND_OWNER_CLOSED');
          if (occupied) throw new Error('STAGEHAND_CONTEXT_BUSY');
          // Set before awaiting setup so two leases cannot race for one CDP port.
          occupied = true;
          let finishSetup!: () => void;
          const setup = new Promise<void>((resolve) => {
            finishSetup = resolve;
          });
          pendingSetup = setup;
          let profile: string | undefined;
          try {
            await mkdir(options.profileRoot, { recursive: true, mode: 0o700 });
            profile = await mkdtemp(join(options.profileRoot, 'session-'));
            const context = await launchPersistentContext(profile, {
              ...contextOptions,
              ...browserOptions,
              channel: 'chromium',
              headless: true,
              acceptDownloads: false,
              serviceWorkers: 'block',
              args: [
                `--disable-extensions-except=${options.extensionDir}`,
                `--load-extension=${options.extensionDir}`,
                '--enable-unsafe-extension-debugging',
                '--enable-features=WebMCPTesting,DevToolsWebMCPSupport',
                `--remote-allow-origins=chrome-extension://${options.extensionId}`,
                '--remote-debugging-address=127.0.0.1',
                `--remote-debugging-port=${options.cdpPort}`,
              ],
            });
            const nativeClose = context.close.bind(context);
            let closePromise: Promise<void> | undefined;
            const ownedProfile = profile;
            context.close = async () => {
              closePromise ??= (async () => {
                let captureError: unknown;
                if (options.onBeforeContextClose) {
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  try {
                    await Promise.race([
                      Promise.resolve().then(() => options.onBeforeContextClose!(context)),
                      new Promise<never>((_, reject) => {
                        timer = setTimeout(
                          () => reject(new Error('STAGEHAND_PRE_CLOSE_TIMEOUT')),
                          5_000,
                        );
                      }),
                    ]);
                  } catch (error) {
                    captureError = error;
                  } finally {
                    clearTimeout(timer);
                  }
                }
                // Retain occupancy on failed close; never hand a possibly-live browser to another lease.
                await nativeClose();
                active = null;
                occupied = false;
                await rm(ownedProfile, { recursive: true, force: true });
                if (captureError) throw captureError;
              })();
              await closePromise;
            };
            active = context;
            if (input.signal?.aborted || ownerClosed) {
              await context.close();
              throw new Error('STAGEHAND_SETUP_ABORTED');
            }
            options.onContextCreated?.(context);
            return context;
          } catch (error) {
            if (active) await active.close().catch(() => undefined);
            if (!active) {
              occupied = false;
              if (profile) await rm(profile, { recursive: true, force: true });
            }
            throw error;
          } finally {
            finishSetup();
            if (pendingSetup === setup) pendingSetup = null;
          }
        },
        async close() {
          ownerClosed = true;
          if (active) await active.close();
          const setup = pendingSetup;
          if (setup) await setup;
          if (active) await active.close();
        },
      }),
    })(input);
  };
}
