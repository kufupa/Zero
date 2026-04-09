export const WORK_QUEUE_SLUGS = [
  'group',
  'individual',
  'travel-agent',
  'hr',
  'urgent',
] as const;

export type WorkQueueSlug = (typeof WORK_QUEUE_SLUGS)[number];

export type DemoCorpusThreadShape = {
  id: string;
  demoCategory: 'group' | 'individual' | 'travel-agent' | 'hr';
  urgent: boolean;
  messages: { isDraft?: boolean }[];
};

export function parseWorkQueueSlug(value: string | undefined): WorkQueueSlug | null {
  if (!value) return null;
  return (WORK_QUEUE_SLUGS as readonly string[]).includes(value)
    ? (value as WorkQueueSlug)
    : null;
}

export function threadMatchesWorkQueue(
  thread: DemoCorpusThreadShape,
  queue: WorkQueueSlug,
): boolean {
  if (queue === 'urgent') return thread.urgent === true;
  return thread.demoCategory === queue;
}
