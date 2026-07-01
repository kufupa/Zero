/**
 * Settings router: per-user settings CRUD.
 *
 * Settings are keyed by `userId` (not transport). The frontend `useSettings`
 * hook calls `settings.get` (no input) and `settings.save(settings)`. We
 * upsert a `userSettings` row for the caller.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { privateProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { userSettings } from '../../db/schema/app.js';
import { userSettingsSchema, defaultUserSettings } from '../../lib/schemas.js';

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
    .input(z.object({ settings: userSettingsSchema }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const userId = ctx.sessionUser.id;
      const existing = await db
        .select({ id: userSettings.id })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
      if (existing.length > 0) {
        await db
          .update(userSettings)
          .set({ settings: input.settings, updatedAt: new Date() })
          .where(eq(userSettings.id, existing[0]!.id));
        return { id: existing[0]!.id };
      }
      // Insert new row. Use a deterministic id so re-saves are idempotent.
      const id = `settings-${userId}`;
      await db.insert(userSettings).values({
        id,
        userId,
        settings: input.settings,
      });
      return { id };
    }),
});

// Suppress unused-import lint (and is reserved for future multi-condition filters).
void and;
