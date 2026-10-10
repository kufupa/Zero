/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoredTranslation, StoredWork } from '@/lib/quote-workflow/backend-bind';
import { TranslationBox } from '@/components/nava-pane/blocks/translation-box';
import { useStoredWork } from '@/lib/quote-workflow/use-work-item';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => cleanup());

const SEGMENTS = [
  {
    clean: 'Good evening, we need three rooms.',
    literal: 'Good evening, we have need of three rooms.',
  },
  { clean: 'Thank you in advance.', literal: 'Thanks in advance.' },
];
const TRANSLATED: StoredTranslation = { status: 'succeeded', segments: SEGMENTS, truncated: false };

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('TranslationBox', () => {
  it('is not shown for English mail, or when the language is unknown', () => {
    const { container, rerender } = render(
      <TranslationBox language="en" translation={TRANSLATED} busy={false} onRetry={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(
      <TranslationBox language={null} translation={TRANSLATED} busy={false} onRetry={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('region', { name: 'Translation' })).toBeNull();
  });

  it('opens by default on Clean, with each segment in English', () => {
    render(
      <TranslationBox language="fr" translation={TRANSLATED} busy={false} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole('region', { name: 'Translation' })).toBeDefined();
    expect(screen.getByText('Written in French. Replies stay in English.')).toBeDefined();
    expect(screen.getByRole('tablist', { name: 'Translation view' })).toBeDefined();
    expect(tab('Clean').getAttribute('aria-selected')).toBe('true');
    expect(tab('Word-for-word').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText(SEGMENTS[0]!.clean)).toBeDefined();
    expect(screen.getByText(SEGMENTS[1]!.clean)).toBeDefined();
    expect(screen.queryByText(SEGMENTS[0]!.literal)).toBeNull();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('Clean').id);
  });

  it('shows the word-for-word segments for the same pairs when that tab is chosen', () => {
    render(
      <TranslationBox language="fr" translation={TRANSLATED} busy={false} onRetry={vi.fn()} />,
    );
    fireEvent.click(tab('Word-for-word'));
    expect(tab('Word-for-word').getAttribute('aria-selected')).toBe('true');
    expect(tab('Clean').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText(SEGMENTS[0]!.literal)).toBeDefined();
    expect(screen.queryByText(SEGMENTS[0]!.clean)).toBeNull();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      tab('Word-for-word').id,
    );
  });

  it('moves between the tabs with the arrow, Home and End keys, moving focus with them', () => {
    render(
      <TranslationBox language="fr" translation={TRANSLATED} busy={false} onRetry={vi.fn()} />,
    );
    const list = screen.getByRole('tablist');
    expect(tab('Clean').tabIndex).toBe(0);
    expect(tab('Word-for-word').tabIndex).toBe(-1);

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(tab('Word-for-word').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Word-for-word'));
    expect(tab('Word-for-word').tabIndex).toBe(0);
    expect(tab('Clean').tabIndex).toBe(-1);

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(tab('Clean').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Clean'));

    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(tab('Word-for-word').getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(list, { key: 'Home' });
    expect(tab('Clean').getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(list, { key: 'End' });
    expect(tab('Word-for-word').getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(list, { key: 'a' });
    expect(tab('Word-for-word').getAttribute('aria-selected')).toBe('true');
  });

  it('says when only the start of a long mail is translated', () => {
    render(
      <TranslationBox
        language="fr"
        translation={{ ...TRANSLATED, truncated: true }}
        busy={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('Only the first part of this email is translated.')).toBeDefined();
  });

  it('can be hidden and shown again from its header', () => {
    render(
      <TranslationBox language="fr" translation={TRANSLATED} busy={false} onRetry={vi.fn()} />,
    );
    const toggle = screen.getByRole('button', { name: 'Hide translation' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Show translation' }).getAttribute('aria-expanded'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByRole('tablist')).toBeDefined();
  });

  it('says Translating… while a translation is being asked for, with no retry to press', () => {
    render(
      <TranslationBox language="fr" translation={{ status: 'failed' }} busy onRetry={vi.fn()} />,
    );
    expect(screen.getByRole('status').textContent).toBe('Translating…');
    expect(screen.queryByRole('button', { name: 'Retry translation' })).toBeNull();
  });

  it('says Translation unavailable with a retry when the translation failed', () => {
    const onRetry = vi.fn();
    render(
      <TranslationBox
        language="fr"
        translation={{ status: 'failed' }}
        busy={false}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Translation unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry translation' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says Translation unavailable with a retry when no translation was stored for a non-English read', () => {
    render(<TranslationBox language="de" translation={null} busy={false} onRetry={vi.fn()} />);
    expect(screen.getByText('Translation unavailable.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry translation' })).toBeDefined();
  });
});

/** The pane's wiring: the stored read's translation, and the retry that replaces it on the pane. */
function Harness({ trpc }: { trpc: unknown }) {
  const storedWork = useStoredWork({ trpc, internetMessageId: 'm-1' });
  if (storedWork.pane.state !== 'ready') return <p>{storedWork.pane.state}</p>;
  return (
    <TranslationBox
      key={storedWork.pane.workItemId}
      language={storedWork.pane.language}
      translation={storedWork.pane.translation}
      busy={storedWork.translationBusy}
      onRetry={storedWork.retryTranslation}
    />
  );
}

const FAILED_READ: StoredWork = {
  status: 'ready',
  workItemId: 'wi-fr',
  workItemStatus: 'needs_you',
  extractionId: 'ex-fr',
  refs: {},
  analysis: { intent: 'quote', groups: [], secondaryAsks: [], alternatives: [] } as never,
  contact: { name: null, company: null, endClient: null, email: null, phone: null },
  language: 'fr',
  translation: { status: 'failed' },
};

function trpcWithRetry(mutate: (input: { workItemId: string }) => Promise<unknown>) {
  return {
    workItems: {
      getByMessage: { query: async () => FAILED_READ },
      recordEvent: { mutate: vi.fn(async () => ({ aiValue: null, value: null })) },
      retryTranslation: { mutate: vi.fn(mutate) },
    },
  };
}

describe('translation retry through the stored work', () => {
  it('shows Translating… while the retry runs, then the translation in place of the failure', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const trpc = trpcWithRetry(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness trpc={trpc} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry translation' }));
    expect(screen.getByRole('status').textContent).toBe('Translating…');
    expect(trpc.workItems.retryTranslation.mutate).toHaveBeenCalledWith({ workItemId: 'wi-fr' });

    await act(async () => {
      finish({ status: 'done', translation: TRANSLATED });
    });
    await waitFor(() => expect(screen.getByRole('tablist')).toBeDefined());
    expect(screen.getByText(SEGMENTS[0]!.clean)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry translation' })).toBeNull();
  });

  it('keeps the unavailable copy when the retry is refused or the call fails', async () => {
    const refused = trpcWithRetry(async () => ({ status: 'capped', translation: null }));
    const { unmount } = render(<Harness trpc={refused} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry translation' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Translation unavailable.'),
    );
    unmount();

    const failing = trpcWithRetry(async () => {
      throw new Error('offline');
    });
    render(<Harness trpc={failing} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry translation' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Translation unavailable.'),
    );
    expect(screen.queryByText('Translating…')).toBeNull();
  });
});
