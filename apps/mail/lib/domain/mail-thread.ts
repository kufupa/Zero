import type { ParsedMessage } from '@/types';

export type CenturionMailCategory = 'internal' | 'individual' | 'group' | 'travel-agents';

export interface IGetThreadsResponse {
  threads: {
    id: string;
    historyId: string | null;
    $raw?: unknown;
    centurionCategory?: CenturionMailCategory;
  }[];
  nextPageToken: string | null;
}

export interface IGetThreadResponse {
  messages: ParsedMessage[];
  latest?: ParsedMessage;
  hasUnread: boolean;
  totalReplies: number;
  labels: { id: string; name: string }[];
  isLatestDraft?: boolean;
  centurionCategory?: CenturionMailCategory;
}

export interface ParsedDraft {
  id: string;
  to?: string[];
  subject?: string;
  content?: string;
  rawMessage?: {
    internalDate?: string | null;
  };
  cc?: string[];
  bcc?: string[];
}
