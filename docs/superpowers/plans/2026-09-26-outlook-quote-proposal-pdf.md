# Outlook Quote Proposal PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlook pane attaches a Gotenberg-converted Excel Proposal PDF into the reply draft instead of an HTML rate table.

**Architecture:** Pure quote-proposal helpers (identity, DESCRIPTION, filename, wrapper, money). Server `workstation.quoteProposalPdf` patches the Centurion xlsx and converts via Gotenberg. Pane matches Nava email to Outlook mailbox, then `CREATE_REPLY_DRAFT` + `ADD_ATTACHMENT_TO_DRAFT`.

**Tech Stack:** TypeScript, Vitest, tRPC, JSZip/fflate, Gotenberg LibreOffice HTTP, Outlook bridge v3.

**Spec:** `docs/superpowers/specs/2026-09-26-outlook-quote-proposal-pdf.md`

## Global Constraints

- Pilot-RDS: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest. Never `VITEST_ALLOW_PILOT_RDS=1`.
- No PII or `.private/` corpus in Git.
- Template print area `A1:H69`, drawings, and formulas stay; patch value cells only.
- VAT cell stays the literal `Included`.
- Hotel telephone `0126433600`.
- `GOTENBERG_URL` required for convert; tests mock `fetch`.
- Pane 380px: no download button.

## File map

- Create: `apps/mail/lib/quote-proposal/identity.ts`
- Create: `apps/mail/lib/quote-proposal/copy.ts`
- Create: `apps/mail/lib/quote-proposal/description.ts`
- Create: `apps/mail/lib/quote-proposal/filename.ts`
- Create: `apps/mail/tests/quote-proposal.test.ts`
- Create: `apps/server-pilot/src/quote-proposal/patch-template.ts`
- Create: `apps/server-pilot/src/quote-proposal/gotenberg.ts`
- Create: `apps/server-pilot/tests/quote-proposal-pdf.test.ts`
- Create: `apps/server-pilot/fixtures/centurion-quotation-template.xlsx` (copy from lab template)
- Modify: `apps/server-pilot/src/trpc/routes/workstation.ts`
- Modify: `apps/server-pilot/tests/workstation-router-contract.test.ts`
- Modify: `apps/mail/app/(routes)/outlook-pane/page.tsx`
- Modify: `apps/mail/tests/outlook-pane-render.test.tsx`
- Modify: `apps/server-pilot/src/db/seed.ts` (Kamala)
- Modify: `apps/server-pilot/tests/seed-contract.test.ts`

### Task 1: Pure helpers

**Interfaces:**

```ts
emailsMatch(a: string, b: string): boolean
proposalDescription(roomCode: string, meal: 'dinner_bb' | 'bb' | 'room_only'): string
quotePdfFileName(agency: string, dateLabel: string): string
quoteWrapperHtml(guestFirstName: string): string
lineTotal(qty: number, nights: number, rate: number): number
HOTEL_TELEPHONE = '0126433600'
```

- [ ] Failing tests in `apps/mail/tests/quote-proposal.test.ts`
- [ ] Implement helpers
- [ ] `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter mail exec vitest run tests/quote-proposal.test.ts`

### Task 2: xlsx patch + Gotenberg (mocked)

Patch B12–B15 (client), row 24+ line items (A date, B qty, C DESCRIPTION, F nights, G rate; leave H formula), B61–B63 (name, email, tel). Preserve `xl/drawings` and print area.

- [ ] Failing tests: patched XML contains Attention value; drawings still present; identity mismatch throws; Gotenberg `fetch` mocked returns PDF bytes
- [ ] Implement `patchProposalWorkbook` + `convertXlsxWithGotenberg`
- [ ] `workstation.quoteProposalPdf` privateProcedure
- [ ] `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter @zero/server exec vitest run tests/quote-proposal-pdf.test.ts tests/workstation-router-contract.test.ts`

### Task 3: Pane attach-only

- [ ] Failing tests: mismatch toasts and skips convert; match calls `quoteProposalPdf` then `CREATE_REPLY_DRAFT` with wrapper (no `<table`) then `ADD_ATTACHMENT_TO_DRAFT`; htmlBody contains “Please see attached quotation”
- [ ] Wire `handleInsertAiDraft`
- [ ] `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm --filter mail exec vitest run tests/outlook-pane-render.test.tsx tests/outlook-pane-onboarding.test.tsx tests/quote-proposal.test.ts`

### Task 4: Kamala seed

- [ ] Failing seed-contract: `kdouglas@legacyhotels.co.za` in `PILOT_USERS`
- [ ] Add user + Centurion mailbox access
- [ ] Same Vitest unset; seed-contract only if disposable DB

### Reviews (done in-session before code)

- Eng: Gotenberg is a single HTTP POST; identity enforced client and server; draft `entryId` from `CREATE_REPLY_DRAFT` is required for attach.
- Ponytail: no ExcelJS, no HTML clone, no per-user phone table in V1.
- Design: 380px pane — same Insert Draft button, no extra download chrome.

## Self-review

Spec D1–D10 each have a task. No TBD. Types: `quoteProposalPdf` returns `{ fileName: string, pdfBase64: string }`.
