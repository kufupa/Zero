# Quoted Message History Ellipsis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: overnight-autonomous-execution (mandate below is binding). Use superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix cropped outbound reply history and collapse inline quoted history behind a Gmail/Outlook-style ellipsis control (default hidden) on the live pilot path.

**Architecture:** Restore `quotedMessage` on FE `constructReplyBody`/`constructForwardBody` (mirror `apps/server`). Port `collapseQuoted` into `server-pilot` `processEmailContent` after sanitize; render `<details class="quoted-toggle">` with boxed `…` summary. Stored MIME stays whole — collapse is view-layer only.

**Tech Stack:** TypeScript, Vitest, React mail UI, server-pilot tRPC, cheerio (quote collapse), sanitize-html.

**Execution posture:** Overnight autonomous — user unavailable; implement-fix-loop until done criteria green.

**Branch:** `EC2-pilot`

## Global Constraints

- Pilot path only (`apps/server-pilot` + `apps/mail`); do not redesign thread cards.
- Do not repurpose `MailDisplay.isCollapsed` for quote toggle.
- No force-push, `--no-verify`, IT Exchange/VPN creds.
- Characterization tests first (TDD).
- One atomic conventional commit per completed task cluster.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. Goal = ship done criteria.

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

```text
FAIL → reproduce → root cause (file:line) → fix → test → commit → resume
```

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] Reply/forward outbound HTML includes prior message body after quote header
- [ ] Quote header attribution uses original recipients (not reply To)
- [ ] Quoted blocks collapsed by default behind ellipsis/`details` (`blockquote`, `.gmail_quote`)
- [ ] Expand shows full quote; collapse hides again
- [ ] Targeted vitest green locally
- [ ] EC2 SSM gate green for touched server-pilot suites
- [ ] Handoff report under `docs/superpowers/plans/handoff-reports/`

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

## RCA (confirmed)

Outbound crop: `constructReplyBody` omits body; composer comments out `decodedBody`; pilot `sendInput` drops `originalMessage`. Display: pilot `processEmailContent` sanitizes only — no `collapseQuoted` (legacy in `apps/server/src/lib/email-processor.ts`).

## File map

| Create/Modify | Role |
|---------------|------|
| `apps/mail/lib/utils.ts` | `quotedMessage` on reply/forward |
| `apps/mail/components/mail/reply-composer.tsx` | Pass `decodedBody` + original To |
| `apps/mail/tests/construct-reply-body.test.ts` | Characterization |
| `apps/server-pilot/src/mail/collapse-quoted-html.ts` | Port collapse |
| `apps/server-pilot/src/mail/sanitize-email-html.ts` | Allow style on details/summary if needed |
| `apps/server-pilot/src/trpc/routes/mail.ts` | `processEmailContent` calls collapse |
| `apps/server-pilot/src/trpc/wire-compat.ts` | Optional `originalMessage` belt |
| `apps/server-pilot/tests/collapse-quoted-html.test.ts` | Collapse tests |
| `apps/server-pilot/tests/sanitize-email-html.test.ts` | Preserve details |

---

### Task 1: Failing tests — reply body includes quoted history

**Files:**
- Create: `apps/mail/tests/construct-reply-body.test.ts`
- Modify: `apps/mail/lib/utils.ts`

- [ ] Write failing test: `constructReplyBody` with quoted HTML contains prior body after `wrote:`
- [ ] Write failing test: `constructForwardBody` includes prior body
- [ ] Implement `quotedMessage` param (mirror server utils)
- [ ] Pass tests; commit `fix(mail): include quoted history in reply and forward bodies`

### Task 2: Wire composer

**Files:**
- Modify: `apps/mail/components/mail/reply-composer.tsx`

- [ ] Pass `replyToMessage.decodedBody` into constructors
- [ ] Pass original message `to` (or `[sender]` fallback) for quote attribution — not reply `toRecipients`
- [ ] Commit `fix(mail): pass decodedBody into reply construct bodies`

### Task 3: Failing tests + collapseQuoted in pilot

**Files:**
- Create: `apps/server-pilot/src/mail/collapse-quoted-html.ts`
- Create: `apps/server-pilot/tests/collapse-quoted-html.test.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/server-pilot/package.json` (cheerio if needed)

- [ ] Failing test: `blockquote` → `details.quoted-toggle` default closed; summary is ellipsis
- [ ] Failing test: `.gmail_quote` collapsed
- [ ] Implement collapse; wire `processEmailContent`
- [ ] Commit `feat(mail): collapse quoted history behind ellipsis in processEmailContent`

### Task 4: Belt-and-suspenders send path (optional if Task 1 sufficient)

**Files:**
- Modify: `apps/server-pilot/src/trpc/wire-compat.ts`, `mail.ts` send

- [ ] Accept optional `originalMessage`; append when html lacks quote body
- [ ] Test in wire contract
- [ ] Commit if changed

### Task 5: Deploy + gate + handoff

- [ ] Local vitest green (mail + server-pilot touched suites)
- [ ] Push `EC2-pilot`; `ops-deploy.sh`
- [ ] SSM run collapse + sanitize tests
- [ ] Write `docs/superpowers/plans/handoff-reports/2026-07-23-quoted-history-ellipsis-gate-report.md`
