---
title: Playwright E2E gate fails on EC2 against the pilot UI (cookies, browser revision, onboarding, legacy specs)
date: 2026-07-07
module: packages/testing e2e + apps/mail pilot UI
problem_type: test_failure
component: testing_framework
severity: high
related_components:
  - authentication
  - development_workflow
symptoms:
  - "Playwright run reports frontend not reachable on :3000 (dev server never started on EC2)"
  - "Injected auth session is ignored — cookies set for domain 'localhost' don't apply to the EC2 base URL / 127.0.0.1"
  - "Browser launch fails: Executable doesn't exist / Playwright browser revision mismatch"
  - "Onboarding tour modal covers the inbox so every spec times out on the first interaction"
  - "Strict-mode violation: getByText('Inbox') resolves multiple nodes"
  - "Legacy Gmail-era specs assert UI that the pilot no longer has (fail on missing elements)"
root_cause: config_error
resolution_type: test_fix
tags:
  - playwright
  - e2e
  - ec2
  - ssm
  - auth-cookies
  - onboarding
  - pilot-ui
  - flaky-locators
---

# Playwright E2E gate fails on EC2 against the pilot UI

## Problem
Running the Playwright E2E gate on EC2 (via SSM) against the live pilot UI failed
for a chain of independent reasons: the frontend wasn't up, the injected auth
cookies were pinned to `localhost`, the browser binary revision didn't match the
pinned package, an onboarding modal blocked the inbox, locators were too broad,
and several specs still targeted the old Gmail-style UI.

## Symptoms
- "frontend not up on :3000" — dev server never started in the SSM shell.
- Auth injection silently ignored — cookies scoped to `localhost` don't match the EC2 / `127.0.0.1` base URL, so the app bounced back to sign-in.
- `Executable doesn't exist` / browser revision mismatch at launch.
- Every spec times out because the onboarding tour overlays the inbox.
- `getByText('Inbox')` throws strict-mode (matches nav link + heading + folder pill).
- Legacy specs fail asserting elements the pilot UI removed.

## What Didn't Work
- **Assuming a dev server was already listening** — the SSM command runs in a bare shell; nothing starts `apps/mail` unless the gate does.
- **Hardcoded `domain: 'localhost'` in `auth.setup.ts`** — worked on a laptop, broke the moment the base URL was anything else. Cookie domain must be derived from `PLAYWRIGHT_BASE_URL`.
- **Floating `@playwright/test`** — the installed browser bundle drifted from the test runner's expected revision.
- **Broad text locators** (`getByText('Inbox')`) — fragile and strict-mode-illegal on a real page with repeated labels.
- **Keeping the old Gmail specs as-is** — the pilot uses a command palette + context menus + hotkeys, not the legacy affordances.

## Solution
Derive cookie scope from the base URL in `packages/testing/e2e/auth.setup.ts`:

```ts
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const cookieDomain = new URL(baseUrl).hostname;      // was hardcoded 'localhost'
const cookieSecure = baseUrl.startsWith('https:');   // secure only under TLS
const cookiePrefix = process.env.PLAYWRIGHT_COOKIE_PREFIX ?? 'better-auth-dev';

await page.context().addCookies([
  { name: `${cookiePrefix}.session_token`, value: SessionToken, domain: cookieDomain, path: '/', httpOnly: true, secure: cookieSecure, sameSite: 'Lax' },
  { name: `${cookiePrefix}.session_data`,  value: SessionData,  domain: cookieDomain, path: '/', httpOnly: true, secure: cookieSecure, sameSite: 'Lax' },
]);
```

- **Session minting**: the SSM run mints a real Better Auth session (POST `/api/auth/sign-in/email` using a password from Secrets Manager), then exports `PLAYWRIGHT_SESSION_TOKEN` / `PLAYWRIGHT_SESSION_DATA` and `PLAYWRIGHT_COOKIE_PREFIX=better-auth` for the gate.
- **Browser revision**: pin `"@playwright/test": "1.52.0"` in `packages/testing/package.json` and point `PLAYWRIGHT_BROWSERS_PATH=/opt/nava/playwright-browsers` on EC2 so the runner finds the matching install.
- **Onboarding + robust locators**: shared helpers in `packages/testing/e2e/helpers/mail-inbox.ts`:

```ts
export async function dismissMailOnboarding(page: Page) {
  const skipTour = page.getByRole('button', { name: 'Skip for now' });
  if (await skipTour.isVisible({ timeout: 3000 }).catch(() => false)) {
    await skipTour.click();
    return;
  }
  // legacy welcome fallback: click off the modal
}

export async function expectPilotInboxVisible(page: Page) {
  await expect(
    page.getByRole('link', { name: 'Inbox', exact: true }).first(),
  ).toBeVisible({ timeout: 15000 });
}

export async function openCommandPalette(page: Page) {
  await page.keyboard.press('Control+k');
  await expect(page.locator('[cmdk-dialog], [role="dialog"]').first()).toBeVisible({ timeout: 5000 });
}
```

- **Spec rewrites**: `mail-actions.spec.ts`, `mail-inbox.spec.ts`, `search-bar.spec.ts` retargeted to the pilot UI (command palette hotkeys, role-based `exact` locators, context menus) instead of Gmail-era selectors.

## Why This Works
Each failure was environment/config drift, not a product bug. The auth injection
is the subtle one: cookies are domain-scoped, so a `localhost`-pinned cookie is
simply not sent to a `127.0.0.1`/EC2 origin, and the app treats the request as
unauthenticated. Deriving `cookieDomain`/`cookieSecure` from the same base URL
Playwright navigates to keeps the cookie and the origin in agreement. Pinning the
runner + browser path removes revision drift; dismissing onboarding and using
`role` + `exact` + `.first()` locators removes the two biggest flake sources on a
real, populated page.

## Prevention
- **Never hardcode cookie domain/secure in test auth setup** — always derive from `PLAYWRIGHT_BASE_URL` so the same setup runs locally, on `127.0.0.1`, and behind TLS.
- **Pin `@playwright/test`** and set `PLAYWRIGHT_BROWSERS_PATH` on remote runners; treat runner and browser bundle as one pinned unit.
- **Start the frontend inside the gate** — don't assume a dev server; the SSM/EC2 shell is bare.
- **Centralize onboarding dismissal + inbox assertions** in one helper so every spec is tour-proof and uses strict-mode-safe locators (`getByRole(..., { exact: true }).first()`, not `getByText`).
- **Rewrite specs when the UI paradigm changes** (command palette / hotkeys / context menus) rather than patching legacy selectors.
- **Mint sessions from Secrets Manager** for autonomous runs instead of requiring an interactive login.

## Related
- [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](../workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — running long gates on EC2 via SSM
- [nava-fixture-loopback-e2e-harness.md](../architecture-patterns/nava-fixture-loopback-e2e-harness.md) — fixture/wire E2E harness that complements the browser gate
- `docs/superpowers/plans/2026-07-06-server-pilot-contract-convergence-sdd.md` — Task 17 (full repo, Mailpit, Playwright E2E gate)
