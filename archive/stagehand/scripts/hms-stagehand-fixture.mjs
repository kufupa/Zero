#!/usr/bin/env node

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SDK = path.resolve(HERE, '../tooling/stagehand');
const SAFETY_MS = 10 * 60 * 1000;

function usage() {
  console.error('usage: node hms-stagehand-fixture.mjs --mode owner|probe [--sdk PATH] [flags]');
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help') return { help: true };
    if (!argv[i]?.startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    out[argv[i].slice(2)] = value;
    i += 1;
  }
  return out;
}

function port(value, label, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${label} must be port 1..65535`);
  return n;
}

function loopback(value, label) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  )
    throw new Error(`${label} must be an HTTP(S) loopback URL`);
  return url;
}

function loadSdk(input) {
  const root = path.resolve(input);
  const modules = path.basename(root) === 'node_modules' ? root : path.join(root, 'node_modules');
  const requireFromSdk = createRequire(path.join(modules, 'hms-stagehand-fixture.cjs'));
  const playwright = requireFromSdk('playwright');
  // Stagehand 4.1.0 exports import/types only; use the pinned SDK file directly.
  const entry = path.join(modules, '@browserbasehq/stagehand/dist/index.mjs');
  return import(pathToFileURL(entry).href).then((stagehand) => ({
    chromium: (playwright.default ?? playwright).chromium,
    extensionDir: path.join(path.dirname(entry), 'extension'),
    localBrowser: stagehand.localBrowser,
    Stagehand: stagehand.Stagehand,
    sdkPath: root,
  }));
}

async function privateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

function reply(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function fixture(marker) {
  const counters = {
    requestsReceived: 0,
    readRequests: 0,
    writeRequests: 0,
    traceRequests: 0,
    statusRequests: 0,
    unexpectedRequests: 0,
    nonLoopbackRequests: 0,
  };
  const html = `<!doctype html><html data-proof-session="${marker}"><body>
    <h1>Synthetic Stagehand transport fixture</h1>
    <button id="read" type="button" onclick="fetch('/read',{method:'POST'})">Read</button>
    <button id="write" type="button" onclick="fetch('/write',{method:'POST'})">Write</button>
  </body></html>`;
  const server = createServer((request, response) => {
    counters.requestsReceived += 1;
    if (!isLoopback(request.socket.remoteAddress)) {
      counters.nonLoopbackRequests += 1;
      request.resume();
      return reply(response, 403, { error: 'loopback_only' });
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    if (pathname === '/' && method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(html);
    }
    if (pathname === '/read' && method === 'POST') {
      counters.readRequests += 1;
      request.resume();
      return reply(response, 200, { kind: 'synthetic_read', value: 'read-ok' });
    }
    if (pathname === '/write' && method === 'POST') {
      counters.writeRequests += 1;
      request.resume();
      return reply(response, 403, { error: 'synthetic_write_forbidden' });
    }
    if (pathname === '/v1/traces' && method === 'POST') {
      counters.traceRequests += 1;
      request.resume();
      response.writeHead(204);
      return response.end();
    }
    if (pathname === '/status' && method === 'GET') {
      counters.statusRequests += 1;
      return reply(response, 200, counters);
    }
    counters.unexpectedRequests += 1;
    request.resume();
    return reply(response, 404, { error: 'unexpected_fixture_request' });
  });
  return { server, counters };
}

async function listen(server, portNumber) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(portNumber, '127.0.0.1', resolve);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(url, label) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`${label} did not become reachable`);
}

async function findExtension(context, cdp) {
  for (let i = 0; i < 100; i += 1) {
    for (const worker of context.serviceWorkers()) {
      const match = worker.url().match(/^chrome-extension:\/\/([^/]+)/);
      if (match) return match[1];
    }
    try {
      const targets = await (await fetch(new URL('/json/list', cdp))).json();
      for (const target of targets) {
        const match = target.url?.match(/^chrome-extension:\/\/([^/]+)/);
        if (target.type === 'service_worker' && match) return match[1];
      }
    } catch {}
    await sleep(100);
  }
  throw new Error('preloaded Stagehand extension service worker not found');
}

async function owner(options) {
  const sdk = await loadSdk(options.sdk ?? process.env.HMS_STAGEHAND_SDK_ROOT ?? DEFAULT_SDK);
  const httpPort = port(options['http-port'], 'http-port', 19224);
  const cdpPort = port(options['cdp-port'], 'cdp-port', 19223);
  const approvedExtensionId = options['extension-id'];
  if (!/^[a-p]{32}$/.test(approvedExtensionId ?? '')) throw new Error('owner needs exact extension-id');
  if (httpPort === cdpPort) throw new Error('http-port and cdp-port must differ');
  const output = path.resolve(
    options.output ??
      process.env.HMS_STAGEHAND_FIXTURE_META ??
      path.join(os.tmpdir(), `hms-stagehand-fixture-${process.pid}.json`),
  );
  const videoDir = path.resolve(options['video-dir'] ?? path.join(path.dirname(output), 'video'));
  const userDataDir = path.resolve(
    options['user-data-dir'] ?? path.join(os.tmpdir(), `hms-stagehand-profile-${process.pid}`),
  );
  const marker = `hms-stagehand-fixture-${randomUUID()}`;
  const fixtureUrl = new URL(`http://127.0.0.1:${httpPort}/`);
  const cdp = new URL(`http://127.0.0.1:${cdpPort}`);
  const { server, counters } = fixture(marker);
  const blocked = [];
  let context;
  let video;
  let closing;
  let metadata = {
    schemaVersion: 'hms-stagehand-fixture/v1',
    mode: 'owner',
    phase: 'starting',
    marker,
    fixtureUrl: fixtureUrl.href,
    telemetryUrl: new URL('/v1/traces', fixtureUrl).href,
    cdpUrl: cdp.href,
    httpPort,
    cdpPort,
    output,
    videoDir,
    userDataDir,
    sdkPath: sdk.sdkPath,
    extensionDir: sdk.extensionDir,
    startedAt: new Date().toISOString(),
  };
  const proof = () => ({
    ...metadata,
    counters,
    routeBlocked: blocked.length,
    routeBlockedPaths: blocked.slice(0, 12),
  });
  const shutdown = (reason) => {
    if (closing) return closing;
    closing = (async () => {
      metadata = { ...metadata, phase: 'closing', closeReason: reason };
      try {
        await context?.close();
      } finally {
        if (video) metadata = { ...metadata, videoPath: await video.path().catch(() => null) };
        await closeServer(server);
        await privateJson(output, {
          ...proof(),
          phase: 'closed',
          closedAt: new Date().toISOString(),
        });
      }
    })();
    return closing;
  };
  await listen(server, httpPort);
  try {
    await mkdir(videoDir, { recursive: true, mode: 0o700 });
    context = await sdk.chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
      args: [
        '--enable-unsafe-extension-debugging',
        `--remote-allow-origins=chrome-extension://${approvedExtensionId}`,
        `--disable-extensions-except=${sdk.extensionDir}`,
        `--load-extension=${sdk.extensionDir}`,
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${cdpPort}`,
      ],
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const allowed =
        url.origin === fixtureUrl.origin &&
        ((url.pathname === '/' && request.method() === 'GET') ||
          (url.pathname === '/read' && request.method() === 'POST') ||
          (url.pathname === '/status' && request.method() === 'GET') ||
          (url.pathname === '/v1/traces' && request.method() === 'POST'));
      if (allowed) return route.continue();
      blocked.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient').catch(() => {});
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(fixtureUrl.href, { waitUntil: 'load' });
    await waitFor(new URL('/json/version', cdp), 'private CDP');
    const extensionId = await findExtension(context, cdp);
    if (extensionId !== approvedExtensionId) throw new Error('extension identity mismatch');
    video = page.video();
    metadata = {
      ...metadata,
      phase: 'ready',
      extensionId,
      videoPath: null,
      readyAt: new Date().toISOString(),
    };
    await privateJson(output, proof());
    console.log(
      JSON.stringify({
        mode: 'owner',
        phase: 'ready',
        marker,
        extensionId,
        fixtureUrl: fixtureUrl.href,
        cdpUrl: cdp.href,
        output,
      }),
    );
    await new Promise((resolve) => {
      const timer = setTimeout(() => void shutdown('safety_timeout'), SAFETY_MS);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('beforeExit', finish);
    });
  } catch (error) {
    await shutdown('startup_error').catch(() => {});
    throw error;
  }
}

async function probe(options) {
  const sdk = await loadSdk(options.sdk ?? process.env.HMS_STAGEHAND_SDK_ROOT ?? DEFAULT_SDK);
  const cdp = loopback(options['cdp-url'], 'cdp-url');
  const fixtureUrl = loopback(options['fixture-url'], 'fixture-url');
  const telemetry = loopback(
    options['telemetry-url'] ?? new URL('/v1/traces', fixtureUrl),
    'telemetry-url',
  );
  const extensionId = options['extension-id'];
  const markerExpected = options.marker;
  if (!extensionId || !markerExpected) throw new Error('probe needs --extension-id and --marker');
  const output = path.resolve(
    options.output ?? path.join(os.tmpdir(), `hms-stagehand-probe-${process.pid}.json`),
  );
  let browser;
  let stagehand;
  let failure;
  let modelCalls = 0;
  let pageUrl;
  let markerObserved;
  let snapshotText = '';
  let readResult;
  let writeResult;
  let status;
  let stagehandClosed = false;
  try {
    browser = await sdk.localBrowser.connect({ cdpUrl: cdp.href, extensionId });
    stagehand = await sdk.Stagehand.create({
      browser,
      cache: false,
      selfHeal: false,
      logging: { level: 'off' },
      telemetry: { traces: { endpoint: telemetry.href } },
      model: {
        generate: async () => {
          modelCalls += 1;
          throw new Error('MODEL_CALL_FORBIDDEN');
        },
      },
    });
    let page;
    for (const candidate of await browser.context.pages()) {
      const candidateUrl = await candidate.url();
      if (candidateUrl === fixtureUrl.href) {
        page = candidate;
        pageUrl = candidateUrl;
        break;
      }
    }
    if (!page) throw new Error('exact synthetic fixture page not found');
    markerObserved = await page.evaluate(
      () => document.documentElement.dataset.proofSession || null,
    );
    snapshotText = (await page.snapshot({ includeIframes: false })).formattedTree;
    readResult = await page.evaluate(async () => {
      const response = await fetch('/read', { method: 'POST' });
      return { ok: response.ok, body: await response.text() };
    });
    writeResult = await page.evaluate(async () => {
      try {
        const response = await fetch('/write', { method: 'POST' });
        return { blocked: false, status: response.status };
      } catch {
        return { blocked: true };
      }
    });
    status = await page.evaluate(async () => (await fetch('/status')).json());
    if (
      markerObserved !== markerExpected ||
      !snapshotText.includes('Read') ||
      !snapshotText.includes('Write')
    )
      throw new Error('synthetic marker/controls proof failed');
    if (!readResult.ok || !readResult.body.includes('read-ok'))
      throw new Error('synthetic read proof failed');
    if (status.writeRequests !== 0 || status.unexpectedRequests !== 0)
      throw new Error('server saw forbidden/unexpected request');
  } catch (error) {
    failure = error;
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
        stagehandClosed = true;
      } catch (error) {
        failure ??= error;
      }
    }
  }
  let browserReachable = false;
  try {
    browserReachable = (await fetch(new URL('/json/version', cdp))).ok;
  } catch {}
  const proof = {
    schemaVersion: 'hms-stagehand-fixture/v1',
    mode: 'probe',
    cdpUrl: cdp.href,
    fixtureUrl: fixtureUrl.href,
    telemetryUrl: telemetry.href,
    extensionId,
    markerExpected,
    markerObserved,
    exactPage: pageUrl === fixtureUrl.href,
    snapshotHasReadWrite: snapshotText.includes('Read') && snapshotText.includes('Write'),
    readSucceeded: Boolean(readResult?.ok && readResult.body.includes('read-ok')),
    writeBlocked: Boolean(writeResult?.blocked),
    server: status,
    modelCalls,
    noModelCalls: modelCalls === 0,
    stagehandClosed,
    browserReachable,
    failure: failure ? String(failure.message ?? failure) : null,
    recordedAt: new Date().toISOString(),
  };
  await privateJson(output, proof);
  console.log(JSON.stringify({ ...proof, output }));
  return failure ||
    !proof.exactPage ||
    !proof.readSucceeded ||
    !proof.writeBlocked ||
    !proof.noModelCalls ||
    !proof.stagehandClosed ||
    !browserReachable
    ? 1
    : 0;
}

let options;
try {
  options = parse(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }
  if (!options.mode || !['owner', 'probe'].includes(options.mode))
    throw new Error('mode must be owner or probe');
  const allowed =
    options.mode === 'owner'
      ? new Set(['mode', 'sdk', 'output', 'http-port', 'cdp-port', 'video-dir', 'user-data-dir', 'extension-id'])
      : new Set([
          'mode',
          'sdk',
          'output',
          'cdp-url',
          'fixture-url',
          'telemetry-url',
          'extension-id',
          'marker',
        ]);
  for (const key of Object.keys(options))
    if (!allowed.has(key)) throw new Error(`unsupported ${options.mode} option: --${key}`);
  if (options.mode === 'owner') await owner(options);
  else process.exit(await probe(options));
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
