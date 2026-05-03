import type { MailApiMode } from '../runtime/mail-mode';

const root = (mode: MailApiMode, accountId: string | null) =>
  ['frontendApi', mode, accountId ?? 'anon'] as const;

export const apiQueryKeys = {
  root,
  mail: {
    listThreads: (mode: MailApiMode, accountId: string | null, input: unknown) =>
      [...root(mode, accountId), 'mail', 'listThreads', input] as const,
    getThread: (mode: MailApiMode, accountId: string | null, input: unknown) =>
      [...root(mode, accountId), 'mail', 'getThread', input] as const,
  },
  drafts: {
    list: (mode: MailApiMode, accountId: string | null, input: unknown) =>
      [...root(mode, accountId), 'drafts', 'list', input] as const,
    get: (mode: MailApiMode, accountId: string | null, input: unknown) =>
      [...root(mode, accountId), 'drafts', 'get', input] as const,
  },
  labels: {
    list: (mode: MailApiMode, accountId: string | null) => [...root(mode, accountId), 'labels', 'list'] as const,
  },
  settings: {
    get: (mode: MailApiMode, accountId: string | null) => [...root(mode, accountId), 'settings', 'get'] as const,
  },
  connections: {
    list: (mode: MailApiMode, accountId: string | null) => [...root(mode, accountId), 'connections', 'list'] as const,
  },
  auth: {
    session: (mode: MailApiMode, accountId: string | null) => [...root(mode, accountId), 'auth', 'session'] as const,
  },
};
