import centurionThreads from './centurion-threads.json';
import { parseDemoCorpus } from './schema';
import { filterRemovedDemoLabels } from './label-filter';

type DemoConnection = {
  id: string;
  providerId: string;
  email: string;
  name: string;
  picture: string | null;
};

type DemoLabel = {
  id: string;
  name: string;
  type: 'user' | 'system';
  labels: DemoLabel[];
};

const DEMO_CONNECTIONS: DemoConnection[] = [
  {
    id: 'demo-connection',
    providerId: 'demo',
    email: 'demo@centurion.local',
    name: 'Centurion Demo Inbox',
    picture: null,
  },
];

const parsedCorpus = parseDemoCorpus(centurionThreads as unknown);

const demoLabels: DemoLabel[] = buildDemoLabels();

function buildDemoLabels(): DemoLabel[] {
  const map = new Map<string, DemoLabel>();

  for (const thread of parsedCorpus.threads) {
    for (const label of filterRemovedDemoLabels(thread.labels)) {
      if (!map.has(label.id)) {
        map.set(label.id, {
          id: label.id,
          name: label.name,
          type: inferLabelType(label.name),
          labels: [],
        });
      }
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function inferLabelType(name: string): 'user' | 'system' {
  const uppercase = name.toUpperCase();
  return uppercase === name ? 'system' : 'user';
}

export function listDemoConnections(): {
  connections: DemoConnection[];
  disconnectedIds: string[];
} {
  return {
    connections: DEMO_CONNECTIONS,
    disconnectedIds: [],
  };
}

export function getDemoActiveConnection(): DemoConnection | null {
  return DEMO_CONNECTIONS[0] ?? null;
}

export function listDemoLabels(): DemoLabel[] {
  return demoLabels;
}
