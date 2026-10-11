/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HmsLinkActions,
  cleanLandingUrl,
  copyText,
} from '../components/quote-workflow/hms-link-actions';

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const LANDING = 'https://appsrv-1.legacyhotels.co.za/web/base/logindisp?tenant=HMS_LEGACY';

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

function setExecCommand(value: unknown) {
  Object.defineProperty(document, 'execCommand', { configurable: true, value });
}

afterEach(() => {
  cleanup();
  toast.success.mockClear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setClipboard(undefined);
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

describe('cleanLandingUrl', () => {
  it('keeps an http or https URL, and refuses anything that is not one', () => {
    expect(cleanLandingUrl(LANDING)).toBe(LANDING);
    expect(cleanLandingUrl(`  ${LANDING}  `)).toBe(LANDING);
    expect(cleanLandingUrl('javascript:alert(1)')).toBeNull();
    expect(cleanLandingUrl('appsrv-1.legacyhotels.co.za/web/base/logindisp')).toBeNull();
    expect(cleanLandingUrl('   ')).toBeNull();
    expect(cleanLandingUrl(undefined)).toBeNull();
  });
});

describe('HmsLinkActions Open HMS', () => {
  it('is a plain link to the configured landing page, with no target attribute', () => {
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', LANDING);
    render(<HmsLinkActions confirmation="64318608-1" />);
    const link = screen.getByRole('link', { name: 'Open HMS' });
    expect(link.getAttribute('href')).toBe(LANDING);
    expect(link.hasAttribute('target')).toBe(false);
  });

  it('is hidden when the landing URL is not set, and Copy still shows', () => {
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', '');
    render(<HmsLinkActions confirmation="64318608-1" />);
    expect(screen.queryByRole('link', { name: 'Open HMS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });

  it('is hidden when the configured value is not an http URL', () => {
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', 'javascript:alert(1)');
    render(<HmsLinkActions confirmation="64318608-1" />);
    expect(screen.queryByRole('link', { name: 'Open HMS' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });

  it('renders nothing for an empty confirmation', () => {
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', LANDING);
    const { container } = render(<HmsLinkActions confirmation="  " />);
    expect(container.innerHTML).toBe('');
  });
});

describe('HmsLinkActions Copy confirmation', () => {
  it('writes the exact confirmation to the clipboard and then shows Copied', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('64318608-1');
  });

  it('announces the number with a toast once it is copied, and not when the copy fails', async () => {
    setClipboard({ writeText: vi.fn(async () => {}) });
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Confirmation number 64318608-1 copied.'),
    );
    toast.success.mockClear();
    cleanup();
    setClipboard(undefined);
    setExecCommand(vi.fn(() => false));
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() =>
      expect(screen.getByText("Couldn't copy. Select the number and copy it.")).toBeTruthy(),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('falls back to copying a selected hidden textarea when the clipboard API refuses', async () => {
    setClipboard({
      writeText: vi.fn(async () => {
        throw new Error('clipboard denied');
      }),
    });
    let copiedValue: string | null = null;
    const execCommand = vi.fn((command: string) => {
      copiedValue = (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? null;
      return command === 'copy';
    });
    setExecCommand(execCommand);
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copiedValue).toBe('64318608-1');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('says so, and does not claim Copied, when neither copy path works', async () => {
    setClipboard(undefined);
    setExecCommand(vi.fn(() => false));
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await waitFor(() => expect(screen.getByText("Couldn't copy. Select the number and copy it.")).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });

  it('goes back to Copy confirmation after the feedback window', async () => {
    vi.useFakeTimers();
    setClipboard({ writeText: vi.fn(async () => {}) });
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy confirmation' }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });
});

describe('copyText', () => {
  it('resolves true when the clipboard API accepts the text', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await expect(copyText('64318608-1')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('64318608-1');
  });
});

describe('HmsLinkActions Copy link', () => {
  it('copies the landing page address and then shows Copied on the link button', async () => {
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', LANDING);
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(LANDING);
    expect(screen.getByRole('button', { name: 'Copy confirmation' })).toBeTruthy();
  });

  it('says so and points to Open HMS when the link cannot be copied', async () => {
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', LANDING);
    setClipboard(undefined);
    setExecCommand(vi.fn(() => false));
    render(<HmsLinkActions confirmation="64318608-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() =>
      expect(screen.getByText("Couldn't copy the link. Use Open HMS instead.")).toBeTruthy(),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('HmsLinkActions Copy for HMS', () => {
  it('copies the landing URL, confirmation, guest surname and arrival in one write', async () => {
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', LANDING);
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(
      <HmsLinkActions
        confirmation="64318608-1"
        guestSurname="Smith"
        arrival="2026-11-12"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy for HMS' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied for HMS' })).toBeTruthy());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      LANDING + '\nConfirmation: 64318608-1\nGuest surname: Smith\nArrival: 2026-11-12',
    );
  });

  it('copies only the confirmation when no landing URL is configured', async () => {
    vi.stubEnv('VITE_PUBLIC_HMS_LANDING_URL', '');
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(
      <HmsLinkActions
        confirmation="64318608-1"
        guestSurname="Smith"
        arrival="2026-11-12"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy for HMS' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied for HMS' })).toBeTruthy());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('64318608-1');
    expect(toast.success).toHaveBeenCalledWith('Confirmation number 64318608-1 copied.');
  });
});
