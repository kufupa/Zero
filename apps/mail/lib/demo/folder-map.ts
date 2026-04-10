import { parseWorkQueueSlug, type WorkQueueSlug } from '../demo-data/work-queue';

export type DemoFolderIdentity =
  | 'internal'
  | 'individual'
  | 'group'
  | 'spam'
  | 'urgent';

export type DemoFolderQueryContext = {
  folder: string;
  workQueue: WorkQueueSlug | null;
};

type DemoFolderDefinition = {
  id: DemoFolderIdentity;
  title: string;
  workQueue: WorkQueueSlug | null;
  aliases: string[];
};

export const DEMO_FOLDER_DEFINITIONS: DemoFolderDefinition[] = [
  {
    id: 'internal',
    title: 'Internal Mail',
    workQueue: 'hr',
    aliases: ['internal-mail', 'hr'],
  },
  {
    id: 'individual',
    title: 'Individual Room Bookings',
    workQueue: 'individual',
    aliases: ['individual-room-bookings'],
  },
  {
    id: 'group',
    title: 'Group Bookings',
    workQueue: 'group',
    aliases: ['group-bookings'],
  },
  {
    id: 'spam',
    title: 'Spam',
    workQueue: null,
    aliases: [],
  },
  {
    id: 'urgent',
    title: 'Urgent',
    workQueue: 'urgent',
    aliases: [],
  },
];

const demoFolderLookup = new Map<string, DemoFolderDefinition>(
  DEMO_FOLDER_DEFINITIONS.flatMap((definition) => [
    [definition.id, definition] as const,
    ...definition.aliases.map((alias) => [alias, definition] as const),
  ]),
);

export function isDemoQueueFolder(folder?: string): boolean {
  if (!folder) return false;
  const normalized = folder.trim().toLowerCase();
  return demoFolderLookup.has(normalized);
}

export function resolveDemoFolderQueryContext(folder?: string): DemoFolderQueryContext {
  const normalizedFolder = (folder ?? 'inbox').trim().toLowerCase() || 'inbox';
  const mappedFolder = demoFolderLookup.get(normalizedFolder);
  if (mappedFolder) {
    return {
      folder: mappedFolder.id === 'spam' ? 'spam' : 'inbox',
      workQueue: mappedFolder.workQueue,
    };
  }

  const directQueue = parseWorkQueueSlug(normalizedFolder);
  if (directQueue) {
    return {
      folder: 'inbox',
      workQueue: directQueue,
    };
  }

  return {
    folder: normalizedFolder,
    workQueue: null,
  };
}
