# Compose Close Draft Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` under **Overnight Autonomous Execution Mandate** + **Execution Mode** below. **SDD with parallel Wave 2.** No "which approach?" pause. Do **not** use sequential-only executing-plans unless subagents unavailable. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Honest Save draft / Discard / Keep editing on composer X; real lifecycle discard; silent flush-save on dirty thread switch; silent empty close.

**Architecture:** (1) Pure close/flush helpers in `draft-persistence` + a tiny module-level compose flush registry. (2) One EmailComposer task owns dialog + register/unregister flush + Escape/beforeunload. (3) Parallel navigation agents call the registry before clearing compose URL state — they never edit `email-composer.tsx`.

**Tech Stack:** React, TipTap, tRPC `drafts.create` / `drafts.delete`, Vitest, shadcn Dialog/Button, `optimisticDeleteDraft`, nuqs compose URL state.

**Authority:** `docs/plans/2026-07-24-001-fix-compose-close-draft-honesty-plan.md`

## Global Constraints

- Classic Outlook close honesty (Save / Discard / Keep editing) + Gmail-like silent save on navigate.
- Meaningful content = `shouldPersistDraft` predicates only — no second heuristic.
- Discard = `optimisticDeleteDraft` → `drafts.delete` → `status='discarded'`, never close-UI-only.
- Reply+X with no new edits must not discard a prior-session active draft.
- Dialog chrome order: Keep editing (`outline`) → Save draft (default) → Discard (`destructive`).
- i18n under `common.replyCompose`: reuse `saveDraft`; add `discardDraft`, `keepEditing`, `closeDraftTitle`, `closeDraftBody`.
- English `apps/mail/messages/en.json` required this PR; other locales deferred (fallback OK).
- **File ownership:** never two parallel agents edit the same file.
- TDD: failing test → implement → green → commit per task (or per parallel lane).
- Model: implementer = standard capable model (not fast); mechanical pure-helper task may use composer-2.5; final branch review = most capable available.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report under `docs/superpowers/plans/handoff-reports/` if shipping overnight.

### Done criteria

- [x] Task 1–2 + Wave 2 lanes 3a/3b implemented, reviewed, committed
- [x] `pnpm exec vitest run tests/draft-persistence.test.ts tests/compose-flush-registry.test.ts tests/reply-compose-context.test.ts tests/stale-draft-send-flow.test.ts` green in `apps/mail`
- [x] AE1–AE4 satisfied (Save draft / Discard / Keep editing honesty; silent flush on thread switch; silent empty close)
- [x] No lying "changes will be lost" Stay/Leave dialog remains
- [x] Push `EC2-pilot` + `ops-deploy.sh` when FE ship needs pilot host (no schema migrate expected)
- [x] No open blockers for compose-close honesty goal

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` with **parallel Wave 2** (Task 3a + 3b same parent turn). Do not ask "which approach?" Fallback `executing-plans` only if subagents unavailable; still honor file ownership.

---

## SDD + Parallel Dispatch Protocol

### Why parallel works here (analysis)

| Old sequential tasks | Shared files? | Parallel? |
|----------------------|---------------|-----------|
| Pure helpers | alone | Wave 0 alone |
| Dialog + Escape + flush register inside composer | `email-composer.tsx` | **Must be one agent** — old Task 2+4 merged |
| mail-list flush | `mail-list.tsx` only | Wave 2 lane A |
| thread-display flush | `thread-display.tsx` only | Wave 2 lane B |
| reply-composer | only if prop-drilling | **Avoided** via module registry — no Wave 2 reply-composer edit required |

**Do not parallelize** dialog work with flush-registration work — both touch `email-composer.tsx` (dispatching-parallel-agents: shared state → sequential).

**Do parallelize** mail-list vs thread-display after the registry exists — independent domains, no shared writes.

### Execution graph

```text
Wave 0 (sequential, 1 implementer + 1 reviewer)
  Task 1: pure helpers + compose-flush-registry + Vitest
       |
Wave 1 (sequential, 1 implementer + 1 reviewer)
  Task 2: EmailComposer dialog + Discard/Save + register flush + Escape/beforeunload + en.json
       |
