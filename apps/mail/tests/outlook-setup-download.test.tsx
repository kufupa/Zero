/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OutlookSetupDownloadButton } from '../components/settings/outlook-setup-download';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

describe('OutlookSetupDownloadButton', () => {
  afterEach(() => {
    cleanup();
  });

  it('sits on the right and links to the Outlook installer', () => {
    const { container } = render(<OutlookSetupDownloadButton />);
    const link = screen.getByRole('link', { name: /Download Outlook Setup/i });
    expect(link.getAttribute('href')).toBe('/download/NavaOutlookSetup.exe');
    expect(link.getAttribute('download')).toBe('NavaOutlookSetup.exe');
    expect(container.querySelector('.justify-end')).toBeTruthy();
  });

  it('opens install steps after click', () => {
    render(<OutlookSetupDownloadButton />);
    fireEvent.click(screen.getByRole('link', { name: /Download Outlook Setup/i }));
    expect(screen.getByRole('heading', { name: /Install Nava in Outlook/i })).toBeDefined();
    expect(screen.getByText(/Close Outlook/i)).toBeDefined();
    expect(screen.getByText(/NavaOutlookSetup.exe/)).toBeDefined();
    expect(screen.getByText(/click Yes/i)).toBeDefined();
    expect(screen.getByText(/Nava tab/i)).toBeDefined();
  });

  it('is mounted on the catchup upload page', () => {
    const source = readFileSync(
      path.join(testsDir, '../components/settings/catchup-upload.tsx'),
      'utf8',
    );
    expect(source).toContain('OutlookSetupDownloadButton');
  });
});
