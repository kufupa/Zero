# EC2 Production V3 — Human Review

Source plan: `docs/superpowers/plans/2026-06-30-ec2-production-per-user-mailbox-plan-v3.md`

Audience: solo dev / tech lead. Pre-build review only.

Supersedes: `docs/superpowers/plans/2026-06-30-ec2-production-human-loop-review.md` (aggregate-`nava@` shared-state mistake).

---

## One-Screen Summary

- Build **real prod backend**, pilot = smaller rollout on same shape
  - 1 user / ~1k copies/day first
  - scale to 50 users / 15k **delivered copies**/day
  - no second backend rewrite after pilot

- **V2 was wrong**
  - assumed shared `nava@` inbox + shared read/star/labels
  - product truth: **personal inboxes + real shared inboxes**
  - personal inbox = one owner
  - shared inbox = owner/member/admin access to same mailbox state

- **V3 inbound trick**
  - all copied mail lands in one POP3 box: `nava@`
  - Exchange stamps `X-Zero-Mailbox: centurion@...` (etc.)
  - worker routes copy → correct mailbox DB rows
  - `From`/`To`/`Cc`/`Message-ID` stay original; header is **owner only**

- **Stack swap**
  - out: Cloudflare Workers/DO/KV/R2/Queues/Gmail/OAuth
  - in: EC2 Node, PM2 (1 HTTP + 1 worker), RDS Postgres, S3, on-prem POP3/SMTP
  - new code: `apps/server-pilot/` on branch `EC2-pilot`
  - old `apps/server/` untouched; FE still imports `@zero/server/*`

- **Non-negotiables**
  - POP3: S3 + Postgres commit **before** `DELE`
  - every mail query/mutation: prove `mailboxAccess(userId, activeTransportId)`
  - missing `X-Zero-Mailbox` → quarantine, never user inbox
  - never send as `nava@`; send as staff mailbox via Send As
  - browser cache cleared/scoped on logout/session expiry
  - real 30s React Query polling, not just background flag
  - one HTTPS frontend host serves all users

---

## Mental Model

```mermaid
flowchart LR
  exchange[Legacy Exchange] --> centurion[centurion@]
  exchange --> frontdesk[frontdesk@]
  centurion -->|rule BCC + X-Zero-Mailbox| nava[nava@ POP3]
  frontdesk -->|future rule| nava
  worker[PM2 worker] --> nava
  worker --> rds[(RDS mailbox threads)]
  worker --> s3[(S3 raw MIME)]
  fe[React app] --> http[PM2 HTTP tRPC]
  http --> rds
  http --> s3
  http -->|SMTP Send As| exchange
```

- **Input**: one aggregate copy stream (`nava@`)
- **Storage/view/send**: per staff mailbox identity (`mailboxTransport`)
- **Access**: `mailboxAccess` decides personal/shared/admin visibility

---

## What You're Actually Building

- **HTTP server**
  - Hono + tRPC + Better Auth (email/password, session cookie)
  - mirrors old `AppRouter` + `@zero/server/*` exports
  - all mail reads filtered by selected mailbox after access check

- **Worker**
  - polls `nava@` every ~30s
  - `UIDL → RETR → parse → S3 → PG → DELE → QUIT`
  - singleton only (two workers = race on same POP3)

- **DB**
  - 16 tables
  - new vs v2: `mailIngestMailbox`, `mailIngestQuarantine`
  - personal/shared/admin access: `mailboxAccess`
  - thread/message/draft/label scoped by `transportId`
  - drafts/sends record actor user where needed
  - snooze lives on mailbox `mailThread`
  - no `staffMember`, `mailSnooze`, or `mailPrompt`
  - snooze is `mailThread.snoozedUntil`

- **Frontend**
  - mostly unchanged
  - one static SPA served over HTTPS
  - real polling (30s) + focus refetch, no WebSocket
  - login = allowed mailbox list; mailbox switcher chooses active inbox
  - live persisted query cache disabled or keyed by `userId + activeTransportId`
  - logout/session expiry clears React Query + IndexedDB

