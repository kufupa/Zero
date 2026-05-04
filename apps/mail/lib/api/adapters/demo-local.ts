import { AiChatPrompt, StyledEmailAssistantSystemPrompt } from '@/lib/prompts';
import { getDemoThread, listDemoThreads } from '@/lib/demo-data/adapter';
import {
  demoAiCompose,
  demoBulkDeleteThreads,
  demoCreateLabel,
  demoDeleteDraft,
  demoDeleteLabel,
  demoDeleteNote,
  demoGenerateEmailSubject,
  demoGenerateSearchQuery,
  demoGenerateSummary,
  demoGetSettings,
  demoListTemplates,
  demoMarkAsRead,
  demoMarkAsUnread,
  demoModifyLabels,
  demoMoveThreadsTo,
  demoReorderNotes,
  demoSendEmail,
  demoSetSettings,
  demoSnoozeThreads,
  demoToggleImportant,
  demoToggleStar,
  demoUnsendEmail,
  demoUnsnoozeThreads,
  demoUpdateNote,
  demoUpsertDraft,
  demoUpsertNote,
  demoUpsertTemplate,
  demoWebSearch,
} from '@/lib/demo/local-actions';
import {
  deleteDemoTemplate,
  getDemoDraft,
  listDemoLabels,
  listDemoNotes,
  listDemoDrafts,
  upsertDemoLabel,
} from '@/lib/demo/local-store';
import {
  AiPromptTypeEnum,
  ReSummarizeThread,
  SummarizeMessage,
  SummarizeThread,
} from '@/lib/domain/ai-prompts';
import { UnsupportedFeatureError } from '../errors';
import type { FrontendApi } from '../contract';
import type { MailSettings, MailThreadListItem } from '../types';

const DEMO_CONNECTION = {
  id: 'demo-connection',
  email: 'guest@demo.centurion.local',
  name: 'Demo guest',
  picture: undefined as string | undefined,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  providerId: 'demo',
};

