import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { mailCategory, mailThread, mailThreadCategory } from '../db/schema/mail.js';

export const TRIAGE_CATEGORIES = [
  'internal',
  'individual',
  'group',
  'travel-agents',
  'spam',
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export const triageOutputSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  urgent: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  policyFlags: z.array(z.string()).default([]),
});

export type TriageOutput = z.infer<typeof triageOutputSchema>;

export interface ShadowTriageResult {
  threadId: string;
  transportId: string;
  output: TriageOutput;
  metrics: Record<string, unknown>;
}

export function validateTriageOutput(raw: unknown): TriageOutput {
  return triageOutputSchema.parse(raw);
}

export function applyShadowTriageResult(input: ShadowTriageResult): ShadowTriageResult {
  validateTriageOutput(input.output);
  return {
    ...input,
    metrics: {
      ...input.metrics,
      shadow: true,
      category: input.output.category,
      urgent: input.output.urgent,
      confidence: input.output.confidence,
    },
  };
}

export interface ApplyDurableTriageInput {
  db: DB;
  transportId: string;
  threadId: string;
  output: TriageOutput;
  writeGateEnabled: boolean;
}

export async function applyDurableTriageResult(input: ApplyDurableTriageInput): Promise<void> {
  const output = validateTriageOutput(input.output);
  if (!input.writeGateEnabled) return;

  const { db, transportId, threadId } = input;

  if (output.category === 'spam') {
    await db
      .update(mailThread)
      .set({ spamAt: new Date(), updatedAt: new Date() })
      .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)));
    return;
  }

  await db
    .update(mailThread)
    .set({ spamAt: null, updatedAt: new Date() })
    .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)));

  const categoryRows = await db
    .select({ id: mailCategory.id, slug: mailCategory.slug })
    .from(mailCategory)
    .where(and(eq(mailCategory.transportId, transportId), eq(mailCategory.isActive, true)));

  const bySlug = new Map(categoryRows.map((row) => [row.slug, row.id]));
  const targetSlugs = [output.category, ...(output.urgent ? (['urgent'] as const) : [])];

  await db
    .delete(mailThreadCategory)
    .where(and(eq(mailThreadCategory.threadId, threadId), eq(mailThreadCategory.transportId, transportId)));

  const categoryIds = targetSlugs
    .map((slug) => bySlug.get(slug))
    .filter((id): id is string => Boolean(id));

  if (categoryIds.length > 0) {
    await db.insert(mailThreadCategory).values(
      categoryIds.map((categoryId) => ({
        threadId,
        categoryId,
        transportId,
      })),
    );
  }
}
