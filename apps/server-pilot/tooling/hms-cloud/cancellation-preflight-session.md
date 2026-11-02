# Cancellation preflight session

`withCancellationPreflightSession` provides a runtime allowlisted composition
surface over the existing saved-stay session. It accepts only `read` and
`prepareCancellation`. `openCancel`, `confirmCancel`, every other current tool,
and unknown future tools return `PREFLIGHT_TOOL_NOT_ALLOWED` without reaching
the underlying session. Malformed requests return `INVALID_REQUEST`.

```js
import { withCancellationPreflightSession } from './cancellation-preflight-session.mjs';

const result = await withCancellationPreflightSession(async ({ runTool }) => {
  const read = await runTool({ tool: 'read', confirmation, guestName, arrivalDate });
  if (read.outcome !== 'ok') return read;
  return runTool({ tool: 'prepareCancellation', requestedScope: 'unspecified' });
}, { signal });
```

The facade forwards allowed results and the abort signal unchanged. A full read
is required before preparation, and existing session serialization, read guards,
privacy and dialog rules still apply. Callers must use the appropriate property
lock; the facade does not acquire one. The result is for human review and does
not establish cancellation policy, fees, or complete room coverage.

This facade does not change the raw `withSavedStayAgentSession` or its JSONL
runner. Those surfaces still expose explicitly guarded Labtest actions, including
cancellation. The facade is not wired into the installed provider, pane, or
webmail, and does not change their current permissions or behavior.
