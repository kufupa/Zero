import type { CenturionMailCategory } from '@zero/server/driver/types';

export type { CenturionMailCategory };

export type LabelColorValue =
  | string
  | {
      backgroundColor: string;
      textColor: string;
    }
  | null;

export type Label = {
  id: string;
  name: string;
  color?: LabelColorValue;
  type: string;
  labels?: Label[];
};

export interface User {
  name: string;
  email: string;
  avatar: string;
}

export interface ISendEmail {
  to: Sender[];
  subject: string;
  message: string;
  attachments?: File[];
  headers?: Record<string, string>;
  cc?: Sender[];
  bcc?: Sender[];
  threadId?: string;
  fromEmail?: string;
}

export interface Account {
  name: string;
  logo: React.ComponentType<{ className?: string }>;
  email: string;
}

export interface NavItem {
  title: string;
  url: string;
  icon?: React.ComponentType<{ className?: string }>;
  isActive?: boolean;
  badge?: number;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export interface SidebarData {
  user: User;
  accounts: Account[];
  navMain: NavSection[];
}

export interface Sender {
  name?: string;
  email: string;
  subject?: string;
}

export interface HeaderDebugLine {
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
  connectionId?: string;
  title: string;
  subject: string;
  tags: Label[];
  sender: Sender;
  to: Sender[];
  cc: Sender[] | null;
  bcc: Sender[] | null;
  tls: boolean;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  receivedOn: string;
  unread: boolean;
  body: string;
  processedHtml: string;
  blobUrl: string;
  decodedBody?: string;
  references?: string;
  inReplyTo?: string;
  replyTo?: string;
  messageId?: string;
  threadId?: string;
  isDraft?: boolean;
  attachments?: Attachment[];
  debugHeaders?: HeaderDebugLine[];
  reactions?: MessageReactionGroup[];
}

export interface IConnection {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  createdAt: Date;
  providerId: string;
}

export interface Attachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  body: string;
  headers: { name?: string | null; value?: string | null }[];
  /** Set on thread aggregates so chips can call getAttachment without body. */
  messageId?: string;
}
export interface MailListProps {
  isCompact?: boolean;
}

export type MailSelectMode = 'mass' | 'range' | 'single' | 'selectAllBelow';

export type MailListThreadRow = {
  id: string;
  historyId?: string | null;
  categoryIds?: string[];
  centurionCategory?: CenturionMailCategory;
  latestMessageAt?: string | Date | null;
  isStarred?: boolean;
  receivedOn?: string | Date;
  tags?: Label[];
  threadId?: string;
  subject?: string | null;
  snippet?: string | null;
  conversationId?: string;
  linkedThreadIds?: readonly string[];
  conversationResponded?: boolean;
  conversationMessageCount?: number;
  primaryThreadId?: string | null;
  linkedStubs?: readonly {
    threadId: string;
    label: string;
    latestMessageAt?: string | Date | null;
  }[];
};

export type ThreadProps = {
  message: MailListThreadRow;
  onClick?: (message: ParsedMessage) => () => void;
  isKeyboardFocused?: boolean;
  isKeyboardNavigationActive?: boolean;
};

export interface IOutgoingMessage {
  to: Sender[];
  subject: string;
  message: string;
  attachments?: File[];
  headers?: Record<string, string>;
  cc?: Sender[];
  bcc?: Sender[];
  threadId?: string;
  fromEmail?: string;
  isForward?: boolean;
  originalMessage?: string;
}

export interface Note {
  id: string;
  userId: string;
  threadId: string;
  content: string;
  color: string;
  isPinned: boolean | null;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}
