import { isFrontendOnlyDemo } from './runtime';
import { listDemoLabels as listDemoLabelsSeed } from '../demo-data/client';
import { isRemovedDemoLabel } from '../demo-data/label-filter';

export type DemoDraft = {
  id: string;
  userId: string;
  threadId: string;
  subject: string;
  body: string;
  to: string;
  cc: string;
  bcc: string;
  createdAt: string;
  updatedAt: string;
};

export type DemoDraftInput = Partial<
  Pick<DemoDraft, 'threadId' | 'subject' | 'body' | 'to' | 'cc' | 'bcc'>
> & { id?: string; userId?: string };

export type DemoTemplate = {
  id: string;
  userId: string;
  name: string;
  subject: string | null;
  body: string | null;
  to: string[] | null;
  cc: string[] | null;
  bcc: string[] | null;
  createdAt: string;
  updatedAt: string;
};

export type DemoTemplateInput = Partial<
  Omit<DemoTemplate, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
> & { id?: string; userId?: string };

export type DemoNote = {
  id: string;
  userId: string;
  threadId: string;
  content: string;
  color: string;
  isPinned: boolean | null;
  order: number;
  createdAt: string;
  updatedAt: string;
};

export type DemoNoteInput = Partial<
  Pick<DemoNote, 'threadId' | 'content' | 'color' | 'isPinned' | 'order'>
> & { id?: string; userId?: string };

export type DemoLabel = {
  id: string;
  name: string;
  type: 'user' | 'system';
  createdAt?: string;
  updatedAt?: string;
  color?: {
    backgroundColor: string;
    textColor: string;
  };
};

export type DemoLabelInput = Partial<Pick<DemoLabel, 'name' | 'type' | 'color'>> & {
  id?: string;
};

export type DemoSettings = {
  language: string;
  timezone: string;
  dynamicContent: boolean;
  externalImages: boolean;
  customPrompt: string;
  isOnboarded: boolean;
  trustedSenders: string[];
  colorTheme: 'light' | 'dark' | 'system';
  zeroSignature: boolean;
  categories: string[];
  defaultEmailAlias: string;
  undoSendEnabled: boolean;
  imageCompression: 'low' | 'medium' | 'original';
  autoRead: boolean;
  animations: boolean;
};

export type DemoStore = {
  drafts: Record<string, DemoDraft>;
  notes: Record<string, DemoNote>;
  templates: Record<string, DemoTemplate>;
  labels: Record<string, DemoLabel>;
  settings: DemoSettings;
  /** Demo thread draft message ids removed by user (tombstone); hides matching `isDraft` rows in getDemoThread. */
  deletedDraftIds: string[];
};

const DEMO_USER_ID = 'demo-user';
const DEMO_LOCAL_STORE_KEY = 'zero-mail-demo-local-store-v1';
export const DEMO_ACTION_DELAY_MS = 12;
const DEFAULT_SETTINGS: DemoSettings = {
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
};

const SEED_DRAFTS: DemoDraft[] = [
  {
    id: 'sa-002-msg-02',
    userId: DEMO_USER_ID,
    threadId: 'sa-thread-002',
    subject: 'RE: Kleinkaap Overflow Rooms 23 April',
    body: 'Dear Riani,\n\nThank you for your enquiry. Please find our rates for 20 single rooms B&B for 23–24 April below.\n\nKind regards,\nReservations',
    to: 'info@kleinkaap.co.za',
    cc: '',
    bcc: '',
    createdAt: '2026-04-11T10:00:00.000Z',
    updatedAt: '2026-04-11T10:00:00.000Z',
  },
  {
    id: 'sa-006-msg-02',
    userId: DEMO_USER_ID,
    threadId: 'sa-thread-006',
    subject: 'RE: Request for a quotation',
    body: 'Good day,\n\nPlease see the quote for DBB government rate, 17–22 May 2026, attached in the system.\n\nRegards,\nReservations',
    to: 'nmorake@vuselelacollege.co.za',
    cc: '',
    bcc: '',
    createdAt: '2026-04-07T14:00:00.000Z',
    updatedAt: '2026-04-07T14:00:00.000Z',
  },
];

