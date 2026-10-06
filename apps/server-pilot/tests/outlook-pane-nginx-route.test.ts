import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nginx = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8');

describe('Outlook pane Nginx route', () => {
  it('keeps native read-only quote requests alive through both API proxies', () => {
    const apiLocations = [...nginx.matchAll(/location \/api\/ \{([^}]+)\}/g)];
    expect(apiLocations).toHaveLength(2);
    for (const [, body] of apiLocations) {
      expect(body).toContain('proxy_read_timeout 1250s;');
    }
  });
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
