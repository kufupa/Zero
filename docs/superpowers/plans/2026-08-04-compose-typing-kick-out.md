# Compose Typing Kick-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task with a review after each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop reply and new-mail text, formatting, focus, and selection from being overwritten or remounted while staff type through autosaves.

**Architecture:** Give each mounted composer one monotonic local-edit revision ledger. A save acknowledges only the revision captured in its immutable pre-await snapshot; later edits remain dirty and queue a follow-up save. Server draft data may seed an untouched editor, but once any local edit occurs, that mounted editor owns its content. New-mail draft IDs remain persistence identity only and never become React mount identity.

**Tech Stack:** React 19, TipTap 2, React Hook Form, TanStack Query, tRPC, Vitest, existing frontend-only demo browser path.

## Global Constraints

- Human-authored content always wins over stale server echoes.
- Capture revision and every raw draft field before the first `await`, including attachment serialization.
- At most one draft mutation may be in flight per mounted composer.
- Autosave performs one snapshot save; explicit Save, send, close flush, and thread-switch flush drain serialized saves until the latest revision is persisted.
- A failed autosave remains dirty, shows the existing toast once, and does not retry automatically until the next local edit or explicit save.
- Do not redesign `shouldPersistDraft`, AI preview UX, compose-close failure policy, multi-tab merge, autocomplete, or backend draft schema in this fix.
- No new state library, hook abstraction, save-coordinator module, or dependency.
- Preserve unrelated working-tree changes. Do not edit `CONCEPTS.md`.
- Before every Vitest invocation: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`.
- Never run Vitest, Playwright, or another test runner against `nava-zero-mail-pilot` or any production database. Browser verification uses local frontend-only demo; database-required tests need a disposable non-production database.
- Do not commit unless the user separately requests a commit.

---

## Debug Proof

### Primary reply/new-mail overwrite

1. TipTap `onUpdate` sets `hasUnsavedChanges=true` in `apps/mail/components/create/email-composer.tsx`.
2. Three-second autosave snapshots editor HTML and starts `drafts.create`.
3. Staff continue typing while the request is in flight.
4. The old request succeeds and unconditionally calls `setHasUnsavedChanges(false)`.
5. `drafts.get` invalidation returns the older saved body.
6. The hydration effect sees “clean” and calls `editor.commands.setContent(olderHtml, false)`.
7. New text disappears; TipTap selection/focus can jump.

Current `chooseDraftEditorState` protects only *currently unsaved* content. A successful save incorrectly returns content ownership to the server even though the composer has a longer local history.

### Independent new-mail remount

1. Fresh compose mounts without `draftId`.
2. First autosave returns an ID and updates the URL.
3. `CreateEmail` starts `useDraft(newId)` and `isDraftLoading` replaces `EmailComposer` with a spinner.
4. Loaded data mounts another composer.
5. `key={typedDraft?.id || ...}` also changes component identity.

Removing the dynamic key alone is insufficient because the loading branch already unmounts the editor.

### Ruled out

- Reply AI generation does not stream into the editor; generated body is applied only on Accept.
- Ghost autocomplete is a decoration until Tab.
- Reply composer key is stable across reply/reply-all/forward mode changes.

---

## Requirements and Acceptance Examples

- **R1:** A save response acknowledges only edits included in that request.
- **R2:** Edits made during a save remain dirty and trigger one later autosave.
- **R3:** Draft saves are serialized; no overlapping create/update requests from one composer.
- **R4:** The first successful create ID is available synchronously to the next save, before URL/query state rerenders.
- **R5:** Server body/subject can hydrate only before the first local edit in that mounted composer.
- **R6:** Body typing, formatting, paste, subject, recipients, attachments, accepted AI content, and applied templates all count as local edits.
- **R7:** Programmatic server hydration and external reply-header synchronization do not count as local edits.
- **R8:** Fresh new mail remains mounted when first autosave assigns `draftId`.
- **R9:** An explicitly opened existing draft still blocks on its initial load and mounts once with server data.
- **R10:** Existing send, Save draft, and thread-switch paths wait for the latest serializable revision; send recaptures latest values after the drain.
- **R11:** Failed autosave never causes a three-second toast/network retry storm.

Acceptance examples:

- **AE1:** Save captures revision 1; staff type to revision 2 before response. Revision 1 succeeds, editor still shows revision 2, dirty stays true, and next autosave persists revision 2.
- **AE2:** Revision 2 succeeds with no later edit. Dirty becomes false, but later same-ID server refetch still cannot call `setContent`.
- **AE3:** Existing draft arrives before any local edit. Body and subject hydrate once.
- **AE4:** Staff type continuously through two autosaves. Exact text/HTML, focus, and caret remain stable.
- **AE5:** Fresh new mail receives its first draft ID. No spinner, loading announcement, editor-node replacement, or text loss occurs.
- **AE6:** Existing draft opened from Drafts shows the current loading state, then mounts with saved fields.
- **AE7:** A save fails. Content stays editable and dirty, one existing error toast appears, and no automatic retry occurs until another edit.
- **AE8:** AI Accept or template Apply during an in-flight save becomes a newer local revision and is not overwritten.
- **AE9:** Save/close/send invoked during autosave joins the current request, persists any newer revision serially, then continues. Send uses values captured after the drain.
- **AE10:** Reply → Reply All updates headers without replacing body, editor node, focus, or selection.

---

## Review Reconciliation

### Engineering completeness accepted

- Track all current draft-payload mutation surfaces, not body alone.
- Serialize saves and keep the returned draft ID in a synchronous ref.
- Snapshot before attachment serialization.
- Drain latest revision for terminal actions.
- Suppress repeated automatic retries after failure.
- Test stale acknowledgements and mount stability.

### Engineering findings deliberately excluded

- Subject-only/attachment-only/clear-all `shouldPersistDraft` redesign: valid separate contract issue, but not needed to fix the reproduced body overwrite and would widen product behavior.
- Removing `aiBlocked`: separate AI-preview/close policy.
- Changing `runComposeLeaveFlush` failure-clears behavior: settled compose-close product choice.
- New explicit-draft error/retry screen: existing behavior, unrelated to autosave remount.

### Simplicity gate

- Delete old plan’s `shouldApplyServerDraftHydrate` helper and hydrated-draft-ID ref.
- Replace two save/hydrate predicates with one two-event revision reducer.
- Keep coordination inside `EmailComposer`; no generic coordinator, custom hook, store, or backend work.
- `RecipientAutosuggest.onValueChange` and `TemplateButton.onApply` are required because each component has one call site.
- Keep the local save result distinction (`saved | skipped | failed`): flush must distinguish “nothing persistable” from “revision persisted” to avoid an infinite drain loop.
- Update the existing solution document; do not create another learning file.

### UX gate

- No visual redesign.
- Preserve exact text, rich formatting, focus, selection, and IME input.
- Existing-draft loader gains `role="status"` and `aria-live="polite"`.
- Autosave-created IDs produce no loader or announcement.

---

## File Map

- Modify `apps/mail/lib/mail/draft-persistence.ts`
  - Own the pure revision transition and lifetime-local hydration decision.
- Modify `apps/mail/tests/draft-persistence.test.ts`
  - Prove stale-save acknowledgement, catch-up, monotonicity, failure no-op, and hydration ownership.
- Modify `apps/mail/components/create/email-composer.tsx`
  - Own revision ref, single-flight save, active draft ID, retry suppression, terminal drain, and all local-edit marks.
- Modify `apps/mail/components/ui/recipient-autosuggest.tsx`
  - Report committed recipient changes through required `onValueChange`.
- Modify `apps/mail/components/create/template-button.tsx`
  - Report applied templates through required `onApply`.
- Modify `apps/mail/components/create/create-email.tsx`
  - Consume the composer-owned draft ID on send; preserve mount across autosave-created IDs; keep initial explicit-draft loading.
- Modify `apps/mail/components/mail/reply-composer.tsx`
  - Consume the composer-owned draft ID on reply/forward send.
- Create `apps/mail/tests/compose-draft-ownership-contract.test.ts`
  - Lock wiring and mount contracts using the repository’s established source-contract pattern.
- Modify `docs/solutions/logic-errors/mail-draft-refresh-data-loss-and-lifecycle.md`
  - Record the verified “save acknowledgement is not editor ownership” invariant.

Reference only:

- `apps/mail/hooks/use-compose-editor.ts`
- `apps/mail/tests/e2e/real-mail-compose-close-honesty.spec.ts`
- `docs/solutions/logic-errors/compose-close-draft-honesty.md`

---

### Task 1: Revision ownership model

**Files:**
- Modify: `apps/mail/lib/mail/draft-persistence.ts`
- Test: `apps/mail/tests/draft-persistence.test.ts`

**Interfaces:**

```ts
export type DraftRevisionState = {
  localRevision: number;
  savedRevision: number;
};

