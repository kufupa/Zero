import {
  DEMO_ACTION_DELAY_MS,
  getDemoStore,
  getDemoSettings,
  getDemoDraft,
  getDemoNote,
  getDemoTemplate,
  listDemoDrafts,
  listDemoNotes,
  listDemoTemplates,
  deleteDemoDraft,
  deleteDemoNote,
  deleteDemoTemplate,
  deleteDemoLabel,
  reorderDemoNotes,
  setDemoSettings,
  upsertDemoDraft,
  upsertDemoNote,
  upsertDemoLabel,
  upsertDemoTemplate,
  type DemoDraft,
  type DemoNote,
  type DemoLabel,
  type DemoSettings,
  type DemoStore,
  type DemoTemplate,
} from './local-store';
import { isFrontendOnlyDemo } from './runtime';

export function demoAsync<T>(value: T, delayMs = DEMO_ACTION_DELAY_MS): Promise<T> {
  if (typeof setTimeout !== 'function') {
    return Promise.resolve(value);
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, delayMs);
  });
}

function runDemoAction<T>(
  action: () => T,
  fallback: () => T,
  delayMs = DEMO_ACTION_DELAY_MS,
  isFrontendOnlyDemoMode?: boolean,
): Promise<T> {
  const shouldUseDemoAction = isFrontendOnlyDemoMode ?? isFrontendOnlyDemo();
  if (!shouldUseDemoAction) {
    return demoAsync(fallback(), delayMs);
  }
  return demoAsync(action(), delayMs);
}

function normalizeDemoQuery(query: string): string {
  return query.trim() || 'query';
}

export function demoGetStore(delayMs = DEMO_ACTION_DELAY_MS): Promise<DemoStore> {
  return runDemoAction(
    getDemoStore,
    () => createNoopDemoStore(),
    delayMs,
  );
}

export function demoGetDraft(id: string, delayMs = DEMO_ACTION_DELAY_MS): Promise<ReturnType<typeof getDemoDraft>> {
  return runDemoAction(
    () => getDemoDraft(id),
    () => undefined,
    delayMs,
  );
}

export function demoListDrafts(delayMs = DEMO_ACTION_DELAY_MS): Promise<DemoDraft[]> {
  return runDemoAction(listDemoDrafts, () => [], delayMs);
}

export function demoUpsertDraft(input: Parameters<typeof upsertDemoDraft>[0], delayMs = DEMO_ACTION_DELAY_MS) {
  return runDemoAction(
    () => upsertDemoDraft(input),
    () => createNoopDemoDraft(input),
    delayMs,
  );
}

export function demoDeleteDraft(id: string, delayMs = DEMO_ACTION_DELAY_MS): Promise<{ success: boolean }> {
  return runDemoAction(
    () => ({
      success: deleteDemoDraft(id),
    }),
    () => ({ success: false }),
    delayMs,
  );
}

export function demoGetTemplate(id: string, delayMs = DEMO_ACTION_DELAY_MS): Promise<ReturnType<typeof getDemoTemplate>> {
  return runDemoAction(
    () => getDemoTemplate(id),
    () => undefined,
    delayMs,
  );
}

export function demoListTemplates(delayMs = DEMO_ACTION_DELAY_MS): Promise<DemoTemplate[]> {
  return runDemoAction(listDemoTemplates, () => [], delayMs);
}

export function demoUpsertTemplate(
  input: Parameters<typeof upsertDemoTemplate>[0],
  delayMs = DEMO_ACTION_DELAY_MS,
) {
  return runDemoAction(
    () => upsertDemoTemplate(input),
    () => createNoopDemoTemplate(input),
    delayMs,
  );
}

export function demoDeleteTemplate(id: string, delayMs = DEMO_ACTION_DELAY_MS): Promise<{ success: boolean }> {
  return runDemoAction(
    () => ({
      success: deleteDemoTemplate(id),
    }),
    () => ({ success: false }),
    delayMs,
  );
}

export function demoGenerateSearchQuery(
  input: { query: string; isFrontendOnlyDemoMode: boolean },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ query: string }> {
  const query = normalizeDemoQuery(input.query);
  return runDemoAction(
    () => ({
      query: `${query} (demo)`,
    }),
    () => ({
      query: `${query} (demo)`,
    }),
    delayMs,
    input.isFrontendOnlyDemoMode,
  );
}

export function demoWebSearch(
  input: { query: string; isFrontendOnlyDemoMode: boolean },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ text: string; sources: Array<{ id: string; title: string; url: string }> }> {
  const queryText = normalizeDemoQuery(input.query);
  return runDemoAction(
    () => ({
      text: `Demo web search results for: ${queryText}`,
      sources: [],
    }),
    () => ({
      text: `Demo web search results for: ${queryText}`,
      sources: [],
    }),
    delayMs,
    input.isFrontendOnlyDemoMode,
  );
}

