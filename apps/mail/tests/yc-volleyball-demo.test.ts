import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyYcVolleyballSarahInsert,
  clearYcVolleyballDemoStage,
  formatYcVolleyballEditorHtml,
  getYcVolleyballComposerInitialHtml,
  getYcVolleyballDemoStage,
  normalizeDraftText,
  setYcVolleyballDemoStage,
  YC_VOLLEYBALL_DEMO_STAGE_STORAGE_KEY,
} from '../lib/demo/yc-volleyball-demo';

function stubBrowserLocalStorage() {
  const store: Record<string, string> = {};
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => (key in store ? store[key]! : null),
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    },
  });
  return store;
}

describe('applyYcVolleyballSarahInsert', () => {
  it('inserts paragraph before Warm regards when marker exists', () => {
    const base = 'Hello.\n\nWe can hold 22 rooms.\n\nWarm regards,\nTeam';
    const sarah = 'Same wing + F&B review.';
    expect(applyYcVolleyballSarahInsert(base, sarah)).toBe(
      'Hello.\n\nWe can hold 22 rooms.\n\nSame wing + F&B review.\n\nWarm regards,\nTeam',
    );
  });

  it('appends paragraph when marker missing', () => {
    const base = 'Short reply.';
    const sarah = 'Extra ops line.';
    expect(applyYcVolleyballSarahInsert(base, sarah)).toBe('Short reply.\n\nExtra ops line.');
  });

  it('converts HTML draft bodies before applying Sarah copy', () => {
    const base =
      '<p>Dear Marlize,</p><p>We can hold 22 rooms for your dates.</p><p>Warm regards,</p><p>Reservations</p>';
    const sarah = 'We will try to keep both teams on the same wing.';

    expect(applyYcVolleyballSarahInsert(base, sarah)).toBe(
      'Dear Marlize,\n\nWe can hold 22 rooms for your dates.\n\nWe will try to keep both teams on the same wing.\n\nWarm regards,\n\nReservations',
    );
  });

  it('decodes escaped HTML entities before strip so Warm regards marker survives', () => {
    const base =
      '&lt;p&gt;Dear Marlize,&lt;/p&gt;&lt;p&gt;We can hold 22 rooms for your dates.&lt;/p&gt;&lt;p&gt;Warm regards,&lt;/p&gt;&lt;p&gt;Reservations&lt;/p&gt;';
    const sarah = 'We will try to keep both teams on the same wing.';
    expect(applyYcVolleyballSarahInsert(base, sarah)).toBe(
      'Dear Marlize,\n\nWe can hold 22 rooms for your dates.\n\nWe will try to keep both teams on the same wing.\n\nWarm regards,\n\nReservations',
    );
  });

  it('handles double-encoded escaped tags', () => {
    const base =
      '&amp;lt;p&amp;gt;Hi&amp;lt;/p&amp;gt;&amp;lt;p&amp;gt;Body&amp;lt;/p&amp;gt;&amp;lt;p&amp;gt;Warm regards&amp;lt;/p&amp;gt;';
    const sarah = 'Sarah line.';
    expect(applyYcVolleyballSarahInsert(base, sarah)).toBe(
      'Hi\n\nBody\n\nSarah line.\n\nWarm regards',
    );
  });
});

describe('normalizeDraftText', () => {
  it('strips real tags after entity decode', () => {
    expect(normalizeDraftText('<p>A</p><p>B</p>')).toBe('A\n\nB');
  });

  it('treats entity-encoded tags as markup not literal text', () => {
    expect(normalizeDraftText('&lt;p&gt;Hello&lt;/p&gt;')).toBe('Hello');
  });
});

describe('formatYcVolleyballEditorHtml', () => {
  it('formats scripted Sarah copy as editor-safe paragraphs', () => {
    expect(formatYcVolleyballEditorHtml('Hello <team>.\n\nLine one.\nLine two.')).toBe(
      '<p>Hello &lt;team&gt;.</p><p>Line one.<br>Line two.</p>',
    );
  });
});

