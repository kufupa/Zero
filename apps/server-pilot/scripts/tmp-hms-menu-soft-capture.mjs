/**
 * Soft-capture blocks while expanding Front Desk / opening Guest Stay.
 */
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { requireHmsWorkerRuntimeConfig } from '../dist/env.js';
import { loadHmsReadRoleProof } from '../dist/hms/production-runtime.js';
import { hmsSecretSchema } from '../dist/hms/runtime.js';
import { buildLiveGuestStayReadManifest } from '../dist/hms/live-read-manifest.js';
import { evaluateObservedRequest } from '../dist/hms/request-policy.js';

const cfg = requireHmsWorkerRuntimeConfig({
  ...process.env,
  HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
});
await loadHmsReadRoleProof(cfg.roleProofPath);
const sm = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'af-south-1',
});
const secret = hmsSecretSchema.parse(
  JSON.parse(
    (
      await sm.send(
        new GetSecretValueCommand({ SecretId: cfg.secretArn }),
      )
    ).SecretString,
  ),
);
const origin = new URL(secret.loginUrl).origin;
const manifest = buildLiveGuestStayReadManifest(origin);
const blocks = [];
const browser = await chromium.launch({
  executablePath: cfg.chromiumExecutablePath,
  headless: true,
});
const context = await browser.newContext();
await context.route('**/*', async (route) => {
  const req = route.request();
  const decision = evaluateObservedRequest(manifest, {
    method: req.method(),
    url: req.url(),
    resourceType: req.resourceType(),
    headers: req.headers(),
    postData: req.postData(),
    redirectedFrom: req.redirectedFrom()?.url() ?? null,
  });
  if (decision.action === 'block') {
    const u = new URL(req.url());
    blocks.push({
      code: decision.code,
      method: req.method(),
      path: u.pathname,
      rt: req.resourceType(),
      qk: [...u.searchParams.keys()].sort(),
      bk:
        decision.redactedSignature?.bodyKeys ??
        [],
    });
  }
  await route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await page.goto(secret.loginUrl, { timeout: 30_000 });
await page
  .locator('input[name=userid], input[name=username]')
  .first()
  .fill(secret.username);
await page.locator('input[name=password]').fill(secret.password);
await Promise.all([
  page.waitForURL(/COMMON/i, { timeout: 30_000 }).catch(() => undefined),
  page
    .getByRole('button', { name: 'Sign in' })
    .click()
    .catch(() => page.locator('input[name=password]').press('Enter')),
]);
await page.waitForTimeout(3000);
const before = blocks.length;
await page.getByText('Front Desk', { exact: true }).first().click({
  force: true,
  timeout: 10_000,
});
await page.waitForTimeout(2000);
const afterFd = blocks.slice(before);
await page
  .getByText('Guest Stay', { exact: true })
  .first()
  .click({ force: true, timeout: 10_000 })
  .catch(() => undefined);
await page.waitForTimeout(4000);
const afterGs = blocks.slice(before);
const uniq = [];
const seen = new Set();
for (const b of afterGs) {
  const k = `${b.method} ${b.path} ${b.code}`;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(b);
}
const hasSearch = await page
  .locator('input[name=search], input[name=ff_confirmationnumber]')
  .count();
console.log(
  JSON.stringify(
    {
      afterFdCount: afterFd.length,
      afterGsCount: afterGs.length,
      uniqueBlocks: uniq.slice(0, 40),
      hasSearch,
      path: new URL(page.url()).pathname,
    },
    null,
    2,
  ),
);
await browser.close();