export type DraftRevisionEvent =
  | { type: 'edited' }
  | { type: 'saved'; capturedRevision: number };

export function reduceDraftRevision(
  state: DraftRevisionState,
  event: DraftRevisionEvent,
): DraftRevisionState;

type DraftEditorStateInput = {
  hasLocalEdits: boolean;
  localHtml: string;
  localSubject: string;
  serverDraft?: {
    content?: string | null;
    subject?: string | null;
    updatedAt?: string | null;
  } | null;
};
```

- [ ] **Step 1: Write failing revision tests**

Add focused cases:

```ts
it('acknowledges only the revision captured by an in-flight save', () => {
  let state = { localRevision: 0, savedRevision: 0 };
  state = reduceDraftRevision(state, { type: 'edited' });
  const capturedRevision = state.localRevision;
  state = reduceDraftRevision(state, { type: 'edited' });
  state = reduceDraftRevision(state, { type: 'saved', capturedRevision });

  expect(state).toEqual({ localRevision: 2, savedRevision: 1 });
});

it('clears the revision gap when the latest save succeeds', () => {
  const state = reduceDraftRevision(
    { localRevision: 2, savedRevision: 1 },
    { type: 'saved', capturedRevision: 2 },
  );
  expect(state).toEqual({ localRevision: 2, savedRevision: 2 });
});