Wave 2 (PARALLEL — dispatch BOTH implementers in the SAME parent turn)
  Task 3a: mail-list.tsx — await flushComposeBeforeLeave, fix keyboard draftId clear
  Task 3b: thread-display.tsx — await flush inside clearComposeContext
       |
  Parallel task-reviewers (optional, same turn) OR one combined Wave-2 reviewer
       |
Final whole-branch code review (1 capable reviewer)
```

### Parent coordinator rules (SDD)

1. Fresh implementer subagent per task/lane; paste only that task's section + Global Constraints + Interfaces from prior waves — **no full chat history**.
2. After each sequential task: task-reviewer (spec + quality); fix Critical/Important before next wave.
3. Wave 2: fire Task 3a and Task 3b implementers **in one message** (true parallel). Wait for both. Then one Wave-2 review covering both diffs.
4. If either Wave-2 agent needs `email-composer.tsx`, STOP — design violated; fix registry instead.
5. Continuous execution — do not ask the human between tasks unless BLOCKED.

### Subagent prompt stubs (parent fills paths)

**Task 1 implementer:** mechanical TDD on `draft-persistence.ts` + new `compose-flush-registry.ts` only.

**Task 2 implementer:** `email-composer.tsx` + `en.json` only; import registry + helpers from Task 1; wire `optimisticDeleteDraft`.

**Task 3a implementer:** `mail-list.tsx` only; call `flushComposeBeforeLeave` then clear compose; add `setDraftId(null)` on keyboard nav.

**Task 3b implementer:** `thread-display.tsx` only; `clearComposeContext` awaits `flushComposeBeforeLeave` then `clearReplyComposeContext`.

---

## File Map

| File | Owner task | Responsibility |
|------|------------|----------------|
| `apps/mail/lib/mail/draft-persistence.ts` | Task 1 | `resolveComposeCloseAction`, `nextAfterDialogChoice`, `runComposeLeaveFlush` |
| `apps/mail/lib/mail/compose-flush-registry.ts` | Task 1 | Module register/get/flush — enables Wave 2 parallel |
| `apps/mail/tests/draft-persistence.test.ts` | Task 1 | Gate + dialog choice + leave-flush tests |
| `apps/mail/tests/compose-flush-registry.test.ts` | Task 1 | Registry register / clear / flush |
| `apps/mail/components/create/email-composer.tsx` | Task 2 | Dialog, handlers, register flush, Escape, beforeunload |
| `apps/mail/messages/en.json` | Task 2 | Copy keys |
| `apps/mail/components/mail/mail-list.tsx` | Task 3a | Flush before thread click / keyboard nav |
| `apps/mail/components/mail/thread-display.tsx` | Task 3b | Flush before clearComposeContext |

**Not modified this PR:** `reply-composer.tsx` (registry removes need), other locale JSON, create-email DialogClose bypass (deferred in authority plan).

---

### Task 1: Pure helpers + compose flush registry (Wave 0)

**Files:**
- Modify: `apps/mail/lib/mail/draft-persistence.ts`
- Create: `apps/mail/lib/mail/compose-flush-registry.ts`
- Test: `apps/mail/tests/draft-persistence.test.ts`
- Test: `apps/mail/tests/compose-flush-registry.test.ts`

**Interfaces:**
- Consumes: existing `shouldPersistDraft` / `PersistDecisionInput`
- Produces (exact names Wave 1–2 must use):

```ts
// draft-persistence.ts
export type ComposeCloseIntent = 'userClose' | 'threadSwitch';
export type ComposeCloseAction = 'closeSilent' | 'prompt' | 'flushAndLeave';
export type ComposeDialogChoice = 'keepEditing' | 'saveDraft' | 'discard';

export function resolveComposeCloseAction(
  input: PersistDecisionInput & { intent: ComposeCloseIntent },
): ComposeCloseAction;

export function nextAfterDialogChoice(
  choice: ComposeDialogChoice,
): 'dismiss' | 'saveThenClose' | 'discardThenClose';

export async function runComposeLeaveFlush(
  flush: (() => Promise<void>) | null | undefined,
  clear: () => void | Promise<void>,
): Promise<void>;