export function demoGenerateSummary(
  input: { threadId: string; isFrontendOnlyDemoMode: boolean },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ data: { short: string; long: string } }> {
  const threadId = normalizeDemoQuery(input.threadId);
  return runDemoAction(
    () => ({
      data: {
        short: `Demo summary for thread ${threadId}.`,
        long: `Demo summary for thread ${threadId} without backend data.`,
      },
    }),
    () => ({
      data: {
        short: `Demo summary for thread ${threadId}.`,
        long: `Demo summary for thread ${threadId} without backend data.`,
      },
    }),
    delayMs,
    input.isFrontendOnlyDemoMode,
  );
}

export function demoCreateLabel(
  input: Parameters<typeof upsertDemoLabel>[0],
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<DemoLabel> {
  return runDemoAction(
    () => upsertDemoLabel(input),
    () => ({ id: input.id || 'demo-label', name: input.name || 'New Label', type: 'user' }),
    delayMs,
  );
}

export function demoDeleteLabel(id: string, delayMs = DEMO_ACTION_DELAY_MS): Promise<{ success: boolean }> {
  return runDemoAction(
    () => ({
      success: deleteDemoLabel(id),
    }),
    () => ({ success: false }),
    delayMs,
  );
}

export function demoGetNote(id: string, delayMs = DEMO_ACTION_DELAY_MS): Promise<ReturnType<typeof getDemoNote>> {
  return runDemoAction(() => getDemoNote(id), () => undefined, delayMs);
}

export function demoListNotes(delayMs = DEMO_ACTION_DELAY_MS): Promise<DemoNote[]> {
  return runDemoAction(listDemoNotes, () => [], delayMs);
}

export function demoUpsertNote(input: Parameters<typeof upsertDemoNote>[0], delayMs = DEMO_ACTION_DELAY_MS) {
  return runDemoAction(
    () => upsertDemoNote(input),
    () => createNoopDemoNote(input),
    delayMs,
  );
}

export function demoUpdateNote(
  noteId: string,
  data: Partial<DemoNote>,
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ note?: DemoNote }> {
  return runDemoAction(
    () => {
      const updated = upsertDemoNote({
        id: noteId,
        threadId: data.threadId,
        content: data.content,
        color: data.color,
        isPinned: data.isPinned,
        order: data.order,
      });
      return { note: updated };
    },
    () => ({ note: undefined }),
    delayMs,
  );
}

export function demoDeleteNote(noteId: string, delayMs = DEMO_ACTION_DELAY_MS): Promise<{ success: boolean }> {
  return runDemoAction(
    () => ({
      success: deleteDemoNote(noteId),
    }),
    () => ({ success: false }),
    delayMs,
  );
}

export function demoReorderNotes(
  input: Array<Pick<DemoNote, 'id' | 'order' | 'isPinned'>>,
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ success: boolean; notes: DemoNote[] }> {
  return runDemoAction(
    () => ({
      success: true,
      notes: reorderDemoNotes(input),
    }),
    () => ({ success: false, notes: [] }),
    delayMs,
  );
}

export function demoSendEmail(
  input: {
    scheduleAt?: string;
    [key: string]: unknown;
  },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ success: true } | { queued: true; messageId: string; sendAt: number }> {
  return runDemoAction(
    () => {
      if (!input.scheduleAt) {
        return { success: true } as const;
      }
      const parsed = Date.parse(input.scheduleAt);
      const sendAt = Number.isFinite(parsed) ? parsed : Date.now() + 15_000;
      const messageId = generateDemoMessageId();
      return { queued: true as const, messageId, sendAt };
    },
    () => ({ success: true } as const),
    delayMs,
  );
}

export function demoUnsendEmail(
  _input: { messageId: string },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ success: boolean }> {
  return runDemoAction(
    () => ({ success: true }),
    () => ({ success: false }),
    delayMs,
  );
}

export function demoAiCompose(
  input: { prompt: string; [key: string]: unknown },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ newBody: string }> {
  return runDemoAction(
    () => ({
      newBody: `Draft from AI:\n\n${input.prompt || 'Your draft is ready.'}`,
    }),
    () => ({ newBody: '' }),
    delayMs,
  );
}

export function demoGenerateEmailSubject(
  input: { message: string },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ subject: string }> {
  return runDemoAction(
    () => ({
      subject: input.message ? input.message.slice(0, 64).trim() : 'New Message',
    }),
    () => ({ subject: 'New Message' }),
    delayMs,
  );
}

export function demoMarkAsRead(ids: string[], delayMs = DEMO_ACTION_DELAY_MS): Promise<{ ids: string[] }> {
  return runDemoAction(
    () => ({ ids }),
    () => ({ ids }),
    delayMs,
  );
}

export function demoMarkAsUnread(ids: string[], delayMs = DEMO_ACTION_DELAY_MS): Promise<{ ids: string[] }> {
  return runDemoAction(
    () => ({ ids }),
    () => ({ ids }),
    delayMs,
  );
}

export function demoToggleStar(ids: string[], delayMs = DEMO_ACTION_DELAY_MS): Promise<{ ids: string[] }> {
  return runDemoAction(
    () => ({ ids }),
    () => ({ ids }),
    delayMs,
  );
}

export function demoToggleImportant(ids: string[], delayMs = DEMO_ACTION_DELAY_MS): Promise<{ ids: string[] }> {
  return runDemoAction(
    () => ({ ids }),
    () => ({ ids }),
    delayMs,
  );
}

export function demoModifyLabels(
  payload: { threadId: string[]; addLabels: string[]; removeLabels: string[] },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ threadId: string[]; addLabels: string[]; removeLabels: string[] }> {
  return runDemoAction(
    () => payload,
    () => payload,
    delayMs,
  );
}

export function demoSnoozeThreads(
  payload: { ids: string[]; wakeAt: string },
  delayMs = DEMO_ACTION_DELAY_MS,
): Promise<{ ids: string[]; wakeAt: string }> {
  return runDemoAction(
    () => payload,
    () => payload,
    delayMs,
  );
}

export function demoUnsnoozeThreads(payload: { ids: string[] }, delayMs = DEMO_ACTION_DELAY_MS): Promise<{ ids: string[] }> {
  return runDemoAction(
    () => payload,
    () => payload,
    delayMs,
  );
}

export function demoMoveThreadsTo(payload: {
  threadIds: string[];
  currentFolder: string;
  destination: string;
}, delayMs = DEMO_ACTION_DELAY_MS): Promise<{ threadIds: string[]; currentFolder: string; destination: string }> {
  return runDemoAction(
    () => payload,
    () => payload,
    delayMs,
  );
}

export function demoBulkDeleteThreads(payload: { ids: string[] }, delayMs = DEMO_ACTION_DELAY_MS): Promise<{ ids: string[] }> {
  return runDemoAction(
    () => payload,
    () => payload,
    delayMs,
  );
}

export function demoGetSettings(delayMs = DEMO_ACTION_DELAY_MS): Promise<DemoSettings> {
  return runDemoAction(
    getDemoSettings,
    () => createNoopDemoSettings(),
    delayMs,
  );
}

export function demoSetSettings(nextSettings: Partial<DemoSettings>, delayMs = DEMO_ACTION_DELAY_MS): Promise<DemoSettings> {
  return runDemoAction(
    () => setDemoSettings(nextSettings),
    () => createNoopDemoSettings(nextSettings),
    delayMs,
  );
}

export function getDemoAsyncDelayMs(): number {
  return DEMO_ACTION_DELAY_MS;
}

function createNoopDemoStore(): DemoStore {
  return {
    drafts: {},
    notes: {},
    templates: {},
    labels: {},
    settings: createNoopDemoSettings(),
  };
}

function createNoopDemoDraft(input: Parameters<typeof upsertDemoDraft>[0]): DemoDraft {
  const now = nowIso();
  return {
    id: input.id ?? 'demo-draft',
    userId: input.userId?.trim() || 'demo-user',
    threadId: (input.threadId ?? '').trim(),
    subject: (input.subject ?? '').trim(),
    body: (input.body ?? '').trim(),
    to: (input.to ?? '').trim(),
    cc: (input.cc ?? '').trim(),
    bcc: (input.bcc ?? '').trim(),
    createdAt: now,
    updatedAt: now,
  };
}

function createNoopDemoTemplate(input: Parameters<typeof upsertDemoTemplate>[0]): DemoTemplate {
  const now = nowIso();
  return {
    id: input.id ?? 'demo-template',
    userId: input.userId?.trim() || 'demo-user',
    name: (input.name ?? '').trim(),
    subject: input.subject ?? null,
    body: input.body ?? null,
    to: input.to == null ? null : [...input.to],
    cc: input.cc == null ? null : [...input.cc],
    bcc: input.bcc == null ? null : [...input.bcc],
    createdAt: now,
    updatedAt: now,
  };
}

function createNoopDemoNote(input: Parameters<typeof upsertDemoNote>[0]): DemoNote {
  const now = nowIso();
  return {
    id: input.id ?? 'demo-note',
    userId: input.userId?.trim() || 'demo-user',
    threadId: (input.threadId ?? '').trim(),
    content: (input.content ?? '').trim(),
    color: (input.color ?? 'default').trim(),
    isPinned: input.isPinned ?? false,
    order: input.order ?? 0,
    createdAt: now,
    updatedAt: now,
  };
}

function generateDemoMessageId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `demo-message-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createNoopDemoSettings(overrides: Partial<DemoSettings> = {}): DemoSettings {
  return {
    language: 'en',
    timezone: 'UTC',
    dynamicContent: false,
    externalImages: true,
    customPrompt: '',
    isOnboarded: false,
    trustedSenders: [],
    colorTheme: 'system',
    zeroSignature: false,
    categories: [],
    defaultEmailAlias: 'centurion@legacyhotels.co.za',
    undoSendEnabled: true,
    imageCompression: 'medium',
    autoRead: true,
    animations: false,
    ...overrides,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