it('never lets an older acknowledgement move saved revision backward', () => {
  const state = reduceDraftRevision(
    { localRevision: 3, savedRevision: 2 },
    { type: 'saved', capturedRevision: 1 },
  );
  expect(state).toEqual({ localRevision: 3, savedRevision: 2 });
});
```

Update the existing hydration test to pass `hasLocalEdits: true`. Add a saved-but-locally-owned case proving server data still loses after revisions are equal.

- [ ] **Step 2: Run the focused test and confirm red**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --dir apps/mail exec vitest run tests/draft-persistence.test.ts
```

Expected: FAIL because `reduceDraftRevision` is not exported and `DraftEditorStateInput` still expects `isDirty`.

- [ ] **Step 3: Implement the minimal pure reducer**

```ts
export function reduceDraftRevision(
  state: DraftRevisionState,
  event: DraftRevisionEvent,
): DraftRevisionState {
  if (event.type === 'edited') {
    return { ...state, localRevision: state.localRevision + 1 };
  }
  return {
    ...state,
    savedRevision: Math.max(state.savedRevision, event.capturedRevision),
  };
}
```

Change `chooseDraftEditorState` to branch on `hasLocalEdits`. Keep server hydration behavior unchanged when false.

- [ ] **Step 4: Run focused tests green**

Run the same Vitest command.

Expected: all `draft-persistence.test.ts` cases pass.

- [ ] **Step 5: Review checkpoint**

Confirm reducer has exactly two events, no async behavior, no content equality, and no draft-ID awareness.

---

### Task 2: Mark every local draft mutation

**Files:**
- Modify: `apps/mail/components/create/email-composer.tsx`
- Modify: `apps/mail/components/ui/recipient-autosuggest.tsx`
- Modify: `apps/mail/components/create/template-button.tsx`
- Create: `apps/mail/tests/compose-draft-ownership-contract.test.ts`

**Interfaces:**

```ts
// RecipientAutosuggestProps
onValueChange: () => void;

// TemplateButtonProps
onApply: () => void;
```

- [ ] **Step 1: Write the failing ownership wiring contract**

Use `readFileSync(new URL(..., import.meta.url), 'utf8')`, matching `mail-shell-overflow-contract.test.ts`. Assert:

```ts
expect(emailComposerSource).toContain('revisionRef');
expect(emailComposerSource).toContain('markUnsavedChanges');
expect(emailComposerSource).toMatch(/hasLocalEdits:\s*revisionRef\.current\.localRevision > 0/);
expect(emailComposerSource).toContain('onValueChange={markUnsavedChanges}');
expect(emailComposerSource).toContain('onApply={markUnsavedChanges}');
expect(recipientSource).toContain('onValueChange();');
expect(templateSource).toContain('onApply();');
```

Also assert the AI Accept branch calls `markUnsavedChanges()` after `setContent`.

- [ ] **Step 2: Run the contract test and confirm red**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --dir apps/mail exec vitest run tests/compose-draft-ownership-contract.test.ts
```

Expected: FAIL on missing revision and callback wiring.

- [ ] **Step 3: Add the mounted-session revision ref**

In `EmailComposer`:

```ts
const revisionRef = useRef<DraftRevisionState>({
  localRevision: 0,
  savedRevision: 0,
});

