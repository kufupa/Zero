---
title: "False green gate: claimed tsc fixes were never persisted to disk"
date: 2026-07-07
category: workflow-issues
module: apps/mail
problem_type: workflow_issue
component: development_workflow
severity: high
symptoms:
  - "Prior hand-off summary reported '0 tsc errors' but a fresh `npx tsc --noEmit` on disk showed 39 errors"
  - "Claimed fixes were never committed and edits never stuck, so on-disk state never matched the reported green"
  - "`tsconfig` `exclude` did not suppress errors in inert files that were still imported by live code"
  - "A single mistyped hook (`use-threads.ts`) collapsed `threads` to `unknown[]`, cascading TS18046 across mail-list, select-all, and hotkeys"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "Acting on a hand-off summary that claims a green typecheck, test, or build gate"
  - "Running autonomous or multi-file edits where changes may not have persisted to disk"
  - "Excluding inert or feature-flagged files from a TypeScript project"
  - "Converging a frontend against a backend wire contract"
tags: [false-green-gate, tsc-regression, verification-gap, typescript, tsconfig-exclude, wire-contract, ec2-pilot]
---

# False green gate: claimed tsc fixes were never persisted to disk

## Context

During FE↔pilot contract convergence on branch `EC2-pilot`, a prior hand-off summary reported the `apps/mail` frontend typecheck (`npx tsc --noEmit`) as **"0 errors."** A fresh on-disk run surfaced **39 TypeScript errors**. The gate was false: the described fixes existed only in prose — they were never committed and the edits never stuck — so the branch was silently broken and unshippable while appearing clean.

The follow-up question ("did the LLM overwrite something?") is the tell: no overwrite occurred. The on-disk state simply never matched the claimed state, and nobody re-ran the check to notice.

## Guidance

Treat a reported gate as a **claim of intent, not a result**. The only source of truth is running the exact check against the actual working tree.

1. **Re-run the gate on disk before trusting it.** Any "0 errors / all green" hand-off is unverified until you re-run `npx tsc --noEmit` (and the test suite) yourself — ideally enforced in CI so a claim cannot diverge from reality.
2. **Know that `tsconfig` `exclude` ≠ "not type-checked."** `exclude` only drops a file as a *program entry point*. Any file reachable via an `import` from an included/live file is still fully type-checked. To silence inert-but-imported code, add `// @ts-nocheck` as the **first line**, or stop importing it — do not rely on `exclude`.
3. **Fix the keystone type first.** When many errors share an `unknown`/inference origin, find the single hub type and fix it; the downstream `'x' is of type 'unknown'` errors usually resolve in bulk rather than one call site at a time.
4. **Extend wire contracts truthfully.** Only add a field to a shared type if the producer actually returns it (or it is genuinely optional/demo-only). Adding a phantom field to silence a consumer just pushes a runtime `undefined` bug downstream.

## Why This Matters

- **A gate is only meaningful when executed against reality.** A summary describing fixes is not a build result. When the two diverge — because edits weren't saved, weren't committed, or a stale cache reported success — the "green" is worse than no signal, because it is *trusted*. This erodes confidence in every future gate report.
- **`exclude` vs `@ts-nocheck` is a common false assumption.** Engineers add files to `exclude` expecting silence and move on; the type graph keeps checking them through their imports. `@ts-nocheck` is the correct per-file tool.
- **Keystone cascades hide the true error count.** 21+ of the 39 errors here traced back to one hub (a hook whose `threads` array lost its type) and to inert files. The raw count looked alarming; the actual work was a handful of root fixes. Reading the cascade structure before patching each site saves time and prevents whack-a-mole.
- **Truthful contracts prevent the next bug.** Silencing a type error with a field the backend never sends converts a compile-time signal into a silent runtime `undefined`.

## When to Apply

- Acting on any hand-off that claims a green typecheck, test, or build gate — re-run it.
- Autonomous or long multi-file editing sessions, where an edit may be reported as applied but not persisted.
- Excluding inert or feature-flagged files from a TypeScript project.
- Converging a frontend against a backend wire contract (`@zero/server/driver/types` here).

## Examples

