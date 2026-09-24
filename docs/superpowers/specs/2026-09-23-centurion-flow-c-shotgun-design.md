# Centurion Flow C design shotgun

- **Status:** Recovered Antigravity canvas; static design study, not shipped behavior.
- **Live gallery:** https://hermes.trynava.io/designs/index.html
- **Local gallery:** [65-board HTML](./2026-09-23-centurion-flow-c-shotgun-gallery.html)
- **Last prompt:** make many more boards for a single-page Outlook flow centered on parsed email facts, editable tool schemas and optional fields, visible loading, HMS proof, saved output, and adding the next tool.

## Recovered design

Antigravity finished that prompt with 65 light-mode boards: a 13-board Flow C builder first, then Flow A (14), Flow B (12), Flow C (12), and Flow D (14). The new builder shows the parsed request, editable required/optional inputs, progress, proof, output/save, and chained reservation steps; diagnostics stay at the bottom.

Keep the Outlook pane vertical and scannable. Show the message context, source-linked values, edits, progress, and the next human decision in one flow. Treat the full-screen proof window as a host-dependent concept, not an Office pane feature. All gallery buttons are visual only.

The public stay-proof screenshot masks guest identifiers; contact values in the boards use sample values. The rate-screen proof remains visible as requested.

## Runtime flags — do not claim “100% concurrent”

- App-level user/mailbox isolation and cross-user receipt checks have test coverage, but that is not proof of the full live multi-user workflow. HMS reads use a shared serialized runtime/lock; quote admission in this checkout fails closed, and the active agent tool registry has no reservation-create path. See [quote authority default](../../../apps/server-pilot/src/hms/quote-request-normalization.ts:104), [read tool registry](../../../apps/server-pilot/src/hms/read-tools.ts:17), and [two-user DB coverage](../../../apps/server-pilot/tests/hms-independent-read-db-review.test.ts:1425).
- The audited Outlook VSTO host has no app-managed WebView2 `NewWindowRequested` pop-out. The 1000×800 proof window remains a design target; see `TaskPaneControl.cs` in the VSTO host checkout.
- Microsoft documents narrow Office task panes (Outlook on the web is 320×570 at the cited layout) and a host-handled WebView2 new-window event. These establish UI/API options, not this app’s implementation: [task pane guidance](https://learn.microsoft.com/en-us/office/dev/add-ins/design/task-pane-add-ins), [Outlook pinnable pane](https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/pinnable-taskpane), [WebView2 `NewWindowRequested`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.newwindowrequested?view=webview2-dotnet-1.0.4129.50).
- The human-review pattern is consistent with an editable, AI-prefilled form and an explicit action gate; see [Airia Form Review](https://airia.ai/docs/build/components/form-review) and [n8n Human Review](https://github.com/n8n-io/skills/blob/main/skills/n8n-agents-official/references/HUMAN_REVIEW.md).

## Deployment notes

Antigravity generated the static HTML with `assemble_final_builder_matrix.py`, then checked the existing port-9898 Python server and Caddy `/designs/` route. No special deployment CLI was involved. The restored public page was hash-checked against the final Antigravity artifact and returned HTTP 200.
