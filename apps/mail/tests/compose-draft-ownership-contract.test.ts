import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const emailComposerSource = readSource('../components/create/email-composer.tsx');
const recipientSource = readSource('../components/ui/recipient-autosuggest.tsx');
const templateSource = readSource('../components/create/template-button.tsx');
const createEmailSource = readSource('../components/create/create-email.tsx');
const replyComposerSource = readSource('../components/mail/reply-composer.tsx');

describe('compose draft ownership wiring', () => {
  it('tracks local edits with a revision ref and marks mutation surfaces', () => {
    expect(emailComposerSource).toContain('revisionRef');
    expect(emailComposerSource).toContain('markUnsavedChanges');
    expect(emailComposerSource).toMatch(/hasLocalEdits:\s*revisionRef\.current\.localRevision > 0/);
    expect(emailComposerSource).toContain('onValueChange={markUnsavedChanges}');
    expect(emailComposerSource).toContain('onApply={markUnsavedChanges}');
    expect(recipientSource).toContain('onValueChange();');
    expect(templateSource).toContain('onApply();');
    expect(emailComposerSource).toMatch(
      /onLengthChange:\s*\(\)\s*=>\s*\{\s*markUnsavedChanges\(\);\s*\}/,
    );
  });

  it('serializes saves and acknowledges only captured revisions', () => {
    expect(emailComposerSource).toContain('saveInFlightRef');
    expect(emailComposerSource).toContain('activeDraftIdRef');
    expect(emailComposerSource).toContain('capturedRevision');
    expect(emailComposerSource).toMatch(/type:\s*'saved',\s*capturedRevision/);
    expect(emailComposerSource).toContain('flushDraftUntilCurrent');
    expect(emailComposerSource).toContain('autosaveSuppressedAfterFailure');
    expect(emailComposerSource).toContain('setAutosaveSuppressedAfterFailure(true)');
    expect(emailComposerSource).toContain('setAutosaveSuppressedAfterFailure(false)');
    expect(emailComposerSource).toContain('draftId: activeDraftIdRef.current ?? undefined');
    expect(emailComposerSource).toContain('editor.commands.clearContent(false)');
    expect(createEmailSource).toContain('draftId: data.draftId');
    expect(replyComposerSource).toContain('draftId: data.draftId');

    const saveSuccessSection = emailComposerSource.slice(
      emailComposerSource.indexOf('persistDraftOnce'),
      emailComposerSource.indexOf('flushDraftUntilCurrent'),
    );
    expect(saveSuccessSection).not.toMatch(/setHasUnsavedChanges\(false\);\s*\n\s*return true;/);
  });

  it('keeps fresh new-mail composer mounted after first draft id', () => {
    expect(createEmailSource).toContain('initialDraftIdRef');
    expect(createEmailSource).toMatch(/initialDraftIdRef\.current.*!draft.*!draftError/s);
    expect(createEmailSource).not.toContain('key={typedDraft?.id');
    expect(createEmailSource).toContain('role="status"');
    expect(createEmailSource).toContain('aria-live="polite"');
  });
});
