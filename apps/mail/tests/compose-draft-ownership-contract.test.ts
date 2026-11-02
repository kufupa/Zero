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
    expect(emailComposerSource).toContain('onValueChange={markNonBodyChanges}');
    expect(emailComposerSource).toContain('onApply={markNonBodyChanges}');
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
    expect(emailComposerSource).toContain("type: 'saved', capturedRevision");
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

  it('reads synchronous revision state, not stale rendered state, after a save', () => {
    const check = emailComposerSource.slice(emailComposerSource.indexOf('const hasSynchronousDraftChanges'),
      emailComposerSource.indexOf('const processAndSetAttachments'));
    expect(check).toContain('revisionRef.current.localRevision > revisionRef.current.savedRevision');
    expect(check).toContain('pendingAttachmentWorkRef.current > 0');
    expect(check).toContain('pendingInlineImageWorkRef.current > 0');
    expect(check).not.toContain('hasUnsavedChanges ||');
  });

  it('keeps fresh new-mail composer mounted after first draft id', () => {
    expect(createEmailSource).toContain('initialDraftIdRef');
    expect(createEmailSource).toMatch(/initialDraftIdRef\.current.*!draft.*!draftError/s);
    expect(createEmailSource).not.toContain('key={typedDraft?.id');
    expect(createEmailSource).toContain('role="status"');
    expect(createEmailSource).toContain('aria-live="polite"');
  });
});
