/**
 * Settings router: per-user settings CRUD.
 *
 * Settings are keyed by `userId` (not transport). The frontend `useSettings`
 * hook calls `settings.get` (no input) and `settings.save(settings)`. We
 * upsert a `userSettings` row for the caller.
 */
import { eq, sql } from 'drizzle-orm';
import { privateProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { userSettings } from '../../db/schema/app.js';
import {
  userSettingsSchema,
  defaultUserSettings,
} from '../../lib/schemas.js';

export const settingsSaveInput = userSettingsSchema.partial();

export const settingsRouter = tRouter({
  get: privateProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, ctx.sessionUser.id))
      .limit(1);
    if (rows.length === 0) {
      // No row yet -> return defaults; the frontend normalizes anyway.
      return { id: null, settings: defaultUserSettings };
    }
    const row = rows[0]!;
    return { id: row.id, settings: row.settings };
  }),

  save: privateProcedure
    .input(settingsSaveInput)
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const userId = ctx.sessionUser.id;
      const id = `settings-${userId}`;
      const base = { ...defaultUserSettings, ...input };
      await db
        .insert(userSettings)
        .values({
          id,
          userId,
          settings: base,
        })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            settings: sql`coalesce(${userSettings.settings}, ${JSON.stringify(defaultUserSettings)}::jsonb) || ${JSON.stringify(input)}::jsonb`,
            updatedAt: new Date(),
          },
        });
      return { success: true as const };
    }),
});

void sql;
