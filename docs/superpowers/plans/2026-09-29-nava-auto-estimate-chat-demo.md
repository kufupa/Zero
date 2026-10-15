# Nava Auto-Estimate Chat Demo Implementation Plan

> **For agentic workers:** Execute only local implementation and safe verification below. No external quote call is authorized by this plan.

**Goal:** Provide a profile-local Nava-branded offline auto-estimate demo, and confirm Foresee connectivity without submitting quote details.

**Architecture:** Hermes profile `nava-car` loads a local stdio MCP wrapper exposing only `get_auto_estimate`. Synthetic sample data goes only to an offline fake; live Foresee check is initialize + tools/list. Real quote forwarding remains fail-closed until a genuine host-side approval UX binds a human action to canonical payload and fixed recipient. Native `trust: untrusted` classification and model-visible consent claims do not prove approval.

**Tech Stack:** Python 3.11, Hermes-installed MCP SDK, profile-local skill/config, local stdio, Foresee Streamable HTTP.

## Global constraints

- Only this coding workspace and Hermes profile `nava-car`; no deployment, production, VPS, database, CI, or app tests.
- All Hermes CLI calls explicitly use `-p nava-car`; preserve existing `codegraph` and `exa` config.
- No invented/synthetic/third-party applicant profile goes to Foresee. No quote tool call—real or fake—on Foresee. This task permits only initialize/tools/list live discovery.
- Local fake test must use kernel-enforced egress block. Its flag can never appear in profile config.
- Never persist real or synthetic profile values in logs/timings. Simulated transcript stamped clearly; no assertion it is live model conversation or real quote.
- Keep Nava branding local-demo only. Accurately disclose Foresee as service provider if asked; preserve insurer facts and caveats.
- Real quote use remains disabled pending payload-bound human approval. Do not broaden existing user/vendor permission.

## Files

- `tools/nava-auto-estimate-wrapper/server.py`: strict schema, stdio server, live forwarding gate.
- `tools/nava-auto-estimate-wrapper/test_server.py`: validation, no-logging, disabled-forwarding, offline protocol.
- `tools/nava-auto-estimate-wrapper/fake_foresee.py`: fixed fake fixture.
- `tools/nava-auto-estimate-wrapper/offline_fake_runner.py`: seccomp egress-denied runner.
- `tools/nava-auto-estimate-wrapper/run_fake_chat.py`: deterministic scripted conversation and local timing CSV.
- `tools/nava-auto-estimate-wrapper/check_connections.py`: sanitized profile + live-discovery check; never tools/call.
- `tools/nava-auto-estimate-wrapper/README.md`: scope, runbook, and privacy boundary.
- `/home/ubuntu/.hermes/profiles/nava-car/skills/nava-auto-estimate/SKILL.md`: local demo instructions and real-call disabled disclosure.
- `/home/ubuntu/.hermes/profiles/nava-car/nava-auto-estimate/simulated_conversation.md`, `timings.csv`: offline demo artifacts.

## Acceptance

1. Offline suite: `python3 -m unittest discover -s tools/nava-auto-estimate-wrapper -p 'test_*.py' -v`; all pass. Must assert a valid fake exchange, validation rejection, no sensitive logging, one exposed tool, kernel egress block, and no live forwarding without host approval.
2. `python3 tools/nava-auto-estimate-wrapper/run_fake_chat.py`: local fake tool call succeeds once. Transcript prominently labels simulated; timings say local fake and not Foresee latency; profile values are never printed in artifacts.
3. `python3 tools/nava-auto-estimate-wrapper/check_connections.py`: reports only tool names/schema required keys, no data; upstream quote calls = 0.
4. `hermes -p nava-car mcp test nava`: startup and tool discovery succeed; exactly one selected Nava tool.
5. `git diff --check`; review only task-owned files. No secrets, raw config, applicant payloads, or hidden production state.

## Live synthetic request gate

Foresee Terms last updated 16 September 2026 say automated access must be on behalf of an actual person shopping for insurance and use accurate information that is the person’s own or genuinely authorized. User-provided email approves a local Hermes demo and hiding Foresee branding, but does not expressly authorize synthetic external quote inputs. No sandbox/test endpoint was found in current public docs. Therefore no fake profile may be sent to `quote_insurance` absent explicit written synthetic-test approval or documented sandbox instructions. Draft request: `tools/nava-auto-estimate-wrapper/FORESEE-SYNTHETIC-TEST-APPROVAL-DRAFT.md`. If approved, make exactly one request; record request timing/status only; keep the returned details labeled as a synthetic test and private. If denied/unanswered, the live test acceptance criterion remains blocked; use local fake.

## Remaining human/product gate

Before real shopper estimate can be supported, implement an interactive approval control outside model arguments, binding a canonical payload hash and fixed Foresee destination to an explicit user action. Then separately review the user-facing data/retention disclosures. Until then, wrapper must reject live forwarding. No fabricated test quote can substitute.