The 39 errors were re-surfaced by running the gate on disk, then fixed in four buckets.

**Bucket 1 — Inert pilot-off features (21 errors).** These were in `tsconfig.json` `exclude` but still imported by live code, so they kept erroring. Added `// @ts-nocheck` as the first line of `components/mail/note-panel.tsx`, `components/ui/ai-sidebar.tsx`, `components/ui/bimi-avatar.tsx`, and `components/create/template-button.tsx`.

**Bucket 2 — Pilot wire contract incomplete (4 errors).** `apps/server-pilot/src/lib/driver/types.ts` was missing consumed fields. Added only what the producer actually returns or is genuinely optional:

```ts
interface ThreadListItem {
  historyId: string | null;           // backend listThreads already returned this
  centurionCategory?: CenturionMailCategory; // demo/hotel-pilot only
}
interface ThreadDetailResponse {
  centurionCategory?: CenturionMailCategory;
}
export type IGetThreadsResponse = ThreadListResponse;
interface ParsedMessage {
  listUnsubscribe?: string;      // real email header
  listUnsubscribePost?: string;  // real email header
}
```

**Bucket 3 — `use-threads.ts` keystone cascade.** The hook returned a union of 4 infinite-query page shapes; `.flatMap(e => e.threads)` produced an un-unifiable element type, so `threads` collapsed to `unknown[]` and cascaded TS18046 (`'item' is of type 'unknown'`) into `mail-list.tsx`, `select-all-checkbox.tsx`, and `lib/hotkeys/mail-list-hotkeys.tsx`. Fixing the hub type cleared the cascade:

```ts
const threads = useMemo<ThreadListItem[]>(() => {
  if (!activeThreadsQuery.data) return [];
  const pages = activeThreadsQuery.data.pages as Array<{ threads: ThreadListItem[] }>;
  return pages
    .flatMap((p) => p.threads)
    .filter((t): t is ThreadListItem => Boolean(t))
    .filter((t) => !isInQueue(`thread:${t.id}`));
}, [/* deps */]);
```

Also fixed `historyId: null as const` → `null as string | null` (TS1355), and typed `resolveMailRouteFilter`'s return `folder` as a `MailListFolderSlug` union so it matched the tRPC `listThreads` folder enum (TS2769).

**Bucket 4 — Leftover live errors.**

- `mail-list.tsx`: imported `ParsedDraft` from the legacy path `../../../server/src/lib/driver/types` → switched to `@zero/server/driver/types`; render `draft.updatedAt` (`Date.parse`) instead of `draft.rawMessage.internalDate`.
- `reply-composer.tsx`: `decodedBody` → `content` (`?? undefined`).
- `thread-actions.ts`: narrowed `moveThreads` destination to exclude `snoozed`.
- `email-composer.tsx`: AI-compose union guard `'newBody' in result`; draft `attachments: SerializedFile[]`.

**Verification:** `apps/mail` tsc 0 errors + 182 tests passing; `apps/server-pilot` tsc 0 errors + 127 pass / 90 skip. Committed as `a6525b58`. A pre-commit oxlint hook then blocked on 4 unused-var warnings (uncovered by the same "re-run the real gate" discipline), which were removed before the commit landed.

## Related

- [`docs/solutions/workflow-issues/autonomous-agent-file-truncation-patch-fragment.md`](autonomous-agent-file-truncation-patch-fragment.md) — closest sibling; same autonomous-run failure family (broken edits + mass `tsc` errors, missing per-wave typecheck gate). Same 2026-07-06 contract-convergence run. This doc adds the "fixes claimed but never persisted" variant.
- [`docs/solutions/integration-issues/fe-pilot-trpc-wire-contract-drift.md`](../integration-issues/fe-pilot-trpc-wire-contract-drift.md) — runtime tRPC wire-contract drift; Bucket 2 here is the type-level cousin (driver types missing `historyId`/`centurionCategory`/`listUnsubscribe`).
- [`docs/solutions/workflow-issues/ec2-pilot-post-audit-tier5-execution.md`](ec2-pilot-post-audit-tier5-execution.md) — shares the "don't trust a claimed-green summary" gate-report discipline, applied to test-suite triage.
