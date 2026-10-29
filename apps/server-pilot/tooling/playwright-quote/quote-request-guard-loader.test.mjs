import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsxRoot = dirname(createRequire(import.meta.url).resolve('tsx/package.json'));

async function fixture(t, { loader = true, source = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nava-quote-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = join(root, 'tooling', 'playwright-quote');
  const modules = join(root, 'node_modules');
  const dist = join(root, 'dist', 'hms');
  await Promise.all([mkdir(tools, { recursive: true }), mkdir(modules), mkdir(dist, { recursive: true })]);
  await Promise.all([
    copyFile(join(here, 'quote-request-guard.mjs'), join(tools, 'quote-request-guard.mjs')),
    copyFile(join(here, 'session-reuse.mjs'), join(tools, 'session-reuse.mjs')),
    ...['live-read-manifest', 'request-policy', 'browser-artifacts'].map((name) =>
      writeFile(join(dist, `${name}.js`), "throw new Error('stale dist was used');\n")),
  ]);
  if (source) await symlink(join(serverRoot, 'src'), join(root, 'src'), 'dir');
  if (loader) await symlink(tsxRoot, join(modules, 'tsx'), 'dir');
  else {
    // An installed package without the loader API masks any ancestor installation.
    await mkdir(join(modules, 'tsx'));
    await writeFile(join(modules, 'tsx', 'package.json'), JSON.stringify({ name: 'tsx', exports: {} }));
  }
  return pathToFileURL(join(tools, 'quote-request-guard.mjs')).href;
}

function plainNode(script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH },
  });
}

test('plain-node guard uses current source even when dist is stale', async (t) => {
  const guardUrl = await fixture(t);
  const child = plainNode(`
    import { prepareQuoteRequestPolicy } from ${JSON.stringify(guardUrl)};
    const property = { active: true, propertyCode: 'HRCEN', expectedTenant: 'THECENTURION_PRD',
      expectedPropertyName: 'Fixture hotel', username: 'fixture', browserSlot: 'centurion' };
    const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
    const secret = { ...property, loginUrl: origin + '/web/base/logindisp',
      expectedPropertyCode: property.propertyCode };
    const policy = await prepareQuoteRequestPolicy({ property, secret });
    const body = new URLSearchParams({ tenant: property.expectedTenant,
      userid: '{"action":"save","action":"search"}', password: 'fixture-only' }).toString();
    const calls = [];
    const route = { request: () => ({ url: () => origin + '/web/base/login', method: () => 'POST',
      resourceType: () => 'xhr', headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
      postData: () => body, redirectedFrom: () => null }),
      abort: async () => calls.push('abort'), continue: async () => calls.push('continue') };
    const decision = await policy.enforce(route, policy.manifest);
    console.log(JSON.stringify({ action: decision.action, code: decision.code, calls }));
  `);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { action: 'block', code: 'malformed_json', calls: ['abort'] });
});

for (const missing of ['loader', 'source']) {
  test(`plain-node guard fails closed when ${missing} is unavailable`, async (t) => {
    const guardUrl = await fixture(t, { [missing]: false });
    const child = plainNode(`
      import { prepareQuoteRequestPolicy } from ${JSON.stringify(guardUrl)};
      try {
        await prepareQuoteRequestPolicy({ property: {}, secret: {} });
        throw new Error('policy unexpectedly loaded');
      } catch (error) {
        if (error.message !== 'HMS_QUOTE_CANONICAL_POLICY_UNAVAILABLE') throw error;
        console.log(error.message);
      }
    `);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'HMS_QUOTE_CANONICAL_POLICY_UNAVAILABLE');
  });
}
