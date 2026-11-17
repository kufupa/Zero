import { createOutlookReplyCommand, type ToolContext } from './index.js';

// stdin JSON: {input, context}; use synthetic identifiers, never mailbox content in shared logs.
let raw = '';
for await (const chunk of process.stdin) raw += String(chunk);
try {
  const request: unknown = JSON.parse(raw);
  if (typeof request !== 'object' || request === null || !('input' in request) || !('context' in request) ||
      typeof request.context !== 'object' || request.context === null || !('sessionId' in request.context) ||
      typeof request.context.sessionId !== 'string' || !('mode' in request.context) ||
      (request.context.mode !== 'live' && request.context.mode !== 'labtest' && request.context.mode !== 'historical')) {
    throw new Error('Expected {input, context: {sessionId, mode, outlookReply}}');
  }
  const context: ToolContext = { sessionId: request.context.sessionId, mode: request.context.mode,
    ...('outlookReply' in request.context ? { outlookReply: request.context.outlookReply } : {}) };
  const result = await createOutlookReplyCommand(request.input, context);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch {
  process.stderr.write('Invalid JSON or command context.\n');
  process.exitCode = 2;
}
