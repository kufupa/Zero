export const outlookReplyCommandSchema = {
  type: 'object',
  properties: {
    proposal_id: { type: 'string', minLength: 1 },
    expected_revision: { type: 'integer', minimum: 1 },
  },
  required: ['proposal_id', 'expected_revision'],
  additionalProperties: false,
} satisfies { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };

export const outlookReplyCommandName = 'outlook_reply_command';

export type OutlookReplySnapshot = {
  thread: { id: string; source: 'outlook'; mailbox_id: string; selected_message_id: string };
  selected_message: { id: string; entryId: string; storeId: string; folderEntryId: string };
  proposal: { id: string; thread_id: string; session_id: string; revision: number; reply_draft: string | null };
  operationId: string;
};

export type OutlookReplyCommand = {
  action: 'CREATE_REPLY_DRAFT';
  payload: {
    operationId: string;
    entryId: string;
    storeId: string;
    folderEntryId: string;
    htmlBody: string;
    replyAll: false;
    openInComposer: false;
  };
  binding: {
    session_id: string;
    thread_id: string;
    mailbox_id: string;
    selected_message_id: string;
    proposal_id: string;
    proposal_revision: number;
  };
};
