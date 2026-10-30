# Draft: live HMS lookup and memory run

> Historical draft from 30 October 2026. This run has since been completed; see the [HMS Cloud tools](../../../../apps/server-pilot/tooling/hms-cloud/README.md) for the current implementation.

## Goal

In at most **2½ hours**, build a useful first part of Nava's reservation workflow: a reusable live booking-agency lookup and a small working memory that helps an agent decide what to search for. Use the real Centurion HMS UI and the existing confirmation corpus. Stop earlier if the useful work is done; do not stretch the run to fill the time.

This is a first working slice toward a reservationist that reads an email, remembers relevant past decisions, searches current HMS records, and pre-fills as much as possible. It is not a mandate to build the entire product in this run. One solid lookup and a usable memory-to-lookup flow are more valuable than several incomplete tools.

## Time and priorities

- Spend roughly 20–30 minutes on targeted corpus analysis; at most one hour. Use it to choose the most valuable examples and identify ambiguous cases. Move on as soon as it is useful.
- Spend most of the remaining time building and driving the real HMS. Reserve time to verify and report the result. If the agency lookup and memory work well and time remains, tackle an organization or A/R lookup; don't parallelize several browser-building efforts.
- Use Luna 6 max subagents for independent analysis where helpful. Use one browser owner at a time; Terra 6.1 max is suitable for the Playwright work. Do not duplicate or disturb the other active Codex CLI chat.

## Inputs and starting point

- Read `PRODUCT.md`, workspace guidance and the current `building-hms-playwright-tools` skill. Use existing login, browser and Notes-popup handling where applicable. The existing 1a/1b/1c readers are useful references for composable tools, but 1a searches an existing confirmation and is not a prerequisite for a new booking. Existing creation code uses Guest Stay → New Record; verify the current UI rather than assuming the path.
- Primary saved corpus: `/home/orca/.local/share/zero/research/halloween/raw-data/stay360-1a-1b-1c-20261029-run01.json`. Related outbound-PDF records and prior analysis are under `/home/orca/.local/share/zero/research/halloween/`. These files are shared across worktrees and contain sensitive data.
- The corpus contains 892 successful unique confirmation reads, including 492 with Source of Business E-Mail. These are later HMS snapshots linked to outbound confirmations, not a complete view of the hotel's directory or all incoming requests. An outbound recipient is not automatically the original inbound sender. Do not count repeated PDFs or rereads as independent bookings.
- If finding genuine linked inbound emails is practical, use a few to make examples more realistic. Otherwise, label outbound-recipient examples or simulated requests accurately; don't spend the run chasing a perfect email corpus.
- The old party lookup may contain useful UI clues, but don't import its whole framework or assume it works today. Build small tools in the existing `apps/server-pilot/tooling/playwright-quote/` style, with explicit inputs and structured outputs, suitable for reuse by an agent.

## Build the first slice

1. **Analyze high-value patterns.** Look at agency, organization and A/R combinations, common rate/guarantee relationships, and how often past choices vary for the same identity signal. Record the counts and limitations that affect the tool. Historical associations are hints, not hotel policy. Pricing, eligibility and availability still need live checks.
2. **Make working memory, simply.** Derive a small, property-scoped private JSON index from the corpus. Preserve observed combinations and conflicts, their source, support counts and relevant times. Distinguish outbound recipients from known inbound senders and blank fields from unknown fields; retain native IDs only when actually observed. Offer a small callable interface that takes available identity hints and returns plausible past combinations with evidence. Support adding a new observation with its real provenance and reading it back, without silently replacing conflicting examples or teaching model guesses as confirmed staff decisions. Demonstrate this using honestly labeled data. No database migration, generic memory platform or elaborate framework is needed; note that concurrent production writers will need suitable storage.
3. **Build a live agency search.** In headless Chromium, use one authenticated page/session, reach the appropriate new-booking UI and inspect the agency buttons. Implement a small composable module that accepts a search query and returns the visible candidates and available identifiers/details. Distinguish a verified empty result from a failed or still-loading search and from a potentially truncated result. Return ambiguity to the caller; do not guess which record to select. If safe on an unsaved new-record form, add a separate explicit action to select a verified candidate and read back the field, without saving. Report which UI details and actions were and weren't verified.
4. **Connect them.** Show a usable path where an input or representative historical example retrieves memory suggestions, uses a suggestion to search the live HMS, and returns the current candidates and supporting evidence. The caller/agent can refine its query based on those results. Show how conflicting or missing evidence is surfaced. This should be reusable code and a runnable flow, not just an analysis notebook.
5. **Verify on the actual UI.** Exercise representative unique, ambiguous and no-match searches where feasible, plus a memory-assisted example. Record what was observed, errors, incomplete results and any remaining unknowns. Do not write low-value local unit tests; direct headless Playwright verification is the priority. Do not claim a small set of examples establishes production accuracy.

## Boundaries and output

- Read real records only. Do not save a real-guest booking, create profiles, send messages, or deploy. Labtest is allowed under `PRODUCT.md` if genuinely needed, but this slice should normally be read-only. Keep credentials, guest data, screenshots and raw derived JSON in the shared private data area, outside Git.
- Save concise, sanitized findings and runnable instructions in `docs/research/halloween/memory-experiments/`; keep reusable tool code in the existing HMS tooling area. Preserve other sessions' changes and avoid editing files another session owns. Do not commit or push their work.
- Give progress updates. At the end, report what works, commands/interfaces, live examples without personal data, what the memory actually contains, any data limitations, unresolved issues and the best next step. Be explicit about whether anything is merely a local building block rather than integrated into the production product.
