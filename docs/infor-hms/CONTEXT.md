# Centurion PMS tool lab

Language for the Sep 2026 corpus → Playwright PMS tools → schema-lab work. Not the whole Zero mail product.

## Language

**Thread**:
One mail conversation (shared `threadId` plus recovered reply/quote links). Reading context only. Not the eval unit, not the QA bucket.
_Avoid_: email, folder, task

**Inbound**:
One received message (`inboundId`). Lab processes all 1069. “Every email” means every inbound.
_Avoid_: thread, email blob, stay

**Gold reply**:
A Centurion-origin outbound that we treat as the human answer to evaluate against.
_Avoid_: sent item, template, gold email (ambiguous)

**Request extract**:
Fields taken from the inbound (and quoted history) that a PMS tool would need.
_Avoid_: schema, body, prompt

**StayAsk**:
Internal unit: one Hotel Availability / create write (arrival, departure, roomQty, roomType). Not a user-facing control.
_Avoid_: stay chip, chip, thread, email, booking (HMS reservation record), pair

**Proposed action**:
One HITL card in the right rail: a PMS tool plus the filled request for *this* inbound. Color-matched to body marks. Click expands Input and Staff-did (gold `usedResult`). Superseded/already-gold actions stay folded.
_Avoid_: stay chip, folder, schema pane (the pane *shows* actions), card-as-email

**Card**:
Right-rail Proposed tool. Not a left-list email.
_Avoid_: thread, inbound row

**Inbound row**:
Left list unit (`inboundId`). One received mail. Click this.
_Avoid_: card, thread blob

**PMS tool**:
One deterministic Playwright operation with a JSON Schema request and result.
_Avoid_: workflow, folder, category, agent

**Workflow folder**:
Existing live triage slug (`bookings`, `manage-stay`, `automated-channel`, …). Staff unused as of 2026-09-18. Kept as a tag, not the lab’s primary LHS.
_Avoid_: tool folder

**Captured result**:
Full PMS tool `$defs.result` kept for audit, including unused fields.
_Avoid_: output, quote

**Used result**:
Subset of the captured result that appears in the gold reply (later: in a drafted send).
_Avoid_: output we’d use (say used result)

**Skip**:
No PMS tool on this thread. Reasons include other-desk already answered, true channel auto-confirm, spam, ack-only.
_Avoid_: unanswered (unanswered is a stratum, not automatically skip)

**Schema**:
Three stacked contracts: (1) tool JSON Schema Draft 2020-12, (2) Luna extract record, (3) the request object typed into the tool.
_Avoid_: using “schema” without saying which layer

**Run-audit bundle**:
Private video / Playwright trace / screenshots / events for one live PMS run.
_Avoid_: audit (alone)

**Lab UI**:
Snapshot HITL right pane over the Sep window: mail + gold, then stacked proposed actions. Preview of `/mail` copilot pane. Not the live inbox route, not a live PMS click. Original Zero product, not a third-party plugin clone.
_Avoid_: audit, product inbox, stay chip, /tools, workflow plugin

**Other-desk**:
A gold-looking reply whose From is a known non-Centurion handler (Martha, Kamala, Penny/PMBOBO, …). Label, not a Centurion PMS-tool miss.
_Avoid_: Malta, skip (other-desk is a label; skip is the PMS-tool decision)

**Unanswered**:
In-window inbound with no Centurion gold reply yet. Not skip. Staff may reply after the snapshot.
_Avoid_: ignore, skip

**Facet**:
Who/what the request is (travel agent, group, company, individual, add-on meal). Not an LHS tool folder.
_Avoid_: tool, folder

**Channel-auto**:
Fingerprintable Infor/OTA/PMS template with no human Centurion prose. Intelligent skip. Copy-paste-into-client-reply is *not* gated this pass.
_Avoid_: sent, confirmation

**CRS Check Availability**:
Call Center → Central Reservation button that **creates a reservation record**. Not a quote/read. Forbidden as a Playwright “availability check.”
_Avoid_: Hotel Availability, Guest Stay Check Availability (that path only temporarily holds a rate on an open stay form)

