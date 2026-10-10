import type { StoredTranslation } from '@/lib/quote-workflow/backend-bind';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Section } from '../pane-ui';

type View = 'clean' | 'literal';
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'clean', label: 'Clean' },
  { id: 'literal', label: 'Word-for-word' },
];

/** The language's English name ("fr" to "French"), or the code when the runtime does not name it. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Each segment with a React key: its pair of texts, numbered when the same pair repeats in the mail. */
function keyedSegments(segments: Array<{ clean: string; literal: string }>) {
  const seen = new Map<string, number>();
  return segments.map((segment) => {
    const pair = JSON.stringify([segment.clean, segment.literal]);
    const repeat = seen.get(pair) ?? 0;
    seen.set(pair, repeat + 1);
    return { ...segment, key: `${pair}#${repeat}` };
  });
}

/** The tab to move to for an arrow, Home or End key. Null for any other key. */
function tabAfter(key: string, current: number, count: number): number | null {
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * Translation box (U16, R2): the English of a mail that is not written in English. It is open by default, and shows
 * nothing for English or an unknown language. Clean and Word-for-word are two views of the same aligned segments.
 * Replies stay in English, so this box is for reading only. A translation that is still being asked for shows as
 * "Translating…". One that failed, or is missing, shows "Translation unavailable" with a retry.
 */
export function TranslationBox({
  language,
  translation,
  busy,
  onRetry,
}: {
  language: string | null;
  translation: StoredTranslation;
  busy: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<View>('clean');
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  if (!language || language === 'en') return null;

  const succeeded = translation?.status === 'succeeded' ? translation : null;
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = VIEWS.findIndex((item) => item.id === view);
    const next = tabAfter(event.key, current, VIEWS.length);
    const target = next === null ? undefined : VIEWS[next];
    if (next === null || !target) return;
    event.preventDefault();
    setView(target.id);
    tabs.current[next]?.focus();
  };

  return (
    <Section
      title="Translation"
      id="quote-translation"
      action={
        <button
          type="button"
          aria-expanded={open}
          aria-controls="quote-translation-body"
          aria-label={open ? 'Hide translation' : 'Show translation'}
          onClick={() => setOpen((value) => !value)}
          className="rounded-[2px] text-[11.5px] font-semibold text-[#0066cc] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0066cc]"
        >
          {open ? 'Hide' : 'Show'}
        </button>
      }
    >
      {open ? (
        <div id="quote-translation-body" className="flex flex-col gap-2.5">
          <p className="text-[11.5px] text-[#64748b]">
            Written in {languageName(language)}. Replies stay in English.
          </p>
          {busy ? (
            <p role="status" className="text-[12px] text-[#475569]">
              Translating…
            </p>
          ) : succeeded ? (
            <>
              <div
                role="tablist"
                aria-label="Translation view"
                onKeyDown={onTabKeyDown}
                className="flex gap-1 border-b border-[#e2e8f0]"
              >
                {VIEWS.map((item, index) => {
                  const selected = view === item.id;
                  return (
                    <button
                      key={item.id}
                      ref={(node) => {
                        tabs.current[index] = node;
                      }}
                      type="button"
                      role="tab"
                      id={`quote-translation-tab-${item.id}`}
                      aria-selected={selected}
                      aria-controls="quote-translation-panel"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setView(item.id)}
                      className={`-mb-px border-b-2 px-2 py-1 text-[12px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0066cc] ${
                        selected
                          ? 'border-[#1a4332] text-[#1a4332]'
                          : 'border-transparent text-[#64748b]'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
              <div
                role="tabpanel"
                id="quote-translation-panel"
                aria-labelledby={`quote-translation-tab-${view}`}
                tabIndex={0}
                className="flex flex-col gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0066cc]"
              >
                {/* The email's own text, translated: it names the guest, so the preview gate masks it (data-pii). */}
                <ol data-pii className="flex flex-col gap-2">
                  {keyedSegments(succeeded.segments).map((segment) => (
                    <li key={segment.key} className="text-[12.5px] leading-snug text-[#1e293b]">
                      {view === 'clean' ? segment.clean : segment.literal}
                    </li>
                  ))}
                </ol>
                {succeeded.truncated ? (
                  <p className="text-[11px] text-[#64748b]">
                    Only the first part of this email is translated.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <p
              role="status"
              className="flex flex-wrap items-center gap-2 text-[12px] text-[#b45309]"
            >
              Translation unavailable.
              <button
                type="button"
                onClick={onRetry}
                className="font-semibold underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0066cc]"
              >
                Retry translation
              </button>
            </p>
          )}
        </div>
      ) : null}
    </Section>
  );
}
