# Sender Click Copies Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `overnight-autonomous-zero` + `superpowers:subagent-driven-development`. Execute task-by-task overnight — no “which approach?” pause. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a message sender name copies that email to the clipboard and shows `Email copied to clipboard` — no “More about …” web-search dialog / pilot stub card.

**Architecture:** Extract a tiny pure `copySenderEmail` helper (clipboard outcome enum) with Vitest coverage. Wire header sender + details-popover From: to that helper + existing toast strings. Delete the mail-display web-search dialog stack (`MoreAboutPerson`, dead `MoreAboutQuery`, `resolveMailDisplayWebSearch`, related mutation/`StreamingText` if unused). Leave server `ai.webSearch` alone (ElevenLabs).

**Tech Stack:** TypeScript, React, Vitest, sonner toasts, Clipboard API

**Spec source:** `docs/plans/2026-07-23-002-feat-sender-click-copy-email-plan.md` + gstack plan-eng-review overnight auto-decisions

## Global Constraints

- Toast success string stays exactly: `Email copied to clipboard`
- Toast error string: `Failed to copy email` (new, only on clipboard rejection)
- Never flip `FORCE_FRONTEND_ONLY_DEMO`
- Do not modify `apps/server-pilot` `ai.webSearch` / `elevenlabs-tools.ts`
- Keep `e.stopPropagation()` + `e.preventDefault()` on sender click (collapse must not fire)
- Commits: one commit per task on `EC2-pilot`. Never `--no-verify` / force-push main
- Subagents: `/caveman ultra`; models **composer-2.5** or **cursor-grok-4.5-high** only (no fast variants)

---

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

Better path to done criteria → take it. Log in handoff report.

### Overnight wave

```text
local: tests green → commit → push EC2-pilot
→ ops-deploy.sh            # no --migrate (FE-only)
→ handoff report under docs/superpowers/plans/handoff-reports/
```

### Done criteria

- [ ] Tasks 1–2 implemented + committed on `EC2-pilot`
- [ ] Vitest green: `copy-sender-email` + `demo-backend-guards` (no `resolveMailDisplayWebSearch` import)
- [ ] Sender name click copies email + success toast; no More-about dialog
- [ ] Details popover From: same copy behavior
- [ ] Empty email / clipboard failure handled (no success toast / error toast)
- [ ] Recipient chip copy icon still works
- [ ] Server `ai.webSearch` untouched
- [ ] Pushed + `ops-deploy.sh` on EC2; handoff report written

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

---

## File map

| File | Role |
|------|------|
| `apps/mail/lib/mail/copy-sender-email.ts` | Pure clipboard helper (create) |
| `apps/mail/tests/copy-sender-email.test.ts` | Unit tests for helper (create) |
| `apps/mail/components/mail/mail-display.tsx` | Wire clicks; delete More-about stack |
| `apps/mail/lib/demo/local-actions.ts` | Remove `demoWebSearch` if unused |
| `apps/mail/tests/demo-backend-guards.test.ts` | Drop mail-display web-search tests + import |

---

### Task 1: Pure `copySenderEmail` helper + tests

**Files:**
- Create: `apps/mail/lib/mail/copy-sender-email.ts`
- Create: `apps/mail/tests/copy-sender-email.test.ts`

**Interfaces:**
- Consumes: `navigator.clipboard.writeText`
- Produces: `copySenderEmail(email: string): Promise<'copied' | 'empty' | 'failed'>`

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copySenderEmail } from '../lib/mail/copy-sender-email';