---

## Decision Ledger

| Decision | Why | Risk if wrong | Your call before build |
|---|---|---|---|
| Aggregate `nava@` + `X-Zero-Mailbox` | BCC recipient not in headers; POP3 no envelope | mail in wrong inbox or nowhere | IT must prove header on test copy |
| `nava@` is ingest-only | avoids polling real staff mailboxes with DELE | delete from Centurion's real mailbox | confirm IT never points worker at primary mailbox |
| Mailbox thread state on `mailThread` | personal inbox private; shared inbox truly shared | wrong access guard = leak | access tests mandatory |
| One `message` row per copied mailbox delivery | same guest email to 2 mailboxes = 2 rows | more storage, simpler access | accept storage cost |
| No `message_recipient` fan-out | simpler than shared message + per-user overlay | shared inbox state cannot be per-user | don't reintroduce for "efficiency" |
| `apps/server-pilot/` parallel | don't break Cloudflare backend | duplicate backend during migration | ok? |
| EC2 + RDS + S3 | one dev, AWS credits, simpler than CF mail stack | you own ops | VPN to on-prem mail? |
| PM2 1+1 | no cross-process POP3 races | scaling worker >1 breaks ingest | lock PM2 config |
| POP3 download-delete on `nava@` only | drain copy mailbox; RDS/S3 = record | delete before persist = data loss | manual kickoff test |
| React Query polling | skip WS complexity | up to 30s stale UI | ok for hotel ops? |
| Send As via `nava-app@` | standard Exchange pattern for app send | IT won't grant permission | confirm before send work |
| Quarantine table | fail closed on bad routing | ops must clear quarantine | who owns quarantine triage? |
| AI deferred | mail core first | users see dead AI buttons | hide or no-op AI UI |
| One hosted SPA | all 50 users use same VPN URL | TLS/static hosting ambiguity | nginx serves assets + proxies `/api/*` |
| Disable/scoped live query cache | shared terminals likely | stale inbox leak across users | must pass shared-browser test |
| RDS `t4g.medium` floor | `t4g.small` 2GB can bottleneck | DB pressure before EC2 pressure | load test before go-live |

---

## Mail Topology — Highest Risk Area

### Why BCC alone fails

