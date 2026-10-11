import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trackPaneAction } from '@/lib/quote-workflow/pane-telemetry';

/**
 * The HMS handoff for one confirmation number: Copy link and Copy confirmation, with Open HMS as the plain link. Copy
 * link copies the HMS landing page and the number finds the booking there. Copy link and Open HMS need
 * VITE_PUBLIC_HMS_LANDING_URL in the build. Without it only Copy confirmation shows. Open HMS has no link target:
 * the Outlook add-in opens non-Nava origins in the default browser.
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

type CopyTarget = 'link' | 'number';

/** Copy link and Copy confirmation for one HMS confirmation number. Renders nothing for an empty number. */
export function HmsLinkActions({ confirmation }: { confirmation: string }) {
  const landing = hmsLandingUrl();
  const number = confirmation.trim();
  const [feedback, setFeedback] = useState<{ target: CopyTarget; copied: boolean } | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  if (!number) return null;

  const copy = async (target: CopyTarget, text: string) => {
    const copied = await copyText(text);
    setFeedback({ target, copied });
    if (copied && target === 'number') trackPaneAction({ type: 'copy.confirmation' });
    if (copied) {
      toast.success(
        target === 'link'
          ? 'HMS link copied. Paste it into a browser.'
          : `Confirmation number ${text} copied.`,
      );
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setFeedback(null), 2000);
  };

  const label = (target: CopyTarget, idle: string) =>
    feedback?.target === target && feedback.copied ? 'Copied' : idle;
  const failure =
    feedback && !feedback.copied
      ? feedback.target === 'link'
        ? "Couldn't copy the link. Use Open HMS instead."
        : "Couldn't copy. Select the number and copy it."
      : '';

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {landing ? (
        <button type="button" className={buttonClass} onClick={() => void copy('link', landing)}>
          {label('link', 'Copy link')}
        </button>
      ) : null}
      <button type="button" className={buttonClass} onClick={() => void copy('number', number)}>
        {label('number', 'Copy confirmation')}
      </button>
      {landing ? (
        <a href={landing} className={linkClass}>
          Open HMS
        </a>
      ) : null}
      <span role="status" className="text-[11px] text-amber-900">
        {failure}
      </span>
    </span>
  );
}
