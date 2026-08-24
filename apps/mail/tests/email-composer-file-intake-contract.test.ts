import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../components/create/email-composer.tsx', import.meta.url),
  'utf8',
);

const between = (start: string, end: string) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
};

describe('EmailComposer file intake', () => {
  it('serializes supported attachment intake through policy-filtered original files', () => {
    expect(source).toContain("from '@/lib/compose-attachment-policy'");
    expect(source).toContain("from '@/lib/attachment-intake-queue'");
    expect(source).toContain('drainAttachmentIntakeQueue');
    expect(source).toContain('COMPOSE_ATTACHMENT_ACCEPT');
    expect(source).toContain('partitionComposeAttachmentFiles');
    expect(source).toContain('type AttachmentEntry = {');
    expect(source).toContain('const attachmentEntryIdRef = useRef(initialAttachments.length)');
    expect(source).toContain('const originalAttachmentsRef = useRef<AttachmentEntry[]>(');
    expect(source).toContain('const createAttachmentEntry = useCallback(');
    expect(source).toContain('const attachmentQueueRef = useRef<Promise<void>>(Promise.resolve())');
    expect(source).toContain('const pendingAttachmentWorkRef = useRef(0)');
    expect(source).toContain('const enqueueAttachmentTask = useCallback(');
    expect(source).toContain('attachmentQueueRef.current = queuedTask.catch');
    expect(source).toContain('const inlineImageQueueRef = useRef<Promise<void>>(Promise.resolve())');
    expect(source).toContain('const pendingInlineImageWorkRef = useRef(0)');
    expect(source).toContain('const enqueueInlineImageTask = useCallback(');
    expect(source).toContain('inlineImageQueueRef.current = queuedTask.catch');

    const enqueue = between(
      'const enqueueAttachmentTask = useCallback(',
      'const queueAttachmentCandidates',
    );
    expect(enqueue).not.toContain('sendInFlightRef.current');

    const intake = between('const queueAttachmentCandidates = useCallback(', 'const handleAttachment');
    const intakeSendLock = intake.indexOf('if (sendInFlightRef.current) {');
    const intakeRejection = intake.indexOf('rejectFileChangeDuringSend()');
    const partition = intake.indexOf('partitionComposeAttachmentFiles(candidates)');
    const appendOriginals = intake.indexOf('originalAttachmentsRef.current =');

    expect(intakeSendLock).toBeGreaterThanOrEqual(0);
    expect(intakeRejection).toBeGreaterThan(intakeSendLock);
    expect(intakeRejection).toBeLessThan(partition);
    expect(intakeSendLock).toBeLessThan(partition);
    expect(intakeSendLock).toBeLessThan(appendOriginals);
    expect(intake).toContain('partitionComposeAttachmentFiles(candidates)');
    expect(intake).toContain('if (accepted.length === 0) return;');
    expect(intake).toContain('const acceptedEntries = accepted.map(createAttachmentEntry)');
    expect(intake).toContain('originalAttachmentsRef.current');
    expect(intake).toContain('await processAndSetAttachments');
    expect(intake).toContain('marksDraftDirty: true');

    const remove = between('const removeAttachment', 'const editor = useComposeEditor');
    const removeSendLock = remove.indexOf('if (sendInFlightRef.current) {');
    const removeRejection = remove.indexOf('rejectFileChangeDuringSend()');

    expect(removeSendLock).toBeGreaterThanOrEqual(0);
    expect(removeRejection).toBeGreaterThan(removeSendLock);
    expect(removeSendLock).toBeLessThan(remove.indexOf('enqueueAttachmentTask'));
    expect(remove).toContain('enqueueAttachmentTask');
    expect(remove).toContain('originalAttachmentsRef.current');
    expect(remove).toContain('(attachmentId: string)');
    expect(remove).toContain('entry.id !== attachmentId');

    const quality = between('const handleQualityChange', 'const handleScheduleChange');
    const qualitySendLock = quality.indexOf('if (sendInFlightRef.current) {');
    const qualityRejection = quality.indexOf('rejectFileChangeDuringSend()');

    expect(qualitySendLock).toBeGreaterThanOrEqual(0);
    expect(qualityRejection).toBeGreaterThan(qualitySendLock);
    expect(qualitySendLock).toBeLessThan(quality.indexOf('setImageQuality(newQuality)'));
    expect(qualitySendLock).toBeLessThan(quality.indexOf('enqueueAttachmentTask'));
    expect(quality).toContain('enqueueAttachmentTask');
    expect(quality).toContain('originalAttachmentsRef.current');
  });

  it('keeps rendered attachment identities with compressed files', () => {
    expect(source).toContain(
      'const [attachmentEntries, setAttachmentEntries] = useState<AttachmentEntry[]>(() =>',
    );
    expect(source).not.toContain('originalAttachmentsRef.current[index]?.id');

    const process = between('const processAndSetAttachments', 'const externalHeaderSyncKey');
    expect(process).toContain(
      'const compressedEntries = entriesToProcess.map((entry, index) => ({',
    );
    expect(process).toContain('id: entry.id');
    expect(process).toContain('file: compressedFiles[index]');
    expect(process).toContain('setAttachmentEntries(compressedEntries)');
    expect(process).toContain('setAttachmentEntries(entriesToProcess)');

    const clear = between('const clearAttachmentState', 'useEffect(() => {');
    expect(clear).toContain('setAttachmentEntries([])');
  });

  it('uses synchronous file work for draft lifecycle decisions and save snapshots', () => {
    const synchronousChanges = between(
      'const hasSynchronousDraftChanges = useCallback(',
      'const processAndSetAttachments',
    );
    expect(synchronousChanges).toContain('pendingAttachmentWorkRef.current > 0');
    expect(synchronousChanges).toContain('pendingInlineImageWorkRef.current > 0');

    const drainAttachmentWork = between(
      'const drainAttachmentWork = useCallback(',
      'const drainInlineImageWork',
    );
    expect(drainAttachmentWork).toContain('for (;;) {');
    expect(drainAttachmentWork).toContain('const queue = attachmentQueueRef.current');
    expect(drainAttachmentWork).toContain('await drainAttachmentIntakeQueue(');
    expect(drainAttachmentWork).toContain('queue === attachmentQueueRef.current');
    expect(drainAttachmentWork).toContain('pendingAttachmentWorkRef.current === 0');

    const drainInlineImageWork = between(
      'const drainInlineImageWork = useCallback(',
      'const drainComposeFileWork',
    );
    expect(drainInlineImageWork).toContain('for (;;) {');
    expect(drainInlineImageWork).toContain('const queue = inlineImageQueueRef.current');
    expect(drainInlineImageWork).toContain('await drainAttachmentIntakeQueue(');
    expect(drainInlineImageWork).toContain('queue === inlineImageQueueRef.current');
    expect(drainInlineImageWork).toContain('pendingInlineImageWorkRef.current === 0');

    const terminalDrain = between(
      'const drainComposeFileWork = useCallback(',
      'const proceedWithSend',
    );
    expect(terminalDrain).toContain('await drainAttachmentWork()');
    expect(terminalDrain).toContain('await drainInlineImageWork()');
    expect(terminalDrain).toContain('pendingAttachmentWorkRef.current === 0');
    expect(terminalDrain).toContain('pendingInlineImageWorkRef.current === 0');

    const beforeUnload = between('const handleBeforeUnload', 'window.addEventListener');
    expect(beforeUnload).toContain('hasUnsavedChanges: hasSynchronousDraftChanges()');

    const persistence = between('const buildPersistInput', 'const handleClose');
    expect(persistence).toContain('hasUnsavedChanges: hasSynchronousDraftChanges()');

    const threadSwitch = between('const flush = async () => {', 'registerComposeFlush(flush)');
    expect(threadSwitch).toContain('hasUnsavedChanges: hasSynchronousDraftChanges()');

    const persist = between('const persistDraftOnce', 'const flushDraftUntilCurrent');
    expect(persist.indexOf('await drainComposeFileWork()')).toBeGreaterThanOrEqual(0);
    expect(persist.indexOf('await drainComposeFileWork()')).toBeLessThan(
      persist.indexOf('const capturedRevision'),
    );
  });

  it('clears in-flight save after a skipped persistence decision', () => {
    const persist = between('const persistDraftOnce', 'const flushDraftUntilCurrent');

    expect(persist).toMatch(
      /try \{[\s\S]*return 'skipped';[\s\S]*\} finally \{[\s\S]*if \(saveInFlightRef\.current === savePromise\)/,
    );
  });

  it('drains pending attachment work before warning and non-reentrant send decisions', () => {
    expect(source).toContain('const sendInFlightRef = useRef(false)');

    const handleSend = between('const handleSend = async () => {', 'const persistDraftOnce');
    const warningCheck = handleSend.indexOf('hasAttachmentKeywords');

    expect(handleSend.indexOf('if (sendInFlightRef.current) return;')).toBeGreaterThanOrEqual(0);
    expect(handleSend.indexOf('sendInFlightRef.current = true')).toBeLessThan(
      handleSend.indexOf('await drainComposeFileWork()'),
    );
    expect(handleSend.indexOf('await drainComposeFileWork()')).toBeGreaterThanOrEqual(0);
    expect(handleSend.indexOf('await drainComposeFileWork()')).toBeLessThan(warningCheck);
    expect(handleSend).toContain('sendInFlightRef.current = false');

    const proceedWithSend = between('const proceedWithSend = async', 'const handleSend');
    expect(proceedWithSend.indexOf('await drainComposeFileWork()')).toBeGreaterThanOrEqual(0);
    expect(proceedWithSend.indexOf('await drainComposeFileWork()')).toBeLessThan(
      proceedWithSend.indexOf('onSendEmail({'),
    );
  });

  it('visibly rejects file changes after a send lock starts', () => {
    const rejection = between(
      'const rejectFileChangeDuringSend = useCallback(',
      'const queueAttachmentCandidates',
    );
    expect(rejection).toContain('setAttachmentStatus(message)');
    expect(rejection).toContain('toast.error(message)');

    const inlineImagePicker = between(
      'const handleInlineImagePickerClick = useCallback(',
      'const handleScheduleChange',
    );
    expect(inlineImagePicker).toContain('if (sendInFlightRef.current) {');
    expect(inlineImagePicker).toContain('rejectFileChangeDuringSend()');

    const addButton = between(
      'onClick={() => fileInputRef.current?.click()}',
      'aria-label="Insert image"',
    );
    expect(addButton).toContain('disabled={isLoading}');

    const inlineImageButton = between('aria-label="Insert image"', '<TemplateButton');
    expect(inlineImageButton).toContain('onClick={handleInlineImagePickerClick}');
    expect(inlineImageButton).toContain('disabled={isLoading}');

    const attachmentInput = between('id="attachment-input"', 'style={{ zIndex: 100 }}');
    expect(attachmentInput).toContain('disabled={isLoading}');

    const inlineImageInput = between('id="inline-image-input"', '{attachments && attachments.length > 0');
    expect(inlineImageInput).toContain('disabled={isLoading}');
  });

  it('captures every file paste before editor handlers while leaving no-file paste untouched', () => {
    expect(source).not.toContain("document.addEventListener('paste'");
    expect(source).toContain('onPasteCapture={handlePasteFiles}');
    expect(source).not.toContain('onPaste={handlePasteFiles}');

    const paste = between('const handlePasteFiles = useCallback(', 'const handleInlineImage');
    const fileGuard = paste.indexOf('if (!clipboardData || !clipboardData.files.length) return;');
    const preventDefault = paste.indexOf('event.preventDefault()');
    const stopPropagation = paste.indexOf('event.stopPropagation()');
    const queueCandidates = paste.indexOf('queueAttachmentCandidates');

    expect(fileGuard).toBeGreaterThanOrEqual(0);
    expect(paste).toMatch(
      /if \(!clipboardData \|\| !clipboardData\.files\.length\) return;\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/,
    );
    expect(paste).not.toContain('hasTextOrHtml');
    expect(preventDefault).toBeGreaterThan(fileGuard);
    expect(stopPropagation).toBeGreaterThan(preventDefault);
    expect(queueCandidates).toBeGreaterThan(stopPropagation);
  });

  it('captures native file drops before editor handlers and exposes passive status UI', () => {
    expect(source).toContain("Array.from(dataTransfer.types).includes('Files')");
    expect(source).toContain('const fileDragDepthRef = useRef(0)');
    expect(source).toContain('onDragEnter={handleFileDragEnter}');
    expect(source).toContain('onDragOver={handleFileDragOver}');
    expect(source).toContain('onDragLeave={handleFileDragLeave}');
    expect(source).toContain('onDropCapture={handleFileDrop}');
    expect(source).not.toContain('onDrop={handleFileDrop}');

    const drop = between('const handleFileDrop = useCallback(', 'const handlePasteFiles');
    const fileGuard = drop.indexOf('if (!hasFileDrag(event.dataTransfer)) return;');
    const preventDefault = drop.indexOf('event.preventDefault()');
    const stopPropagation = drop.indexOf('event.stopPropagation()');
    const queueCandidates = drop.indexOf('queueAttachmentCandidates');

    expect(fileGuard).toBeGreaterThanOrEqual(0);
    expect(preventDefault).toBeGreaterThan(fileGuard);
    expect(stopPropagation).toBeGreaterThan(preventDefault);
    expect(queueCandidates).toBeGreaterThan(stopPropagation);
    expect(drop).toContain('fileDragDepthRef.current = 0');

    expect(source).toContain('Drop files to attach');
    expect(source).toContain('pointer-events-none');
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
  });

  it('makes inline images explicit while file images remain attachments', () => {
    expect(source).toMatch(/enableInlineFileHandling:\s*false/);
    expect(source).toContain('aria-label="Insert image"');
    expect(source).toContain('inlineImageInputRef');
    expect(source).toContain('accept={COMPOSE_ATTACHMENT_ACCEPT}');
    expect(source).toContain('accept="image/*"');
    expect(source).toContain('key={attachmentEntry.id}');
    expect(source).toContain('await removeAttachment(attachmentEntry.id)');

    const inlineImage = between('const handleInlineImage = useCallback(', 'const handleQualityChange');
    expect(inlineImage).toContain('reader.readAsDataURL(file)');
    expect(inlineImage).toContain("type: 'image'");
    expect(inlineImage).toContain('if (sendInFlightRef.current) {');
    expect(inlineImage).toContain('rejectFileChangeDuringSend()');
    expect(inlineImage).toContain('enqueueInlineImageTask(');
    expect(inlineImage).not.toContain('queueAttachmentCandidates');
    expect(inlineImage).not.toContain('enqueueAttachmentTask');
  });

  it('rejects non-image inline picker files before queueing or reading', () => {
    const inlineImage = between('const handleInlineImage = useCallback(', 'const handleQualityChange');
    const sendLock = inlineImage.indexOf('if (sendInFlightRef.current) {');
    const nonImageGuard = inlineImage.indexOf("if (!file.type.startsWith('image/')) {");
    const enqueue = inlineImage.indexOf('return enqueueInlineImageTask(');
    const read = inlineImage.indexOf('reader.readAsDataURL(file)');

    expect(nonImageGuard).toBeGreaterThan(sendLock);
    expect(nonImageGuard).toBeLessThan(enqueue);
    expect(nonImageGuard).toBeLessThan(read);

    const rejection = inlineImage.slice(nonImageGuard, enqueue);
    expect(rejection).toContain("const message = 'Only image files can be inserted inline'");
    expect(rejection).toContain('setAttachmentStatus(message)');
    expect(rejection).toContain('toast.error(message)');
  });

  it('settles inline queue when editor insertion throws', () => {
    const onload = between('reader.onload = () => {', 'reader.onerror = fail;');

    expect(onload).toMatch(/try \{[\s\S]*\.insertContentAt\([\s\S]*\} catch \{[\s\S]*fail\(\)/);
  });

  it('replaces attachment previews when recompression replaces a File', () => {
    expect(source).toContain('type AttachmentPreviewUrlRecord = {');
    expect(source).toContain(
      'const attachmentPreviewUrlMapRef = useRef(new Map<string, AttachmentPreviewUrlRecord>())',
    );
    expect(source).toContain(
      'const nextMap = new Map<string, AttachmentPreviewUrlRecord>()',
    );

    const previews = between(
      'const previousMap = attachmentPreviewUrlMapRef.current;',
      'attachmentPreviewUrlMapRef.current = nextMap;',
    );
    expect(previews).toContain('existingPreview?.file === file');
    expect(previews).toContain('URL.createObjectURL(file)');
    expect(previews).toContain('URL.revokeObjectURL(existingPreview.url)');
    expect(previews).toContain('record.url');
  });
});
