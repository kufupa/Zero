import { test as setup } from '@playwright/test';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.join(__dirname, '../playwright/.auth/user.json');
const hasPlaywrightSession = Boolean(
  process.env.PLAYWRIGHT_SESSION_TOKEN && process.env.PLAYWRIGHT_SESSION_DATA,
);

setup.describe('authentication setup', () => {
  setup.skip(
    !hasPlaywrightSession,
    'Requires PLAYWRIGHT_SESSION_TOKEN and PLAYWRIGHT_SESSION_DATA',
  );

  setup('inject real authentication session', async ({ page }) => {
    const SessionToken = process.env.PLAYWRIGHT_SESSION_TOKEN;
    const SessionData = process.env.PLAYWRIGHT_SESSION_DATA;
    const cookiePrefix = process.env.PLAYWRIGHT_COOKIE_PREFIX ?? 'better-auth-dev';

    if (!SessionToken || !SessionData) {
      return;
    }

    console.log('Injecting real authentication session...');
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
    const cookieDomain = new URL(baseUrl).hostname;
    const cookieSecure = baseUrl.startsWith('https:');

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('Page loaded, setting up authentication...');

    // sets better auth session cookies
    await page.context().addCookies([
      {
        name: `${cookiePrefix}.session_token`,
        value: SessionToken,
        domain: cookieDomain,
        path: '/',
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'Lax',
      },
      {
        name: `${cookiePrefix}.session_data`,
        value: SessionData,
        domain: cookieDomain,
        path: '/',
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'Lax',
      },
    ]);

    console.log('Real session cookies injected');

    try {
      const decodedSessionData = JSON.parse(atob(SessionData));

      await page.addInitScript((sessionData) => {
        if (sessionData.session) {
          localStorage.setItem('better-auth.session', JSON.stringify(sessionData.session.session));
          localStorage.setItem('better-auth.user', JSON.stringify(sessionData.session.user));
        }
      }, decodedSessionData);

      console.log('Session data set in localStorage');
    } catch (error) {
      console.log('Could not decode session data for localStorage:', error);
    }

    await page.goto('/mail/inbox');
    await page.waitForLoadState('domcontentloaded');

    const currentUrl = page.url();
    console.log('Current URL after clicking Get Started:', currentUrl);

    if (currentUrl.includes('/mail')) {
      console.log('Successfully reached mail app! On:', currentUrl);
    } else {
      console.log('Did not reach mail app. Current URL:', currentUrl);
      await page.screenshot({ path: 'debug-auth-failed.png' });
    }

    await page.context().storageState({ path: authFile });

    console.log('Real authentication session injected and saved!');
  });
});