describe('copySenderEmail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns empty when email is blank', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copySenderEmail('')).resolves.toBe('empty');
    await expect(copySenderEmail('   ')).resolves.toBe('empty');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns copied when clipboard write succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copySenderEmail('aurora@example.com')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('aurora@example.com');
  });

  it('returns failed when clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copySenderEmail('aurora@example.com')).resolves.toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mail && pnpm exec vitest run tests/copy-sender-email.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Write minimal implementation**

```ts
export type CopySenderEmailResult = 'copied' | 'empty' | 'failed';

export async function copySenderEmail(email: string): Promise<CopySenderEmailResult> {
  const trimmed = email.trim();
  if (!trimmed) return 'empty';
  try {
    await navigator.clipboard.writeText(trimmed);
    return 'copied';
  } catch {
    return 'failed';
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd apps/mail && pnpm exec vitest run tests/copy-sender-email.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/copy-sender-email.ts apps/mail/tests/copy-sender-email.test.ts
git commit -m "$(cat <<'EOF'
feat(mail): add copySenderEmail clipboard helper

Pure outcome enum for sender-click copy with empty/fail paths.
EOF
)"
```

---

### Task 2: Wire sender click, remove More-about stack, update guards

**Files:**
- Modify: `apps/mail/components/mail/mail-display.tsx`
- Modify: `apps/mail/tests/demo-backend-guards.test.ts`
- Modify (if unused): `apps/mail/lib/demo/local-actions.ts`

**Interfaces:**
- Consumes: `copySenderEmail` from Task 1
- Produces: UI click → toast; no `MoreAboutPerson` / `resolveMailDisplayWebSearch`

- [ ] **Step 1: Update `handleCopySenderEmail` to use helper**

Replace the body of `handleCopySenderEmail` with:

```ts
const handleCopySenderEmail = useCallback(async (personEmail: string) => {
  const result = await copySenderEmail(personEmail || '');
  if (result === 'copied') {
    toast.success('Email copied to clipboard');
  } else if (result === 'failed') {
    toast.error('Failed to copy email');
  }
}, []);
```

Import `copySenderEmail` from `@/lib/mail/copy-sender-email`.

Fix `renderPerson` deps: change `[]` to `[handleCopySenderEmail]`.

- [ ] **Step 2: Wire header sender click**

Replace `setResearchSender({...})` with:

```ts
onClick={(e) => {
  e.stopPropagation();
  e.preventDefault();
  void handleCopySenderEmail(emailData?.sender?.email || '');
}}
onKeyDown={(e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.stopPropagation();
    e.preventDefault();
    void handleCopySenderEmail(emailData?.sender?.email || '');
  }
}}
role="button"
tabIndex={0}
title="Copy email address"
aria-label="Copy email address"
className="hover:bg-muted min-w-0 cursor-pointer"
```

(Apply on the same `<span>` wrapping `MailboxInline` in the header.)

- [ ] **Step 3: Wire details popover From: the same way**

Wrap the details `MailboxInline` (`From:` row) in a clickable control with the same copy handler + stopPropagation (popover already stops click bubble).

- [ ] **Step 4: Delete More-about / web-search UI stack from mail-display**

Remove:
- `researchSender` / `searchQuery` state
- JSX for `MoreAboutPerson` / `MoreAboutQuery`
- Components `MoreAboutPerson`, `MoreAboutQuery`
- `resolveMailDisplayWebSearch`, `useMailDisplayWebSearchMutation`, `MailDisplayWebSearchResult`
- `StreamingText` if only used by those dialogs
- `demoWebSearch` import

Grep mail-display: zero hits for `setResearchSender`, `MoreAboutPerson`, `resolveMailDisplayWebSearch`.

- [ ] **Step 5: Remove orphan `demoWebSearch` if unused**

Grep repo for `demoWebSearch`. If only defined in `local-actions.ts`, delete that export/function.

- [ ] **Step 6: Update demo-backend-guards**

Remove `import { resolveMailDisplayWebSearch } from '../components/mail/mail-display'`.
Remove the four mail-display web-search tests (demo fallback, empty query, long punctuation, backend when demo off).
Keep all other tests.

- [ ] **Step 7: Run tests**

```bash
cd apps/mail && pnpm exec vitest run tests/copy-sender-email.test.ts tests/demo-backend-guards.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/mail/components/mail/mail-display.tsx apps/mail/tests/demo-backend-guards.test.ts apps/mail/lib/demo/local-actions.ts
git commit -m "$(cat <<'EOF'
feat(mail): sender click copies email, remove More-about dialog

Replace pilot web-search card with clipboard copy + toast.
EOF
)"
```

---

### Task 3: Deploy + handoff

**Files:**
- Create: `docs/superpowers/plans/handoff-reports/2026-07-23-sender-click-copy-email.md`

- [ ] **Step 1:** Push `EC2-pilot` to origin
- [ ] **Step 2:** Run `apps/server-pilot/deploy/ops-deploy.sh` (no migrate)
- [ ] **Step 3:** Write handoff report (commits, test evidence, done-criteria checklist, divergence notes)
- [ ] **Step 4:** Commit handoff if not already on branch

---

## NOT in scope

- Re-enabling AI web search / restoring `MoreAboutPerson`
- Changing recipient-chip UX beyond deps fix
- Toast string “Email name copied”
- Server `ai.webSearch` stub / ElevenLabs tools
- BIMI avatar click behavior
- Playwright E2E for clipboard (unit + manual smoke)

## What already exists

- `handleCopySenderEmail` + recipient chip `CopyIcon` — reused / upgraded via helper
- Pilot stub text path — deleted with dialog (intentional)

## Failure modes

| Failure | Test | UX |
|---------|------|-----|
| Empty sender email | unit `empty` | no toast |
| Clipboard permission denied | unit `failed` | error toast |
| Accidental collapse on click | stopPropagation required | no collapse |
| Dialog regresses | grep + deleted components | no overlay |

## Parallelization

Sequential implementation, no parallelization opportunity (same primary module).