export function createDemoLocalAdapter(): FrontendApi {
  const demoFlag = true;
  return {
    capabilities: { mode: 'demo' },
    mail: {
      listThreads: async (input) => {
        const res = listDemoThreads(input);
        return {
          threads: res.threads as MailThreadListItem[],
          nextPageToken: res.nextPageToken ?? undefined,
        };
      },
      getThread: async (input) => getDemoThread((input as { id: string }).id) as never,
      send: (input) => demoSendEmail(input as never),
      unsend: (input) => demoUnsendEmail(input as { messageId: string }),
      deleteThread: (input) => demoBulkDeleteThreads({ ids: (input as { ids: string[] }).ids }),
      bulkDelete: (input) => demoBulkDeleteThreads({ ids: (input as { ids: string[] }).ids }),
      archive: (input) =>
        demoMoveThreadsTo({
          threadIds: (input as { ids: string[] }).ids,
          currentFolder: 'inbox',
          destination: 'archive',
        }),
      markAsRead: (input) => demoMarkAsRead((input as { ids: string[] }).ids),
      markAsUnread: (input) => demoMarkAsUnread((input as { ids: string[] }).ids),
      toggleStar: (input) => demoToggleStar((input as { ids: string[] }).ids),
      toggleImportant: (input) => demoToggleImportant((input as { ids: string[] }).ids),
      modifyLabels: (input) =>
        demoModifyLabels({
          threadId: (input as { threadId: string[] }).threadId,
          addLabels: (input as { addLabels: string[] }).addLabels,
          removeLabels: (input as { removeLabels: string[] }).removeLabels,
        }),
      snoozeThreads: (input) =>
        demoSnoozeThreads({
          ids: (input as { ids: string[] }).ids,
          wakeAt: (input as { wakeAt: string }).wakeAt,
        }),
      unsnoozeThreads: (input) => demoUnsnoozeThreads({ ids: (input as { ids: string[] }).ids }),
      getMessageAttachments: async () => [],
      processEmailContent: async (input) => input,
      suggestRecipients: async (input) => {
        const q = (input.query ?? '').toLowerCase();
        if (!q) return [];
        return [
          { email: 'concierge@centurion.demo', name: 'Concierge' },
          { email: 'vip@centurion.demo', name: 'VIP Desk' },
        ].filter((r) => r.email.includes(q) || (r.name ?? '').toLowerCase().includes(q));
      },
      verifyEmail: async () => ({ valid: true }),
      forceSync: async () => ({ success: true }),
    },
    drafts: {
      get: async (input) => getDemoDraft((input as { id: string }).id) ?? null,
      list: async () => ({ drafts: listDemoDrafts() }),
      create: (input) => demoUpsertDraft(input as never),
      delete: (input) => demoDeleteDraft((input as { id: string }).id),
    },
    labels: {
      list: async () => listDemoLabels() as never,
      create: (input) => demoCreateLabel(input as never),
      update: (input) => upsertDemoLabel(input as never),
      delete: (input) => demoDeleteLabel((input as { id: string }).id),
    },
    settings: {
      get: async () => (await demoGetSettings(0)) as MailSettings,
      save: (input) => demoSetSettings(input as Partial<MailSettings>),
    },
    connections: {
      list: async () => [DEMO_CONNECTION],
      getDefault: async () => DEMO_CONNECTION,
      setDefault: async () => undefined,
      delete: async () => undefined,
    },
    notes: {
      list: async (input) => ({
        notes: listDemoNotes().filter((n) => n.threadId === (input as { threadId: string }).threadId),
      }),
      create: (input) => demoUpsertNote(input as never),
      update: (input) =>
        demoUpdateNote((input as { noteId: string }).noteId, (input as { data: Record<string, unknown> }).data),
      delete: (input) => demoDeleteNote((input as { noteId: string }).noteId),
      reorder: (input) =>
        demoReorderNotes((input as { notes: Array<{ id: string; order: number; isPinned?: boolean | null }> }).notes),
    },
    templates: {
      list: async () => ({ templates: await demoListTemplates(0) }),
      create: (input) => demoUpsertTemplate(input as never),
      delete: async (input) => {
        deleteDemoTemplate((input as { id: string }).id);
        return { success: true };
      },
    },
    ai: {
      generateSearchQuery: (input) =>
        demoGenerateSearchQuery({ ...(input as { query: string }), isFrontendOnlyDemoMode: demoFlag }),
      compose: (input) => demoAiCompose(input as { prompt: string }),
      generateEmailSubject: (input) => demoGenerateEmailSubject(input as { message: string }),
      webSearch: (input) =>
        demoWebSearch({ ...(input as { query: string }), isFrontendOnlyDemoMode: demoFlag }),
      generateSummary: (input) =>
        demoGenerateSummary({
          threadId: (input as { threadId: string }).threadId,
          isFrontendOnlyDemoMode: demoFlag,
        }),
      getBrainState: async () => ({ enabled: true }),
      getPrompts: async () => ({
        [AiPromptTypeEnum.SummarizeMessage]: SummarizeMessage,
        [AiPromptTypeEnum.SummarizeThread]: SummarizeThread,
        [AiPromptTypeEnum.ReSummarizeThread]: ReSummarizeThread,
        [AiPromptTypeEnum.Chat]: AiChatPrompt(),
        [AiPromptTypeEnum.Compose]: StyledEmailAssistantSystemPrompt(),
      }),
      updatePrompt: async () => ({ success: true }),
      executeTool: async () => {
        throw new UnsupportedFeatureError('ai.executeTool', 'demo');
      },
    },
    assets: {
      getBimiByEmail: async () => ({ found: false }),
    },
    user: {
      delete: async () => ({ success: true }),
      getIntercomToken: async () => null,
    },
  };
}
