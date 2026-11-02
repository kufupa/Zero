// Runtime-restricted composition surface for cancellation preparation only.
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';

/** Own a saved-stay session while exposing only read and cancellation preparation. */
export async function withCancellationPreflightSession(operation, { signal } = {}) {
  if (typeof operation !== 'function') throw new Error('SESSION_CALLBACK_REQUIRED');
  return withSavedStayAgentSession(async ({ runTool }) => {
    const runPreflightTool = (request) => {
      let input;
      try { input = structuredClone(request); }
      catch { return Promise.resolve({ id: null, tool: null, outcome: 'input_gap', issue: 'INVALID_REQUEST' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return Promise.resolve({ id: null, tool: null, outcome: 'input_gap', issue: 'INVALID_REQUEST' });
      }
      if (input.tool !== 'read' && input.tool !== 'prepareCancellation') {
        return Promise.resolve({ id: input.id ?? null, tool: input.tool ?? null,
          outcome: 'refused', issue: 'PREFLIGHT_TOOL_NOT_ALLOWED' });
      }
      return runTool(input);
    };
    return operation({ runTool: runPreflightTool });
  }, { signal });
}
