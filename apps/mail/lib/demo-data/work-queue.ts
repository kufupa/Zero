export const WORK_QUEUE_SLUGS = ['group', 'individual', 'travel-agent', 'hr', 'urgent'] as const;

export type WorkQueueSlug = (typeof WORK_QUEUE_SLUGS)[number];

export type DemoQueueThread = {
  id: string;
  demoCategory: 'group' | 'individual' | 'travel-agent' | 'hr';
  urgent: boolean;
  messages: {
    id: string;
    isDraft?: boolean;
  }[];
};

export function parseWorkQueueSlug(value?: string): WorkQueueSlug | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return WORK_QUEUE_SLUGS.includes(normalized as WorkQueueSlug) ? (normalized as WorkQueueSlug) : null;
}

export function threadMatchesWorkQueue(thread: DemoQueueThread, queue: WorkQueueSlug): boolean {
  return queue === 'urgent' ? thread.urgent : thread.demoCategory === queue;
}
