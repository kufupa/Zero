import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const loaderSources = [
  '../app/(routes)/mail/layout.tsx',
  '../app/(routes)/mail/page.tsx',
  '../app/(routes)/mail/[folder]/page.tsx',
  '../app/(routes)/mail/create/page.tsx',
  '../app/(routes)/mail/compose/page.tsx',
  '../app/(routes)/settings/layout.tsx',
  '../app/mailto-handler.ts',
].map((path) => [path, readSource(path)] as const);

const servingHosts = ['nava.legacyhotels.co.za', 'nava-admin.trynava.io'];

function generatedBrowserFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return generatedBrowserFiles(path);
    return /\.(?:css|html|js|json|map)$/i.test(entry.name) && statSync(path).isFile()
      ? [path]
      : [];
  });
}

describe('remote host-neutral SPA contract', () => {
  it('derives all client-loader redirects from request URLs', () => {
    for (const [path, source] of loaderSources) {
      expect(source, path).toContain('new URL(request.url)');
      expect(source, path).not.toContain('VITE_PUBLIC_APP_URL');
    }
  });

  it('registers mailto handler outside the API proxy namespace', () => {
    const routes = readSource('../app/routes.ts');
    const mailto = readSource('../components/mail/mail.tsx');
    const compose = readSource('../app/(routes)/mail/compose/page.tsx');

    expect(routes).toContain("route('/mailto-handler', 'mailto-handler.ts')");
    expect(routes).not.toContain("route('/api/mailto-handler'");
    expect(mailto).toContain('`/mailto-handler?mailto=%s`');
    expect(compose).toContain("new URL('/mailto-handler', url.origin)");
    expect(compose).toContain("mailtoHandler.searchParams.set('mailto'");
    expect(compose).not.toContain('/api/mailto-handler');
  });

  it('uses current browser origin to validate navigation', () => {
    const navigation = readSource('../components/ui/nav-main.tsx');
    const constants = readSource('../lib/constants.tsx');

    expect(navigation).toContain('window.location.origin');
    expect(navigation).not.toContain('BASE_URL');
    expect(constants).not.toContain('VITE_PUBLIC_APP_URL');
    expect(constants).not.toContain('BASE_URL');
  });

  it('omits baked canonical and Open Graph hosts', () => {
    const siteConfig = readSource('../lib/site-config.ts');
    const root = readSource('../app/root.tsx');

    expect(siteConfig).not.toContain('VITE_PUBLIC_APP_URL');
    expect(siteConfig).not.toContain('alternates');
    expect(siteConfig).toContain("url: '/og.png'");
    expect(root).not.toContain("property: 'og:url'");
  });

  it('contains neither serving hostname in browser source', () => {
    const browserSources = [
      ...loaderSources.map(([, source]) => source),
      readSource('../app/routes.ts'),
      readSource('../components/mail/mail.tsx'),
      readSource('../components/ui/nav-main.tsx'),
      readSource('../lib/constants.tsx'),
      readSource('../lib/site-config.ts'),
      readSource('../app/root.tsx'),
    ];

    for (const source of browserSources) {
      expect(source).not.toContain('nava.legacyhotels.co.za');
      expect(source).not.toContain('nava-admin.trynava.io');
    }
  });

  it('contains neither serving hostname in generated browser output', () => {
    const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const clientBuild = join(appRoot, 'build', 'client');
    expect(
      existsSync(clientBuild),
      'build/client missing; run pnpm build before this generated-output check',
    ).toBe(true);
    const files = generatedBrowserFiles(clientBuild);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const host of servingHosts) {
        expect(contents, file).not.toContain(host);
      }
    }
  });
});