**Proforma**:
HMS Print Documents → Pro Forma: a **not-yet-final** invoice-shaped PDF (guest/org recipient). Separate from confirmation letter and from a posted tax invoice.
_Avoid_: confirmation, quote, folio

**Confirmation letter**:
HMS-generated stay confirmation (CRS Confirm-to-Email, Guest Stay print/email documents, or batch report). May be auto-templated; sending is still a distinct click/job, not “the create tick” unless live proof says so.
_Avoid_: proforma, channel-auto (channel-auto is the OTA/PMS mail we skip)

**BEO**:
Banquet Event Order — HMS Events report/print of F&B, room setup, staffing, deposits for an event. Not a room reservation tool.
_Avoid_: group block, SCS

**SCS**:
Infor Sales & Catering Solution — separate product from HMS. Event/group quotes may live there. No connector in this lab unless analysis + live proof demand it.
_Avoid_: HMS Events, group block

**Tool contract**:
The frozen JSON Schema request and result for one Playwright PMS tool. Completeness means every field is source-backed, an explicit unknown, or a typed error. No silent drop.
_Avoid_: 10/10, mail-agent ready, HITL (those are extra envelopes unless the contract includes them)

**Lab stay**:
A real HMS reservation we created for tool tests: far-future dates, unique guest marker, not from mailbox gold. Pair: a keeper stay and a cancel-victim stay.
_Avoid_: dummy, fake, test database row

**Mailbox stay**:
A guest reservation from Centurion mail or the find grid. Read-only during the write factory.
_Avoid_: production row (the whole hotel is live HMS)

**Kernel**:
Shared once: Playwright login, CDP browser owner, audit bundle helper, lab-stay confirmation allowlist. Today this is `tooling/playwright-quote/` (login, `audit.mjs`, `remote-owner.mjs`). A renamed `playwright-hms` extract is optional later.
_Avoid_: framework, Stagehand, per-tool login rewrite

**Builder kit**:
The pack another LLM uses to ship a schema-complete Playwright PMS tool: frozen tool contract, Infor/page evidence, Astra brief template, kernel import, Grok/Astra swimlanes. Canonical feed is skill `building-hms-playwright-tools` (shared catalog + this worktree `.cursor/skills/`). Not a reservation create/cancel product by itself.
_Avoid_: building the create tool, Nava agent, mail UI, a deep playbook

**Orchestrator**:
This Cursor Grok 4.6 high session: schema, kernel, tests, docs, Astra briefs, git. Never attaches to HMS.
_Avoid_: calling this Astra

**Computer-use agent**:
One resumed Codex `exec` GPT-6 Astra session: live HMS, selectors, live proof. Not the Stagehand click-model and not Cursor Browser.
_Avoid_: Astra parent chat, runtime LLM inside the shipped CLI

**Native fact**:
Exact PMS label or panel text (for example `STWN`, `Standard Twin`, `Two Double Beds`).
_Avoid_: guessing beds from the room-type name

**Normalized fact**:
A closed enum filled only from a documented native fact (`Two Double Beds` → `double`). Unmapped native text stays unknown.
_Avoid_: `STWN` means twin beds

## Multi-hotel slots (Centurion + Da Vinci)

**Hotel slot**:
One property + one dedicated robot HMS login + one borrowed Chromium + one lock. Parallel means two slots, not two jobs on one login.
_Avoid_: lane (that is `default`/`hms` on the worker), always-on browser (that is a desired session state, not the slot)

**NAVAAI**:
The robot HMS user for a slot. Centurion and Da Vinci each have their own NAVAAI and secret. Staff never log into these.
_Avoid_: staff HMS login, shared hotel login

**Actor**:
The Nava user who kicked or approved the work (`actorUserId`). Not a person in HMS. HMS always shows NAVAAI.
_Avoid_: calling NAVAAI the actor, calling Actor and Slot the same user

**Slot session**:
Managed login state for one slot: `ready`, `recovering`, `down`. Desired state is `ready`. Recovery and reset are first-class, not afterthoughts.
_Avoid_: login-per-job, zombie session with no recover path

