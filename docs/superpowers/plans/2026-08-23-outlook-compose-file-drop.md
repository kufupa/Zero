# Outlook-style Compose File Drop Implementation Plan

**Goal:** Let staff attach supported files by dropping or pasting them anywhere in an active email composer, while keeping inline image insertion an explicit action.

**Architecture:** `EmailComposer` owns one serialized attachment-intake queue for Add, paste, and native file drop. A small shared policy module defines the existing supported file types and rejects other files consistently. The Tiptap hook keeps its existing inline-file handling by default for AI chat, but EmailComposer disables it so dropped images become attachments. A separate image-picker action retains intentional inline image insertion.

**Tech stack:** React 19, TypeScript, Tiptap, Tailwind, Vitest source/behavior contracts, ESLint.

## Global constraints

- Active compose only. Do not promise attachment restoration after closing and reopening a draft.
- Preserve existing clicked Add, compression, preview, removal, draft serialization, send, reply, and scheduling behavior.
- Supported attachment policy matches existing picker intent: `image/*`, PDF, Word (`.doc`, `.docx`), Excel (`.xls`, `.xlsx`), and text (`.txt`).
- Native file drops and clipboard file pastes attach files; they must never create inline images in EmailComposer.
- Text drags and ordinary text/HTML pastes retain editor/browser behavior.
- Keep `FileHandler` installed for `AIChat`; EmailComposer alone opts out.
- Do not interfere with dnd-kit mail/folder drags. React state may paint overlay UI, but the file-drag counter and queue state must be synchronous refs.
- The drag affordance is passive (`pointer-events-none`), announced through a polite live region, and never traps keyboard focus.
- Before every Vitest command, run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. No production/pilot database test access.
- Preserve unrelated user changes. Do not commit, push, deploy, or alter backend attachment storage.

## Files

- Create `apps/mail/lib/compose-attachment-policy.ts`
- Create `apps/mail/lib/attachment-intake-queue.ts`
- Create `apps/mail/tests/compose-attachment-policy.test.ts`
- Create `apps/mail/tests/attachment-intake-queue.test.ts`
- Create `apps/mail/tests/use-compose-editor-inline-file-handling-contract.test.ts`
- Create `apps/mail/tests/email-composer-file-intake-contract.test.ts`
- Modify `apps/mail/hooks/use-compose-editor.ts`
- Modify `apps/mail/components/create/email-composer.tsx`

## Task 1: Define supported compose attachment policy

**Files:**
- Create `apps/mail/lib/compose-attachment-policy.ts`
- Create `apps/mail/tests/compose-attachment-policy.test.ts`

**Requirements:**

1. Export one picker accept string equivalent to the current input policy:
   `image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt`.
2. Export a pure function that partitions candidate `File` objects into accepted and rejected arrays without changing their order.
3. Accept every `image/*` MIME type.
4. Accept PDF, Word, Excel, and text via known MIME types and safe case-insensitive extension fallback, including files whose browser MIME type is empty or generic.
5. Reject unsupported formats, including unknown binary extensions.
6. Do not introduce arbitrary size/count limits because none exist today.

**TDD proof:**

1. Write behavior tests for all accepted format groups, extension fallback, ordering, and rejected unsupported files.
2. Run the new test and observe failure before implementation.
3. Add only the policy needed to make the test pass.
4. Re-run the policy test and lint its implementation.

## Task 2: Make inline file handling opt-in

**Files:**
- Modify `apps/mail/hooks/use-compose-editor.ts`
- Create `apps/mail/tests/use-compose-editor-inline-file-handling-contract.test.ts`

**Requirements:**

1. Add `enableInlineFileHandling?: boolean` to `useComposeEditor`, defaulting to `true`.
2. Add the existing `FileHandler.configure(...)` extension only when that option is true.
3. Preserve the current default FileHandler image drop/paste behavior for `AIChat`; do not remove the dependency.
4. Let EmailComposer pass `enableInlineFileHandling: false` in Task 3.

**TDD proof:**

1. Add a focused source contract that checks the opt-in/default conditional and confirms `AIChat` keeps its default behavior.
2. Run it first and observe the expected failure.
3. Implement the conditional with no unrelated extension changes.
4. Re-run it with existing editor-related contracts. Task 3 owns the EmailComposer opt-out assertion because that call site does not exist until Task 3.

## Task 3: Route Add, paste, and file drops through one composer intake queue

**Files:**
- Modify `apps/mail/components/create/email-composer.tsx`
- Create `apps/mail/tests/email-composer-file-intake-contract.test.ts`

**Requirements:**

1. Replace direct Add/paste attachment state mutation with one queued intake path.
   - It filters through Task 1 policy.
   - It retains originals for recompression, runs existing `compressImages`, updates form attachments, marks unsaved changes, and reports accepted/rejected outcomes.
   - It serializes rapid Add/paste/drop/remove/quality operations through a promise ref and authoritative originals ref so events cannot overwrite one another.
   - Queue drain re-reads the current promise until it is stable and pending work reaches zero, so save/send cannot snapshot a removal or addition that was appended during a prior await.
   - Sending waits for stable queued attachment intake before checking attachment-keyword warning or building the send payload.
2. Replace document-wide paste listener with composer-root paste handling.
   - Only prevent default when clipboard data has file candidates.
   - Pasted supported files attach; text and HTML paste continue to the editor.
3. Add native drag handlers at the EmailComposer root.
   - Activate only for `DataTransfer` containing files.
   - Ignore non-file drags and do not prevent their default behavior.
   - Use a synchronous nested-enter counter ref to prevent overlay flicker.
   - On file drop, prevent default, clear active state, enqueue candidates, and attach supported files.
4. Show an in-composer, pointer-transparent “Drop files to attach” overlay only while a file drag is active. Include a polite live region for status/result feedback.
5. Change EmailComposer’s `useComposeEditor` call to opt out of inline FileHandler handling, so dropped/pasted images become attachments.
6. Add a visible, keyboard-accessible “Insert image” action plus hidden image-only picker.
   - A selected image is intentionally inserted into the editor as the current inline data-URL flow.
   - It must not enter the attachment intake path.
7. Use the shared picker accept string for Add and `image/*` for the inline-image picker.

**TDD proof:**

1. Add a focused contract covering policy import/use, queue refs, send drain, composer-scoped paste, native file-drag guard/counter/drop intake, passive live overlay, FileHandler opt-out, explicit image action, and both picker accept values.
2. Run it and observe failure before changing EmailComposer.
3. Implement the smallest composition matching the contract.
4. Run the new contract plus Task 1 and Task 2 tests, existing composer footer/draft ownership contracts, and mail lint.

## Integrated verification

1. Re-read this plan against the final diff; confirm all scope boundaries above.
2. Run:

   ```bash
   unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/mail exec vitest run \
     tests/compose-attachment-policy.test.ts \
     tests/use-compose-editor-inline-file-handling-contract.test.ts \
     tests/email-composer-file-intake-contract.test.ts \
     tests/composer-footer-parity-contract.test.ts \
     tests/compose-draft-ownership-contract.test.ts
   pnpm --filter @zero/mail lint
   pnpm --filter @zero/mail build
   ```

3. Run final `ce-code-review mode:agent plan:docs/superpowers/plans/2026-08-23-outlook-compose-file-drop.md`; fix verified P0/P1 findings, then re-run affected checks and repeat review if code changes materially.
4. Manual UI smoke when a local mail app is available: verify drop overlay, supported and rejected file feedback, rapid multi-file drop before Send, text paste, image paste becoming attachment, explicit inline image insertion, keyboard navigation, and a non-file drag.