const SEED_TEMPLATES: DemoTemplate[] = [
  {
    id: 'template-checkin-followup',
    userId: DEMO_USER_ID,
    name: 'Check-in follow-up',
    subject: 'Thanks for the introduction',
    body: 'Thanks for taking a minute to review this thread.',
    to: null,
    cc: null,
    bcc: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'template-standup-update',
    userId: DEMO_USER_ID,
    name: 'Daily standup',
    subject: 'Daily standup update',
    body: "Hi team,\n\nHere is today's update:\n- Completed:\n- In progress:\n- Blockers:",
    to: null,
    cc: null,
    bcc: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
];
const DEMO_LABEL_NAME_DEFAULT = 'Demo Label';
const DEMO_LABEL_BG_DEFAULT = '#202020';
const DEMO_LABEL_TEXT_DEFAULT = '#FFFFFF';

let inMemoryStore: DemoStore = createEmptyDemoStore();

export function isDemo(): boolean {
  return isFrontendOnlyDemo();
}

export function resetDemoStoreForTests(): void {
  inMemoryStore = createEmptyDemoStore();
}

export function getDemoStore(): DemoStore {
  const store = getActiveDemoStore();
  return clone(store);
}

export function upsertDemoDraft(input: DemoDraftInput): DemoDraft {
  const store = getActiveDemoStore();
  const now = nowIso();
  const id = input.id ?? generateDraftId(input);
  const existing = store.drafts[id];
  const draft: DemoDraft = {
    id,
    userId: input.userId?.trim() || DEMO_USER_ID,
    threadId: (input.threadId ?? existing?.threadId ?? '').trim(),
    subject: (input.subject ?? existing?.subject ?? '').trim(),
    body: (input.body ?? existing?.body ?? '').trim(),
    to: (input.to ?? existing?.to ?? '').trim(),
    cc: (input.cc ?? existing?.cc ?? '').trim(),
    bcc: (input.bcc ?? existing?.bcc ?? '').trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.drafts[id] = draft;
  persistDemoStore(store);
  return clone(draft);
}

export function deleteDemoDraft(id: string): boolean {
  const store = getActiveDemoStore();
  if (store.drafts[id]) {
    delete store.drafts[id];
  }
  if (!store.deletedDraftIds.includes(id)) {
    store.deletedDraftIds.push(id);
  }
  persistDemoStore(store);
  return true;
}

export function getDemoDeletedDraftIds(): readonly string[] {
  const store = getActiveDemoStore();
  return [...store.deletedDraftIds];
}

function ensureSeededDemoDrafts(store: DemoStore): void {
  if (!isDemo()) return;
  if (Object.keys(store.drafts).length > 0) return;
  for (const draft of SEED_DRAFTS) {
    store.drafts[draft.id] = clone(draft);
  }
  persistDemoStore(store);
}

export function getDemoDraft(id: string): DemoDraft | undefined {
  const store = getActiveDemoStore();
  ensureSeededDemoDrafts(store);
  return store.drafts[id] ? clone(store.drafts[id] as DemoDraft) : undefined;
}

export function listDemoDrafts(): DemoDraft[] {
  const store = getActiveDemoStore();
  ensureSeededDemoDrafts(store);
  return Object.values(store.drafts).map((draft) => clone(draft));
}

export function upsertDemoTemplate(input: DemoTemplateInput): DemoTemplate {
  const store = getActiveDemoStore();
  const now = nowIso();
  const id = input.id ?? generateTemplateId(input);
  const existing = store.templates[id];
  const template: DemoTemplate = {
    id,
    userId: input.userId?.trim() || DEMO_USER_ID,
    name: (input.name ?? existing?.name ?? '').trim(),
    subject: input.subject ?? existing?.subject ?? null,
    body: input.body ?? existing?.body ?? null,
    to: input.to ?? existing?.to ?? null,
    cc: input.cc ?? existing?.cc ?? null,
    bcc: input.bcc ?? existing?.bcc ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.templates[id] = template;
  persistDemoStore(store);
  return clone(template);
}

export function deleteDemoTemplate(id: string): boolean {
  const store = getActiveDemoStore();
  if (!store.templates[id]) {
    return false;
  }

  delete store.templates[id];
  persistDemoStore(store);
  return true;
}

export function listDemoTemplates(): DemoTemplate[] {
  const store = getActiveDemoStore();
  const templates = Object.values(store.templates);
  if (!templates.length) {
    for (const template of SEED_TEMPLATES) {
      store.templates[template.id] = clone(template);
    }
    persistDemoStore(store);
    return SEED_TEMPLATES.map((template) => clone(template));
  }
  return templates.map((template) => clone(template));
}

export function getDemoTemplate(id: string): DemoTemplate | undefined {
  const store = getActiveDemoStore();
  return store.templates[id] ? clone(store.templates[id] as DemoTemplate) : undefined;
}

export function upsertDemoNote(input: DemoNoteInput): DemoNote {
  const store = getActiveDemoStore();
  const now = nowIso();
  const id = input.id ?? generateNoteId(input);
  const existing = store.notes[id];
  const note: DemoNote = {
    id,
    userId: input.userId?.trim() || DEMO_USER_ID,
    threadId: (input.threadId ?? existing?.threadId ?? '').trim(),
    content: (input.content ?? existing?.content ?? '').trim(),
    color: (input.color ?? existing?.color ?? 'default').trim(),
    isPinned: input.isPinned ?? existing?.isPinned ?? false,
    order: input.order ?? existing?.order ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.notes[id] = note;
  persistDemoStore(store);
  return clone(note);
}

export function deleteDemoNote(id: string): boolean {
  const store = getActiveDemoStore();
  if (!store.notes[id]) {
    return false;
  }

  delete store.notes[id];
  persistDemoStore(store);
  return true;
}

export function reorderDemoNotes(
  input: Array<Pick<DemoNote, 'id' | 'order' | 'isPinned'>>,
): DemoNote[] {
  const store = getActiveDemoStore();
  const now = nowIso();

  const reorderedNotes: DemoNote[] = [];
  for (const item of input) {
    const note = store.notes[item.id];
    if (!note) continue;

    store.notes[item.id] = {
      ...note,
      order: item.order ?? note.order,
      isPinned: item.isPinned ?? note.isPinned,
      updatedAt: now,
    };
    reorderedNotes.push(clone(store.notes[item.id]));
  }

  persistDemoStore(store);
  return reorderedNotes;
}

export function listDemoLabels(): DemoLabel[] {
  const store = getActiveDemoStore();
  return Object.values(store.labels).map((label) => clone(label));
}

export function upsertDemoLabel(input: DemoLabelInput): DemoLabel {
  const store = getActiveDemoStore();
  const now = nowIso();
  const id = input.id ?? generateLabelId(input);
  const existing = store.labels[id];
  const label: DemoLabel = {
    id,
    name: (input.name ?? existing?.name ?? DEMO_LABEL_NAME_DEFAULT).trim(),
    type: input.type === 'system' ? 'system' : 'user',
    color: normalizeDemoLabelColor(input.color ?? existing?.color),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.labels[id] = {
    ...label,
  };
  persistDemoStore(store);
  return clone(label);
}

export function deleteDemoLabel(id: string): boolean {
  const store = getActiveDemoStore();
  if (!store.labels[id]) {
    return false;
  }

  delete store.labels[id];
  persistDemoStore(store);
  return true;
}

export function listDemoNotes(): DemoNote[] {
  const store = getActiveDemoStore();
  return Object.values(store.notes).map((note) => clone(note));
}

export function getDemoNote(id: string): DemoNote | undefined {
  const store = getActiveDemoStore();
  return store.notes[id] ? clone(store.notes[id] as DemoNote) : undefined;
}

export function getDemoSettings(): DemoSettings {
  const store = getActiveDemoStore();
  return clone(store.settings);
};

export function setDemoSettings(nextSettings: Partial<DemoSettings>): DemoSettings {
  const store = getActiveDemoStore();
  store.settings = {
    ...store.settings,
    ...nextSettings,
    categories: nextSettings.categories ?? store.settings.categories,
    trustedSenders: nextSettings.trustedSenders ?? store.settings.trustedSenders,
  };
  persistDemoStore(store);
  return clone(store.settings);
}

export function getDemoAsyncDelayMs(): number {
  return DEMO_ACTION_DELAY_MS;
}

function getActiveDemoStore(): DemoStore {
  if (!isDemo()) {
    return inMemoryStore;
  }
  return loadDemoStore();
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyDemoStore(): DemoStore {
  return {
    drafts: {},
    notes: {},
    templates: {},
    labels: seedLabels(),
    settings: clone(DEFAULT_SETTINGS),
    deletedDraftIds: [],
  };
}

function clone<T>(value: T): T {
  const structuredCloneFn = (globalThis as { structuredClone?: (value: T) => T }).structuredClone;
  if (typeof structuredCloneFn === 'function') {
    return structuredCloneFn(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadDemoStore(): DemoStore {
  if (!isDemo() || !hasDemoStorage()) {
    return inMemoryStore;
  }

  const storedValue = readDemoStore();
  if (!storedValue) {
    inMemoryStore = createEmptyDemoStore();
    return inMemoryStore;
  }

  inMemoryStore = {
    drafts: storedValue.drafts ?? {},
    notes: storedValue.notes ?? {},
    templates: storedValue.templates ?? {},
    labels: sanitizeLabels(storedValue.labels),
    settings: {
      ...DEFAULT_SETTINGS,
      ...storedValue.settings,
      categories: storedValue.settings?.categories ?? DEFAULT_SETTINGS.categories,
      trustedSenders: storedValue.settings?.trustedSenders ?? DEFAULT_SETTINGS.trustedSenders,
    },
    deletedDraftIds: Array.isArray(storedValue.deletedDraftIds)
      ? storedValue.deletedDraftIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [],
  };
  return inMemoryStore;
}

function readDemoStore(): DemoStore | null {
  if (!hasDemoStorage()) return null;
  const raw = localStorage.getItem(DEMO_LOCAL_STORE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return sanitizeStore(parsed as Partial<DemoStore>);
  } catch {
    return null;
  }
}

function sanitizeStore(raw: Partial<DemoStore>): DemoStore {
  return {
    drafts: sanitizeDrafts(raw.drafts),
    notes: sanitizeNotes(raw.notes),
    templates: sanitizeTemplates(raw.templates),
    labels: sanitizeLabels(raw.labels),
    settings: {
      ...DEFAULT_SETTINGS,
      ...raw.settings,
      categories: raw.settings?.categories ?? DEFAULT_SETTINGS.categories,
      trustedSenders: raw.settings?.trustedSenders ?? DEFAULT_SETTINGS.trustedSenders,
    },
    deletedDraftIds: Array.isArray(raw.deletedDraftIds)
      ? raw.deletedDraftIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
      : [],
  };
}

function seedLabels(): Record<string, DemoLabel> {
  const labels: Record<string, DemoLabel> = {};
  for (const label of listDemoLabelsSeed()) {
    const id = typeof label.id === 'string' && label.id.length > 0 ? label.id : `label-${hashSeed(label.name ?? 'label')}`;
    labels[id] = {
      id,
      name: typeof label.name === 'string' && label.name.length > 0 ? label.name : DEMO_LABEL_NAME_DEFAULT,
      type: label.type === 'system' ? 'system' : 'user',
      color: normalizeDemoLabelColor({
        backgroundColor:
          typeof (label as { color?: { backgroundColor?: string } }).color?.backgroundColor === 'string'
            ? ((label as { color?: { backgroundColor?: string } }).color?.backgroundColor as string)
            : DEMO_LABEL_BG_DEFAULT,
        textColor:
          typeof (label as { color?: { textColor?: string } }).color?.textColor === 'string'
            ? ((label as { color?: { textColor?: string } }).color?.textColor as string)
            : DEMO_LABEL_TEXT_DEFAULT,
      }),
    };
  }
  return labels;
}

function sanitizeLabels(rawLabels: Partial<Record<string, DemoLabel>> | undefined): Record<string, DemoLabel> {
  if (!isRecord(rawLabels) || Object.keys(rawLabels).length === 0) {
    return seedLabels();
  }

  const labels: Record<string, DemoLabel> = {};
  for (const [id, label] of Object.entries(rawLabels)) {
    if (!isRecord(label)) continue;
    const maybeId = typeof label.id === 'string' && label.id.length > 0 ? label.id : id;
    if (!maybeId) continue;

    const name = typeof label.name === 'string' && label.name.length > 0 ? label.name : DEMO_LABEL_NAME_DEFAULT;
    if (isRemovedDemoLabel({ id: maybeId, name })) continue;

    const rawColor = isRecord(label.color) ? label.color : undefined;
    labels[maybeId] = {
      id: maybeId,
      name,
      type: label.type === 'system' ? 'system' : 'user',
      color: normalizeDemoLabelColor({
        backgroundColor:
          typeof rawColor?.backgroundColor === 'string' ? (rawColor.backgroundColor as string) : DEMO_LABEL_BG_DEFAULT,
        textColor: typeof rawColor?.textColor === 'string' ? (rawColor.textColor as string) : DEMO_LABEL_TEXT_DEFAULT,
      }),
      createdAt: typeof label.createdAt === 'string' ? label.createdAt : nowIso(),
      updatedAt: typeof label.updatedAt === 'string' ? label.updatedAt : nowIso(),
    };
  }

  if (!Object.keys(labels).length) {
    return seedLabels();
  }
  return labels;
}

function normalizeDemoLabelColor(
  input?: DemoLabel['color'],
): {
  backgroundColor: string;
  textColor: string;
} {
  return {
    backgroundColor: typeof input?.backgroundColor === 'string' ? input.backgroundColor : DEMO_LABEL_BG_DEFAULT,
    textColor: typeof input?.textColor === 'string' ? input.textColor : DEMO_LABEL_TEXT_DEFAULT,
  };
}

function sanitizeDrafts(rawDrafts: Partial<Record<string, DemoDraft>> | undefined): Record<string, DemoDraft> {
  if (!isRecord(rawDrafts)) return {};
  const drafts: Record<string, DemoDraft> = {};
  for (const [id, draft] of Object.entries(rawDrafts)) {
    if (!isRecord(draft)) continue;
    const maybeId = typeof draft.id === 'string' && draft.id.length > 0 ? draft.id : id;
    if (!maybeId) continue;
    drafts[maybeId] = {
      id: maybeId,
      userId: typeof draft.userId === 'string' ? draft.userId : DEMO_USER_ID,
      threadId: typeof draft.threadId === 'string' ? draft.threadId : '',
      subject: typeof draft.subject === 'string' ? draft.subject : '',
      body: typeof draft.body === 'string' ? draft.body : '',
      to: typeof draft.to === 'string' ? draft.to : '',
      cc: typeof draft.cc === 'string' ? draft.cc : '',
      bcc: typeof draft.bcc === 'string' ? draft.bcc : '',
      createdAt: typeof draft.createdAt === 'string' ? draft.createdAt : nowIso(),
      updatedAt: typeof draft.updatedAt === 'string' ? draft.updatedAt : nowIso(),
    };
  }
  return drafts;
}

function sanitizeNotes(rawNotes: Partial<Record<string, DemoNote>> | undefined): Record<string, DemoNote> {
  if (!isRecord(rawNotes)) return {};
  const notes: Record<string, DemoNote> = {};
  for (const [id, note] of Object.entries(rawNotes)) {
    if (!isRecord(note)) continue;
    const maybeId = typeof note.id === 'string' && note.id.length > 0 ? note.id : id;
    if (!maybeId) continue;
    notes[maybeId] = {
      id: maybeId,
      userId: typeof note.userId === 'string' ? note.userId : DEMO_USER_ID,
      threadId: typeof note.threadId === 'string' ? note.threadId : '',
      content: typeof note.content === 'string' ? note.content : '',
      color: typeof note.color === 'string' ? note.color : 'default',
      isPinned: typeof note.isPinned === 'boolean' ? note.isPinned : false,
      order: typeof note.order === 'number' ? note.order : 0,
      createdAt: typeof note.createdAt === 'string' ? note.createdAt : nowIso(),
      updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : nowIso(),
    };
  }
  return notes;
}

function sanitizeTemplates(
  rawTemplates: Partial<Record<string, DemoTemplate>> | undefined,
): Record<string, DemoTemplate> {
  if (!isRecord(rawTemplates)) return {};
  const templates: Record<string, DemoTemplate> = {};
  for (const [id, template] of Object.entries(rawTemplates)) {
    if (!isRecord(template)) continue;
    const maybeId = typeof template.id === 'string' && template.id.length > 0 ? template.id : id;
    if (!maybeId) continue;
    templates[maybeId] = {
      id: maybeId,
      userId: typeof template.userId === 'string' ? template.userId : DEMO_USER_ID,
      name: typeof template.name === 'string' ? template.name : '',
      subject: typeof template.subject === 'string' || template.subject === null ? template.subject : null,
      body: typeof template.body === 'string' || template.body === null ? template.body : null,
      to: Array.isArray(template.to) ? template.to : null,
      cc: Array.isArray(template.cc) ? template.cc : null,
      bcc: Array.isArray(template.bcc) ? template.bcc : null,
      createdAt: typeof template.createdAt === 'string' ? template.createdAt : nowIso(),
      updatedAt: typeof template.updatedAt === 'string' ? template.updatedAt : nowIso(),
    };
  }
  return templates;
}

function persistDemoStore(store: DemoStore): void {
  inMemoryStore = clone(store);
  if (!isDemo() || !hasDemoStorage()) return;

  try {
    localStorage.setItem(DEMO_LOCAL_STORE_KEY, JSON.stringify(inMemoryStore));
  } catch (error) {
    console.error('Failed to persist demo store to localStorage', error);
  }
}

function hasDemoStorage(): boolean {
  return typeof localStorage !== 'undefined' && Boolean(localStorage);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function hashSeed(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function generateDraftId(input: DemoDraftInput): string {
  const payload = {
    subject: input.subject ?? '',
    body: input.body ?? '',
    to: input.to ?? '',
    cc: input.cc ?? '',
    bcc: input.bcc ?? '',
    threadId: input.threadId ?? '',
    userId: input.userId ?? DEMO_USER_ID,
  };
  return `draft-${hashSeed(stableStringify(payload))}`;
}

function generateTemplateId(input: DemoTemplateInput): string {
  const payload = {
    name: input.name ?? '',
    subject: input.subject ?? '',
    body: input.body ?? '',
    to: input.to ?? '',
    cc: input.cc ?? '',
    bcc: input.bcc ?? '',
    userId: input.userId ?? DEMO_USER_ID,
  };
  return `template-${hashSeed(stableStringify(payload))}`;
}

function generateNoteId(input: DemoNoteInput): string {
  const payload = {
    threadId: input.threadId ?? '',
    content: input.content ?? '',
    userId: input.userId ?? DEMO_USER_ID,
  };
  return `note-${hashSeed(stableStringify(payload))}`;
}

function generateLabelId(input: DemoLabelInput): string {
  const payload = {
    name: input.name ?? '',
    type: input.type ?? 'user',
    userId: DEMO_USER_ID,
  };
  return `label-${hashSeed(stableStringify(payload))}`;
}
