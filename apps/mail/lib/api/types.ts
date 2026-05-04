import type { Attachment, Label, ParsedMessage } from '@/types';
import type { MailSettings } from '../domain/settings';
import type { AiPromptType } from '../domain/ai-prompts';

export type MailLabel = Label;

export type MailThreadListItem = {
  id: string;
  historyId?: string | null;
  title?: string;
  unread?: boolean;
  totalReplies?: number;
  latestReceivedOn?: string;
  [key: string]: unknown;
};

export type MailThreadDetail = {
  thread: unknown;
  messages?: ParsedMessage[];
  latest?: ParsedMessage;
  [key: string]: unknown;
};

export type MailMessage = ParsedMessage;

export type MailDraft = {
  id: string;
  threadId?: string | null;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  message?: string;
  fromEmail?: string | null;
  [key: string]: unknown;
};

export type { MailSettings };

export type MailConnection = {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  createdAt: Date;
  providerId: string;
};

export type RecipientSuggestion = {
  email: string;
  name?: string;
};

export type BimiLogo = {
  url?: string;
  /** SVG markup when the backend returns inline BIMI art (optional in demo). */
  svgContent?: string;
  found: boolean;
};

export type AiComposeResult = unknown;
export type AiSummaryResult = unknown;
export type AiSearchQueryResult = unknown;
export type AiWebSearchResult = unknown;
export type AiPrompts = Partial<Record<AiPromptType, string>>;
export type AiToolName = string;
export type AiToolResult = unknown;

export type LoginProvider = {
  id: string;
  name: string;
  enabled?: boolean;
};

export type AuthSession = {
  user?: {
    id?: string;
    email?: string;
    name?: string;
    image?: string;
  } | null;
  session?: { id?: string } | null;
};

export type ListThreadsInput = {
  folder?: string;
  q?: string;
  maxResults?: number;
  cursor?: string;
  labelIds?: string[];
};

export type ThreadIdInput = { id: string };

export type { Attachment };
