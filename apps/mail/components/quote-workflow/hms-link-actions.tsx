import { useEffect, useRef, useState } from 'react';

/**
 * Open HMS and Copy confirmation, shown beside an HMS confirmation number. Open HMS is a plain link with no target:
 * the Outlook add-in opens non-Nava origins in the default browser. The link needs VITE_PUBLIC_HMS_LANDING_URL in the
 * build. Without it the link is hidden, and Copy still shows.
 */

const linkClass = 'text-[11.5px] font-medium text-[#0066cc] underline';
const buttonClass =
  'rounded-sm border border-[#0066cc] bg-white px-2.5 py-1 text-[11.5px] font-medium text-[#0066cc]';

/** The landing URL when it is an http or https URL, else null. Nothing else can become a link. */
export function cleanLandingUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/** The HMS landing page for this build, or null when it is not configured. */
export function hmsLandingUrl(): string | null {
  return cleanLandingUrl(import.meta.env.VITE_PUBLIC_HMS_LANDING_URL);
}

/**
 * Puts the text on the clipboard. The async API is tried first. Where it is missing or refused, a hidden textarea is
 * selected and copied. Resolves false when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyWithSelection(text);
  }
}

function copyWithSelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Open HMS and Copy confirmation for one HMS confirmation number. Renders nothing for an empty number. */
export function HmsLinkActions({ confirmation }: { confirmation: string }) {
  const landing = hmsLandingUrl();
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  if (!confirmation.trim()) return null;

  const copy = async () => {
    const copied = await copyText(confirmation);
    setFeedback(copied ? 'copied' : 'failed');
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setFeedback('idle'), 2000);
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {landing ? (
        <a href={landing} className={linkClass}>
          Open HMS
        </a>
      ) : null}
      <button type="button" className={buttonClass} onClick={() => void copy()}>
        {feedback === 'copied' ? 'Copied' : 'Copy confirmation'}
      </button>
      <span role="status" className="text-[11px] text-amber-900">
        {feedback === 'failed' ? "Couldn't copy. Select the number and copy it." : ''}
      </span>
    </span>
  );
}
