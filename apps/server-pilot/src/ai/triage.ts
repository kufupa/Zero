import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { AI_MANAGED_CATEGORY_SLUGS, AI_PRIMARY_CATEGORY_SLUGS } from './categories.js';
import { isAutoTriageNeverSpam, normalizeEmailAddress } from './never-spam.js';
import {
  getLatestInboundFromAddress,
  getSenderPreference,
} from '../mail/sender-preference.js';
import { mailCategory, mailThread, mailThreadCategory } from '../db/schema/mail.js';

export const TRIAGE_CATEGORIES = [...AI_PRIMARY_CATEGORY_SLUGS, 'spam'] as const;

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

export function refineTriageOutput(
  input: { from: string; body: string; subject?: string },
  output: TriageOutput,
): TriageOutput {
  const subject = (input.subject ?? '').trim();
  const body = input.body.trim();
  const haystack = `${subject}\n${body}`;
  let next = output;

  if (next.category === 'spam' && isAutoTriageNeverSpam(input.from)) {
    const category = normalizeEmailAddress(input.from).endsWith('@legacyhotels.co.za')
      || normalizeEmailAddress(input.from).endsWith('@mail.legacyhotels.com')
      ? 'ops'
      : 'new-bookings';
    next = {
      ...next,
      category,
      policyFlags: [...next.policyFlags, 'refine:never-spam-allowlist'],
      rationale: `${next.rationale} Sender is on auto-triage never-spam allowlist.`,
    };
  }

  if (next.category === 'spam') {
    const salesSignal =
      /promo|sale|discount|unsubscribe|limited[- ]time|book a demo|whatsapp|newsletter|marketing|click here|viqal|outreach|boost|% off|\$\d/i.test(
        haystack,
      );
    const emptyBodyPreferWork = !salesSignal && body.length === 0 && subject.length <= 80;
    if (emptyBodyPreferWork) {
      next = {
        ...next,
        category: 'new-bookings',
        policyFlags: [...next.policyFlags, 'refine:empty-body-not-spam'],
        rationale: `${next.rationale} Empty body with no sales pitch prefers work.`,
      };
    }
    const shortPersonal =
      !salesSignal &&
      body.length > 0 &&
      body.length <= 120 &&
      subject.length <= 40 &&
      !/\b(https?:\/\/|www\.)/i.test(haystack) &&
      (/^(hi|hello|hey|test|tester\d*|bonjour|thanks|thank you)\b/i.test(body) ||
        /^(hi|hello|hey|test|tester\d*)\b/i.test(subject));
    if (shortPersonal) {
      next = {
        ...next,
        category: 'new-bookings',
        policyFlags: [...next.policyFlags, 'refine:short-personal-not-spam'],
        rationale: `${next.rationale} Short personal note is not sales spam.`,
      };
    }
  }

  if (next.category === 'ops' && next.urgent) {
    const opsHandover = /handover|room readiness|vip arrivals/i.test(haystack);
    if (opsHandover) {
      next = {
        ...next,
        urgent: false,
        policyFlags: [...next.policyFlags, 'refine:ops-handover-not-urgent'],
        rationale: `${next.rationale} Ops handover is not same-day urgent.`,
      };
    }
  }

  if (
    next.category === 'ops' &&
    next.urgent &&
    /\burgent\b/i.test(subject) &&
    /invoice|commission/i.test(haystack) &&
    !/(today|tonight|same[- ]day|arrives? tomorrow|check[- ]?in tomorrow|within \d+\s*h)/i.test(
      haystack,
    )
  ) {
    next = {
      ...next,
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:subject-urgent-not-sla'],
      rationale: `${next.rationale} Subject URGENT on ops invoice/commission is not SLA.`,
    };
  }

  return next;
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

export type ApplyMode = 'full' | 'urgency_only' | 'skipped';

export async function applyDurableTriageResult(
  input: ApplyDurableTriageInput,
): Promise<{ applyMode: ApplyMode }> {
  const output = validateTriageOutput(input.output);
  if (!input.writeGateEnabled) return { applyMode: 'skipped' };

  const { db, transportId, threadId } = input;

  const [thread] = await db
    .select({ spamAt: mailThread.spamAt, spamUserLockedAt: mailThread.spamUserLockedAt })
    .from(mailThread)
    .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)))
    .limit(1);

  const primaryRows = await db
    .select({ categoryId: mailCategory.id, slug: mailCategory.slug })
    .from(mailThreadCategory)
    .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
    .where(
      and(
        eq(mailThreadCategory.threadId, threadId),
        eq(mailThreadCategory.transportId, transportId),
        inArray(mailCategory.slug, [...AI_PRIMARY_CATEGORY_SLUGS]),
      ),
    );

  const settled =
    primaryRows.length > 0 || thread?.spamAt != null || thread?.spamUserLockedAt != null;

  if (settled) {
    // KTD2: settled threads never flip primary/spamAt — urgency overlay only.
    const allCats = await db
      .select({ id: mailCategory.id, slug: mailCategory.slug })
      .from(mailCategory)
      .where(and(eq(mailCategory.transportId, transportId), eq(mailCategory.isActive, true)));
    const urgentId = allCats.find((c) => c.slug === 'urgent')?.id;
    if (!urgentId) throw new Error(`AI category missing for transport ${transportId}: urgent`);

    await db.delete(mailThreadCategory).where(
      and(
        eq(mailThreadCategory.threadId, threadId),
        eq(mailThreadCategory.transportId, transportId),
        eq(mailThreadCategory.categoryId, urgentId),
      ),
    );
    if (output.urgent) {
      await db.insert(mailThreadCategory).values({
        threadId,
        categoryId: urgentId,
        transportId,
      });
    }
    return { applyMode: 'urgency_only' };
  }

  const aiManagedRows = await db
    .select({ categoryId: mailCategory.id })
    .from(mailCategory)
    .where(
      and(eq(mailCategory.transportId, transportId), inArray(mailCategory.slug, AI_MANAGED_CATEGORY_SLUGS)),
    );

  const aiManagedIds = aiManagedRows.map((row) => row.categoryId);
  if (aiManagedIds.length > 0) {
    await db.delete(mailThreadCategory).where(
      and(
        eq(mailThreadCategory.threadId, threadId),
        eq(mailThreadCategory.transportId, transportId),
        inArray(mailThreadCategory.categoryId, aiManagedIds),
      ),
    );
  }

  if (output.category === 'spam') {
    const latestFrom = await getLatestInboundFromAddress(db, transportId, threadId);
    if (latestFrom) {
      const preference = await getSenderPreference({
        db,
        transportId,
        emailRaw: latestFrom,
      });
      if (preference === 'allow' || isAutoTriageNeverSpam(latestFrom)) {
        return { applyMode: 'full' };
      }
    }

    await db
      .update(mailThread)
      .set({ spamAt: new Date(), updatedAt: new Date() })
      .where(and(eq(mailThread.id, threadId), eq(mailThread.transportId, transportId)));
    return { applyMode: 'full' };
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
  if (!bySlug.get(output.category)) {
    throw new Error(`AI category missing for transport ${transportId}: ${output.category}`);
  }

  const targetSlugs = [output.category, ...(output.urgent ? (['urgent'] as const) : [])];
  const categoryIds = targetSlugs
    .map((slug) => {
      const id = bySlug.get(slug);
      if (!id && slug !== output.category) return undefined;
      if (!id) {
        throw new Error(`AI category missing for transport ${transportId}: ${slug}`);
      }
      return id;
    })
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

  return { applyMode: 'full' };
}
