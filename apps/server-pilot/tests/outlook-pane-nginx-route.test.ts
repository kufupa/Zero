import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nginx = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');

describe('Outlook pane Nginx route', () => {
  it('canonicalizes slash form and blocks pane subpaths before the permissive SPA fallback', () => {
    const tlsServerStart = nginx.indexOf('listen 443 ssl default_server;');
    const paneStart = nginx.indexOf('location = /outlook-pane {', tlsServerStart);
    const slashRedirect = nginx.indexOf('location = /outlook-pane/ {', paneStart);
    const slashPrefix = nginx.indexOf('location ^~ /outlook-pane/ {', slashRedirect);
    const spaFallback = nginx.indexOf('location / {', paneStart);

    expect(tlsServerStart).toBeGreaterThanOrEqual(0);
    expect(paneStart).toBeGreaterThan(tlsServerStart);
    expect(slashRedirect).toBeGreaterThan(paneStart);
    expect(slashPrefix).toBeGreaterThan(slashRedirect);
    expect(spaFallback).toBeGreaterThan(slashPrefix);
    expect(nginx).toMatch(
      /location = \/outlook-pane\/ \{\s*return 308 \/outlook-pane\$is_args\$args;\s*\}/,
    );
    expect(nginx).toMatch(/location \^~ \/outlook-pane\/ \{\s*return 404;\s*\}/);
  });

  it('answers the pane build check with uncached JSON under the pane connect-src, before the SPA fallback', () => {
    const paneStart = nginx.indexOf('location = /outlook-pane {');
    const paneEnd = nginx.indexOf('}', paneStart);
    const pane = nginx.slice(paneStart, paneEnd);
    const version = nginx.indexOf('location = /pane-version.json {');
    const spaFallback = nginx.indexOf('location / {');

    expect(pane).toContain("connect-src 'self'");
    expect(version).toBeGreaterThan(paneStart);
    expect(spaFallback).toBeGreaterThan(version);
    expect(nginx.slice(version, spaFallback)).toMatch(
      /location = \/pane-version\.json \{\s*default_type application\/json;\s*return 200 '\{"release":"__NAVA_RELEASE_ID__","build":"__NAVA_PANE_BUILD__"\}';[\s\S]*?expires -1;\s*\}/,
    );
  });

  it('rejects case variants of the pane URL and its subpaths before the SPA fallback', () => {
    const tlsServerStart = nginx.indexOf('listen 443 ssl default_server;');
    const paneStart = nginx.indexOf('location = /outlook-pane {', tlsServerStart);
    const caseGuard = nginx.indexOf('location ~* ^/outlook-pane(?:/|$) {', paneStart);
    const spaFallback = nginx.indexOf('location / {', paneStart);

    expect(caseGuard).toBeGreaterThan(paneStart);
    expect(spaFallback).toBeGreaterThan(caseGuard);
    expect(nginx).toMatch(/location ~\* \^\/outlook-pane\(\?:\/\|\$\) \{\s*return 404;\s*\}/);
  });
});
