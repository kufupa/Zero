# Outlook reply command

`createOutlookReplyCommand({proposal_id, expected_revision}, context)` maps a trusted snapshot to an unsent `CREATE_REPLY_DRAFT` command. `tools` exposes the same function as `outlook_reply_command`; it is separate from `reply_draft`, which stores agent text on a proposal. This pack does not persist, dispatch, open, or send email.

The server must authorize the staff mailbox and resolve the proposal, thread, selected message and Outlook locator itself. It supplies `context.outlookReply` as `OutlookReplySnapshot`; never populate it from model input. The selected message `id` must be the thread's `selected_message_id`; its `entryId`, `storeId`, and `folderEntryId` must come from the host's matching selected Outlook item. The normalized thread contract does not itself supply this locator. Generate a fresh host-compatible `op_<unix-ms>_<32-hex-guid>` operation ID for each intended draft.

At dispatch, the pane/host must recheck the current selected item and mailbox against `binding` and the three native locator fields, and the proposal against `proposal_revision`. Abort on a changed selection or revision. Then use the existing authorized `sendCommand(command.action, command.payload)` bridge. The native bridge requires a valid ticket, exact store/item/source-folder scope, and a current operation ID; a timeout is not proof that no draft exists. Replay the same operation ID only within the native replay window; reconcile an unknown result before starting a new operation. Treat returned draft location as host confirmation; this mapper's `ok` only confirms command construction.

Plain proposal text is HTML-escaped and converted to line breaks. Recipient and thread semantics come from Outlook's reply operation. The command requests a saved draft (`openInComposer: false`); host controls any later presentation. There is no send action.

CLI: pipe `{ "input": { "proposal_id": "...", "expected_revision": 1 }, "context": { "sessionId": "...", "mode": "live", "outlookReply": { ... } } }` JSON to `tsx apps/nava-agent/tools/outlook-reply/cli.ts`. Use synthetic data for shared logs.