// compose-flush-registry.ts
export type ComposeFlushFn = () => Promise<void>;
export function registerComposeFlush(fn: ComposeFlushFn | null): void;
export function getComposeFlush(): ComposeFlushFn | null;
export async function flushComposeBeforeLeave(): Promise<void>;
```

- [ ] **Step 1: Write failing tests for `resolveComposeCloseAction` + `nextAfterDialogChoice` + `runComposeLeaveFlush`**

Append to `apps/mail/tests/draft-persistence.test.ts`:

```ts
import {
  nextAfterDialogChoice,
  resolveComposeCloseAction,
  runComposeLeaveFlush,
} from '../lib/mail/draft-persistence';

describe('resolveComposeCloseAction', () => {
  const dirtyBody = {
    hasUnsavedChanges: true,
    initialHtml: '',
    html: '<p>Thanks</p>',
    text: 'Thanks',
    to: [] as string[],
    subject: '',
    aiBlocked: false,
  };

  it('prompts on userClose when content is persistable', () => {
    expect(resolveComposeCloseAction({ ...dirtyBody, intent: 'userClose' })).toBe('prompt');
  });

  it('flushAndLeave on threadSwitch when content is persistable', () => {
    expect(resolveComposeCloseAction({ ...dirtyBody, intent: 'threadSwitch' })).toBe(
      'flushAndLeave',
    );
  });

  it('closeSilent when whitespace-only and no subject/to', () => {
    expect(
      resolveComposeCloseAction({
        hasUnsavedChanges: true,
        initialHtml: '',
        html: '<p>   </p>',
        text: '   ',
        to: [],
        subject: '',
        aiBlocked: false,
        intent: 'userClose',
      }),
    ).toBe('closeSilent');
  });

  it('closeSilent when html unchanged from initial (quoted reply only)', () => {
    expect(
      resolveComposeCloseAction({
        hasUnsavedChanges: true,
        initialHtml: '<p>Quoted</p>',
        html: '<p>Quoted</p>',
        text: 'Quoted',
        to: [],
        subject: '',
        aiBlocked: false,
        intent: 'userClose',
      }),
    ).toBe('closeSilent');
  });

  it('closeSilent when not dirty', () => {
    expect(
      resolveComposeCloseAction({
        ...dirtyBody,
        hasUnsavedChanges: false,
        intent: 'userClose',
      }),
    ).toBe('closeSilent');
  });
});

describe('nextAfterDialogChoice', () => {
  it('maps keepEditing / saveDraft / discard', () => {
    expect(nextAfterDialogChoice('keepEditing')).toBe('dismiss');
    expect(nextAfterDialogChoice('saveDraft')).toBe('saveThenClose');
    expect(nextAfterDialogChoice('discard')).toBe('discardThenClose');
  });
});

describe('runComposeLeaveFlush', () => {
  it('awaits flush then clear', async () => {
    const order: string[] = [];
    await runComposeLeaveFlush(
      async () => {
        order.push('flush');
      },
      () => {
        order.push('clear');
      },
    );
    expect(order).toEqual(['flush', 'clear']);
  });

  it('still clears when flush rejects', async () => {
    const order: string[] = [];
    await runComposeLeaveFlush(
      async () => {
        order.push('flush');
        throw new Error('save failed');
      },
      () => {
        order.push('clear');
      },
    );
    expect(order).toEqual(['flush', 'clear']);
  });

  it('clears when flush is null', async () => {
    let cleared = false;
    await runComposeLeaveFlush(null, () => {
      cleared = true;
    });
    expect(cleared).toBe(true);
  });
});
```

- [ ] **Step 2: Write failing tests for registry**

Create `apps/mail/tests/compose-flush-registry.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import {
  flushComposeBeforeLeave,
  getComposeFlush,
  registerComposeFlush,
} from '../lib/mail/compose-flush-registry';

