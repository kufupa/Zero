import type { MailApiMode } from '../runtime/mail-mode';
import type {
  AiComposeResult,
  AiPrompts,
  AiSearchQueryResult,
  AiSummaryResult,
  AiToolName,
  AiToolResult,
  AiWebSearchResult,
  Attachment,
  BimiLogo,
  ListThreadsInput,
  MailConnection,
  MailDraft,
  MailLabel,
  MailSettings,
  MailThreadDetail,
  MailThreadListItem,
  RecipientSuggestion,
  ThreadIdInput,
} from './types';
import type { AiPromptType } from '../domain/ai-prompts';

export type ThreadListResult = {
  threads: MailThreadListItem[];
  nextPageToken?: string;
};

export type FrontendApiCapabilities = {
  mode: MailApiMode;
};

export type MailApi = {
  listThreads: (input: ListThreadsInput) => Promise<ThreadListResult>;
  getThread: (input: ThreadIdInput) => Promise<MailThreadDetail>;
  send: (input: unknown) => Promise<unknown>;
  unsend: (input: unknown) => Promise<unknown>;
  deleteThread: (input: unknown) => Promise<unknown>;
  bulkDelete: (input: unknown) => Promise<unknown>;
  archive: (input: unknown) => Promise<unknown>;
  markAsRead: (input: unknown) => Promise<unknown>;
  markAsUnread: (input: unknown) => Promise<unknown>;
  toggleStar: (input: unknown) => Promise<unknown>;
  toggleImportant: (input: unknown) => Promise<unknown>;
  modifyLabels: (input: unknown) => Promise<unknown>;
  snoozeThreads: (input: unknown) => Promise<unknown>;
  unsnoozeThreads: (input: unknown) => Promise<unknown>;
  getMessageAttachments: (input: unknown) => Promise<Attachment[]>;
  processEmailContent: (input: unknown) => Promise<unknown>;
  suggestRecipients: (input: { query?: string; limit?: number }) => Promise<RecipientSuggestion[]>;
  verifyEmail: (input: unknown) => Promise<unknown>;
  forceSync: () => Promise<unknown>;
};

export type DraftsApi = {
  get: (input: unknown) => Promise<MailDraft | null>;
  list: (input: unknown) => Promise<unknown>;
  create: (input: unknown) => Promise<unknown>;
  delete: (input: unknown) => Promise<unknown>;
};

export type LabelsApi = {
  list: () => Promise<MailLabel[]>;
  create: (input: unknown) => Promise<unknown>;
  update: (input: unknown) => Promise<unknown>;
  delete: (input: unknown) => Promise<unknown>;
};

export type SettingsApi = {
  get: () => Promise<MailSettings>;
  save: (input: unknown) => Promise<unknown>;
};

export type ConnectionsApi = {
  list: () => Promise<MailConnection[]>;
  getDefault: () => Promise<MailConnection | null>;
  setDefault: (input: unknown) => Promise<unknown>;
  delete: (input: unknown) => Promise<unknown>;
};

export type NotesApi = {
  list: (input: unknown) => Promise<unknown>;
  create: (input: unknown) => Promise<unknown>;
  update: (input: unknown) => Promise<unknown>;
  delete: (input: unknown) => Promise<unknown>;
  reorder: (input: unknown) => Promise<unknown>;
};

export type TemplatesApi = {
  list: (input: unknown) => Promise<unknown>;
  create: (input: unknown) => Promise<unknown>;
  delete: (input: unknown) => Promise<unknown>;
};

export type AiApi = {
  generateSearchQuery: (input: unknown) => Promise<AiSearchQueryResult>;
  compose: (input: unknown) => Promise<AiComposeResult>;
  generateEmailSubject: (input: unknown) => Promise<unknown>;
  webSearch: (input: unknown) => Promise<AiWebSearchResult>;
  generateSummary: (input: unknown) => Promise<AiSummaryResult>;
  getBrainState: () => Promise<unknown>;
  getPrompts: () => Promise<AiPrompts>;
  updatePrompt: (input: { promptType: AiPromptType; prompt: string }) => Promise<unknown>;
  executeTool: (input: { action: AiToolName; payload: unknown; caller: string }) => Promise<AiToolResult>;
};

export type AssetsApi = {
  getBimiByEmail: (input: unknown) => Promise<BimiLogo | null>;
};

export type UserApi = {
  delete: () => Promise<unknown>;
  getIntercomToken: () => Promise<unknown>;
};

export type FrontendApi = {
  capabilities: FrontendApiCapabilities;
  mail: MailApi;
  drafts: DraftsApi;
  labels: LabelsApi;
  settings: SettingsApi;
  connections: ConnectionsApi;
  notes: NotesApi;
  templates: TemplatesApi;
  ai: AiApi;
  assets: AssetsApi;
  user: UserApi;
};