const markUnsavedChanges = useCallback(() => {
  revisionRef.current = reduceDraftRevision(revisionRef.current, { type: 'edited' });
  setHasUnsavedChanges(true);
}, []);
```

Replace existing `setHasUnsavedChanges(true)` sites with `markUnsavedChanges`. Make attachment processing mark once per logical mutation, including removing the final attachment.

- [ ] **Step 4: Wire recipient changes**

In `RecipientAutosuggest`, route add, remove, and paste commits through one function:

```ts
const commitRecipients = useCallback(
  (next: string[]) => {
    onRecipientsChange(next);
    onValueChange();
  },
  [onRecipientsChange, onValueChange],
);
```

Do not mark query text, dropdown navigation, invalid input, or focus changes.

- [ ] **Step 5: Wire programmatic local content**

- `TemplateButton` calls required `onApply()` once after applying the template.
- AI Accept calls `editor.commands.setContent(content, false)`, then `markUnsavedChanges()`.
- Server hydration keeps `setContent(..., false)` and does not mark.
- `syncReplyHeadersFromProps` remains unmarked because it is external synchronization, not staff editing.

- [ ] **Step 6: Gate hydration by lifetime ownership**

Call:

```ts
chooseDraftEditorState({
  hasLocalEdits: revisionRef.current.localRevision > 0,
  localHtml: editor.getHTML(),
  localSubject: subjectInput,
  serverDraft,
});
```

Remove `hasUnsavedChanges` from this effect’s ownership decision. A successful save must not reset `localRevision`.

- [ ] **Step 7: Run Task 1–2 tests**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --dir apps/mail exec vitest run tests/draft-persistence.test.ts tests/compose-draft-ownership-contract.test.ts
```

Expected: PASS.

---

### Task 3: Serialize saves and acknowledge captured revisions

**Files:**
- Modify: `apps/mail/components/create/email-composer.tsx`
- Modify: `apps/mail/components/create/create-email.tsx`
- Modify: `apps/mail/components/mail/reply-composer.tsx`
- Test: `apps/mail/tests/compose-draft-ownership-contract.test.ts`

**Interfaces:**

```ts
type DraftSaveResult = 'saved' | 'skipped' | 'failed';

const persistDraftOnce: () => Promise<DraftSaveResult>;
const flushDraftUntilCurrent: () => Promise<boolean>;

type ComposerSendInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  message: string;
  attachments: File[];
  fromEmail?: string;
  scheduleAt?: string;
  draftId?: string;
};

const onSendEmail: (input: ComposerSendInput) => Promise<boolean>;
```

- [ ] **Step 1: Extend the failing source contract**

Assert presence of:

```ts
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
```

Assert the old unconditional post-save `setHasUnsavedChanges(false)` is absent from the save-success section.

- [ ] **Step 2: Run contract test red**

Run the Task 2 contract-test command.

Expected: FAIL on missing save coordination.

- [ ] **Step 3: Add single-flight and draft-ID refs**

```ts
const activeDraftIdRef = useRef<string | null>(draftId ?? null);
const saveInFlightRef = useRef<Promise<DraftSaveResult> | null>(null);
const [autosaveSuppressedAfterFailure, setAutosaveSuppressedAfterFailure] = useState(false);
```

Synchronize a non-null URL `draftId` into `activeDraftIdRef`. On create success, assign `response.id` to the ref before calling `setDraftId`. Extend `markUnsavedChanges` here to call `setAutosaveSuppressedAfterFailure(false)`; Task 2 remains independently compilable before this state exists.

- [ ] **Step 4: Join first, then snapshot before every await**

At `persistDraftOnce` entry:

```ts
if (saveInFlightRef.current) return saveInFlightRef.current;

const capturedRevision = revisionRef.current.localRevision;
const values = getValues();
const snapshot = {
  hasUnsavedChanges:
    revisionRef.current.localRevision > revisionRef.current.savedRevision,
  initialHtml: initialMessage ?? '',
  aiBlocked: Boolean(aiGeneratedMessage || aiIsLoading || isGeneratingSubject),
  draftId: activeDraftIdRef.current,
  threadId: threadId ?? null,
  replyToMessageId,
  to: [...(values.to ?? [])],
  cc: [...(values.cc ?? [])],
  bcc: [...(values.bcc ?? [])],
  subject: values.subject ?? '',
  html: editor.getHTML(),
  text: editor.getText(),
  fromEmail: values.fromEmail || undefined,
  attachments: [...(values.attachments ?? [])],
};
```