describe('getYcVolleyballComposerInitialHtml', () => {
  const baseline =
    '<p>Dear Marlize,</p><p>We can hold 22 rooms for your dates.</p><p>Warm regards,</p><p>Reservations</p>';
  const sarah = 'We will try to keep both teams on the same wing.';

  it('uses clean baseline while edit has not been applied, even if a stale demo draft was saved', () => {
    expect(
      getYcVolleyballComposerInitialHtml({
        stage: 'editing',
        baselineDraft: baseline,
        sarahParagraph: sarah,
      }),
    ).toBe('<p>Dear Marlize,</p><p>We can hold 22 rooms for your dates.</p><p>Warm regards,</p><p>Reservations</p>');
  });

  it('draft stage ignores contaminated stored idea — same clean baseline as editing', () => {
    expect(
      getYcVolleyballComposerInitialHtml({
        stage: 'draft',
        baselineDraft: baseline,
        sarahParagraph: sarah,
      }),
    ).toBe('<p>Dear Marlize,</p><p>We can hold 22 rooms for your dates.</p><p>Warm regards,</p><p>Reservations</p>');
  });

  it('uses the Sarah-applied draft after Apply Sarah edit has run', () => {
    expect(
      getYcVolleyballComposerInitialHtml({
        stage: 'sarah-preview',
        baselineDraft: baseline,
        sarahParagraph: sarah,
      }),
    ).toBe(
      '<p>Dear Marlize,</p><p>We can hold 22 rooms for your dates.</p><p>We will try to keep both teams on the same wing.</p><p>Warm regards,</p><p>Reservations</p>',
    );
  });

  it('editing with escaped-HTML baseline still opens clean paragraphs', () => {
    const escaped =
      '&lt;p&gt;Dear Marlize,&lt;/p&gt;&lt;p&gt;We can hold 22 rooms for your dates.&lt;/p&gt;&lt;p&gt;Warm regards,&lt;/p&gt;&lt;p&gt;Reservations&lt;/p&gt;';
    expect(
      getYcVolleyballComposerInitialHtml({
        stage: 'editing',
        baselineDraft: escaped,
        sarahParagraph: sarah,
      }),
    ).toBe('<p>Dear Marlize,</p><p>We can hold 22 rooms for your dates.</p><p>Warm regards,</p><p>Reservations</p>');
  });
});

describe('YC volleyball demo stage (localStorage)', () => {
  beforeEach(() => {
    stubBrowserLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to draft when unset', () => {
    expect(getYcVolleyballDemoStage()).toBe('draft');
  });

  it('round-trips every demo stage', () => {
    const stages = [
      'draft',
      'editing',
      'sarah-preview',
      'sent',
      'reasoning',
      'teaching',
      'workflow-preview',
      'stored',
    ] as const;

    for (const stage of stages) {
      setYcVolleyballDemoStage(stage);
      expect(getYcVolleyballDemoStage()).toBe(stage);
    }
  });

  it('maps old demo stage values to the current staged flow', () => {
    window.localStorage.setItem(YC_VOLLEYBALL_DEMO_STAGE_STORAGE_KEY, 'initial');
    expect(getYcVolleyballDemoStage()).toBe('draft');
    window.localStorage.setItem(YC_VOLLEYBALL_DEMO_STAGE_STORAGE_KEY, 'edited');
    expect(getYcVolleyballDemoStage()).toBe('sarah-preview');
  });

  it('treats unknown values as draft', () => {
    window.localStorage.setItem(YC_VOLLEYBALL_DEMO_STAGE_STORAGE_KEY, 'garbage');
    expect(getYcVolleyballDemoStage()).toBe('draft');
  });

  it('clearYcVolleyballDemoStage removes key', () => {
    setYcVolleyballDemoStage('sent');
    clearYcVolleyballDemoStage();
    expect(window.localStorage.getItem(YC_VOLLEYBALL_DEMO_STAGE_STORAGE_KEY)).toBeNull();
    expect(getYcVolleyballDemoStage()).toBe('draft');
  });
});
