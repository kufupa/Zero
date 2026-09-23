import { z } from 'zod';

export const BRIDGE_PROTOCOL_VERSION = 2;

export const WorkstationEmailPayloadSchema = z.object({
  entryId: z.string(),
  subject: z.string(),
  senderEmail: z.string(),
  senderName: z.string(),
  to: z.string().optional(),
  cc: z.string().optional(),
  receivedTime: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string(),
  conversationId: z.string().optional(),
  internetMessageId: z.string().optional(),
  transportHeaders: z.string().optional(),
});

export type WorkstationEmailPayload = z.infer<typeof WorkstationEmailPayloadSchema>;

export const FolderEmailSummarySchema = z.object({
  entryId: z.string(),
  subject: z.string(),
  senderName: z.string(),
  receivedTime: z.string(),
  internetMessageId: z.string().optional(),
});

export type FolderEmailSummary = z.infer<typeof FolderEmailSummarySchema>;

export const TemplateSummarySchema = z.object({
  name: z.string(),
  fileName: z.string(),
  path: z.string(),
  modifiedTime: z.string(),
  byteSize: z.number().optional(),
});

export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

export const TemplateContentSchema = z.object({
  path: z.string(),
  subject: z.string(),
  to: z.string().optional(),
  cc: z.string().optional(),
  htmlBody: z.string(),
  plainBody: z.string(),
});

export type TemplateContent = z.infer<typeof TemplateContentSchema>;

export const SignatureSummarySchema = z.object({
  name: z.string(),
  fileName: z.string(),
  htmlBody: z.string(),
});

export type SignatureSummary = z.infer<typeof SignatureSummarySchema>;

export const AttachmentMetaSchema = z.object({
  index: z.number(),
  fileName: z.string(),
  displayName: z.string().optional(),
  byteSize: z.number(),
  type: z.string().optional(),
});

export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export const AttachmentContentSchema = z.object({
  index: z.number(),
  fileName: z.string(),
  byteSize: z.number(),
  base64Data: z.string(),
});

export type AttachmentContent = z.infer<typeof AttachmentContentSchema>;

export type BridgeAction =
  | 'PING'
  | 'GET_ACTIVE_EMAIL'
  | 'GET_FOLDER_EMAILS'
  | 'GET_EMAIL_BY_ENTRY_ID'
  | 'CREATE_DRAFT'
  | 'CREATE_REPLY_DRAFT'
  | 'MOVE_EMAIL'
  | 'MOVE_TO_SPAM'
  | 'CREATE_FOLDER'
  | 'LIST_TEMPLATES'
  | 'GET_TEMPLATE_CONTENT'
  | 'LIST_SIGNATURES'
  | 'GET_ATTACHMENT_METADATA'
  | 'READ_ATTACHMENT_BASE64'
  | 'ADD_ATTACHMENT_TO_DRAFT'
  | 'SET_EMAIL_CATEGORY'
  | 'SET_FOLLOW_UP_FLAG'
  | 'MARK_EMAIL_READ'
  | 'GET_CONVERSATION_THREAD'
  | 'ON_SELECTION_CHANGED';

export interface BridgeRequest<T = unknown> {
  requestId: string;
  version: number;
  action: BridgeAction;
  payload: T;
}

export interface BridgeResponse<T = unknown> {
  requestId: string;
  version?: number;
  action?: BridgeAction;
  success: boolean;
  data?: T;
  error?: string;
}

export function createBridgeRequest<T>(action: BridgeAction, payload: T): BridgeRequest<T> {
  return {
    requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    version: BRIDGE_PROTOCOL_VERSION,
    action,
    payload,
  };
}

export function parseBridgeMessage<T = unknown>(raw: string): BridgeResponse<T> {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return {
      requestId: typeof json.requestId === 'string' ? json.requestId : 'unknown',
      version: typeof json.version === 'number' ? json.version : undefined,
      action: json.action as BridgeAction | undefined,
      success: Boolean(json.success),
      data: json.data as T | undefined,
      error: typeof json.error === 'string' ? json.error : undefined,
    };
  } catch (err) {
    return {
      requestId: 'unknown',
      success: false,
      error: err instanceof Error ? err.message : 'Invalid JSON from bridge',
    };
  }
}

export function isSelectionChangedEvent(response: BridgeResponse): boolean {
  return response.requestId.startsWith('evt_') && response.action === 'ON_SELECTION_CHANGED';
}
