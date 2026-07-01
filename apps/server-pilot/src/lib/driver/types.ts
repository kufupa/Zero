/**
 * Placeholder driver types. Task 4 (schema) and Task 6 (driver manager) will
 * fill in the real interfaces mirroring the old `apps/server/src/lib/driver/types.ts`
 * (MailManager, IGetThreadResponse, ParsedDraft, ManagerConfig, etc.).
 *
 * Kept as a typed empty shell so `@zero/server/driver/types` resolves for any
 * future deep import and so the package export surface is stable.
 */

export type CenturionMailCategory = 'internal' | 'individual' | 'group' | 'travel-agents';

export interface IGetThreadResponse {
  // TODO(task-4/6): mirror full shape from legacy driver types.
  messages: unknown[];
  hasUnread: boolean;
  totalReplies: number;
  labels: { id: string; name: string }[];
}

export interface ManagerConfig {
  auth: {
    userId: string;
    accessToken: string;
    refreshToken: string;
    email: string;
  };
}

export interface MailManager {
  config: ManagerConfig;
  // TODO(task-6): mirror full method surface.
}
