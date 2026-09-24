/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import OutlookAddinDownloadPage from '../app/(routes)/settings/outlook-addin/page';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

describe('OutlookAddinDownloadPage', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders download button linking to NavaOutlookSetup.exe', () => {
    render(<OutlookAddinDownloadPage />);
    const link = screen.getByRole('link', { name: /Download Nava Outlook Assistant/i });
    expect(link.getAttribute('href')).toBe('/download/NavaOutlookSetup.exe');
  });

  it('renders the 3-step setup instructions', () => {
    render(<OutlookAddinDownloadPage />);
    expect(screen.getByText(/Step 1: Download/i)).toBeDefined();
    expect(screen.getByText(/Step 2: Run Installer/i)).toBeDefined();
    expect(screen.getByText(/Step 3: Launch Outlook/i)).toBeDefined();
  });

  it('registers outlook-addin in settings navigation', () => {
    const source = readFileSync(path.join(testsDir, '../config/navigation.ts'), 'utf8');
    expect(source).toContain("id: 'outlook-addin'");
    expect(source).toContain("url: '/settings/outlook-addin'");
  });

  it('registers the settings route before the catch-all', () => {
    const routesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app/routes.ts');
    const source = readFileSync(routesPath, 'utf8');
    const addinIndex = source.indexOf("route('/outlook-addin'");
    const catchAllIndex = source.indexOf("route('/*', '(routes)/settings/[...settings]/page.tsx')");
    expect(addinIndex).toBeGreaterThan(-1);
    expect(addinIndex).toBeLessThan(catchAllIndex);
  });

  it('maps outlook-addin in the settings catch-all page table', () => {
    const catchAllPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../app/(routes)/settings/[...settings]/page.tsx',
    );
    const source = readFileSync(catchAllPath, 'utf8');
    expect(source).toContain("'outlook-addin'");
  });
});
