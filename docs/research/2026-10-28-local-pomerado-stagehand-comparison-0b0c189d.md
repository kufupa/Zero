# Local Pomerado versus Stagehand SDK

Research-only comparison, checked 2026-10-28. No browser trial, install, upgrade, deploy, HMS change or send was performed. This builds on [prior framework-fit research](2026-10-28-booking-wayfinding-evidence-codex-7f2c.md#2026-10-28-follow-up-framework-fit), adding installed-version, source, vendor-claims and cloud-boundary checks.

## Versions

- Pomerado source checkout `/home/orca/pomerado`: `087e7fb930ffa32f61206005900fa6af23229f96`; public GitHub HEAD `755ca9d0f771a38ac0b916b1f302beef3addf15a` was 27 commits ahead when checked. No update was made.
- Global Pomerado CLI: `0.4.0-canary.399`; prior HRCEN trial package at `/home/orca/.local/share/pomerado/native-canary477`: `0.4.0-canary.477`. These are separate installations; do not conflate them with the source checkout.
- Installed `@browserbasehq/stagehand`: `4.3.0`, also npm's `latest` at check time. No update was made.
- Open-source licenses: Stagehand MIT; Pomerado current core and `.477` MIT, with third-party notices. Pomerado versions `0.1.2` and earlier were AGPL-3.0-only per its [README](https://github.com/Pomerado/pomerado).

## Comparison and vendor claim boundaries

| Capability | Local Pomerado | Local Stagehand 4.3 |
|---|---|---|
| Product shape | Model-powered minter builds a website-specific operation, saves source and serves it through local MCP. | SDK exposes browser operations; the caller or a separate agent controls workflow and code. |
| Multi-step reasoning | Built into minting; published runtime executes generated code. | V4 has no built-in `agent()` loop. User code or an external agent orchestrates. |
| Natural-language action and extraction | Minter explores and writes a task-specific integration. | `act`, `observe`, `extract` are SDK methods; extraction accepts typed schemas. |
| Repeated execution without inference | Vendor states published integration runs make no model request. Site and input can still make execution fail. | Stored observed `Action` can be passed to `act` with no inference. Deterministic selectors also avoid inference. Building, storing and orchestrating the workflow remains our responsibility. |
| Healing after page change | Cloud-managed automatic breakage detection and repair are not part of the local core. Manual investigation, editing or reminting are possible. | Opt-in `selfHeal` can re-infer a broken recorded action and retry once. It is not general autonomous integration maintenance and may incur model cost. |
| Managed action cache | Not equivalent to automatically persisting and repairing Stagehand calls; generated integration itself is persistent source code. | Browserbase server-side cache does not operate with a local browser. Local retained Action replay is separate. |
| Browser sessions | Local Chromium or a compatible Playwright WebSocket server; the audited checkout explicitly rejects CDP attachment because it may reset site data and close tabs. | Launch local Chrome or attach over CDP; actual existing Infor session compatibility remains unproven. Extension and Stagehand-managed connection are required. |
| Login | Minter supports login and interactive verification; vendor says saved credentials/OAuth brokerage are cloud additions. Local runtime may ask again. | Browser operations can implement login. A local browser profile can persist session data; application owns credential/session policy. |
| Screenshots | Browser tooling and generated custom code can potentially capture evidence; do not assume ready-made runtime screenshot reports for every integration. | Local `page.screenshot()` returns bytes and can save a PNG. Synthetic smoke showed a PNG with no inference. |
| MCP | Local mint MCP plus a locally served MCP for each generated integration. | Experimental local adapter is in the Stagehand source repo, not a standalone installed SDK binary. Its tools include run, snapshot and screenshot. Hosted Browserbase MCP is separate. |
| Safety | Guardian reviews mint-time browser actions and final generated source. Vendor warns runtime does not verify authority or intent and local source edits are not reviewed. A write mint can perform its write during building. | No equivalent bundled Guardian. Caller owns action policy, authorization, write boundaries and verification. |
| Models | Stock vendor setup specifies OpenAI models for minting/review; project-specific Azure bridge is separate customization. Normal generated runs are model-free per vendor. | Named providers and custom LLM callback; our Azure adapter is custom. AI calls, healing and extraction may incur provider cost. |
| Model and data egress | Self-hosted browser does not imply local inference. The local guide says answers including passwords pass through the MCP client and its model provider; the browser host does not save them. | Local Chrome does not imply local inference. Placeholder variables can avoid sending their values to the model, but screenshots/page content, logs and other paths need separate assessment. |
| Browser/network behavior | Generated integration semantics depend on its code and local runtime. | Stagehand v4 uses Playwright-style APIs, not full Playwright equivalence. Its migration docs describe different locator waits and missing request interception. |

Sources: [Pomerado README](https://github.com/Pomerado/pomerado); [Stagehand act](https://docs.stagehand.dev/v4/basics/act); [Stagehand v4 migration](https://docs.stagehand.dev/v4/migrations/v3); [local browser and CDP](https://docs.stagehand.dev/v4/configuration/browser); [Stagehand CLI agent adapter](https://docs.stagehand.dev/v4/integrations/cli-agents/overview); [Playwright migration](https://docs.stagehand.dev/v4/migrations/playwright).

## Cloud-only versus paid

Cloud-only does **not** mean a paid subscription is always needed. Both vendors advertise limited free cloud tiers. Local source use needs no vendor cloud subscription, but infrastructure and separately routed model calls may cost money.

- Pomerado identifies hosted jobs/integrations, managed browser fleet, login vault/OAuth brokerage, access control, and automatic breakage detection and repair as cloud additions. Its [pricing](https://pomerado.ai/) lists some team and governance functions under Business.
- Stagehand's Browserbase cloud adds managed browsers, Model Gateway, server-side cache, hosted session replay/inspection and managed functions. The [cache docs](https://docs.stagehand.dev/v4/best-practices/caching) explicitly say the cache option has no effect on a local browser. Local screenshots and manually retained Action replay remain available.
- A model provider may charge even when the browser and SDK are self-hosted. No HMS-specific cost comparison was measured here.

## Claims checked

1. Browserbase's [marketing page](https://dev.browserbase.com/stagehand) says the `agent` primitive works locally. Its [v4 migration](https://docs.stagehand.dev/v4/migrations/v3) says `agent()` was removed, and installed v4 types expose `act`, `observe`, `extract` but no `agent()`.
2. Pomerado's [homepage](https://pomerado.ai/) shows self-healing and gives performance figures. Its [repository](https://github.com/Pomerado/pomerado) puts automatic detection/repair in Cloud. The homepage benchmark used pre-minted integrations on 30 tasks across 25 apps, one attempt each. It is not an Infor or Stagehand head-to-head and does not establish first-mint cost or booking accuracy.
3. Pomerado Guardian is a mint-time reviewer, not runtime approval or a substitute for independently verified results. The README warns that generated runtime calls do not check authority or intent. A write build can perform a real write during minting.
4. `selfHeal` is not full workflow repair: it can retry one recorded action after a selector failure when enabled. The SDK default is off; verify changed targets and write outcomes independently.

## Existing HMS evidence, not a head-to-head

- Prior [Pomerado research](2026-10-28-booking-wayfinding-evidence-codex-7f2c.md#2026-10-28-follow-up-framework-fit) records an HRCEN arrival lookup published after about 13 minutes. A separate call failed after 29.4 seconds; a diagnostic failed after 32.3 seconds, before search at the property control. Cause was not confirmed.
- [Stagehand 4.1 Labtest trial](2026-10-28-stagehand-labtest-fable-f777f33d.md) matched six fields on an already-open fake stay; profile-frame extraction failed. It did not independently locate the stay.
- A later [Stagehand 4.3 handoff](../context/ACTIVE.md) recorded a successful HRCEN sign-in and Stay 360 navigation, with booking-form discovery still incomplete at that snapshot. It is not a live status check.
- Synthetic [Stagehand replay and screenshot evidence](2026-10-28-stagehand-rate-grid-assessment-f777f33d.md) showed zero model calls for the demonstrated replay. Full Infor replay, auto-healing, complete rates, and booking remain unproven.
- These tasks, versions and setups differ. No winner for Infor speed, cost or accuracy follows from these observations.

## Source-audit details and constraints

- The checked-out Pomerado local host explicitly lists unavailable hosted features: HTTP recording and HTTP versions, saved browser profiles, protected answers, offline-command sandboxing and write fencing, as well as maintenance, saved logins and managed anti-bot functions. A local minted integration is usable as an MCP tool, not evidence that this package builds a standalone direct-HTTP integration. [Explicit exclusions](/home/orca/pomerado/typescript/src/hosted-features.ts#L15)
- The Pomerado checkout hardcodes a Sol model for its minter and Luna for Guardian. The Sol default conflicts with the owner's routing rule; a project-specific Azure launcher is not equivalent to an upstream-supported configuration. [Model defaults](/home/orca/pomerado/typescript/src/models/models.ts#L1)
- Pomerado's 70% pre-review read-test threshold counts pass/fail cases, excludes inconclusive and other categories, and considers zero counted cases to have reached that threshold. Guardian review still follows: this is not proof every zero-test build publishes, and publication is not an independent HMS accuracy test. [Threshold implementation](/home/orca/pomerado/typescript/src/mint/live-tests.ts#L1357)
- Local Pomerado asks for login and one-time codes through the MCP client. Vendor warns that answers, including passwords, pass through that client and its model provider; it does not read SMS or authenticators itself. [Getting started](/home/orca/pomerado/docs/getting-started.md#L213)
- Stagehand's SDK implements no-inference `act(Action)` replay, but its controller still requires a configured model or gateway when `act` is called. A retained action's replay may make no inference despite this configuration requirement. [Controller](/home/ubuntu/projects/zero/.worktrees/recover-parse-failure/apps/server-pilot/tooling/stagehand/node_modules/@browserbasehq/stagehand/dist/extension/service-worker.js#L51952)
- Stagehand v4 documentation says `act` replay skips the usual DOM-settle wait, and its locator waiting differs from Playwright. A timeout, page change or wrong control is not established safe by selector self-healing. [Act](https://docs.stagehand.dev/v4/basics/act) · [Playwright migration](https://docs.stagehand.dev/v4/migrations/playwright)