Run `shouldPersistDraft` with `snapshot.hasUnsavedChanges`, `snapshot.initialHtml`, `snapshot.aiBlocked`, and the captured content fields. If it returns false, return `skipped`. Otherwise create and assign the in-flight promise synchronously; serialize `snapshot.attachments` only inside that claimed promise.

- [ ] **Step 5: Claim or join one promise**

- The existing-promise check happens before any snapshot or persistence decision.
- Create one promise, assign it to the ref before its first asynchronous continuation, and set `isSavingDraft=true`.
- On success:
  - update `activeDraftIdRef` immediately;
  - reduce `{ type: 'saved', capturedRevision }`;
  - mirror `localRevision > savedRevision` into `hasUnsavedChanges`;
  - keep query invalidations fire-and-forget.
- On failure:
  - do not acknowledge the revision;
  - keep dirty;
  - set `autosaveSuppressedAfterFailure=true`;
  - emit the existing error toast once.
- In `finally`, clear `saveInFlightRef` only when it still equals the promise being finalized, then set `isSavingDraft=false`.

- [ ] **Step 6: Drain only for terminal actions**

`flushDraftUntilCurrent`:

1. Await/join `persistDraftOnce`.
2. Return false on `failed`.
3. Return true on `skipped`, preserving existing non-persistable close semantics.
4. After `saved`, repeat while `savedRevision < localRevision`.

Wire it into:

- explicit Save draft;
- registered thread-switch flush;
- send preflight.

Autosave calls `persistDraftOnce` once; it never loops.

Terminal result handling is exact:

- Remove the current `isSavingDraft` early-return from send; send joins/drains instead.
- Explicit Save keeps the dialog open when the flush returns false.
- Send aborts when the flush returns false.
- Thread-switch awaits the flush but preserves the existing leave-on-failure policy.

After send drain succeeds, call `getValues()` and `editor.getHTML()` again before building `onSendEmail` input. Do not reuse values captured before the drain.

Add `draftId?: string` to the `onSendEmail` payload. `EmailComposer` passes `activeDraftIdRef.current ?? undefined`; both `CreateEmail.handleSendEmail` and `ReplyCompose.handleSendEmail` use that payload value instead of their potentially stale query-state closure.

Make `onSendEmail` return `Promise<boolean>`. Both parent handlers return `true` only after transport success, return `false` after an already-reported ordinary failure, and return `false` when stale-send confirmation is cancelled. `EmailComposer` performs cleanup only when the result is `true`; an unexpected thrown error also keeps content mounted.

On a `true` send result:

```ts
activeDraftIdRef.current = null;
setDraftId(null);
setHasUnsavedChanges(false);
revisionRef.current = { localRevision: 0, savedRevision: 0 };
editor.commands.clearContent(false);
```

`clearContent(false)` is required so cleanup does not create a fresh local revision and post-send autosave.

- [ ] **Step 7: Re-arm autosave safely**

```ts
useEffect(() => {
  if (isSavingDraft || !hasUnsavedChanges || autosaveSuppressedAfterFailure) return;
  const timer = setTimeout(() => void persistDraftOnce(), 3000);
  return () => clearTimeout(timer);
}, [
  autosaveSuppressedAfterFailure,
  hasUnsavedChanges,
  isSavingDraft,
  persistDraftOnce,
]);
```

If edits arrived in flight, save success leaves dirty true; `isSavingDraft` changing to false arms the next timer. Failure suppression blocks a retry storm. The next `markUnsavedChanges` clears suppression reactively.

- [ ] **Step 8: Run focused tests and lint**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --dir apps/mail exec vitest run tests/draft-persistence.test.ts tests/compose-draft-ownership-contract.test.ts
pnpm --dir apps/mail exec eslint components/create/email-composer.tsx components/create/create-email.tsx components/create/template-button.tsx components/mail/reply-composer.tsx components/ui/recipient-autosuggest.tsx lib/mail/draft-persistence.ts tests/draft-persistence.test.ts tests/compose-draft-ownership-contract.test.ts
```

Expected: tests pass; ESLint reports no new errors.

---

### Task 4: Preserve new-mail composer mount

**Files:**
- Modify: `apps/mail/components/create/create-email.tsx`
- Test: `apps/mail/tests/compose-draft-ownership-contract.test.ts`

- [ ] **Step 1: Add failing mount-contract assertions**

```ts
expect(createEmailSource).toContain('initialDraftIdRef');
expect(createEmailSource).toMatch(/initialDraftIdRef\.current.*!draft.*!draftError/s);
expect(createEmailSource).not.toContain('key={typedDraft?.id');
expect(createEmailSource).toContain('role="status"');
expect(createEmailSource).toContain('aria-live="polite"');
```

- [ ] **Step 2: Run contract test red**

Run focused Vitest command.

Expected: FAIL on current loading condition, dynamic key, and loader semantics.

- [ ] **Step 3: Capture mount-time draft intent**

```ts
const initialDraftIdRef = useRef(draftId ?? propDraftId ?? null);
const shouldWaitForInitialDraft =
  Boolean(initialDraftIdRef.current) && !draft && !draftError;
