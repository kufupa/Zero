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
  input: { from: string; body: string; subject?: string; asOf?: string },
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
    const dayVisitorOrContactForm =
      /day[- ]?visitor|contact form|restaurant|lunch|dinner|f\s*&\s*b|food and bev/i.test(haystack);
    if (dayVisitorOrContactForm && !/unsubscribe|book a demo|whatsapp sales/i.test(haystack)) {
      next = {
        ...next,
        category: 'new-bookings',
        policyFlags: [...next.policyFlags, 'refine:day-visitor-not-spam'],
        rationale: `${next.rationale} Day-visitor/F&B/contact-form is not sales spam.`,
      };
    }
    const propertySubjectOnly =
      /^(centurion lake hotel|centurion hotel)\b/i.test(subject) &&
      !/unsubscribe|newsletter|book a demo/i.test(haystack);
    if (propertySubjectOnly) {
      next = {
        ...next,
        category: 'new-bookings',
        policyFlags: [...next.policyFlags, 'refine:property-subject-prefer-work'],
        rationale: `${next.rationale} Property-name subject prefers work over spam.`,
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

  if (
    next.category === 'ops' &&
    (/(release|cancel).{0,40}(held|series|allocation|block)|(held|series)\s+allocation/i.test(
      haystack,
    ) ||
      (/allocation/i.test(haystack) && /series/i.test(haystack)))
  ) {
    next = {
      ...next,
      category: 'at-risk',
      policyFlags: [...next.policyFlags, 'refine:series-release-at-risk'],
      rationale: `${next.rationale} Held series/allocation release is at-risk.`,
    };
  }

  if (
    next.category === 'at-risk' &&
    /booking|voucher|reservation|rooms?\b/i.test(haystack) &&
    !/\b(cancel|cancell?ation|amend|release held|unpaid|pay at (check|ci)|within \d+\s*h|synxis|ota)\b/i.test(
      haystack,
    ) &&
    !/\b(2|3|4|5|6|7|8|9|10|\d{2})\s+rooms?\b/i.test(haystack) &&
    !/\b(allocation|series\s+rates|held\s+series|room\s+block)\b/i.test(haystack)
  ) {
    next = {
      ...next,
      category: 'new-bookings',
      policyFlags: [...next.policyFlags, 'refine:one-room-ack-not-at-risk'],
      rationale: `${next.rationale} One-room booking ack without cancel/SLA is new-bookings.`,
    };
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

  if (
    next.category === 'ops' &&
    next.urgent &&
    /invoice|tax invoice/i.test(haystack) &&
    !/(today|tonight|same[- ]day|arrives? tomorrow|check[- ]?in tomorrow|within \d+\s*h)/i.test(
      haystack,
    ) &&
    !hasSameDayCheckInSignal(haystack, input.asOf)
  ) {
    next = {
      ...next,
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:ops-invoice-not-urgent'],
      rationale: `${next.rationale} Ops invoice without same-day/hard SLA is not urgent.`,
    };
  }

  if (
    !next.urgent &&
    (next.category === 'new-bookings' ||
      next.category === 'groups-events' ||
      next.category === 'at-risk') &&
    hasSameDayCheckInSignal(haystack, input.asOf)
  ) {
    next = {
      ...next,
      urgent: true,
      policyFlags: [...next.policyFlags, 'refine:same-day-ci-urgent'],
      rationale: `${next.rationale} Same-day check-in/arrival relative to asOf is urgent.`,
    };
  }

  if (
    next.urgent &&
    next.category === 'new-bookings' &&
    /\burgent\b/i.test(subject) &&
    !hasSameDayCheckInSignal(haystack, input.asOf) &&
    !/(today|tonight|same[- ]day|within \d+\s*h|arrives? tomorrow)/i.test(haystack)
  ) {
    next = {
      ...next,
      urgent: false,
      policyFlags: [...next.policyFlags, 'refine:subject-urgent-no-sla-signal'],
      rationale: `${next.rationale} Subject URGENT without same-day/hard SLA is not urgent.`,
    };
  }

  return next;
}

function hasSameDayCheckInSignal(haystack: string, asOf?: string): boolean {
  if (/check\s*[- ]?in\s*:?\s*today|arrives?\s+today|arrival\s+today|ci\s+today|same[- ]day\s*(ci|check)/i.test(
    haystack,
  )) {
    return true;
  }
  if (!asOf) return false;
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDate();
  const monShort = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const monLong = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const year = d.getUTCFullYear();
  const dateAlts = [
    `${day}\\s*${monShort}`,
    `${day}\\s*${monLong}`,
    `${day}[-/]0?${d.getUTCMonth() + 1}[-/]${year}`,
    `${day}[-/]0?${d.getUTCMonth() + 1}\\b`,
    `${String(day).padStart(2, '0')}[-/]${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
  ];
  for (const alt of dateAlts) {
    const re = new RegExp(
      `(check\\s*[- ]?in|arrival|ci)\\D{0,12}${alt}|${alt}\\D{0,12}(check\\s*[- ]?in|arrival)|\\b${day}\\s*[-–]\\s*\\d{1,2}\\s*${monShort}`,
      'i',
    );
    if (re.test(haystack)) return true;
  }
  return false;
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
