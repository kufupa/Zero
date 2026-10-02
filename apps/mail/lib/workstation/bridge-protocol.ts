import { z } from 'zod';

export const BRIDGE_PROTOCOL_VERSION = 4;

export const WorkstationEmailPayloadSchema = z.object({
  entryId: z.string(),
  storeId: z.string().optional(),
  folderEntryId: z.string().optional(),
  folderName: z.string().optional(),
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
  storeId: z.string().optional(),
  folderEntryId: z.string().optional(),
  subject: z.string(),
  senderName: z.string(),
  receivedTime: z.string(),
  internetMessageId: z.string().optional(),
});

export type FolderEmailSummary = z.infer<typeof FolderEmailSummarySchema>;

export const FolderEmailPageSchema = z.object({
  items: z.array(FolderEmailSummarySchema).max(200),
  continuationToken: z.string().nullable(),
  snapshotTruncated: z.boolean(),
  totalItems: z.number().int().nonnegative().max(5000),
  storeId: z.string(),
  folderEntryId: z.string(),
});

export type FolderEmailPage = z.infer<typeof FolderEmailPageSchema>;

export const StoreSummarySchema = z.object({
  storeId: z.string(),
  displayName: z.string(),
  isDefault: z.boolean().optional(),
});

export type StoreSummary = z.infer<typeof StoreSummarySchema>;

export const StorePageSchema = z.object({
  items: z.array(StoreSummarySchema).max(200),
  totalItems: z.number().int().nonnegative(),
  continuationToken: z.string().nullable(),
  truncated: z.boolean(),
});

export type StorePage = z.infer<typeof StorePageSchema>;
export const StoreCollectionResultSchema = StorePageSchema;
export type StoreCollectionResult = z.infer<typeof StoreCollectionResultSchema>;

export const FolderSummarySchema = z.object({
  storeId: z.string(),
  entryId: z.string(),
  parentEntryId: z.string().optional(),
  name: z.string(),
  path: z.string(),
  depth: z.number(),
  defaultFolderType: z.number().nullable().optional(),
});

export type FolderSummary = z.infer<typeof FolderSummarySchema>;

export const FolderCollectionEnvelopeSchema = z.object({
  items: z.array(FolderSummarySchema).max(5000),
  truncated: z.boolean(),
});

export const FolderCollectionResultSchema = FolderCollectionEnvelopeSchema;
export type FolderCollectionResult = z.infer<typeof FolderCollectionResultSchema>;

export const AccountSummarySchema = z.object({
  smtpAddress: z.string(),
  displayName: z.string(),
});

export type AccountSummary = z.infer<typeof AccountSummarySchema>;

export const AccountPageSchema = z.object({
  items: z.array(AccountSummarySchema).max(200),
  totalItems: z.number().int().nonnegative(),
  continuationToken: z.string().nullable(),
  truncated: z.boolean(),
});

export type AccountPage = z.infer<typeof AccountPageSchema>;
export const AccountCollectionResultSchema = AccountPageSchema;
export type AccountCollectionResult = z.infer<typeof AccountCollectionResultSchema>;

export const MailLocationSchema = z.object({
  entryId: z.string(),
  storeId: z.string(),
  folderEntryId: z.string(),
  folderName: z.string(),
  displayed: z.boolean().optional(),
  moved: z.boolean().optional(),
  composerWarning: z.string().optional(),
  draftPlacementWarning: z.string().optional(),
  folderPlacementWarning: z.string().optional(),
  locationUnverified: z.boolean().optional(),
});

export type MailLocation = z.infer<typeof MailLocationSchema>;

// A provider returning no MailItem cannot confirm that Move occurred. Its
// expected target is informational only; cache the unconfirmed outcome on retry.
export const MoveEmailResultSchema = z.discriminatedUnion('moveStatus', [
  MailLocationSchema.extend({ moveStatus: z.literal('confirmed'), moved: z.literal(true) }),
  MailLocationSchema.extend({
    moveStatus: z.literal('unconfirmed'),
    moved: z.never().optional(),
    locationUnverified: z.literal(true),
    folderPlacementWarning: z.string(),
  }),
]);
export type MoveEmailResult = z.infer<typeof MoveEmailResultSchema>;

export const BridgeCapabilitiesSchema = z.object({
  bridgeProtocolVersion: z.number(),
  addinVersion: z.string(),
  outlookVersion: z.string(),
  runtime: z.string(),
  newOutlookSupported: z.boolean(),
  interactiveProfileRequired: z.boolean(),
  maxPageSize: z.number(),
  maxFolderDepth: z.number(),
  maxFolderCount: z.number(),
  maxFolderSnapshotItems: z.number(),
  supportedActions: z.array(z.string()),
});

export type BridgeCapabilities = z.infer<typeof BridgeCapabilitiesSchema>;

export const SendDraftResultSchema = z.object({
  submitted: z.boolean(),
  usedDefaultAccount: z.boolean(),
  accountSmtpAddress: z.string().nullable(),
});

export type SendDraftResult = z.infer<typeof SendDraftResultSchema>;

export const DeleteEmailResultSchema = z.object({
  deleted: z.boolean(),
  permanent: z.boolean(),
  exchangeRetentionMayKeepRecoverableCopy: z.boolean().optional(),
});

export type DeleteEmailResult = z.infer<typeof DeleteEmailResultSchema>;

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
  | 'PAIR_DEVICE'
  | 'REGISTER_NAVIGATION'
  | 'CLEAR_SESSION'
  | 'PREPARE_MOVE_CONSENT'
  | 'NATIVE_MOVE_CONSENT_RESOLVED'
  | 'GET_CAPABILITIES'
  | 'LIST_STORES'
  | 'LIST_FOLDERS'
  | 'GET_ACTIVE_EMAIL'
  | 'GET_FOLDER_EMAILS'
  | 'GET_EMAIL_BY_ENTRY_ID'
  | 'CREATE_DRAFT'
  | 'UPDATE_DRAFT'
  | 'CREATE_REPLY_DRAFT'
  | 'LIST_ACCOUNTS'
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
  ticket?: string;
  transportId?: string;
  consentRequestId?: string;
}

export interface BridgeResponse<T = unknown> {
  requestId: string;
  version?: number;
  action?: BridgeAction;
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

export function createBridgeRequest<T>(
  action: BridgeAction,
  payload: T,
  grant?: { ticket: string; transportId: string; consentRequestId?: string },
): BridgeRequest<T> {
  return {
    requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    version: BRIDGE_PROTOCOL_VERSION,
    action,
    payload,
    ...grant,
  };
}

export function createOperationId(): string {
  return `op_${Date.now()}_${crypto.randomUUID().replace(/-/g, '')}`;
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
      errorCode: typeof json.errorCode === 'string' ? json.errorCode : undefined,
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
