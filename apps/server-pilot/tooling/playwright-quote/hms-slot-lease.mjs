/**
 * Exclusive authenticated page lease around a persistent HMS slot.
 * Importing this module does not launch a browser or touch credentials.
 */
import {
  assertPropertyReadConnectionHeld,
  propertyReadLockKey,
} from '../../src/hms/property-read-lock.ts';
import { findReusableAuthenticatedPage, login, newBorrowedContext } from './session-reuse.mjs';
import { persistentBrowserContext, persistentContextPages } from './slot-owner.mjs';

export class SlotLeaseRefusedError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SlotLeaseRefusedError';
    this.code = code;
    this.payload = undefined;
  }
}

function refuse(code, message) {
  throw new SlotLeaseRefusedError(code, message);
}

/** Prefer the persistent slot context; otherwise restore 0600 storageState. Never logs in. */
export async function contextForLease(browser, options, env) {
  return persistentBrowserContext(browser) ?? newBorrowedContext(browser, options, env);
}

/**
 * @param {object} options
 * @param {(code: string) => { propertyCode: string } | null | undefined} options.lookupProperty
 *        Registry lookup. Unknown codes fail closed. No hotel default.
 */
export function createExclusivePageLease({
  lookupProperty,
  loginPage = login,
  authenticatedShell,
  findPage = findReusableAuthenticatedPage,
  contextPages = persistentContextPages,
  assertLockHeld = assertPropertyReadConnectionHeld,
  lockKeyFor = propertyReadLockKey,
} = {}) {
  if (typeof lookupProperty !== 'function') {
    refuse('property_unknown', 'property lookup required');
  }

  let exclusive = false;
  let boundPage = null;
  let boundProperty = null;

  async function pageAuthenticated(page, secret) {
    if (!page) return false;
    if (authenticatedShell) return Boolean(await authenticatedShell(page, secret));
    return (await findPage([page], secret)) === page;
  }

  async function reusablePage(context, secret) {
    if (await pageAuthenticated(boundPage, secret)) return boundPage;
    const pages = contextPages(context);
    if (authenticatedShell) {
      for (const page of pages) {
        if (await pageAuthenticated(page, secret)) return page;
      }
      return null;
    }
    return findPage(pages, secret);
  }

  return {
    async withPage(input, run) {
      const propertyCode = typeof input?.propertyCode === 'string' ? input.propertyCode : '';
      const property = propertyCode ? lookupProperty(propertyCode) : null;
      if (!property || property.propertyCode !== propertyCode) {
        refuse('property_unknown', 'unknown property refused');
      }
      if (boundProperty && boundProperty !== propertyCode) {
        refuse('property_unknown', 'lease is bound to a different property');
      }
      if (input.secret?.expectedPropertyCode !== propertyCode) {
        refuse('property_unknown', 'secret does not match property');
      }

      const session = input.session;
      const liveGeneration = session?.generation;
      if (session?.phase !== 'ready' || !Number.isInteger(liveGeneration)) {
        refuse('stale_generation', 'stale generation refused');
      }
      if (input.generation != null && input.generation !== liveGeneration) {
        refuse('stale_generation', 'stale generation refused');
      }
      const started = liveGeneration;
      const assertGeneration = () => {
        if (session.generation !== started || session.phase !== 'ready') {
          boundPage = null;
          refuse('stale_generation', 'stale generation refused');
        }
      };

      const tenantId = typeof input.tenantId === 'string' ? input.tenantId : '';
      if (!tenantId) assertLockHeld(undefined, '0');
      const expectedKey = lockKeyFor(tenantId, propertyCode);
      if (input.lockKey != null && String(input.lockKey) !== expectedKey) {
        assertLockHeld(undefined, expectedKey);
      }
      assertLockHeld(input.lockConnection, expectedKey);

      if (exclusive) refuse('lease_held', 'lease already held');
      exclusive = true;
      try {
        assertGeneration();

        const context = input.context ?? persistentBrowserContext(input.browser);
        let page = await reusablePage(context, input.secret);
        let reused = Boolean(page);
        assertGeneration();
        if (!page) {
          const createPage = context?.newPage;
          if (typeof createPage !== 'function') {
            refuse('stale_generation', 'authenticated page unavailable');
          }
          page = await createPage.call(context);
          assertGeneration();
          await loginPage(page, input.secret, input.env);
          reused = false;
        }

        assertGeneration();
        boundPage = page;
        boundProperty = propertyCode;
        const result = await run({ page, reused, property });
        assertGeneration();
        return result;
      } finally {
        exclusive = false;
      }
    },
  };
}