```

Use `shouldWaitForInitialDraft` for the existing loading branch. This also waits while the query is session-disabled. An ID created after mount cannot activate the branch.

- [ ] **Step 4: Stabilize identity and loader semantics**

- Remove `typedDraft?.id` and recipient data from `EmailComposer` key; omit the key entirely.
- Add `role="status"` and `aria-live="polite"` to the existing initial-draft loader.
- Preserve existing error toast/fallback and current visual styling.

- [ ] **Step 5: Run focused tests green**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --dir apps/mail exec vitest run tests/draft-persistence.test.ts tests/compose-draft-ownership-contract.test.ts
```

Expected: PASS.

---

### Task 5: Full verification and institutional update

**Files:**
- Modify after proof: `docs/solutions/logic-errors/mail-draft-refresh-data-loss-and-lifecycle.md`

- [ ] **Step 1: Run full frontend unit suite**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --dir apps/mail exec vitest run tests
```

Expected: all frontend Vitest tests pass. If a database-required test appears, stop and provision a disposable non-production database; never point it at pilot RDS.

- [ ] **Step 2: Run static gates**

```bash
pnpm --dir apps/mail exec eslint components/create/email-composer.tsx components/create/create-email.tsx components/create/template-button.tsx components/mail/reply-composer.tsx components/ui/recipient-autosuggest.tsx lib/mail/draft-persistence.ts tests/draft-persistence.test.ts tests/compose-draft-ownership-contract.test.ts
pnpm --dir apps/mail exec tsc --noEmit
pnpm --filter @zero/mail build
```

Expected: no new lint/type/build failures.

- [ ] **Step 3: Run local frontend-only browser canary**

Start:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm dev:demo:frontend
```

Use browser verification against the local URL:

1. New mail: type continuously for more than 10 seconds and through at least two autosave cycles.
2. Record the `.ProseMirror` DOM node, focus, selection, exact text, and HTML before/after first `draftId`.
3. Confirm no loader or loading announcement appears when the first ID is assigned.
4. Reply: type, format text, paste rich text, switch Reply → Reply All, and wait through two autosaves.
5. Accept AI content and apply a template; confirm both remain after autosave.
6. Open an existing demo draft; confirm the initial loader appears once and content hydrates.
7. Exercise native IME composition; confirm composition is uninterrupted and committed text persists.

Expected: no text rollback, remount, focus loss, caret jump, or duplicate save.

- [ ] **Step 4: Update the existing solution**

Append the verified recurrence pattern:

- “dirty” and “locally owned” are different states;
- save acknowledgement covers only its captured revision;
- successful autosave never grants server refetch permission to rewrite an edited mount;
- persistence ID changes must not change React editor identity;
- snapshot before attachment serialization and serialize saves.

Do not create a second solution file.

- [ ] **Step 5: Final review**

- Run correctness review on the final diff.
- Run `ponytail-review`; retain only complexity required by single-flight, revision ownership, and deterministic proof.
- Re-run focused tests if review changes code.

---

## Done Criteria

- Exact local body/formatting survives stale save responses and same-ID refetches.
- Edits made during a save remain dirty and are persisted by a serialized follow-up save.
- No overlapping draft mutations from one mounted composer.
- New-mail first autosave never unmounts the editor.
- Existing draft initial loading still works and is announced accessibly.
- AI/template/recipient/subject/attachment mutations participate in local ownership.
- Failed autosave creates no automatic retry storm.
- Focused and full frontend tests, lint, typecheck, build, and local browser canary are green.
- Existing solution document records the verified invariant.

## Execution

Canonical next step: `/nava-run docs/superpowers/plans/2026-08-04-compose-typing-kick-out.md`.
