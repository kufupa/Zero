/**
 * Development-only Node egress sentinel for deterministic connected reads.
 *
 * Use with `node --import ./scripts/hms-deterministic-egress-sentinel.mjs ...`.
 * It patches this Node process' fetch/http/https entry points only. It is not
 * an OS firewall and does not cover Chromium, child processes, net/tls calls,
 * DNS, or traffic started outside this process.
 *
 * No URL, query, header, credential, or payload is retained. The private
 * artifact contains counters only. Set HMS_EGRESS_SENTINEL_OUT to choose its
 * path; otherwise apps/server-pilot/.private receives the counter artifact.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import https from 'node:https';
import http from 'node:http';

const SCHEMA_VERSION = 'hms-deterministic-egress-sentinel/v1';
const STATE_KEY = Symbol.for('zero.hms.deterministic-egress-sentinel');
const DEFAULT_PMS_ORIGIN = 'https://appsrv-1.legacyhotels.co.za';
const DEFAULT_ARTIFACT_PATH = fileURLToPath(
  new URL('../.private/hms-deterministic-egress-sentinel.json', import.meta.url),
);

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  const value = host.trim().toLowerCase();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function normalizeProtocol(protocol, fallback) {
  if (typeof protocol !== 'string' || protocol.length === 0) return fallback;
  return protocol.endsWith(':') ? protocol.toLowerCase() : `${protocol.toLowerCase()}:`;
}

function parseConfiguredOrigins() {
  const origins = new Map([[DEFAULT_PMS_ORIGIN, 'pms']]);
  const configured = process.env.HMS_EGRESS_ALLOWED_ORIGINS?.trim();
  if (!configured) return origins;

  for (const value of configured.split(/[\s,]+/u)) {
    if (!value) continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('invalid HMS_EGRESS_ALLOWED_ORIGINS entry');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('HMS_EGRESS_ALLOWED_ORIGINS must contain http(s) origins only');
    }
    origins.set(parsed.origin, 'configured');
  }
  return origins;
}

function secretsManagerHosts() {
  const region = (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'af-south-1').trim();
  if (!/^[a-z0-9-]+$/iu.test(region)) throw new Error('invalid AWS region for egress sentinel');
  const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  return new Set([`secretsmanager.${region}.${suffix}`, `secretsmanager-fips.${region}.${suffix}`]);
}

function classifyUrl(url, origins, secretsHosts) {
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin === 'null') {
    return { allowed: false, reason: 'unsupported_target' };
  }

  const configuredCategory = origins.get(url.origin);
  if (configuredCategory) return { allowed: true, category: configuredCategory };

  const host = normalizeHost(url.hostname);
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return { allowed: true, category: 'localhost' };
  }

  if (
    url.protocol === 'https:' &&
    (url.port === '' || url.port === '443') &&
    secretsHosts.has(host)
  ) {
    return { allowed: true, category: 'aws-secrets-manager' };
  }

  if (
    url.protocol === 'http:' &&
    (url.port === '' || url.port === '80') &&
    (host === '169.254.169.254' || host === 'fd00:ec2::254')
  ) {
    return { allowed: true, category: 'aws-ec2-imds' };
  }

  return { allowed: false, reason: 'origin_not_approved' };
}

function hostAuthority(host, port) {
  const value = String(host ?? '').trim();
  if (!value) return 'localhost';
  const bracketedIpv6 = value.startsWith('[') && value.includes(']');
  const ipv6 = !bracketedIpv6 && value.split(':').length > 2;
  const authority = ipv6 ? `[${value}]` : value;
  return port === undefined || port === null || port === ''
    ? authority
    : `${authority}:${String(port)}`;
}

function isOptions(value) {
  return value !== null && typeof value === 'object' && !(value instanceof URL);
}

function requestUrl(kind, args) {
  const first = args[0];
  const second = isOptions(args[1]) ? args[1] : undefined;
  const options = isOptions(first) ? first : second;
  if (options && 'socketPath' in options)
    throw new Error('socket target is not an approved origin');
  const fallbackProtocol = kind === 'https' ? 'https:' : 'http:';
  let target;

  if (typeof first === 'string' || first instanceof URL) {
    target = new URL(String(first));
  } else if (options) {
    const protocol = normalizeProtocol(options.protocol, fallbackProtocol);
    if ('socketPath' in options) throw new Error('socket target is not an approved origin');
    target = new URL(
      `${protocol}//${hostAuthority(options.hostname ?? options.host ?? 'localhost', options.port)}/`,
    );
  } else {
    throw new Error('request target is not an absolute URL or options object');
  }

  if (options) {
    const protocol = normalizeProtocol(options.protocol, target.protocol);
    const host = options.hostname ?? options.host;
    if (host !== undefined || options.port !== undefined || protocol !== target.protocol) {
      target = new URL(
        `${protocol}//${hostAuthority(host ?? target.hostname, options.port ?? target.port)}/`,
      );
    }
  }
  return target;
}

const existingState = globalThis[STATE_KEY];
const sentinelState = existingState ?? {
  schemaVersion: SCHEMA_VERSION,
  processLocalOnly: true,
  browserProcessCovered: false,
  allowedAttemptCount: 0,
  blockedAttemptCount: 0,
  allowedByCategory: {},
  blockedByInterface: {},
  blockedByReason: {},
};

if (!existingState) {
  const origins = parseConfiguredOrigins();
  const secretsHosts = secretsManagerHosts();
  const artifactPath = process.env.HMS_EGRESS_SENTINEL_OUT?.trim() || DEFAULT_ARTIFACT_PATH;

  function artifact() {
    return {
      schemaVersion: sentinelState.schemaVersion,
      processLocalOnly: sentinelState.processLocalOnly,
      browserProcessCovered: sentinelState.browserProcessCovered,
      allowedAttemptCount: sentinelState.allowedAttemptCount,
      blockedAttemptCount: sentinelState.blockedAttemptCount,
      allowedByCategory: { ...sentinelState.allowedByCategory },
      blockedByInterface: { ...sentinelState.blockedByInterface },
      blockedByReason: { ...sentinelState.blockedByReason },
    };
  }

  function flushArtifact() {
    mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o700 });
    writeFileSync(artifactPath, `${JSON.stringify(artifact())}\n`, { mode: 0o600 });
    try {
      chmodSync(artifactPath, 0o600);
    } catch {
      // Artifact write succeeded; restrictive mode is best effort on odd filesystems.
    }
  }

  function record(interfaceName, decision) {
    if (decision.allowed) {
      sentinelState.allowedAttemptCount += 1;
      increment(sentinelState.allowedByCategory, decision.category);
      return;
    }
    sentinelState.blockedAttemptCount += 1;
    increment(sentinelState.blockedByInterface, interfaceName);
    increment(sentinelState.blockedByReason, decision.reason);
    flushArtifact();
    throw new Error(`deterministic egress blocked (${interfaceName}; ${decision.reason})`);
  }

  function classifyHttp(interfaceName, kind, args) {
    let target;
    try {
      target = requestUrl(kind, args);
    } catch {
      record(interfaceName, { allowed: false, reason: 'invalid_target' });
      return null;
    }
    const decision = classifyUrl(target, origins, secretsHosts);
    record(interfaceName, decision);
    return target;
  }

  if (typeof globalThis.fetch === 'function') {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = function sentinelFetch(input, init) {
      let target;
      try {
        const value =
          typeof input === 'string' || input instanceof URL
            ? input
            : input && typeof input.url === 'string'
              ? input.url
              : null;
        target = new URL(String(value));
      } catch {
        record('fetch', { allowed: false, reason: 'invalid_target' });
      }
      record('fetch', classifyUrl(target, origins, secretsHosts));
      // Native fetch follows redirects internally without calling this wrapper.
      // Return the redirect response; no unchecked second origin is contacted.
      return Reflect.apply(nativeFetch, this, [input, { ...init, redirect: 'manual' }]);
    };
  }

  function wrap(module, method, interfaceName, kind) {
    const native = module[method];
    module[method] = function sentinelRequest(...args) {
      classifyHttp(interfaceName, kind, args);
      return Reflect.apply(native, this, args);
    };
  }

  wrap(http, 'request', 'http.request', 'http');
  wrap(http, 'get', 'http.get', 'http');
  wrap(https, 'request', 'https.request', 'https');
  wrap(https, 'get', 'https.get', 'https');
  syncBuiltinESMExports();

  process.once('exit', flushArtifact);
  globalThis[STATE_KEY] = sentinelState;
}

export { sentinelState };
