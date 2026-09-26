# Infor HMS Outlook Side Pane Onboarding & Quoting Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end interactive demo of the Outlook 2016 VSTO side pane featuring the full onboarding sequence (mailbox detection, Infor HMS bridge verification, quick tour primer) transitioning seamlessly into the production-grade Infor HMS Quoting Tool.

**Architecture:** A unified, zero-dependency, self-contained HTML/CSS/JS application served at `https://hermes.trynava.io/designs/outlook-side-pane-demo.html`. Built with native Outlook 2016 VSTO ergonomics and Infor HMS design language (380px strict width, Segoe UI, Infor blue `#0066cc`, pine `#1a4332`, 100% contained in-pane calendar, 1000×800 proof modal, and zero boxes-in-boxes clutter).

**Tech Stack:** HTML5, CSS3 (CSS variables, light mode, native 1px borders), Vanilla JavaScript (state-driven multi-step view transitions), Playwright for automated E2E QA verification.

---

## Global Constraints

- Strictly adhere to 380px width containment with zero horizontal scrolling (`scrollWidth === clientWidth`).
- Pure light mode aesthetic matching Outlook 2016 and Infor HMS (no dark mode, no rounded bubble slop, no rainbow badges).
- No boxes inside boxes: flat hierarchy with clean dividers.
- Infor HMS native terminology only (`Property *`, `Dates of Stay *`, `Meal Plan *`, `Room Types & Occupancy *`, `Sales Strategy *`, `SEARCH CRITERIA`, `ROOM RATES`).
- Zero developer leaks (no CLI schema names, no JSON viewers, no browser host details).
- All interactions fully functional in browser without external backend dependencies.

---

## Plan Reviews

### Completeness Gate (gstack-plan-eng-review)
- **Data Flow:** Step 1 (Mailbox detection) $\rightarrow$ Step 2 (Server/HMS bridge ping returning server time and latency) $\rightarrow$ Step 3 (Feature walkthrough) $\rightarrow$ Step 4 (Quoting Tool with active email sync, availability search, dual audit proof, and email draft insertion).
- **Edge Cases & Failure Modes:** Invalid date range handling, calendar in-pane containment, restricted offer badges (`Closed to Arrival`), modal dismiss via `Escape` key and backdrop click, reset/replay onboarding state preservation.
- **Testing:** Playwright test suite verifying every screen transition, calendar containment, rate calculation updates, modal opening/closing, and draft generation.

### Simplicity Ceiling (ponytail-review)
- **YAGNI Cuts:** Removed raw CLI JSON toggle, removed diagnostic metadata drawer, removed duplicate email body quoting.
- **Unified Architecture:** Combined onboarding wizard and active quoting tool in a single lightweight state-machine container rather than separate disconnected pages.
- **Demo Controls:** Added a discreet top control bar to jump directly between onboarding steps or test the quoting tool without forcing reloads.

### Design Review (gstack-plan-design-review)
- **Visual Hierarchy:** Header $\rightarrow$ Context/Step Indicator $\rightarrow$ Primary Action Card $\rightarrow$ Minimal Footer.
- **Typography:** Segoe UI, clean weights (400, 600, 700), readable 12px-13px body text.
- **Affordance:** Primary actions clearly distinguished (Infor Blue `#0066cc` for search, Pine Green `#1a4332` for confirm/draft).

---

## Task Decomposition

### Task 1: Onboarding Flow State Machine & View Components
**Files:**
- Create/Modify: `scratch/build_clean_sidepane.py`
- Target Artifact: `/home/orca/.gstack/projects/zero/designs/current-ui-showcase/outlook-side-pane-demo.html`
- Target Spec: `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/docs/superpowers/specs/2026-09-23-centurion-outlook-side-pane-demo.html`

**Interfaces:**
- Consumes: User mailbox context (`reservations@centurion.co.za`), server ping mock (`time: UTC, latency: 18ms, hms: HRCEN NAVAAI active`).
- Produces: `switchScreen(screenName)` with screens: `onboard-welcome`, `onboard-diagnostics`, `onboard-tour`, `active-quote`.

