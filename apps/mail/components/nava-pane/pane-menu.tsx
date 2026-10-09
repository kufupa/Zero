import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

const FEEDBACK_EMAIL = 'aroransh17@gmail.com';
const FEEDBACK_WHATSAPP_URL = 'https://wa.me/447505014078';

const ITEM_CLASS =
  'block w-full rounded-xs px-2 py-1.5 text-left text-xs text-[#1e293b] hover:bg-[#f1f5f9] focus:bg-[#f1f5f9] focus:outline-hidden';

/** The pane's ⋯ menu. It holds what the footer used to show: connection check, tour replay, feedback and the build id under About. */
export function PaneMenu({
  buildRelease,
  onCheckConnection,
  onReplayTour,
}: {
  buildRelease: string | null;
  onCheckConnection: () => void;
  onReplayTour: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const close = () => {
    setOpen(false);
    setShowAbout(false);
  };

  return (
    <div className="relative" onKeyDown={(event) => event.key === 'Escape' && close()}>
      <button
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex h-8 w-8 items-center justify-center rounded-xs text-[#64748b] hover:bg-[#f1f5f9]"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="More options"
          className="absolute right-0 bottom-full z-10 mb-1 w-60 rounded-sm border border-[#e2e8f0] bg-white p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            className={ITEM_CLASS}
            onClick={() => {
              close();
              onCheckConnection();
            }}
          >
            Check connection
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM_CLASS}
            onClick={() => {
              close();
              onReplayTour();
            }}
          >
            Replay tour
          </button>
          <a role="menuitem" className={ITEM_CLASS} href={`mailto:${FEEDBACK_EMAIL}`}>
            Feedback by email
          </a>
          <a
            role="menuitem"
            className={ITEM_CLASS}
            href={FEEDBACK_WHATSAPP_URL}
            target="_blank"
            rel="noreferrer"
          >
            Feedback on WhatsApp
          </a>
          <button
            type="button"
            role="menuitem"
            aria-expanded={showAbout}
            className={ITEM_CLASS}
            onClick={() => setShowAbout((value) => !value)}
          >
            About
          </button>
          {showAbout ? (
            <p className="px-2 pt-1 pb-1.5 text-[11px] text-[#64748b]">
              Nava Reservationist{buildRelease ? ` · Build ${buildRelease.slice(0, 7)}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
