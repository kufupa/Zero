import type { AppRouter } from '@zero/server/trpc';
import type { FrontendApi } from '../contract';
import { callServerTool } from '../../server-tool';
import type { MailSettings } from '../types';

export function createLegacyTrpcAdapter(client: AppRouter): FrontendApi {
  return {
    capabilities: { mode: 'legacy' },
    mail: {
      listThreads: (input) => client.mail.listThreads.query(input),
      getThread: (input) => client.mail.get.query(input as { id: string }),
      send: (input) => client.mail.send.mutate(input),
      unsend: (input) => client.mail.unsend.mutate(input),
      deleteThread: (input) => client.mail.delete.mutate(input),
      bulkDelete: (input) => client.mail.bulkDelete.mutate(input),
      archive: (input) => client.mail.bulkArchive.mutate(input),
      markAsRead: (input) => client.mail.markAsRead.mutate(input),
      markAsUnread: (input) => client.mail.markAsUnread.mutate(input),
      toggleStar: (input) => client.mail.toggleStar.mutate(input),
      toggleImportant: (input) => client.mail.toggleImportant.mutate(input),
      modifyLabels: (input) => client.mail.modifyLabels.mutate(input),
      snoozeThreads: (input) => client.mail.snoozeThreads.mutate(input),
      unsnoozeThreads: (input) => client.mail.unsnoozeThreads.mutate(input),
      getMessageAttachments: (input) => client.mail.getMessageAttachments.query(input),
      processEmailContent: (input) => client.mail.processEmailContent.mutate(input),
      suggestRecipients: (input) => client.mail.suggestRecipients.query(input),
      verifyEmail: (input) => client.mail.verifyEmail.query(input),
      forceSync: () => client.mail.forceSync.mutate(),
    },
    drafts: {
      get: (input) => client.drafts.get.query(input as { id: string }),
      list: (input) => client.drafts.list.query(input ?? {}),
      create: (input) => client.drafts.create.mutate(input),
      delete: (input) => client.drafts.delete.mutate(input),
    },
    labels: {
      list: () => client.labels.list.query(),
      create: (input) => client.labels.create.mutate(input),
      update: (input) => client.labels.update.mutate(input),
      delete: (input) => client.labels.delete.mutate(input),
    },
    settings: {
      get: async () => (await client.settings.get.query()).settings as MailSettings,
      save: (input) => client.settings.save.mutate(input as Partial<MailSettings>),
    },
    connections: {
      list: async () => (await client.connections.list.query()).connections,
      getDefault: () => client.connections.getDefault.query(),
      setDefault: (input) =>
        client.connections.setDefault.mutate(input as { connectionId: string }),
      delete: (input) => client.connections.delete.mutate(input as { connectionId: string }),
    },
    notes: {
      list: (input) => client.notes.list.query(input as { threadId: string }),
      create: (input) => client.notes.create.mutate(input),
      update: (input) => client.notes.update.mutate(input),
      delete: (input) => client.notes.delete.mutate(input),
      reorder: (input) => client.notes.reorder.mutate(input),
    },
    templates: {
      list: () => client.templates.list.query(),
      create: (input) => client.templates.create.mutate(input),
      delete: (input) => client.templates.delete.mutate(input),
    },
    ai: {
      generateSearchQuery: (input) => client.ai.generateSearchQuery.mutate(input),
      compose: (input) => client.ai.compose.mutate(input),
      generateEmailSubject: (input) => client.ai.generateEmailSubject.mutate(input),
      webSearch: (input) => client.ai.webSearch.mutate(input),
      generateSummary: (input) => client.brain.generateSummary.query(input as { threadId: string }),
      getBrainState: () => client.brain.getState.query(),
      getPrompts: () => client.brain.getPrompts.query(),
      updatePrompt: (input) =>
        client.brain.updatePrompt.mutate({
          promptType: input.promptType as never,
          content: input.prompt,
        }),
      executeTool: ({ action, payload, caller }) => callServerTool(action, payload, caller),
    },
    assets: {
      getBimiByEmail: (input) => client.bimi.getByEmail.query(input),
    },
    user: {
      delete: () => client.user.delete.mutate(),
      getIntercomToken: () => client.user.getIntercomToken.query(),
    },
  };
}
