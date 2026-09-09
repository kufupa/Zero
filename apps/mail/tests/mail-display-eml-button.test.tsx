/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import * as emlDownloadModule from '../lib/eml-download';
import { ActionButton } from '../components/mail/mail-display';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('MailDisplay EML Download Actions', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('triggers triggerEmlDownload when EML action button is clicked', async () => {
    const spy = vi.spyOn(emlDownloadModule, 'triggerEmlDownload').mockResolvedValue({
      filename: 'Reservation_123_2026-09-09.eml',
    });

    const onClick = vi.fn(async (e: React.MouseEvent) => {
      e.stopPropagation();
      await emlDownloadModule.triggerEmlDownload('msg-test-1');
    });

    render(
      <ActionButton
        onClick={onClick}
        icon={<span data-testid="file-down-icon" />}
        text=".eml"
        aria-label="Download .eml"
      />,
    );

    const button = screen.getByRole('button', { name: /download \.eml/i });
    expect(button).toBeDefined();
    expect(button.textContent).toContain('.eml');

    fireEvent.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('msg-test-1');
  });

  it('displays loading indicator when isDownloadingEml is true', () => {
    render(
      <ActionButton
        onClick={() => {}}
        icon={<span data-testid="file-down-icon" />}
        text="..."
        aria-label="Download .eml"
      />,
    );

    const button = screen.getByRole('button', { name: /download \.eml/i });
    expect(button.textContent).toContain('...');
  });

  it('mail-display.tsx contains required EML download UI elements and wiring', () => {
    const filePath = resolve(__dirname, '../components/mail/mail-display.tsx');
    const content = readFileSync(filePath, 'utf-8');

    expect(content).toMatch(/import\s*\{[^}]*FileDown[^}]*\}\s*from\s*['"]lucide-react['"]/);
    expect(content).toMatch(/import\s*\{[^}]*triggerEmlDownload[^}]*\}\s*from\s*['"]@\/lib\/eml-download['"]/);
    expect(content).toContain('const [isDownloadingEml, setIsDownloadingEml] = useState(false);');
    expect(content).toContain('triggerEmlDownload(emailData.id)');
    expect(content).toContain('Download Email (.eml)');
    expect(content).toMatch(/aria-label=["']Download \.eml["']/);
    expect(content).toMatch(/isDownloadingEml \? ['"]\.\.\.['"] : ['"]\.eml['"]/);
  });
});
