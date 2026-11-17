import { outlookReplyCommandName, outlookReplyCommandSchema, type OutlookReplyCommand, type OutlookReplySnapshot } from './schema.js';

export type ToolContext = {
  sessionId: string;
  mode: 'live' | 'labtest' | 'historical';
  signal?: AbortSignal;
  // Populated only by the server/host after authorizing the mailbox and resolving the selected item.
  outlookReply?: unknown;
};

type ToolError = { code: string; message: string; retryable: boolean; outcome: 'known' | 'uncertain' };
export type ToolResult =
  | { ok: true; data: OutlookReplyCommand; error: null }
  | { ok: false; data: null; error: ToolError };

const failure = (code: string, message: string): ToolResult => ({
  ok: false, data: null, error: { code, message, retryable: false, outcome: 'known' },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isSnapshot(value: unknown): value is OutlookReplySnapshot {
  if (!isRecord(value) || !isRecord(value.thread) || !isRecord(value.selected_message) || !isRecord(value.proposal)) return false;
  const { thread, selected_message: message, proposal } = value;
  return thread.source === 'outlook' && nonempty(thread.id) && nonempty(thread.mailbox_id) &&
    nonempty(thread.selected_message_id) && nonempty(message.id) && nonempty(message.entryId) &&
    nonempty(message.storeId) && message.storeId.length <= 2048 && nonempty(message.folderEntryId) &&
    message.entryId.length <= 512 && message.folderEntryId.length <= 512 && nonempty(proposal.id) &&
    nonempty(proposal.thread_id) && nonempty(proposal.session_id) && nonempty(proposal.source_message_id) && revision(proposal.revision) &&
    (typeof proposal.reply_draft === 'string' || proposal.reply_draft === null) &&
    typeof value.operationId === 'string' && /^op_\d{13}_[0-9a-f]{32}$/.test(value.operationId);
}

function textToHtml(text: string): string {
  const escaped = text.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
  return `<div style="white-space: pre-wrap">${escaped.replace(/\r\n|\r|\n/g, '<br>')}</div>`;
}

// Pure command mapping; this does not create, open, store or send an Outlook draft.
export async function createOutlookReplyCommand(input: unknown, context: ToolContext): Promise<ToolResult> {
  if (context.signal?.aborted) return failure('ABORTED', 'Command creation was aborted.');
  if (context.mode === 'historical') return failure('HISTORICAL_REPLY_UNAVAILABLE', 'Historical sessions cannot create Outlook commands.');
  if (!isRecord(input) || Object.keys(input).some(key => key !== 'proposal_id' && key !== 'expected_revision') ||
      !nonempty(input.proposal_id) || !revision(input.expected_revision)) {
    return failure('INVALID_INPUT', 'Provide proposal_id and expected_revision.');
  }
  if (!isSnapshot(context.outlookReply)) return failure('REPLY_CONTEXT_UNAVAILABLE', 'Authorized Outlook selection and proposal snapshot are required.');
  const { thread, selected_message: message, proposal, operationId } = context.outlookReply;
  if (!nonempty(context.sessionId) || proposal.session_id !== context.sessionId || proposal.thread_id !== thread.id ||
      proposal.id !== input.proposal_id || message.id !== thread.selected_message_id || proposal.source_message_id !== message.id) {
    return failure('REPLY_BINDING_MISMATCH', 'Selection and proposal must belong to the current session and thread.');
  }
  if (proposal.revision !== input.expected_revision) return failure('STALE_PROPOSAL', 'Proposal revision changed; reload before drafting.');
  if (!nonempty(proposal.reply_draft)) return failure('REPLY_EMPTY', 'Proposal has no reply text.');
  return {
    ok: true,
    data: {
      action: 'CREATE_REPLY_DRAFT',
      payload: { operationId, entryId: message.entryId, storeId: message.storeId, folderEntryId: message.folderEntryId,
        htmlBody: textToHtml(proposal.reply_draft), replyAll: false, openInComposer: false },
      binding: { session_id: context.sessionId, thread_id: thread.id, mailbox_id: thread.mailbox_id,
        selected_message_id: message.id, proposal_id: proposal.id, proposal_revision: proposal.revision },
    },
    error: null,
  };
}

export const tools = [{
  name: outlookReplyCommandName,
  description: 'Map the authorized selected Outlook message and saved proposal reply to an unsent host command. Never sends mail.',
  input_schema: outlookReplyCommandSchema,
  run: createOutlookReplyCommand,
}];