describe('compose-flush-registry', () => {
  beforeEach(() => {
    registerComposeFlush(null);
  });

  it('registers and returns flush fn', () => {
    const fn = async () => {};
    registerComposeFlush(fn);
    expect(getComposeFlush()).toBe(fn);
  });

  it('flushComposeBeforeLeave invokes registered fn', async () => {
    let called = false;
    registerComposeFlush(async () => {
      called = true;
    });
    await flushComposeBeforeLeave();
    expect(called).toBe(true);
  });

  it('flushComposeBeforeLeave is no-op when empty', async () => {
    await expect(flushComposeBeforeLeave()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

Run: `cd apps/mail && pnpm exec vitest run tests/draft-persistence.test.ts tests/compose-flush-registry.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 4: Minimal implementation**

In `draft-persistence.ts` add:

```ts
export type ComposeCloseIntent = 'userClose' | 'threadSwitch';
export type ComposeCloseAction = 'closeSilent' | 'prompt' | 'flushAndLeave';
export type ComposeDialogChoice = 'keepEditing' | 'saveDraft' | 'discard';

export function resolveComposeCloseAction(
  input: PersistDecisionInput & { intent: ComposeCloseIntent },
): ComposeCloseAction {
  const { intent, ...persistInput } = input;
  if (!shouldPersistDraft(persistInput)) return 'closeSilent';
  if (intent === 'threadSwitch') return 'flushAndLeave';
  return 'prompt';
}

export function nextAfterDialogChoice(
  choice: ComposeDialogChoice,
): 'dismiss' | 'saveThenClose' | 'discardThenClose' {
  if (choice === 'keepEditing') return 'dismiss';
  if (choice === 'saveDraft') return 'saveThenClose';
  return 'discardThenClose';
}

export async function runComposeLeaveFlush(
  flush: (() => Promise<void>) | null | undefined,
  clear: () => void | Promise<void>,
): Promise<void> {
  try {
    await flush?.();
  } catch {
    // Caller/saveDraft owns user-visible error toast; never block leave.
  } finally {
    await clear();
  }
}
```

Create `apps/mail/lib/mail/compose-flush-registry.ts`:

```ts
export type ComposeFlushFn = () => Promise<void>;

let composeFlush: ComposeFlushFn | null = null;

export function registerComposeFlush(fn: ComposeFlushFn | null): void {
  composeFlush = fn;
}

export function getComposeFlush(): ComposeFlushFn | null {
  return composeFlush;
}

export async function flushComposeBeforeLeave(): Promise<void> {
  await composeFlush?.();
}
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `cd apps/mail && pnpm exec vitest run tests/draft-persistence.test.ts tests/compose-flush-registry.test.ts`
Expected: PASS (including pre-existing draft-persistence cases).

- [ ] **Step 6: Commit**

```bash
git add apps/mail/lib/mail/draft-persistence.ts apps/mail/lib/mail/compose-flush-registry.ts apps/mail/tests/draft-persistence.test.ts apps/mail/tests/compose-flush-registry.test.ts
git commit -m "feat(mail): compose close helpers and flush registry"
```

- [ ] **Step 7: SDD task review** — parent dispatches reviewer on Task 1 diff; fix Critical/Important before Wave 1.

---

### Task 2: EmailComposer honest dialog + flush registration (Wave 1)

**Files:**
- Modify: `apps/mail/components/create/email-composer.tsx`
- Modify: `apps/mail/messages/en.json` (`common.replyCompose` keys)

**Interfaces:**
- Consumes: `resolveComposeCloseAction`, `nextAfterDialogChoice`, `registerComposeFlush`, `shouldPersistDraft`, `optimisticDeleteDraft`
- Produces: registered flush that runs `saveDraft` when `resolveComposeCloseAction(..., threadSwitch)==='flushAndLeave'`; dialog wired to Save/Discard/Keep editing

- [ ] **Step 1: Add en.json keys**

Under `common.replyCompose` add (keep existing `saveDraft`):

```json
"discardDraft": "Discard",
"keepEditing": "Keep editing",
"closeDraftTitle": "Close draft?",
"closeDraftBody": "Save this message as a draft, discard it, or keep editing."
```

- [ ] **Step 2: Register flush on mount**

In `EmailComposer`, after `saveDraft` exists:

```ts
useEffect(() => {
  const flush = async () => {
    const values = getValues();
    const action = resolveComposeCloseAction({
      hasUnsavedChanges,
      initialHtml: initialMessage ?? '',
      html: editor?.getHTML() ?? '',
      text: editor?.getText() ?? '',
      to: values.to ?? [],
      subject: values.subject ?? '',
      aiBlocked: Boolean(aiGeneratedMessage || aiIsLoading || isGeneratingSubject),
      intent: 'threadSwitch',
    });
    if (action === 'flushAndLeave') {
      await saveDraft();
    }
  };
  registerComposeFlush(flush);
  return () => registerComposeFlush(null);
}, [
  hasUnsavedChanges,
  initialMessage,
  editor,
  aiGeneratedMessage,
  aiIsLoading,
  isGeneratingSubject,
  saveDraft,
  getValues,
]);
```

- [ ] **Step 3: Replace handleClose + dialog handlers**

```ts
const buildPersistInput = (): PersistDecisionInput => {
  const values = getValues();
  return {
    hasUnsavedChanges,
    initialHtml: initialMessage ?? '',
    html: editor?.getHTML() ?? '',
    text: editor?.getText() ?? '',
    to: values.to ?? [],
    subject: values.subject ?? '',
    aiBlocked: Boolean(aiGeneratedMessage || aiIsLoading || isGeneratingSubject),
  };
};

const handleClose = () => {
  const action = resolveComposeCloseAction({ ...buildPersistInput(), intent: 'userClose' });
  if (action === 'closeSilent') {
    onClose?.();
    return;
  }
  setShowLeaveConfirmation(true);
};

const handleDialogChoice = async (choice: ComposeDialogChoice) => {
  const next = nextAfterDialogChoice(choice);
  if (next === 'dismiss') {
    setShowLeaveConfirmation(false);
    return;
  }
  if (next === 'saveThenClose') {
    await saveDraft();
    // If saveDraft failed it toasts and leaves hasUnsavedChanges true — stay open.
    if (/* cannot read flag easily: re-check shouldPersistDraft */) {
      const stillDirty = shouldPersistDraft(buildPersistInput());
      if (stillDirty) return;
    }
    setShowLeaveConfirmation(false);
    onClose?.();
    return;
  }
  // discardThenClose
  if (draftId) {
    optimisticDeleteDraft(draftId);
  }
  setShowLeaveConfirmation(false);
  onClose?.();
};
```

Import `useOptimisticActions` and destructure `optimisticDeleteDraft`. Export or import `PersistDecisionInput` if needed — if type is not exported, inline the object without annotating or export the type from `draft-persistence.ts` in this task (allowed one-line export).

**Save-failure stay-open:** Prefer making `saveDraft` return `boolean` success:

```ts
const saveDraft = async (): Promise<boolean> => {
  // ... existing early returns → return false
  try {
    // ... existing save body
    setHasUnsavedChanges(false);
    return true;
  } catch {
    toast.error('Failed to save draft');
    return false;
  } finally {
    setIsSavingDraft(false);
  }
};
```

Then `handleDialogChoice` save path: `const ok = await saveDraft(); if (!ok && shouldPersistDraft(buildPersistInput())) return;`

- [ ] **Step 4: Replace Dialog JSX**

Replace Stay/Leave dialog (~1145–1161) with three buttons using translations; order Keep editing → Save draft → Discard; honest title/body keys from Step 1.

- [ ] **Step 5: Align Escape + beforeunload**

- Escape: call `handleClose` (remove `!draftId` skip).
- beforeunload: if `shouldPersistDraft(buildPersistInput())` then prevent default / set returnValue.

- [ ] **Step 6: Run unit tests + typecheck touch**

Run: `cd apps/mail && pnpm exec vitest run tests/draft-persistence.test.ts tests/compose-flush-registry.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mail/components/create/email-composer.tsx apps/mail/messages/en.json apps/mail/lib/mail/draft-persistence.ts
git commit -m "fix(mail): honest save/discard/keep editing compose close"
```

- [ ] **Step 8: SDD task review** — must pass before Wave 2 parallel dispatch.

---

### Task 3a: mail-list silent flush (Wave 2 — parallel lane A)

**Files:**
- Modify: `apps/mail/components/mail/mail-list.tsx` only

**Interfaces:**
- Consumes: `flushComposeBeforeLeave`, `runComposeLeaveFlush` (optional — or inline try/finally)
- Produces: thread click + keyboard nav never drop dirty persistable drafts

- [ ] **Step 1: Fix `handleMailClick` (single-select path ~967–970)**

Before clearing compose state:

```ts
import { flushComposeBeforeLeave } from '@/lib/mail/compose-flush-registry';
import { runComposeLeaveFlush } from '@/lib/mail/draft-persistence';

// inside handleMailClick after computing messageThreadId:
await runComposeLeaveFlush(flushComposeBeforeLeave, async () => {
  setMode(null);
  setActiveReplyId(null);
  setDraftId(null);
});
setThreadId(messageThreadId);
```

Keep mark-as-read / focus behavior; only wrap the compose-clear + ensure await (handler is already `async`).

- [ ] **Step 2: Fix `handleNavigateToThread` (~859–866)**

```ts
const handleNavigateToThread = useCallback(
  (threadId: string | null) => {
    void runComposeLeaveFlush(flushComposeBeforeLeave, async () => {
      setMode(null);
      setActiveReplyId(null);
      setDraftId(null);
    }).then(() => setThreadId(threadId));
  },
  [setMode, setActiveReplyId, setDraftId, setThreadId],
);
```

Must call `setDraftId(null)` (bug today).

- [ ] **Step 3: Commit lane A**

```bash
git add apps/mail/components/mail/mail-list.tsx
git commit -m "fix(mail): flush draft before list thread switch"
```

**Do not edit** `email-composer.tsx` or `thread-display.tsx`.

---

### Task 3b: thread-display silent flush (Wave 2 — parallel lane B)

**Files:**
- Modify: `apps/mail/components/mail/thread-display.tsx` only

**Interfaces:**
- Consumes: `flushComposeBeforeLeave`, `runComposeLeaveFlush`, existing `clearReplyComposeContext`
- Produces: next/prev/archive clear-compose paths flush first

- [ ] **Step 1: Wrap `clearComposeContext`**

```ts
import { flushComposeBeforeLeave } from '@/lib/mail/compose-flush-registry';
import { runComposeLeaveFlush } from '@/lib/mail/draft-persistence';

const clearComposeContext = useCallback(() => {
  void runComposeLeaveFlush(flushComposeBeforeLeave, async () => {
    await clearReplyComposeContext({
      setMode,
      setActiveReplyId,
      setDraftId,
      setComposeState,
    });
  });
}, [setMode, setActiveReplyId, setDraftId, setComposeState]);
```

All existing callers of `clearComposeContext` inherit flush.

- [ ] **Step 2: Commit lane B**

```bash
git add apps/mail/components/mail/thread-display.tsx
git commit -m "fix(mail): flush draft before thread clear-compose"
```

**Do not edit** `email-composer.tsx` or `mail-list.tsx`.

---

### Task 4: Wave-2 integration verify + final SDD review

**Files:** none new — verify only

- [ ] **Step 1: Parent waits for Task 3a + 3b**, then runs:

```bash
cd apps/mail && pnpm exec vitest run tests/draft-persistence.test.ts tests/compose-flush-registry.test.ts tests/reply-compose-context.test.ts tests/stale-draft-send-flow.test.ts
```

Expected: PASS.

- [ ] **Step 2: Manual AE checklist**

- AE1: type → wait autosave → X → Discard → draft gone after refresh
- AE2: type → X → Save draft → draft in Drafts
- AE3: type → within 1s click other thread → body recoverable
- AE4: Reply → no type → X → no dialog

- [ ] **Step 3: Dispatch whole-branch code reviewer** (most capable model) against authority plan R1–R9 + this file.
- [ ] **Step 4: Fix Critical/Important from final review; commit if needed.**

---

## Self-Review

1. **Spec coverage:** R1–R5,R9 → Task 2; R6 → Task 2 empty gate; R7 → Task 3a+3b; R8 → unchanged autosave; registry enables parallel without reply-composer edits.
2. **Placeholder scan:** No TBD; exact signatures and commands present.
3. **Type consistency:** `flushComposeBeforeLeave` / `runComposeLeaveFlush` / `ComposeDialogChoice` names stable across tasks.
4. **Parallel safety:** Wave 2 lanes own disjoint files; `email-composer.tsx` single-owner in Wave 1.

## Overnight wave (after local green)

```text
local: apps/mail vitest green → commit → push EC2-pilot
→ ops-deploy.sh            # no --migrate unless schema somehow touched
→ optional SSM smoke / manual AE1–AE4 on pilot host
→ handoff report under docs/superpowers/plans/handoff-reports/ if overnight run
```
