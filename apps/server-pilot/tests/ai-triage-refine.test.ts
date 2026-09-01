import {
  applyDurableTriageResult,
  refineTriageOutput,
  staffConversationNotSpam,
  type WorkflowTriageOutput,
} from '../src/ai/triage.js';
import { mailCategory, mailThread, mailThreadCategory } from '../src/db/schema/mail.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

function modelOutput(category: 'at-risk' | 'new-bookings' | 'ops' | 'spam', urgent: boolean) {
  return {
    category,
    urgent,
    confidence: 0.9,
    rationale: 'synthetic model result',
    policyFlags: [],
  };
}

function workflowOutput(overrides: Partial<WorkflowTriageOutput> = {}): WorkflowTriageOutput {
  return {
    primaryFolder: 'unknown-review',
    priority: 'P2',
    urgent: false,
    overlays: {},
    isSpam: true,
    suggestedTools: [],
    sourceScope: 'external',
    automationState: 'unknown',
    humanAction: 'review_required',
    confidence: 0.9,
    rationale: 'synthetic model result',
    policyFlags: [],
    abstainReason: null,
    ...overrides,
  };
}

describe('reservationist triage refinement order', () => {
  it('demotes routine reservation-system updates before urgency refinement', () => {
    const refined = refineTriageOutput(
      {
        from: 'notifications@reservations.example.test',
        subject: 'Reservation update',
        body: 'Channel manager confirms booking 456. Check-in today.',
      },
      modelOutput('new-bookings', false),
    );

    expect(refined.category).toBe('ops');
    expect(refined.urgent).toBe(false);
    expect(refined.policyFlags).toContain('refine:system-mail-ops');
  });

  it('demotes routine reservation-system cancellations to nonurgent ops', () => {
    const refined = refineTriageOutput(
      {
        from: 'notifications@reservations.example.test',
        subject: 'Reservation update',
        body: 'Channel manager cancels booking 456. No action is required.',
      },
      modelOutput('at-risk', true),
    );

    expect(refined.category).toBe('ops');
    expect(refined.urgent).toBe(false);
    expect(refined.policyFlags).toContain('refine:system-mail-ops');
  });

  it('preserves held-series release risk ahead of routine system-mail demotion', () => {
    const refined = refineTriageOutput(
      {
        from: 'notifications@reservations.example.test',
        subject: 'Reservation update',
        body: 'Please release held series allocation. Channel manager confirms update.',
      },
      modelOutput('ops', false),
    );

    expect(refined.category).toBe('at-risk');
    expect(refined.policyFlags).toContain('refine:series-release-at-risk');
    expect(refined.policyFlags).not.toContain('refine:system-mail-ops');
  });

  it.each([
    {
      name: 'retry window without a requested action',
      body: 'The integration will retry within 2 hours. No action is required.',
    },
    {
      name: 'bare SLA not applicable',
      body: 'SLA not applicable to this routine integration retry.',
    },
    {
      name: 'postfix negated SLA',
      body: 'SLA is not applicable to this routine integration retry.',
    },
  ])('treats routine integration mail as non-revenue ops: $name', ({ body }) => {
    const refined = refineTriageOutput(
      {
        from: 'pms@reservations.example.test',
        subject: 'RESERVATION FAILED TO INTEGRATE',
        body,
      },
      modelOutput('at-risk', true),
    );

    expect(refined.category).toBe('ops');
    expect(refined.urgent).toBe(false);
    expect(refined.policyFlags).toContain('refine:system-mail-ops');
  });

  it('keeps revenue risk when system mail says reply is needed by a deadline', () => {
    const refined = refineTriageOutput(
      {
        from: 'notifications@reservations.example.test',
        subject: 'Reservation confirmation',
        body: 'SynXis confirms this reservation. Reply is needed by 17:00 to keep it.',
      },
      modelOutput('at-risk', true),
    );

    expect(refined.category).toBe('at-risk');
    expect(refined.urgent).toBe(true);
    expect(refined.policyFlags).not.toContain('refine:system-mail-ops');
  });

  it('keeps a positive SLA after a negated retry SLA as revenue risk', () => {
    const refined = refineTriageOutput(
      {
        from: 'pms@reservations.example.test',
        subject: 'RESERVATION FAILED TO INTEGRATE',
        body: 'No SLA applies to the retry. A hard SLA applies to this reservation.',
      },
      modelOutput('at-risk', true),
    );

    expect(refined.category).toBe('at-risk');
    expect(refined.urgent).toBe(true);
    expect(refined.policyFlags).not.toContain('refine:system-mail-ops');
  });

  it('keeps a conditional cancellation split across lines as revenue risk', () => {
    const refined = refineTriageOutput(
      {
        from: 'notifications@reservations.example.test',
        subject: 'Reservation update',
        body: 'Channel manager cancels this booking\nif the guest does not respond.',
      },
      modelOutput('at-risk', true),
    );

    expect(refined.category).toBe('at-risk');
    expect(refined.urgent).toBe(true);
    expect(refined.policyFlags).not.toContain('refine:system-mail-ops');
  });

  it('treats FortiMail quarantine as spam only when model classified it as ops', () => {
    const modelOps = refineTriageOutput(
      {
        from: 'security@reservations.example.test',
        subject: 'FortiMail quarantine digest',
        body: 'Routine security summary.',
      },
      modelOutput('ops', true),
    );
    expect(modelOps.category).toBe('spam');
    expect(modelOps.urgent).toBe(false);
    expect(modelOps.policyFlags).toContain('refine:fortimail-spam');

    const bareQuarantine = refineTriageOutput(
      {
        from: 'security@reservations.example.test',
        subject: 'Quarantine notification',
        body: 'Routine security summary.',
      },
      modelOutput('ops', true),
    );
    expect(bareQuarantine.category).toBe('spam');
    expect(bareQuarantine.urgent).toBe(false);
    expect(bareQuarantine.policyFlags).toContain('refine:fortimail-spam');

    const modelRisk = refineTriageOutput(
      {
        from: 'security@reservations.example.test',
        subject: 'FortiMail quarantine summary',
        body: 'Channel manager confirms update.',
      },
      modelOutput('at-risk', true),
    );
    expect(modelRisk.category).toBe('at-risk');
    expect(modelRisk.urgent).toBe(true);
    expect(modelRisk.policyFlags).not.toContain('refine:fortimail-spam');
    expect(modelRisk.policyFlags).not.toContain('refine:system-mail-ops');
  });

  it('demotes non-risk review digests without overriding a deadline-bound risk', () => {
    const digest = refineTriageOutput(
      {
        from: 'updates@reputation.example.test',
        subject: 'GuestRevu daily review digest',
        body: 'Routine reputation summary.',
      },
      modelOutput('spam', true),
    );
    expect(digest.category).toBe('ops');
    expect(digest.urgent).toBe(false);
    expect(digest.policyFlags).toContain('refine:guestrevu-ops');

    const risk = refineTriageOutput(
      {
        from: 'updates@reputation.example.test',
        subject: 'GuestRevu daily review digest',
        body: 'Reply is required within 2 hours to protect this reservation.',
      },
      modelOutput('at-risk', true),
    );
    expect(risk.category).toBe('at-risk');
    expect(risk.urgent).toBe(true);
    expect(risk.policyFlags).not.toContain('refine:guestrevu-ops');
  });

  it('requires routine-system content instead of sender identity', () => {
    const refined = refineTriageOutput(
      {
        from: 'noreply@synxis.example.test',
        subject: 'Accommodation enquiry',
        body: 'Please send availability for one guest next month.',
      },
      modelOutput('new-bookings', false),
    );

    expect(refined.category).toBe('new-bookings');
    expect(refined.urgent).toBe(false);
    expect(refined.policyFlags).not.toContain('refine:system-mail-ops');
  });

  it('does not treat review alerts without a digest signal as routine ops', () => {
    const refined = refineTriageOutput(
      {
        from: 'updates@reputation.example.test',
        subject: 'GuestRevu review alert',
        body: 'A guest submitted a response request.',
      },
      modelOutput('new-bookings', true),
    );

    expect(refined.category).toBe('new-bookings');
    expect(refined.urgent).toBe(true);
    expect(refined.policyFlags).not.toContain('refine:guestrevu-ops');
  });
});

