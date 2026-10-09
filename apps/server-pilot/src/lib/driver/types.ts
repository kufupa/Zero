export type CenturionMailCategory =
  | 'new-bookings'
  | 'groups-events'
  | 'at-risk'
  | 'ops';

export interface ParsedAddress {
  name?: string;
  email: string;
}

export interface ParsedMessageTag {
  id: string;
  name: string;
  type: string;
}

export interface ParsedMessageAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  body: string;
  headers: { name: string | null; value: string | null }[];
}

export interface MailDebugHeaderLine {
  key: string;
  line: string;
}

export interface MessageReactionUser {
  userId?: string | null;
  email: string;
  userName?: string | null;
}

export interface MessageReactionGroup {
  emoji: string;
  count: number;
  users: MessageReactionUser[];
  hasReacted: boolean;
}

export interface ParsedMessage {
  id: string;
  title: string;
  subject: string;
  tags: ParsedMessageTag[];
  sender: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[] | null;
  bcc: ParsedAddress[] | null;
  tls: boolean;
  receivedOn: string;
  unread: boolean;
  body: string;
  processedHtml: string;
  blobUrl: string;
  decodedBody?: string;
  references?: string;
  inReplyTo?: string;
  messageId?: string;
  threadId?: string;
  attachments?: ParsedMessageAttachment[];
  isDraft?: boolean;
  debugHeaders?: MailDebugHeaderLine[];
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  reactions?: MessageReactionGroup[];
}

export interface ParsedDraft {
  id: string;
  threadId: string | null;
  replyToMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  content: string | null;
  updatedAt: string;
  status: 'active' | 'candidate' | 'discarded' | 'sent';
  origin: 'manual' | 'ai';
  generationId: string | null;
  isStale: boolean;
}

export interface MailCategory {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  sortOrder: number;
}

export interface MailLabelWire {
  id: string;
  name: string;
  type: 'system' | 'user';
  color?: string | null;
}

export interface MailFilterInput {
  unread?: boolean;
  important?: boolean;
  starred?: boolean;
  categoryIds?: string[];
  labelIds?: string[];
}

export interface ThreadListItem {
  id: string;
  historyId: string | null;
  subject: string | null;
  snippet: string | null;
  latestMessageAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  labelIds: string[];
  categoryIds: string[];
  hasDraft: boolean;
  draftCount: number;
  conversationId?: string;
  linkedThreadIds?: readonly string[];
  conversationResponded?: boolean;
  conversationMessageCount?: number;
  primaryThreadId?: string;
  // Demo/hotel-pilot only: real Gmail pilot omits this.
  centurionCategory?: CenturionMailCategory;
}

export interface ThreadListResponse {
  threads: ThreadListItem[];
  nextPageToken: string | null;
}

export interface ThreadDetailResponse {
  latest?: ParsedMessage;
  messages: ParsedMessage[];
  drafts: ParsedDraft[];
  hasUnread: boolean;
  /** True when any message on the thread is outbound (ever-replied). */
  hasReplied: boolean;
  totalReplies: number;
  labels: MailLabelWire[];
  categories: MailCategory[];
  categoryIds: string[];
  conversationId?: string;
  linkedThreadIds?: readonly string[];
  conversationResponded?: boolean;
  conversationMessageCount?: number;
  primaryThreadId?: string;
  // Demo/hotel-pilot only: real Gmail pilot omits this.
  centurionCategory?: CenturionMailCategory;
}

export interface PilotCapabilities {
  ai: false;
  brain: false;
  notes: false;
  templates: false;
  bimi: false;
  gmailSearchGrammar: true;
  hotelCategories: true;
  staleDraftWarning: true;
  catchupUpload: boolean;
  /** True when RESERVATIONIST_PANE_SAVE is lab or on: the pane may offer Preview and Book. */
  paneSave: boolean;
  /** The save mode behind paneSave: off (copy-only), lab (Labtest stays only) or on (real guests). */
  paneSaveMode: 'off' | 'lab' | 'on';
}

export interface ManagerConfig {
  auth: {
    userId: string;
    accessToken: string;
    refreshToken: string;
    email: string;
  };
}

export interface MailManager {
  config: ManagerConfig;
}

export type IGetThreadResponse = ThreadDetailResponse;
export type IGetThreadsResponse = ThreadListResponse;
