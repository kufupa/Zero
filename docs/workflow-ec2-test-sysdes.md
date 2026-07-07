## Why we're doing this

- **Problem:** You need HMS (Infor) operations — lookup, booking, etc. — but **no reliable HMS API access**
- **Idea:** Treat the **web UI as the API**
  - Human teaches once in a real browser
  - Save workflow as a file (semantic YAML)
  - Replay **deterministically** from code with parameters — parallel, no LLM on the hot path
- **This repo slice is not the whole NAVA product** — it's the **browser automation / workflow execution layer** the main app will call

---

## What we're building (this pilot)

- **`nava-workflow-pilot`** — teach-once / replay-many stack
  - **Record:** headed Chrome + recorder extension → workflow file
  - **Replay:** `run-workflow-no-ai` — semantic clicks/nav, params via `input_schema`
  - **Goal state:** `run_workflow("lookup_guest", {name, dates})` → structured extract back (like an API response)

- **Second lane (exploratory):** **Imprint** — CDP capture → optional MCP compile (Bun); not the primary HMS path right now

- **Separate experiment:** **`browser-harness-local`** — WhatsApp Web smoke via local Browser Harness (different domain, same “browser as integration” idea)

---

## Tech stack (workflow-use path — the one we've been hardening)

- **Human teach**
  - **Playwright** Chromium (headed) — launches browser, loads extension
  - **Chrome MV3 extension** (`workflow-use/extension`) — side panel record/stop
  - **Python `RecordingService`** — FastAPI on `:7331`, receives extension events

- **Workflow storage**
  - **Semantic YAML** — `target_text` steps, optional `input_schema`, terminal `extract_page_content`
  - Lives under `workflow-use/workflows/tmp/*.semantic.workflow.yaml`

- **Replay**
  - **browser-use `Browser`** + **semantic executor** — maps visible text → clicks; no LLM for interactions
  - **Shared Chrome profile** — logins from record persist into replay
  - **Python entrypoints:** `record.sh` / `replay.sh` → `.venv/bin/python cli.py …`

- **Tooling**
  - **uv** — Python env (`workflow-use/workflows/.venv`)
  - **Node 20** — extension build
  - **AWS SSM** — deploy/verify from laptop without SSH

---

## Why EC2

- **You need a real desktop for recording**
  - Headed Chrome + extension requires `DISPLAY` — xRDP session, not headless SSM shell

- **You already have a NAVA worker there**
  - Instance `i-008f737974a9ba9b3` (`af-south-1`, Ubuntu 24.04)
  - Shared **Playwright Chromium** at `/opt/nava/playwright-browsers` (pinned 1.52.0 / chromium-1169)
  - Same environment you'll run production-ish browser jobs on

- **Ops fit**
  - SSM deploy + preflight from laptop
  - Centralized browser install (no “works on my laptop” Chromium mismatch)
  - Session/cookies stay on the box for HMS login-once patterns

- **Not chosen for:** local dev comfort alone — EC2 is the **target runtime** for teach + replay at scale

---

## Where this plugs into the larger application

- **Today (pilot):** CLI scripts on EC2
  - `bash scripts/record.sh` → YAML on disk
  - `bash scripts/replay.sh <workflow>` → browser run

- **Next integration layer (what you're aiming at):**
  - **Thin Python runner** — `run_workflow(path, inputs) -> dict` (extract output = API-shaped response)
  - **Your app / workers** call that — parallel invocations, each with own browser profile eventually
  - **Optional:** HTTP wrapper or MCP tool — same runner underneath

- **HMS-specific end state:**
  - Record on Infor UAT (login once into profile)
  - Parameterize steps to mirror API fields (`guest_name`, dates, etc.)
  - Final extract step returns confirmation / lookup data your app would have gotten from HMS APIs

- **What stays outside this layer:**
  - NAVA product UI, auth, scheduling, business logic
  - This stack is **“execute cached browser workflow #7 with these params”**

---

## Current maturity (honest)

- **Working:** EC2 record path, replay of your DuckDuckGo workflow end-to-end, SSM preflight
- **Not built yet:** production API service, parallel workers with isolated profiles, HMS UAT workflows, param auto-detection from recordings
- **You are here:** proving **record → cache → deterministic replay** before wiring HMS and the main app