describe('R22/R23 exception-first spam defense', () => {
  it('forces Legacy hotel From not-spam and remaps workflow primary to internal-partner', () => {
    const refined = refineTriageOutput(
      {
        from: 'jvermaak@legacyhotels.co.za',
        subject: 'Promo?',
        body: 'Book a demo unsubscribe',
      },
      workflowOutput(),
    );

    expect(refined.isSpam).toBe(false);
    expect(refined.primaryFolder).toBe('internal-partner');
    expect(refined.policyFlags).toContain('refine:never-spam-allowlist');
  });

  it('forces external inbound not-spam when prior Legacy outbound response exists', () => {
    const refined = refineTriageOutput(
      {
        from: 'guest@example.com',
        subject: 'Re: payment',
        body: 'Please confirm payment.',
        threadSignals: { legacyHotelsOutboundResponse: true },
      },
      workflowOutput(),
    );

    expect(refined.isSpam).toBe(false);
    expect(refined.policyFlags).toContain('refine:staff-conversation-not-spam');
  });

  it('recognizes RC Penny to an external recipient as staff outbound', () => {
    const signals = {
      from: 'pmbobo@eu.mail.reservecloud.com',
      recipients: ['guest@example.com'],
    };
    expect(staffConversationNotSpam(signals)).toBe(true);

    const refined = refineTriageOutput(
      {
        ...signals,
        subject: 'Event Proposal and Contract',
        body: 'Please review the event proposal and contract.',
      },
      workflowOutput(),
    );

    expect(refined.isSpam).toBe(false);
    expect(refined.primaryFolder).toBe('groups-events');
    expect(refined.policyFlags).toContain('refine:staff-conversation-not-spam');
  });

  it('requires validated RC sender and recipient evidence for reserve staff signals', () => {
    const contradictory = refineTriageOutput(
      {
        from: 'guest@example.com',
        subject: 'Newsletter',
        body: 'Routine update.',
        threadSignals: { reserveCloudStaffOutbound: true },
      },
      workflowOutput(),
    );
    expect(contradictory.isSpam).toBe(true);
    expect(contradictory.policyFlags).not.toContain('refine:staff-conversation-not-spam');

    const validatedThreadSignal = refineTriageOutput(
      {
        from: 'guest@example.com',
        subject: 'Re: event',
        body: 'Please see the proposal.',
        threadSignals: {
          reserveCloudStaffOutbound: true,
          reserveCloudStaffOutboundFrom: 'pmbobo@eu.mail.reservecloud.com',
          reserveCloudStaffOutboundRecipients: ['guest@example.com'],
        },
      },
      workflowOutput(),
    );
    expect(validatedThreadSignal.isSpam).toBe(false);
    expect(validatedThreadSignal.policyFlags).toContain('refine:staff-conversation-not-spam');
  });

  it('keeps RC Penny SCS wrapper not-spam without staff-outbound flag', () => {
    const refined = refineTriageOutput(
      {
        from: 'pmbobo@eu.mail.reservecloud.com',
        to: ['pmbobo@legacyhotels.co.za'],
        subject: 'SCS wrapper',
        body: 'Guest booking request forwarded by Sales and Catering.',
      },
      workflowOutput(),
    );

    expect(refined.isSpam).toBe(false);
    expect(refined.policyFlags).toContain('refine:never-spam-allowlist');
    expect(refined.policyFlags).not.toContain('refine:staff-conversation-not-spam');
    expect(
      staffConversationNotSpam({
        from: 'pmbobo@eu.mail.reservecloud.com',
        recipients: ['pmbobo@legacyhotels.co.za'],
      }),
    ).toBe(true);
  });

  it('does not treat noreply ReserveCloud as staff response or never-spam', () => {
    expect(
      staffConversationNotSpam({
        from: 'noreply@noreply.reservecloud.com',
        recipients: ['guest@example.com'],
      }),
    ).toBe(false);

    const refined = refineTriageOutput(
      {
        from: 'noreply@noreply.reservecloud.com',
        subject: 'Daily digest',
        body: 'Unsubscribe from this newsletter.',
      },
      workflowOutput(),
    );
    expect(refined.isSpam).toBe(true);
  });

  it('requires quoted hotel block plus payment shape for FP2 refine', () => {
    const quoted = refineTriageOutput(
      {
        from: 'guest@example.com',
        subject: 'Re: payment',
        body: `${'preamble '.repeat(400)}\n> From: Bongi <centurion@legacyhotels.co.za>\n> Payment invoice for Centurion stay.`,
      },
      workflowOutput(),
    );
    expect(quoted.isSpam).toBe(false);
    expect(quoted.primaryFolder).toBe('money-billing');
    expect(quoted.policyFlags).toContain('refine:hotel-conversation-not-spam');

    const unquoted = refineTriageOutput(
      {
        from: 'vendor@example.com',
        subject: 'Centurion payment invoice',
        body: 'Pay this invoice for a Centurion marketing opportunity.',
      },
      workflowOutput(),
    );
    expect(unquoted.isSpam).toBe(true);
    expect(unquoted.policyFlags).not.toContain('refine:hotel-conversation-not-spam');
  });
});