- SMTP envelope `RCPT TO` not visible over POP3
- `Bcc:` header usually stripped
- one `nava@` inbox with 50 BCC'd copies → **cannot tell which staff mailbox owned each copy**
- guessing `To:`/`Cc:` = privacy breach (CC'd mail visible to wrong user)

### Accepted path (pilot + prod same shape)

- Exchange Transport Rule per staff mailbox
  - condition: mail **sent to** `centurion@...`
  - action 1: set header `X-Zero-Mailbox: centurion@...`
  - action 2: BCC `nava@...`
- worker maps header → `mailboxTransport.ownerHeaderValue`
- pilot: **one rule** (Centurion only)
- prod: add rule per mailbox, same backend

### Fallback if Exchange can't set headers

- per-staff copy mailboxes: `nava-centurion@`, `nava-frontdesk@`
- owner = which mailbox polled
- more IT mailboxes + maybe multi-ingest config later
- still better than headerless aggregate BCC

### Rejected paths

- aggregate BCC with no owner marker
- poll staff primary mailboxes with DELE (kills Outlook copies unless app is sole client)

### Outbound

- never `From: nava@`
- SMTP auth as `nava-app@` (or relay from EC2 IP)
- `From: centurion@...` via Send As
- backend rejects `fromEmail` not matching user's transport

---

## IT Dependencies — Flag Early

| IT deliverable | Blocks | Test |
|---|---|---|
| `nava@` mailbox + POP3 enabled | ingest | UIDL list from EC2/VPN |
| Transport Rule Centurion → `nava@` + header | routing | raw MIME in `nava@` has `X-Zero-Mailbox` |
| Strip external `X-Zero-Mailbox` rule | prod security | spoof test from external sender |
| `nava-app@` + Send As on Centurion | send | send test as Centurion from app |
| SMTP relay / connector for EC2 IP | send if no service account | telnet/auth from EC2 |
| VPN or network path EC2 ↔ on-prem mail | everything | connectivity before build ends |

- **You guide IT**, not vice versa
- plan has UI paths (Exchange 2010/2013+) + PowerShell examples
- journaling = avoid unless IT already runs it clean

---

## Data Model — What Matters

- **`mailIngestMailbox`**
  - POP3 config for `nava@` only
  - not what users see in UI

- **`mailboxTransport`**
  - staff mailbox identity (Centurion, Front Desk, …)
  - `ownerHeaderValue` must match Exchange header exactly
  - not linked directly to one `userId`
  - owns display name, staff mailbox email, send-as config, owner marker

- **`mailboxAccess`**
  - explicit user → mailbox access map
  - roles: `owner`, `member`, `admin`
  - `owner`: personal mailbox owner or shared mailbox responsible manager
  - `member`: shared-inbox user who can read/write/send but not manage access
  - `admin`: production admin/support user with explicit access rows
  - no `delegate` wording now; `member` is clearer

- **No `staffMember` table**
  - access table handles personal inboxes, shared inboxes, and admins
  - extra table duplicated user/mailbox identity
  - admin/read-all uses `mailboxAccess(userId, transportId, role)`, not hidden in base schema

- **No `mailSnooze` table**
  - `mailThread.snoozedUntil` handles snooze
  - simpler wake scan + fewer joins

- **No `mailPrompt` table**
  - AI drafting not shipping in this BE rewrite
  - add prompt schema later with real AI routes/UX

- **`mailIngestQuarantine`**
  - missing/unknown/duplicate-ambiguous `X-Zero-Mailbox`
  - raw MIME kept; **never** in user inbox

- **`mailThread` / `message` / `mailDraft`**
  - always `transportId`
  - inbound `message` also stores `ingestMailboxId`, `pop3Uidl`, `ownerHeaderValue`
  - `mailThread` owns `snoozedUntil`
  - `mailDraft` records `createdByUserId`

### Role Model — Final Recommendation

| Role | Use | Mail Actions | Access Management |
|---|---|---|---|
| `owner` | personal owner or shared inbox responsible manager | read/write/send | can manage that mailbox members |
| `member` | shared inbox participant, e.g. Centurion worker | read/write/send | cannot manage access |
| `admin` | production admin/support user | read/write/send across granted mailboxes | can manage access |

- **Best shape**
  - manager: `owner` on shared Centurion inbox
  - Centurion worker: `member` on shared Centurion inbox
  - each person: optional `owner` on personal inbox
  - admin: `admin` rows across all target mailboxes

- **Why no `delegate`**
  - ambiguous Exchange/Outlook meaning
  - sounds like "act on behalf of" special case
  - product actually needs shared inbox membership

### Indexes you cannot drop

- `(ingest_mailbox_id, pop3_uidl)` unique — dedupe + crash replay
- `(transport_id, thread_root_id)` unique — thread identity
- `owner_header_value` unique on `mailboxTransport` — routing map
- `(user_id, transport_id)` unique on `mailboxAccess` — one access role per mailbox/user pair
- `snoozed_until` index on `mailThread` — worker wake scan

---

## Ingest Flow — Failure Modes

- **Happy path**
  - RETR → parse → S3 PUT → PG transaction → DELE → QUIT → `pop3_purged_at`

- **Parse/store fails**
  - skip DELE for that message
  - stays on server for retry
  - alarm if backlog grows

- **Crash after PG commit, before DELE**
  - replay same UIDL
  - unique index prevents duplicate row
  - still DELE to drain

- **Missing `X-Zero-Mailbox`**
  - quarantine row
  - metric `QuarantinedMissingOwner`
  - **do not** route to default user

- **Cycle cap**
  - `POP3_MAX_MESSAGES_PER_CYCLE=500`
  - at 15k/day ≈ 10.4/min avg — fine if parse < ~1s/msg
  - PDF-heavy or slow Exchange POP3 = real bottleneck

---

## Solo Dev Constraints

- **You are ops**
  - PM2, RDS backups, S3 lifecycle, CloudWatch alarms, Secrets Manager
  - no second person on-call

- **You are integration**
  - Exchange rules, Send As, VPN, POP3 creds
  - pilot blocked until IT test passes

- **You are QA**
  - cross-user isolation tests non-optional
  - 1k backlog drain < 30 min
  - 15k/day sim no backlog growth

- **Cuts already made (ponytail)**
  - no pg-boss
  - no WebSocket
  - no pgvector/AI in v1
  - browser 15s undo send, not server unsend queue

- **Do not "simplify" away**
  - ownership checks every mail path
  - `X-Zero-Mailbox` routing
  - quarantine
  - write-then-DELE
  - cross-user negative tests
  - logout/session-expiry cache clear
  - real `refetchInterval: 30_000`
  - explicit HTTPS frontend hosting

---

## Capacity — Recalculate Before Go-Live

| Assumption | If wrong |
|---|---|
| 15k/day = **delivered copies** | one source email copied to N staff = N× volume |
| ~1s/message ingest | 10s PDF parse → backlog at scale |
| single `nava@` stream | all staff copies queue in one mailbox |
| 30s poll interval | worst case 30s UI delay |
| `m6i.xlarge` enough | HTTP + worker contend for 4 vCPU |
| RDS `t4g.medium` enough | pool waits / CPU credits / memory pressure |

- EC2 `m6i.xlarge`
  - runs nginx, static SPA, Node HTTP, worker, PM2/log agent
  - plausible default, not proven by inherited V2 math

- RDS
  - `t4g.small` now dev/smoke only
  - prod-shaped pilot floor: `t4g.medium`
  - upgrade to `t4g.large` before 50-user go-live if load says so

- go-live block if heavy PDFs + single worker can't drain
- mitigations: faster parse, attachment offload, multiple copy mailboxes (fallback topology)
- go-live block if 50-user HTTP test fails while worker ingests

---

## Defaults Locked For Build

| # | Decision | Default |
|---|---|---|
| Q1 | Exchange can set `X-Zero-Mailbox` | assume yes; per-staff copy mailboxes fallback |
| Q2 | Exchange can BCC to `nava@` | assume yes |
| Q3 | 15k/day meaning | delivered mailbox copies |
| Q4 | 7-day retention | no app-side retention; Exchange/server handles it |
| Q5 | User mapping | Centurion pilot first; final mailbox/access CSV before prod expansion |
| Q6 | Mailbox cardinality | personal + shared mailboxes through `mailboxAccess` |
| Q7 | Automation drafts | require explicit `transportId + threadId`; actor user recorded when human-triggered |
| Q8 | Shared send aliases | off unless explicit allowlist |
| Q9 | Freshness | 30s polling + focus refetch |
| Q10 | AI UI | hide/no-op until mail core works |
| Q11 | Frontend cache | disable live persistence, or key by `userId + activeTransportId` |
| Q12 | Frontend hosting | nginx HTTPS static SPA + `/api/*` proxy |
| Q13 | Access roles | explicit `mailboxAccess` owner/member/admin rows; no delegate wording |
| Q14 | Snooze | `mailThread.snoozedUntil`, no `mailSnooze` table |
| Q15 | AI prompts | no `mailPrompt` table until AI drafting ships |

---

## Risk Register

| Severity | Risk | Mitigation |
|---|---|---|
| **Critical** | IT can't stamp `X-Zero-Mailbox` | per-staff copy mailboxes fallback |
| **Critical** | ingest DELE before persist | write-then-DELE tests + alarms |
| **Critical** | missing mailbox access guard in one route | systematic `mailboxAccess` + `transportId` negative tests |
| **Critical** | admin access leaks into normal routes | separate admin behaviors + `mailboxAccess` tests |
| **Critical** | shared-browser cached inbox leak | clear/scoped query cache + Playwright shared-browser test |
| **High** | external spoof `X-Zero-Mailbox` | strip external header rule before prod multi-user |
| **High** | delivered-copy volume >> 15k | recount with IT; resize RDS/S3/worker |
| **High** | PDF parse stalls worker | benchmark early; alarm on `IngestCycleMs` |
| **High** | static/TLS hosting unspecified | nginx HTTPS static root + API proxy in plan |
| **High** | RDS `t4g.small` bottleneck | use `t4g.medium` floor, load-test before go-live |
| **Medium** | Send As not granted | dedicated receive connector fallback |
| **Medium** | quarantine fills silently | alarm `QuarantinedMissingOwner > 0` |
| **Medium** | FE contract drift | typecheck `apps/mail` vs `server-pilot` in CI |
| **Medium** | polling flag without interval | add `refetchInterval: 30_000` |
| **Low** | 30s stale UI | document; refetch on focus |

---

## Pilot Checklist (You + IT)

**IT**

- [ ] `nava@` exists, POP3 on
- [ ] Rule: Centurion → set `X-Zero-Mailbox` + BCC `nava@`
- [ ] Test raw copy headers verified
- [ ] `nava-app@` + Send As Centurion (or relay path)
- [ ] EC2/VPN can reach POP3+SMTP

**Backend**

- [ ] seed `mailIngestMailbox` (`nava@`)
- [ ] seed Centurion `mailboxTransport`
- [ ] seed manager `mailboxAccess` owner row for Centurion
- [ ] seed Centurion worker `mailboxAccess` member row for Centurion
- [ ] seed personal mailbox rows/access rows where pilot needs them
- [ ] seed admin `mailboxAccess` rows if pilot includes admin user
- [ ] worker routes by header; quarantine on miss
- [ ] send as Centurion only
- [ ] isolation tests green
- [ ] RDS `t4g.medium` or larger for prod-shaped pilot

**Frontend/Deploy**

- [ ] one `apps/mail` build served over HTTPS
- [ ] nginx static root + `/api/*` proxy to Node
- [ ] Better Auth URL matches HTTPS origin
- [ ] live query persistence disabled or scoped by `userId + activeTransportId`
- [ ] logout/session expiry clears query cache + IndexedDB
- [ ] actual 30s polling + focus refetch
- [ ] old OAuth account-switcher hidden or rewritten

**Acceptance**

- [ ] manager + Centurion worker both see shared Centurion copy
- [ ] user without Centurion access does not see Centurion copy
- [ ] reply From Centurion → original sender
- [ ] `From`/`To`/`Cc`/`Message-ID` preserved on stored message
- [ ] `nava@` drains only after S3+PG
- [ ] missing header → quarantine only
- [ ] admin can access Centurion only via `mailboxAccess`-backed admin route
- [ ] non-admin cannot enumerate/select all mailboxes
- [ ] Centurion access logout → Front Desk-only login in same browser shows no Centurion cached data
- [ ] 50-user HTTP load test passes while ingest worker runs

---

## Branch / Repo

- branch: `EC2-pilot` (from `FE-demo-minimal`)
- implementation not started until you say go
- v2 plan + old human review = historical only

---

## Recommended Go/No-Go

- **Go** if IT proves Transport Rule + header on test mail **before** deep ingest code
- **Go** if you accept solo-dev ops (RDS/S3/PM2/alarms)
- **Go** if frontend cache isolation fix is in scope for first implementation slice
- **Pause** if IT says no header stamping **and** no per-staff copy mailboxes
- **Pause** if 15k/day is pre-BCC source count — recalc capacity first
- **Pause** if shared-browser cache isolation cannot be verified
