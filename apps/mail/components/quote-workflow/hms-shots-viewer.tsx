'use client';

import { useEffect, useRef, useState } from 'react';

export type HmsShotRecord = { name: string; sha256: string; at: string };

const SHOT_LABEL: Record<string, string> = {
  'before.png': 'Before',
  'saved.png': 'Saved',
};

export function visibleStayShots(shots: HmsShotRecord[]): HmsShotRecord[] {
  return shots.filter((shot) => shot.name === 'before.png' || shot.name === 'saved.png');
}

/** Before and saved HMS screenshots for one stay, loaded only after staff open them. */
export function HmsShotsViewer({
  runId,
  shots,
  screenshot,
}: {
  runId: string;
  shots: HmsShotRecord[];
  screenshot: (runId: string, name: string) => Promise<string | null>;
}) {
  const shown = visibleStayShots(shots);
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<Record<string, string | null | undefined>>({});
  const closeRef = useRef<HTMLButtonElement>(null);
  const shotKey = shown.map((shot) => shot.name).join(',');

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const name of shotKey.split(',').filter(Boolean)) {
      screenshot(runId, name).then(
        (url) => {
          if (alive) setImages((current) => ({ ...current, [name]: url }));
        },
        () => {
          if (alive) setImages((current) => ({ ...current, [name]: null }));
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [open, runId, screenshot, shotKey]);

  if (shown.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="w-fit text-[11.5px] font-semibold text-[#0066cc] underline"
        onClick={() => setOpen(true)}
      >
        View HMS screenshots
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="HMS screenshots"
          className="fixed inset-0 z-50 flex flex-col gap-3 overflow-auto bg-black/80 p-4"
        >
          <div className="flex justify-end">
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              className="h-8 rounded-xs bg-white px-3 text-[12px] font-semibold text-[#1e293b]"
            >
              Close
            </button>
          </div>
          {shown.map((shot) => {
            const label = SHOT_LABEL[shot.name] ?? shot.name;
            const src = images[shot.name];
            return (
              <figure key={shot.name} className="flex flex-col gap-1 bg-white p-2">
                <figcaption className="text-[12px] font-semibold text-[#1e293b]">{label}</figcaption>
                {src === undefined ? (
                  <p className="text-[11px] text-[#64748b]">Loading the HMS screenshot…</p>
                ) : null}
                {src === null ? (
                  <p className="text-[11px] text-amber-800">
                    The HMS screenshot is no longer available. Check HMS directly.
                  </p>
                ) : null}
                {src ? <img src={src} alt={label} className="w-full" /> : null}
              </figure>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