- [ ] **Step 1: Implement Onboarding Screen 1 (Welcome & Mailbox Detection)**
  - Mailbox detection banner: `reservations@centurion.co.za (Centurion Hotel Front Desk)`.
  - Explanation of Nava for Outlook add-in.
  - Action: `Confirm Account & Connect`.

- [ ] **Step 2: Implement Onboarding Screen 2 (HMS Bridge & Diagnostics)**
  - Simulated live connection handshake with animated checkmarks:
    1. Local VSTO Add-In Bridge: `Active (Outlook 2016)`
    2. Nava Cloud Bridge: `Connected (18ms)`
    3. Infor HMS Session: `HRCEN Verified · User NAVAAI · Read/Write Active`
  - Shows server timestamp and property confirmation.
  - Action: `Next: Feature Tour →`.

- [ ] **Step 3: Implement Onboarding Screen 3 (Quick Tour Primer)**
  - 3-slide carousel/stepper:
    - Slide 1: Automatic Email Parsing (detects dates, room types, guest counts).
    - Slide 2: Infor HMS Availability & Audit Proof (live rates, dual screenshot audit).
    - Slide 3: 1-Click Quotation Replies (formatted quotation tables inserted into draft).
  - Pager dots and Next/Back controls.
  - Action: `Complete Setup & Open Assistant →`.

- [ ] **Step 4: Integrate Top Switcher / Replay Controller**
  - Allows direct jumping between Step 1, Step 2, Step 3, and Active Tool for frictionless testing.

---

### Task 2: Refined Production Quoting Tool Integration
**Files:**
- Modify: `scratch/build_clean_sidepane.py`
- Target Artifact: `outlook-side-pane-demo.html`

**Interfaces:**
- Consumes: Screen transition event from onboarding completion.
- Produces: Seamless switch to active email context with Penny Mbobo CIDB inquiry.

- [ ] **Step 1: Wire Seamless Onboarding $\rightarrow$ Quoting Tool Handoff**
  - On completing onboarding or clicking `Start Quoting`, transition smoothly into `active-quote` view.
  - Retain all refined Infor HMS form elements, in-pane calendar, rate cards, dual audit proof, and email draft insertion.

- [ ] **Step 2: Ensure Zero UI Regression**
  - Verify strict 380px pane containment.
  - Verify in-pane calendar positioning (326px width, zero overflow).
  - Verify 1000×800 full-screen proof modal functionality and `Escape` dismiss.

---

### Task 3: Automated Playwright QA Verification Suite
**Files:**
- Modify: `scratch/test_sidepane_qa.js`

- [ ] **Step 1: Write E2E Test covering full Onboarding Journey**
  - Verify Step 1 loads with mailbox info.
  - Click `Confirm Account & Connect`, verify Step 2 diagnostics checkmarks pass.
  - Click `Next: Feature Tour`, cycle through tour slides 1, 2, and 3.
  - Click `Complete Setup`, verify smooth transition into Quoting Tool.

- [ ] **Step 2: Verify Quoting Tool Functionality within Unified Flow**
  - Test calendar toggle within 380px boundary.
  - Test Meal Plan selection.
  - Test availability search execution.
  - Test rate card selection and grand total calculation.
  - Test dual audit proof tabs and 1000×800 modal popout.
  - Test email draft reply generation.

- [ ] **Step 3: Capture Full Visual Artifact Progression**
  - `onboarding-01-welcome.png`
  - `onboarding-02-diagnostics.png`
  - `onboarding-03-tour.png`
  - `onboarding-04-quote-tool.png`
  - `onboarding-05-email-draft.png`

---

### Task 4: Compounding, Code Review & Deployment
- [ ] Run `ce-code-review mode:agent` on the changes.
- [ ] Run `ce-compound mode:non-interactive` to record durable UX patterns.
- [ ] Verify live URL `https://hermes.trynava.io/designs/outlook-side-pane-demo.html`.
