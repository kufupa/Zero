# Centurion Catch-up Mail Dump Upload Implementation Plan

> **For agentic workers:** TDD inline (failing test → impl → pass → commit → `git push origin HEAD`). Then CORS apply + `ops-deploy.sh --migrate` + bounce. No SDD/review subagents. Checkbox (`- [ ]`) per step. `/autonomous-plan` + `/continue-autonomously` binding.

**Goal:** Centurion staff upload Outlook Sent dumps (`.pst` / `.zip` / `.msg`) in Nava via a flag-gated control under Settings. Store in S3 + DB for later ingest. No parse.

**Architecture (locked):** Presigned upload. **Single PutObject** if `sizeBytes <= 100 MiB`. **S3 multipart** if larger, up to **50 GiB** (Outlook 2016 Unicode PST default ceiling). Browser PUTs parts with progress; server CompleteMPU + Head; mark `stored`. Multiple files OK (`listMine`).

**Why MPU came back:** Single PUT max is **5 GB** ([AWS upload objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html)). Full Sent PST (Unicode) can be tens of GB ([Outlook 2016 MaxLargeFileSize 50 GB](https://learn.microsoft.com/en-us/microsoft-365-apps/outlook/data-files/configure-size-limit-outlook-data-files)). Jul 27–Sep 4 (~40d × ~61 busy-day sends): **~0.8–7 GB** depending on PDF size — **can cross 5 GB**. Zip of PDFs barely shrinks. Staff split-by-month = fallback, not the only path.

**Size math (assumptions, not a measured Centurion PST):**

| Scenario | Rough bytes |
|----------|-------------|
| 40d × 40 msgs × 200 KB | ~0.3 GB |
| 40d × 61 × 500 KB | ~1.2 GB |
| 40d × 61 × 2 MB (PDF confirms) | ~4.9 GB |
| 40d × 61 × 3 MB | ~7.3 GB |
| Full Sent, years, Unicode PST | often **>5 GB**, Outlook allows **50 GB** |

AWS also: consider MPU at **100 MB+** ([MPU overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)).

**Tech Stack:** TypeScript, tRPC, Drizzle/Postgres, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, React mail app, Vitest.

**Design:** `~/.gstack/projects/zero/orca-main-design-20260904-130109.md`

**Execution:** Autonomous. TDD per task. Disposable DB only. Skip eng/ponytail/design review loops (user). Implement inline. **Must commit, push `origin`, and deploy** before done. **Pilot `CATCHUP_UPLOAD_ENABLED=true` after deploy** so staff can drop dumps immediately; agent verifies UI/API with flag on.

```
Staff drop file(s)  [multiple OK]
  → catchup.initUpload (auth + flag + ext + size ≤ 50 GiB)
  → pending row
  → if size ≤ 100 MiB: one PutObject URL
  → else: CreateMultipartUpload + part URLs (16 MiB parts)
  → browser PUT (SSE + Content-Type; collect ETags)
  → catchup.completeUpload → CompleteMPU? + Head size==declared → stored
  → abort: AbortController + AbortMPU if any + row aborted
```

**Human fallback (handoff / WhatsApp, not instead of MPU):** file still too big or upload dies → export **by month** (Jul, Aug, Sep) and drop each. ZIP does not beat 5 GB if PDFs dominate.

## Global Constraints

- **Store only** — no PST/MSG parse, no thread insert, no POP3.
- Ext (case-insensitive): `.pst`, `.zip`, `.msg` only.
- Max: **50 GiB** (`53687091200`). Reject larger at init. (Outlook 2016 Unicode default.)
- **Single PUT** iff `sizeBytes <= 104857600` (100 MiB). Else **multipart**, part size **16 MiB**, last part may be smaller. S3 PUT cannot exceed 5 GB — MPU is the >5 GB path.
- Key: `catchup-uploads/{userId}/{uploadId}/{safeFilename}`
- SSE: `AES256`. Browser PUT **must** send `x-amz-server-side-encryption: AES256` and `Content-Type` exactly as signed.
- `CATCHUP_UPLOAD_ENABLED`: **code default false when unset** (tests prove fail-closed). **Pilot EC2 after Task 7: set `true`** so staff can upload and agent can verify live. `brain.getCapabilities.catchupUpload` reads env **at query time**. FE nav uses that query (static FE default false until query).
- Auth: `privateProcedure`. complete/abort/list: `userId === session` else NOT_FOUND.
- Status: `pending` \| `stored` \| `aborted`. Only `pending` → `stored` or `aborted`. Reject double-complete.
- `s3UploadId` text null — set for MPU, null for single PUT.
- `sizeBytes`: **bigint**. Never `integer`.
- MIME: server maps ext → type; ignore client contentType.
  - `.pst` → `application/vnd.ms-outlook`
  - `.zip` → `application/zip`
  - `.msg` → `application/vnd.ms-outlook`
- Presign `expiresIn`: **43200** (12h) — hotel slow net. Not 300s attachment TTL.
- Head on complete: size **equals** declared `sizeBytes` and `<= 50 GiB` else leave `pending` and error.
- Cap **3 pending** uploads per user. Many **stored** files OK (month splits).
- Pilot RDS: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest. Disposable DB only.
- PII dumps: S3+DB only. Never git.
- CORS: add **PUT** to **canonical** rule. `ExposeHeaders` must include **`ETag`** (MPU complete needs it) plus existing Content-Disposition/Type/Length. Do **not** add PUT to remote-admin CORS (`s3CorsRemoteAdmin` exact GET+HEAD). Read→write→readback in `apps/server-pilot/deploy/aws-resources.md`.
- New router `catchup.ts`. Do not grow `mail.ts`.
- No new deploy shell for CORS — update `aws-resources.md` + apply once + handoff evidence.

## Overnight Autonomous Execution Mandate

**User granted full autonomy** (`/autonomous-plan` + `/continue-autonomously`). No blocking questions. No "which approach?" pause. Continue until done criteria evidenced or a true blocker.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### Decision authority

- Choose best safe reversible option without asking. Log divergences. Do not cut scope.
- Inline TDD. No review/SDD subagents (user). Standard non-fast models only; Fast forbidden. If subagent unavailable, work inline.
- Better route to accepted goal may be taken; log in handoff.

### Continue-autonomously loop

Queued fail-safe. Inspect state first (plan checkboxes, git log, test evidence). Resume first incomplete/failed task. Never redo verified work.

```text
implement → test/gate → red? RCA + smallest correct fix → retest
          → green? commit → git push origin HEAD → next incomplete task
… after last code/CORS task:
          git push origin HEAD → ops-deploy.sh --migrate → bounce → read-only proof → handoff commit+push
```

Not valid stops: failed test/build/deploy/SSM, reversible approach choice, larger-than-expected work, user might want a status ping, prior agent already summarized.

### RCA loop (mandatory on any red)

FAIL → reproduce minimally → root cause (file:line) → smallest correct fix → test → commit → push → resume. Symptom patches, skipped gates, and “user can finish later” are not completion.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) — **no Vitest** |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` — this plan has schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, **commit, `git push origin HEAD` (never `--force`)**, deploy, migrate via `ops-deploy --migrate`, CORS apply per `aws-resources.md`, read-only SSM/health curl, tests against disposable non-production DB.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, Vitest against pilot/production RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into a test process.

### Pilot RDS safety (overrides autonomy)

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

If a test needs Postgres, use disposable DB. Missing disposable DB = safety blocker. Never weaken this to make a gate green.

### Cursor execution-backend flake (not a human gate)

Exact error: `Execution backend unavailable. Do not retry tool calls — the execution environment is down.`

Playbook: `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`. Backoff-retry Shell/Write/StrReplace (~5s → 15s → 45s). Do not ask user to wait. Do not invent app RCA.

### Ship contract (required — not optional)

1. **Commit** after each task (messages below). No empty commits. No amend unless hook auto-modified same HEAD you created and it was not pushed.
2. **Push** `git push origin HEAD` after each successful task commit (and again if deploy needs SHAs not on origin). Never `--force` / `--force-with-lease` on `main`.
3. **Deploy** Task 7: `ops-deploy.sh --migrate` then bounce. **Set `CATCHUP_UPLOAD_ENABLED=true` on EC2** (env file / systemd / however this box already injects `MailEnv` — match existing pattern; persist across restart). Prove: health + CORS readback + `getCapabilities.catchupUpload === true` (session auth). Handoff file under `docs/superpowers/plans/handoff-reports/`.

Typical wave:

```text
local: unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
     + tests on disposable/no DB + typecheck green
     → commit → git push origin HEAD
     → …repeat tasks…
     → Task 6 CORS apply + commit + push
     → Task 7 ops-deploy.sh --migrate → ops-restart.sh
     → set CATCHUP_UPLOAD_ENABLED=true (persist) → bounce if needed
     → SSM/health + capabilities true
     → handoff commit + push
```

### Done criteria

- [ ] Flag + schema + catchup tRPC init/complete/abort/list green on disposable DB / FakeS3
- [ ] FE: **Upload backup** under Settings when flag on; dialog; progress; Received + not-in-inbox copy; own list
- [ ] Flag off **when unset**: nav hidden; API reject (unit/integration)
- [ ] Agent tests **with `CATCHUP_UPLOAD_ENABLED=true`**: init/complete/list + FE nav visible (disposable DB / FakeS3)
- [ ] CORS PUT + ExposeHeaders ETag on canonical rule; `s3CorsCanonical=true`; remote-admin CORS unchanged
- [ ] All task commits on **origin** (`git status` clean vs `origin`; no unpushed commits)
- [ ] **Deployed** with `--migrate`; bounce; **pilot flag `true`**; `getCapabilities.catchupUpload` true
- [ ] No Vitest vs pilot RDS
- [ ] Handoff: flag **already on**; WhatsApp one-liner; CORS evidence; ingest later
- [ ] No unresolved blocker affecting plan goal

### True blockers

Stop only for missing credentials/access that cannot be obtained safely, required human-only interaction, destructive ambiguity, safety-policy conflict, or external outage that prevents required proof.

## Execution Mode

Autonomous overnight — no user checkpoint. `/continue-autonomously`: inspect → first incomplete task → loop until done criteria or true blocker. TDD inline. Do not ask "which approach?"

## Git Commit + Push Strategy

| Task | Commit | Then |
|------|--------|------|
| 1 | `feat(pilot): add catchupUpload capability and env gate` | `git push origin HEAD` |
| 2 | `feat(db): add mail_catchup_upload table` | `git push origin HEAD` |
| 3 | `feat(storage): add catchup S3 presign PUT and multipart` | `git push origin HEAD` |
| 4 | `feat(api): add catchup upload tRPC router` | `git push origin HEAD` |
| 5 | `feat(mail-ui): add catchup upload dialog and nav item` | `git push origin HEAD` |
| 6 | `chore(ops): allow S3 CORS PUT for catchup uploads` | `git push origin HEAD` |
| 7 | `docs(ops): catchup upload enablement handoff` | `git push origin HEAD` **and** `ops-deploy.sh --migrate` + bounce (deploy may run before this docs commit if code already on origin; still push handoff) |

No amend of pushed commits, no force-push, no `--no-verify`.

---

## File Map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/lib/driver/types.ts` | `catchupUpload: boolean` on `PilotCapabilities` |
| `apps/server-pilot/src/env.ts` | `CATCHUP_UPLOAD_ENABLED` |
| `apps/server-pilot/src/trpc/routes/brain.ts` | `getCapabilities` reads env at runtime |
| `apps/mail/lib/pilot/capabilities.ts` | Type satisfy; static default `false` |
| `apps/server-pilot/src/db/schema/mail-catchup-upload.ts` | Table (new file, export from schema index) |
| `apps/server-pilot/drizzle/0022_mail_catchup_upload.sql` | Migration |
| `apps/server-pilot/src/storage/catchup-upload.ts` | Sanitize, key, assert, presign PUT + MPU, head |
| `apps/server-pilot/src/storage/s3.ts` | Add `headObject` on `S3Storage` + FakeS3 |
| `apps/server-pilot/src/trpc/routes/catchup.ts` | Router |
| `apps/server-pilot/src/trpc/router.ts` | Register `catchup` |
| `apps/mail/config/navigation.ts` | Footer item after Settings |
| `apps/mail/components/catchup/catchup-upload-dialog.tsx` | Dialog + dropzone + progress + list |
| `apps/mail/lib/catchup/put-file.ts` | Single PUT or MPU parts + progress + SSE headers |
| `apps/mail/components/ui/app-sidebar.tsx` | Open dialog; hide via `brain.getCapabilities` |
| `apps/server-pilot/deploy/aws-resources.md` | Canonical CORS += PUT |
| `docs/superpowers/plans/handoff-reports/2026-09-04-centurion-catchup-upload.md` | Enable + WhatsApp |

---

### Task 1: Capability + env gate

**Files:** types, env, brain, FE capabilities, `pilot-capabilities.test.ts`, `misc-wire-contract.test.ts`, `env.test.ts`

**Produces:** `MailEnv.CATCHUP_UPLOAD_ENABLED`; `getCapabilities.catchupUpload` from **current env**, not a frozen constant.

- [x] **Step 1:** Failing tests — default false when unset; `CATCHUP_UPLOAD_ENABLED=true` → true at query time; FE/API path covered **with flag true**
- [x] **Step 2:** Run fail (`unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`)
- [x] **Step 3:** Implement
- [x] **Step 4:** Pass
- [x] **Step 5:** Commit Task 1 message + `git push origin HEAD`

---

### Task 2: Schema `mail_catchup_upload`

**Produces:**

- `id` text PK
- `userId` text not null FK `user`
- `originalFilename` text not null
- `contentType` text not null
- `sizeBytes` **bigint** not null
- `s3Key` text not null unique
- `s3UploadId` text null (MPU id; null for single PUT)
- `status` text not null `pending` \| `stored` \| `aborted`
- `createdAt` / `updatedAt` / `completedAt` nullable
- Index `(userId, createdAt)` only

- [x] **Step 1:** Failing test — insert `sizeBytes = 53687091200` (50 GiB) round-trip
- [x] **Step 2:** Schema + `0022_mail_catchup_upload.sql`
- [x] **Step 3:** Pass on disposable DB
- [x] **Step 4:** Commit + `git push origin HEAD`

---

### Task 3: Storage helpers + Head

**Produces:**

- `CATCHUP_PUT_EXPIRES_IN = 43200`
- `sanitizeCatchupFilename` — strip path, replace illegal chars
- `buildCatchupS3Key`
- `assertCatchupAllowedFile` — ext + size
- `contentTypeForCatchupFilename`
- `presignCatchupPut({ key, contentType })` → `{ url, headers: { 'Content-Type', 'x-amz-server-side-encryption': 'AES256' } }`
- `createCatchupMultipart` / `presignCatchupPart` / `completeCatchupMultipart` / `abortCatchupMultipart`
- Fake path: `zero-fake-s3://...` like attachments + FakeS3 Head + MPU recorders
- `S3Storage.headObject(key)` → `{ sizeBytes, contentType } | null` (Real + Fake)

- [x] **Step 1:** Failing tests — `.exe` reject; 50GiB+1 reject; 100MiB threshold single vs MPU; key prefix; fake URL; signed-header contract
- [x] **Step 2:** Implement
- [x] **Step 3:** Pass
- [x] **Step 4:** Commit + `git push origin HEAD`

---

### Task 4: tRPC `catchup`

Register in `apps/server-pilot/src/trpc/router.ts`.

- `initUpload` `{ filename, sizeBytes }` → pending + `{ uploadId, mode: 'single'|'multipart', putUrl?, putHeaders?, parts?, s3UploadId?, key }`
- `completeUpload` `{ uploadId, parts?: { partNumber, etag }[] }` → CompleteMPU if needed + Head match → `stored`
- `abortUpload` `{ uploadId }` → AbortMPU if `s3UploadId` + `aborted` (pending only)
- `listMine` → own rows recent-first

Flag unset: all four fail closed. Flag true: init/complete/list work (agent tests use `true`).
- [x] **Step 2:** Implement
- [x] **Step 3:** Pass
- [x] **Step 4:** Commit + `git push origin HEAD`

---

### Task 5: UI

**Nav:** `id: catchup-upload`, title **Upload backup**, icon Upload, **immediately after** Settings in `bottomNavItems`. Click opens dialog (no route). `hidden` unless `brain.getCapabilities.catchupUpload`. Collapsed tooltip = title.

**Copy (lock):**

| Slot | Text |
|------|------|
| Title | `Upload Outlook backup` |
| Description | `Export Sent mail from Outlook as a .pst, a .zip of .msg files, or a single .msg. Drop it here. We store it for Nava — it will not appear in your inbox yet.` |
| Idle drop | `Drop .pst, .zip, or .msg here` |
| Choose | `Choose file` |
| Hint | `Max 50 GB` |
| Type reject | `That file type isn’t supported. Use .pst, .zip, or .msg.` |
| Size reject | `This file is too large. Maximum is 50 GB.` |
| Uploading | `Uploading… {n}%` + `Keep this window open until it finishes.` |
| Success | `Received.` / `Saved for Nava. Processing into mail comes later.` |
| Toast | `Backup received` |
| Empty list | `No backups yet.` |
| List labels | pending=`In progress`, stored=`Received`, aborted=`Cancelled` |

**Behavior:** `accept=".pst,.zip,.msg"`. Client reject before init. Single XHR PUT or sequential/concurrent (≤4) part PUTs via `File.slice`; collect ETag; complete. Cancel → abortUpload. Close while uploading → confirm. Multiple stored files (month splits). a11y: DialogTitle/Description, progressbar valuemin/max/now, errors `role="alert"`.

Wire: `useQuery(trpc.brain.getCapabilities)` like admin-dashboard hide pattern in `app-sidebar.tsx`.

- [x] **Step 1:** Failing FE tests — wrong ext no init; nav hidden when cap false; empty list copy; success mentions not inbox
- [x] **Step 2:** Implement
- [x] **Step 3:** Mail tests + typecheck
- [x] **Step 4:** Commit + `git push origin HEAD`

---

### Task 6: CORS PUT (canonical only)

Follow `aws-resources.md` read→write→readback.

- Canonical rule: methods `GET`, `HEAD`, **`PUT`**. Same origins. ExposeHeaders += **`ETag`**.
- Do **not** change remote-admin CORS to include PUT.
- Update `aws-resources.md` snippet + `s3CorsCanonical` tests so extra PUT still passes (GET+HEAD still required).
- Evidence: `get-bucket-cors` + launch-readiness `s3CorsCanonical=true`.

- [x] **Step 1:** Read current CORS
- [x] **Step 2:** Apply + update docs/tests
- [x] **Step 3:** Readback
- [x] **Step 4:** Commit + `git push origin HEAD`

---

### Task 7: Push (if needed) + deploy + flag on + handoff

**Not done until origin has the SHAs, pilot is running them, and catchup upload is live.**

- Confirm `git status` / `git log origin..HEAD` empty (or push remaining)
- `apps/server-pilot/deploy/ops-deploy.sh --migrate`
- Bounce `ops-restart.sh` if deploy did not already restart
- **Set `CATCHUP_UPLOAD_ENABLED=true` on EC2** (persist in the same env injection this box already uses for `MailEnv`). Bounce if the process does not pick env without restart.
- Agent proof (no Vitest vs pilot RDS): health curl; schema present; CORS readback (`s3CorsCanonical=true`); authenticated `brain.getCapabilities.catchupUpload === true`; catchup `initUpload` not fail-closed
- Handoff: `docs/superpowers/plans/handoff-reports/2026-09-04-centurion-catchup-upload.md` — flag **already true**; WhatsApp `Open Nava → Upload backup (under Settings) → drop the .pst`; CORS evidence; ingest later

- [x] Origin up to date (`git push origin HEAD`)
- [x] `ops-deploy.sh --migrate` succeeded
- [x] Bounce / app healthy; **`CATCHUP_UPLOAD_ENABLED=true` persisted**
- [x] Capabilities true; upload API accepts (not fail-closed)
- [x] Handoff file
- [x] Commit handoff + `git push origin HEAD`

---

## Test plan

| Case | Expected |
|------|----------|
| Flag unset / false | Nav hidden; all catchup procs error |
| Flag true (tests + pilot) | Nav **Upload backup**; init/complete work |
| `.pst` init | pending + putUrl + headers |
| `.exe` / >50GiB | reject |
| complete Head match | `stored` |
| MPU >100MiB | parts + CompleteMPU then stored |
| complete Head mismatch | error, still pending |
| IDOR complete | NOT_FOUND |
| listMine | own rows only |
| 4th pending | reject |
| FE wrong type | copy, no init |
| FE success | Received + not-in-inbox |

## Out of scope

- PST/MSG ingest into mailbox
- Transfer Acceleration
- Virus scan, admin gallery, VBA Auto-BCC

## Review disposition

Reviews skipped for impl (user). MPU restored after size evidence (S3 5 GB PUT wall + hotel PDF Sent). Safety rules unchanged.
