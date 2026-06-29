export const YC_VOLLEYBALL_THREAD_ID = 'sa-thread-yc-volleyball';

export type YcVolleyballDemoStage =
  | 'draft'
  | 'editing'
  | 'sarah-preview'
  | 'sent'
  | 'reasoning'
  | 'teaching'
  | 'workflow-preview'
  | 'stored';

/** Persisted demo step for YC volleyball thread (frontend-only demo). */
export const YC_VOLLEYBALL_DEMO_STAGE_STORAGE_KEY = 'zero:demo:yc-volleyball-stage' as const;
export const YC_VOLLEYBALL_DEMO_STAGE_EVENT = 'zero:demo:yc-volleyball-stage-change' as const;

const STORAGE_KEY = YC_VOLLEYBALL_DEMO_STAGE_STORAGE_KEY;
const STAGES = new Set<YcVolleyballDemoStage>([
  'draft',
  'editing',
  'sarah-preview',
  'sent',
  'reasoning',
  'teaching',
  'workflow-preview',
  'stored',
]);

export const YC_SARAH_TEACHING_NOTE =
  'Lots of kids in warm weather often want snacks after matches. Check F&B capacity and manager approval before mentioning a gelato stand to the guest.';

export const YC_SARAH_TEACHING_TAGS = ['Add step', 'Children/families', 'Season', 'F&B capacity', 'Approval gate'] as const;

export function getYcVolleyballDemoStage(): YcVolleyballDemoStage {
  if (typeof window === 'undefined') return 'draft';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === 'initial') return 'draft';
  if (raw === 'edited') return 'sarah-preview';
  if (STAGES.has(raw as YcVolleyballDemoStage)) return raw as YcVolleyballDemoStage;
  return 'draft';
}

export function setYcVolleyballDemoStage(stage: YcVolleyballDemoStage): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, stage);
  if (typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(YC_VOLLEYBALL_DEMO_STAGE_EVENT, { detail: stage }));
  }
}

export function clearYcVolleyballDemoStage(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/** One layer: decode common named entities. `&amp;` last so `&amp;lt;` → `&lt;` → `<` across passes. */
function decodeHtmlEntitiesLayer(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Unescape HTML entities repeatedly (handles double-encoded demo drafts). */
function fullyDecodeHtmlEntities(value: string): string {
  let out = value;
  for (let i = 0; i < 6; i++) {
    const next = decodeHtmlEntitiesLayer(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Strip tags and whitespace; run after entity decode so `&lt;p&gt;` becomes real `<p>` then removed. */
function stripHtmlToPlainText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Demo + composer: canonical plain text from HTML, escaped HTML, or plain newlines. */
export function normalizeDraftText(value: string): string {
  const decoded = fullyDecodeHtmlEntities(value);
  return stripHtmlToPlainText(decoded);
}

/** Plain-text draft: insert Sarah workflow paragraph before closing when marker present (YC demo). */
export function applyYcVolleyballSarahInsert(baselineDraft: string, sarahParagraph: string): string {
  const baselinePlain = normalizeDraftText(baselineDraft);
  const marker = '\n\nWarm regards';
  if (baselinePlain.includes(marker)) {
    return baselinePlain.replace(marker, `\n\n${sarahParagraph}${marker}`);
  }
  return `${baselinePlain.trimEnd()}\n\n${sarahParagraph}`;
}

function escapeEditorHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatYcVolleyballEditorHtml(plainText: string): string {
  return plainText
    .trim()
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim().length > 0)
    .map((paragraph) => `<p>${paragraph.split(/\n/).map(escapeEditorHtml).join('<br>')}</p>`)
    .join('');
}

const SARAH_APPLIED_STAGES: YcVolleyballDemoStage[] = [
  'sarah-preview',
  'sent',
  'reasoning',
  'teaching',
  'workflow-preview',
  'stored',
];

export function getYcVolleyballComposerInitialHtml({
  stage,
  baselineDraft,
  sarahParagraph,
}: {
  stage: YcVolleyballDemoStage;
  baselineDraft: string;
  sarahParagraph: string;
}): string {
  if (SARAH_APPLIED_STAGES.includes(stage)) {
    return formatYcVolleyballEditorHtml(applyYcVolleyballSarahInsert(baselineDraft, sarahParagraph));
  }

  return formatYcVolleyballEditorHtml(normalizeDraftText(baselineDraft));
}
