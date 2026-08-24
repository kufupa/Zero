import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../hooks/use-threads.ts', import.meta.url), 'utf8');
const mailListSource = readFileSync(new URL('../components/mail/mail-list.tsx', import.meta.url), 'utf8');
const commandPaletteSource = readFileSync(
  new URL('../components/context/command-palette-context.tsx', import.meta.url),
  'utf8',
);
const selectAllSource = readFileSync(
  new URL('../components/mail/select-all-checkbox.tsx', import.meta.url),
  'utf8',
);
const renderLabelsSource = readFileSync(
  new URL('../components/mail/render-labels.tsx', import.meta.url),
  'utf8',
);

describe('useThread content-query ownership', () => {
  it('does not start invisible content processing for the latest message', () => {
    expect(source).not.toContain('trpc.mail.processEmailContent');
    expect(source).not.toContain('email-content-v2');
  });

  it('uses resolved label filters for demo list scope', () => {
    expect(source).not.toContain('labelIds: labels');
    expect(source).toContain('labelIds: validSearchList.filters.labelIds ?? []');
  });

  it('does not invoke a live list request for invalid searches', () => {
    expect(source).toContain('queryFn: invalidListQueryFn');
  });

  it('keeps demo category routes while all scope uses resolved all', () => {
    expect(source).toContain("validSearchList?.folder === 'all'");
    expect(source).toContain('normalizeDemoMailFolderSlug(canonicalRouteFolder');
  });

  it('keeps unsupported-search notification in the singleton mail list', () => {
    expect(source).not.toContain('toast.error(');
    expect(mailListSource).toContain('isUnsupportedSearchOperatorError');
  });

  it('keeps legacy command palette compatibility argument inert', () => {
    expect(commandPaletteSource).not.toContain('const [threadsQuery, threads] = useThreads');
    expect(commandPaletteSource).not.toContain('useRef,');
  });

  it('keeps legacy command palette writes inside the committed atom shape', () => {
    expect(commandPaletteSource).toContain('EMPTY_SEARCH_VALUE');
    expect(commandPaletteSource).not.toContain('searchValue.folder');
    expect(commandPaletteSource).not.toContain('isAISearching:');
    expect(commandPaletteSource).not.toContain('isLoading:');
  });

  it('does not merge persisted legacy filters into committed search text', () => {
    expect(commandPaletteSource).not.toContain('filters.map((f: ActiveFilter) => f.value).join');
    expect(commandPaletteSource).not.toContain('activeFilters.map((f) => f.value).join');
  });

  it('gates select-all fetches on the resolved list request', () => {
    expect(selectAllSource).toContain('searchList.isValid');
    expect(selectAllSource).toContain('folder: searchList.folder');
    expect(selectAllSource).toContain('filters: searchList.filters');
    expect(selectAllSource).toContain('searchList.useDraftsList');
    expect(selectAllSource).toContain('const MAX_PER_PAGE = 100');
  });

  it('keeps label clicks to exact query tokens', () => {
    expect(renderLabelsSource).toContain('function hasLabelSearchToken');
    expect(renderLabelsSource).toContain('function removeLabelSearchToken');
    expect(renderLabelsSource).not.toContain('includes(`label:${label.name}`)');
  });

  it('keeps the hidden-label tooltip trigger to one child', () => {
    expect(renderLabelsSource).not.toContain('+            <button');
  });
});