const applyDbAvailable = TEST_DB_AVAILABLE && (await probeTestDb());

describe.skipIf(!applyDbAvailable)('R22 Layer-3 durable apply', () => {
  it('clears unlocked spamAt and joins internal-partner for forced not-spam', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const internalPartnerId = randomUUID();
      await db.insert(mailCategory).values({
        id: internalPartnerId,
        transportId: TRANSPORT_ID,
        slug: 'internal-partner',
        name: 'Internal & Partner',
        sortOrder: 999,
      });
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Staff response',
        snippet: 'Reply',
        latestMessageAt: new Date(),
        spamAt: new Date(),
      });

      const result = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        threadSignals: { legacyHotelsOutboundResponse: true },
        output: workflowOutput(),
      });

      expect(result.applyMode).toBe('full');
      const [thread] = await db
        .select({ spamAt: mailThread.spamAt })
        .from(mailThread)
        .where(eq(mailThread.id, threadId));
      expect(thread?.spamAt).toBeNull();
      const memberships = await db
        .select({ categoryId: mailThreadCategory.categoryId })
        .from(mailThreadCategory)
        .where(
          and(
            eq(mailThreadCategory.threadId, threadId),
            eq(mailThreadCategory.transportId, TRANSPORT_ID),
          ),
        );
      expect(memberships.map((row) => row.categoryId)).toContain(internalPartnerId);
    });
  });
});
