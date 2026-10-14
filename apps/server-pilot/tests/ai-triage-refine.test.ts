import {
  applyDurableTriageResult,
  refineTriageOutput,
  staffConversationNotSpam,
  type WorkflowTriageOutput,
} from '../src/ai/triage.js';
import { mailCategory, mailLabel, mailThread, mailThreadCategory } from '../src/db/schema/mail.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import type { DB } from '../src/db/client.js';
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
    expect(bareQuarantine.category).toBe('ops');
    expect(bareQuarantine.policyFlags).not.toContain('refine:fortimail-spam');

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

describe('workflow routine system-mail force-automate (KTD1)', () => {
  it('workflow: routine SynXis confirm → automated-channel, not urgent', () => {
    const refined = refineTriageOutput(
      {
        from: 'noreply@synxis.com',
        subject: 'SynXis Res Confirmed',
        body: 'Reservation confirmed.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: true,
        priority: 'P2',
        overlays: { booking: false, quote: false, payment: false },
        automationState: 'candidate',
        humanAction: 'none',
        confidence: 0.5,
        rationale: 'test',
      }),
    );

    expect(refined.primaryFolder).toBe('automated-channel');
    expect(refined.isSpam).toBe(false);
    expect(refined.urgent).toBe(false);
    expect(refined.suggestedTools).toEqual([]);
    expect(refined.policyFlags).toContain('refine:system-mail-automated');
  });

  it('workflow: WebBeds Channel Manager update clears model spam into automated-channel', () => {
    const refined = refineTriageOutput(
      {
        from: 'noreply-bookings@webbeds.com',
        subject:
          'Booking Update for The Centurion Hotel via Channel Manager: HTL-WBD-1042951365',
        body:
          'New Booking Confirmed via Channel Manager YOUR EMAIL COPY Dear Reservations team, Below is an update from Destinations of the World that has been sent to your Channel Manager. Please click here https://extranet.webbeds.com/book to open your account.',
      },
      workflowOutput({
        primaryFolder: 'unknown-review',
        isSpam: true,
        urgent: true,
        priority: 'P2',
        suggestedTools: [],
      }),
    );

    expect(refined.primaryFolder).toBe('automated-channel');
    expect(refined.isSpam).toBe(false);
    expect(refined.urgent).toBe(false);
    expect(refined.suggestedTools).toEqual([]);
    expect(refined.policyFlags).toContain('refine:system-mail-automated');
    expect(refined.policyFlags).not.toContain('refine:promo-spam');
  });

  it('workflow: SynXis with reply-within-12h stays out of automated-channel', () => {
    const refined = refineTriageOutput(
      {
        from: 'noreply@synxis.com',
        subject: 'SynXis Res Confirmed',
        body: 'SynXis confirms this reservation. Reply within 12 hours to keep it.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: true,
        priority: 'P2',
      }),
    );

    expect(refined.primaryFolder).not.toBe('automated-channel');
    expect(refined.policyFlags).not.toContain('refine:system-mail-automated');
  });

  it('workflow: held series release → exceptions-recovery before automate', () => {
    const refined = refineTriageOutput(
      {
        from: 'notifications@reservations.example.test',
        subject: 'Reservation update',
        body: 'Please release held series allocation. Channel manager confirms update.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: false,
        priority: 'P2',
      }),
    );

    expect(refined.primaryFolder).toBe('exceptions-recovery');
    expect(refined.policyFlags).toContain('refine:series-release-at-risk');
    expect(refined.policyFlags).not.toContain('refine:system-mail-automated');
    expect(refined.primaryFolder).not.toBe('automated-channel');
  });

  it('workflow: series-release clears model isSpam so apply does not spam early-return', () => {
    const refined = refineTriageOutput(
      {
        from: 'notifications@reservations.example.test',
        subject: 'Reservation update',
        body: 'Please release held series allocation. Channel manager confirms update.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: true,
        urgent: true,
        priority: 'P2',
      }),
    );

    expect(refined.primaryFolder).toBe('exceptions-recovery');
    expect(refined.isSpam).toBe(false);
    expect(refined.urgent).toBe(false);
    expect(refined.suggestedTools).toEqual([]);
    expect(refined.policyFlags).toContain('refine:series-release-at-risk');
  });

  it('workflow: internal property never stays automated-channel', () => {
    const refined = refineTriageOutput(
      {
        from: 'notices@branding.legacyhotels.co.za',
        subject: 'SynXis Res Confirmed',
        body: 'Reservation confirmed via channel manager.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: true,
        priority: 'P2',
      }),
    );

    expect(refined.primaryFolder).not.toBe('automated-channel');
    expect(refined.primaryFolder).toBe('internal-partner');
    expect(refined.policyFlags).not.toContain('refine:system-mail-automated');
  });

  it.each([
    {
      name: 'FAILED TO INTEGRATE',
      from: 'pms@reservations.example.test',
      subject: 'RESERVATION FAILED TO INTEGRATE',
      body: 'The integration will retry within 2 hours. No action is required.',
    },
    {
      name: 'calendar Canceled',
      from: 'calendar-notifications@google.com',
      subject: 'Canceled: Front desk hold',
      body: 'Calendar event canceled for room block review.',
    },
    {
      name: 'booking.com channel notice',
      from: 'noreply@booking.com',
      subject: 'Booking.com: New reservation',
      body: 'You have a new booking. Guest: Synthetic Guest. Room nights: 2.',
    },
  ])('workflow: routine $name → automated-channel, not urgent', ({ from, subject, body }) => {
    const refined = refineTriageOutput(
      { from, subject, body },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: true,
        priority: 'P2',
      }),
    );

    expect(refined.primaryFolder).toBe('automated-channel');
    expect(refined.urgent).toBe(false);
    expect(refined.policyFlags).toContain('refine:system-mail-automated');
  });
});

describe('workflow content-intent overrides (quality day-sample)', () => {
  it('workflow: cold vendor free security-audit pitch → isSpam (general salesSignal)', () => {
    const refined = refineTriageOutput(
      {
        from: 'rep@vendor.example.com',
        subject: 'Is Your Business POPIA Compliant?',
        body:
          "That's where we can help. We're offering a 100% FREE Network Security Audit. Business Development Associate.",
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: false,
      }),
    );

    expect(refined.isSpam).toBe(true);
    expect(refined.policyFlags).toContain('refine:promo-spam');
  });

  it('workflow: guest bed-bug complaint → guest-experience, not bookings', () => {
    const refined = refineTriageOutput(
      {
        from: 'guest@example.com',
        subject: 'Bed bugs found during my stay',
        body:
          'I was a guest at your property. I discovered bed bugs in the room. If I do not receive a proper response I will leave a public review.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: false,
      }),
    );

    expect(refined.primaryFolder).toBe('guest-experience');
    expect(refined.isSpam).toBe(false);
    expect(refined.policyFlags).toContain('refine:guest-service-recovery');
  });

  it('workflow: agency cancellation request → exceptions-recovery, not groups-events', () => {
    const refined = refineTriageOutput(
      {
        from: 'agent@tours.example.com',
        subject: 'CANCELLATION REQUEST - CTI X4684',
        body: 'Could you kindly cancel the attached booking. GROUP NAME: CENTURION HOTEL STATUS 01 NIGHT',
      },
      workflowOutput({
        primaryFolder: 'groups-events',
        isSpam: false,
        urgent: false,
      }),
    );

    expect(refined.primaryFolder).toBe('exceptions-recovery');
    expect(refined.policyFlags).toContain('refine:booking-cancel-or-release');
  });

  it('workflow: legacy staff FW rooming list stays groups-events (never-spam must not stomp)', () => {
    const refined = refineTriageOutput(
      {
        from: 'crsa@legacyhotels.co.za',
        subject: 'FW: Tours Group in October 2026 Accommodation',
        body: 'please find below rooming list for the Group Res#9500533',
      },
      workflowOutput({
        primaryFolder: 'groups-events',
        isSpam: false,
        urgent: false,
      }),
    );

    expect(refined.primaryFolder).toBe('groups-events');
    expect(refined.isSpam).toBe(false);
    expect(refined.policyFlags).toContain('refine:groups-events-work');
  });

  it('workflow: release bookings for groups → exceptions-recovery', () => {
    const refined = refineTriageOutput(
      {
        from: 'agent@agency.example.com',
        subject: 'RE: CTI OSA SA+VFA 7D SGL 1016',
        body: "Please can you release the bookings for the following groups as they won't travel:",
      },
      workflowOutput({
        primaryFolder: 'manage-stay',
        isSpam: false,
        urgent: false,
      }),
    );

    expect(refined.primaryFolder).toBe('exceptions-recovery');
    expect(refined.policyFlags).toContain('refine:series-release-at-risk');
  });
});

describe('workflow force-spam (KTD2)', () => {
  it('workflow: bookings + isSpam:false + salesSignal → spam flag, not primaryFolder spam', () => {
    const refined = refineTriageOutput(
      {
        from: 'promo@vendor.example.com',
        subject: 'Limited-time offer',
        body: 'Newsletter promo — unsubscribe here.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: true,
        priority: 'P2',
      }),
    );

    expect(refined.isSpam).toBe(true);
    expect(refined.primaryFolder).not.toBe('spam');
    expect(refined.urgent).toBe(false);
    expect(refined.suggestedTools).toEqual([]);
    expect(refined.policyFlags).toContain('refine:promo-spam');
  });

  it('workflow: FortiMail quarantine digest → isSpam with fortimail-spam, not urgent', () => {
    const refined = refineTriageOutput(
      {
        from: 'security@fortimail.example.com',
        subject: 'FortiMail quarantine digest',
        body: 'Messages held in quarantine summary for review.',
      },
      workflowOutput({
        primaryFolder: 'unknown-review',
        isSpam: false,
        urgent: true,
        priority: 'P2',
      }),
    );

    expect(refined.isSpam).toBe(true);
    expect(refined.primaryFolder).not.toBe('spam');
    expect(refined.urgent).toBe(false);
    expect(refined.suggestedTools).toEqual([]);
    expect(refined.policyFlags).toContain('refine:fortimail-spam');
  });

  it('workflow: Legacy Hotels From with promo body stays not spam', () => {
    const refined = refineTriageOutput(
      {
        from: 'jvermaak@legacyhotels.co.za',
        subject: 'Promo?',
        body: 'Book a demo unsubscribe',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: true,
        urgent: true,
      }),
    );

    expect(refined.isSpam).toBe(false);
    expect(refined.policyFlags).not.toContain('refine:promo-spam');
    expect(refined.policyFlags).toContain('refine:never-spam-allowlist');
  });

  it('workflow: guest quarantine room booking is not fortimail-spam', () => {
    const refined = refineTriageOutput(
      {
        from: 'guest@example.com',
        subject: 'Quarantine room booking',
        body: 'Please confirm our quarantine room reservation for next week.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: false,
      }),
    );

    expect(refined.isSpam).toBe(false);
    expect(refined.policyFlags).not.toContain('refine:fortimail-spam');
  });

  it('workflow: empty-body and short-personal mail are not promo-spam', () => {
    const emptyBody = refineTriageOutput(
      {
        from: 'guest@example.com',
        subject: 'Booking question',
        body: '',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: false,
      }),
    );
    expect(emptyBody.isSpam).toBe(false);
    expect(emptyBody.policyFlags).not.toContain('refine:promo-spam');

    const shortPersonal = refineTriageOutput(
      {
        from: 'guest@example.com',
        subject: 'Hi',
        body: 'Hello, thanks for your help.',
      },
      workflowOutput({
        primaryFolder: 'bookings',
        isSpam: false,
        urgent: false,
      }),
    );
    expect(shortPersonal.isSpam).toBe(false);
    expect(shortPersonal.policyFlags).not.toContain('refine:promo-spam');
  });

  it('workflow: forced spam paths clear urgent', () => {
    const promo = refineTriageOutput(
      {
        from: 'sales@vendor.example.com',
        subject: 'Marketing blast',
        body: 'Click here for 20% off. Unsubscribe.',
      },
      workflowOutput({
        primaryFolder: 'unknown-review',
        isSpam: true,
        urgent: true,
      }),
    );
    expect(promo.isSpam).toBe(true);
    expect(promo.urgent).toBe(false);
    expect(promo.policyFlags).toContain('refine:promo-spam');

    const fortimail = refineTriageOutput(
      {
        from: 'alerts@fortimail.example.com',
        subject: 'Quarantine summary',
        body: 'FortiMail held messages digest.',
      },
      workflowOutput({
        primaryFolder: 'unknown-review',
        isSpam: false,
        urgent: true,
      }),
    );
    expect(fortimail.isSpam).toBe(true);
    expect(fortimail.urgent).toBe(false);
    expect(fortimail.policyFlags).toContain('refine:fortimail-spam');
  });
});

describe('workflow source and automation refinement', () => {
  it('routes internal delivery failures to exceptions and excludes automation', () => {
    const refined = refineTriageOutput(
      {
        from: 'mailer-daemon@mail.legacyhotels.com',
        subject: 'Delivery failure notification',
        body: 'Internal delivery failure: message could not be delivered to the property mailbox.',
      },
      workflowOutput({
        primaryFolder: 'automated-channel',
        sourceScope: 'external',
        automationState: 'routine_candidate',
        humanAction: 'monitor',
      }),
    );

    expect(refined.primaryFolder).toBe('exceptions-recovery');
    expect(refined.sourceScope).toBe('internal_property');
    expect(refined.automationState).toBe('excluded_internal');
    expect(refined.primaryFolder).not.toBe('automated-channel');
  });

  it('recognizes branding.legacyhotels.co.za as internal property signal', () => {
    const refined = refineTriageOutput(
      {
        from: 'notices@branding.legacyhotels.co.za',
        subject: 'Routine property update',
        body: 'Property branding update complete.',
      },
      workflowOutput({
        primaryFolder: 'automated-channel',
        sourceScope: 'external',
        automationState: 'routine_candidate',
      }),
    );

    expect(refined.sourceScope).toBe('internal_property');
    expect(refined.automationState).toBe('excluded_internal');
    expect(refined.primaryFolder).toBe('internal-partner');
  });

  it('deterministically routes hospitality.cloud finance mail to money billing', () => {
    const refined = refineTriageOutput(
      {
        from: 'finance@hospitality.cloud',
        subject: 'Payment confirmation',
        body: 'Booking payment and invoice confirmation for the reservation.',
      },
      workflowOutput({
        primaryFolder: 'automated-channel',
        priority: 'P4',
        overlays: {},
        automationState: 'routine_candidate',
        humanAction: 'monitor',
      }),
    );

    expect(refined.primaryFolder).toBe('money-billing');
    expect(refined.overlays.payment).toBe(true);
    expect(refined.priority).toBe('P3');
    expect(refined.automationState).toBe('candidate');
    expect(refined.humanAction).toBe('payment_or_finance');
    expect(refined.policyFlags).toContain('refine:hospitality-cloud-finance');
  });

  describe('Centurion September 2026 quality fixes', () => {
    it('preserves urgent and manage-stay for Booking.com date change with 12h deadline (Jaco Smit case)', () => {
      const refined = refineTriageOutput(
        {
          from: 'The Centurion Hotel via Booking.com <6181746987-hmrp.xhzk.43en.rdhn@property.booking.com>',
          subject: 'Request to change dates - Jaco Smit',
          body: 'Booking.com Booking number: 6181746987. Request to change dates. Please respond within the next 12 hours. Jaco Smit would like to change dates.',
        },
        workflowOutput({
          primaryFolder: 'manage-stay',
          priority: 'P2',
          urgent: true,
          humanAction: 'amend_or_cancel',
        }),
      );

      expect(refined.primaryFolder).toBe('manage-stay');
      expect(refined.urgent).toBe(true);
      expect(refined.priority).toBe('P2');
      expect(refined.primaryFolder).not.toBe('automated-channel');
    });

    it('routes Penny Mbobo forward of external client RFQ to bookings with quote overlay', () => {
      const refined = refineTriageOutput(
        {
          from: 'Penny Mbobo <pmbobo@legacyhotels.co.za>',
          subject: 'FW: Quotation Request for Accommodation',
          body: 'Good day Bungy,\n\nPlease quote as per the below and attached.\n\nKind regards,\nPenny\n\nFrom: scm@tswelopele.org\nCan you please send me a quotation for accommodation for 1 person. Check in: 27/09/2026.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('bookings');
      expect(refined.overlays.quote).toBe(true);
      expect(refined.suggestedTools).toContain('hms_quote_stay');
      expect(refined.policyFlags).toContain('refine:staff-forwarded-rfq');
      expect(refined.primaryFolder).not.toBe('internal-partner');
    });

    it('routes internal rate mapping discussions without guest stay to internal-partner (Cindy Martin case)', () => {
      const refined = refineTriageOutput(
        {
          from: 'Cindy Martin <cmartin@legacyhotels.co.za>',
          subject: 'Dinner Allowance - Profitroom',
          body: 'Good Afternoon Kamala, We received feedback from Profitroom on how the dinner allowance meal plan works on the booking channel: You will need to set up the rate in INFOR, including the dinner at a specific value. We will then map that specific rate with the dinner included as a package.',
        },
        workflowOutput({
          primaryFolder: 'manage-stay',
        }),
      );

      expect(refined.primaryFolder).toBe('internal-partner');
      expect(refined.policyFlags).toContain('refine:internal-system-mapping');
    });

    it('routes standalone agency travel vouchers to documents-delivery with artifact read tools', () => {
      const refined = refineTriageOutput(
        {
          from: '"Nexus_TravX" <info@nexustravel.co.za>',
          subject: 'Voucher A057096 Nasheley Hammond',
          body: 'Good day, Kindly find the attached voucher for Nasheley Hammond. Kind regards.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('documents-delivery');
      expect(refined.suggestedTools).toEqual(['hms_list_documents']);
      expect(refined.policyFlags).toContain('refine:agency-voucher-delivery');
    });

    it('routes agency travel vouchers with invoice requests to money-billing', () => {
      const refined = refineTriageOutput(
        {
          from: 'Rennies BCD Travel <documents@renniesbcdtravel.com>',
          subject: 'Voucher 0122436 and Tax Invoice request',
          body: 'Good morning Bongi, Please see attached vouchers and assist with invoices for payment. Thank you.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('money-billing');
      expect(refined.overlays.payment).toBe(true);
      expect(refined.suggestedTools).toContain('hms_read_folio');
      expect(refined.policyFlags).toContain('refine:voucher-invoice-request');
    });

    it('routes Tourvest travel agency vouchers without invoice requests to documents-delivery', () => {
      const refined = refineTriageOutput(
        {
          from: 'Serma Du Toit <serma.dutoit@travel.co.za>',
          subject: 'The Centurion Hotel_Confirmation Letter_Hendrik Vermeulen (n°69497118-1)',
          body: 'Good afternoon, Please see voucher attached as guarantee for this booking. Please confirm. Kind regards, Serma Du Toit, Tourvest Travel Services',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('documents-delivery');
      expect(refined.suggestedTools).toContain('hms_list_documents');
      expect(refined.policyFlags).toContain('refine:agency-voucher-delivery');
    });

    it('routes Tourvest travel vouchers with tax invoice requests to money-billing', () => {
      const refined = refineTriageOutput(
        {
          from: 'Livhuwani Tshindane <livhuwani.tshindane@travel.co.za>',
          subject: 'The Centurion Hotel - 110412-24763 - Thursday 3 September 2026',
          body: 'Good day Reservations, Please find attached voucher and kindly send us a tax invoice to facilitate payment. Tourvest Travel Services (Pty) Ltd.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('money-billing');
      expect(refined.overlays.payment).toBe(true);
      expect(refined.suggestedTools).toContain('hms_read_folio');
      expect(refined.policyFlags).toContain('refine:voucher-invoice-request');
    });

    it('routes SynXis Res Confirmed with 48h arrival warning to automated-channel when no reply deadline exists', () => {
      const refined = refineTriageOutput(
        {
          from: 'noreply@synxis.com',
          subject: 'SynXis Res Confirmed (5940SG006899 ) ATTENTION!! Reservation Due to Arrive within 48 hours',
          body: 'The following reservation has been confirmed. Guest: John Doe. Arrival: 02 Sep 2026.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('automated-channel');
      expect(refined.urgent).toBe(false);
      expect(refined.policyFlags).toContain('refine:system-mail-automated');
    });

    it('routes Travelit automated new booking notifications to automated-channel', () => {
      const refined = refineTriageOutput(
        {
          from: 'notifications@travelit.co.za',
          subject: 'New Booking 4795-129046 for Lactalis South Africa Pty Ltd, booking made through Travelit',
          body: 'Booking reference 4795-129046 has been created in Travelit. Check-in 03 Sep 2026.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('automated-channel');
      expect(refined.urgent).toBe(false);
      expect(refined.policyFlags).toContain('refine:system-mail-automated');
    });

    it('routes external job applications to unknown-review at P5', () => {
      const refined = refineTriageOutput(
        {
          from: 'Mukundi Muthambi <mukundimuthambi1990@gmail.com>',
          subject: 'Stock Controller Position Application',
          body: 'Dear Hiring Manager, I would like to formally express my interest in the Stock Controller position at The Centurion Hotel. Attached is my CV.',
        },
        workflowOutput({
          primaryFolder: 'unknown-review',
        }),
      );

      expect(refined.primaryFolder).toBe('unknown-review');
      expect(refined.priority).toBe('P5');
      expect(refined.urgent).toBe(false);
      expect(refined.humanAction).toBe('review_required');
      expect(refined.policyFlags).toContain('refine:job-application');
    });

    it('protects Nedbank payment confirmations from promo spam', () => {
      const refined = refineTriageOutput(
        {
          from: 'epay-noreply@nedbank.co.za',
          subject: 'Nedbank Merchant Payment Confirmation',
          body: 'Click here to view your payment receipt. Special discount rate applied on purchase.',
        },
        workflowOutput({
          primaryFolder: 'money-billing',
          isSpam: false,
        }),
      );

      expect(refined.isSpam).toBe(false);
      expect(refined.primaryFolder).toBe('money-billing');
    });

    it('protects HotelPlanner group RFPs from promo spam', () => {
      const refined = refineTriageOutput(
        {
          from: 'Serena.Golfetto@hotelplanner.com',
          subject: 'Group RFP 15 rooms - Centurion Hotel',
          body: 'Please submit your discount room rate for this group conference booking. Click here to bid.',
        },
        workflowOutput({
          primaryFolder: 'groups-events',
          isSpam: false,
        }),
      );

      expect(refined.isSpam).toBe(false);
      expect(refined.primaryFolder).toBe('groups-events');
    });

    it('routes Hotels.com guest direct messages with mobility/shuttle requests to urgent manage-stay (Kevin Nelson case)', () => {
      const refined = refineTriageOutput(
        {
          from: '0bfde47f-a8f5-44af-90ee-652b583dd90c_415cf5a2-0557-44bb-93f7-fb75eadd1600@m.expediapartnercentral.com',
          subject: 'Hotels.com guest message from Kevin Nelson',
          body: 'The Centurion Hotel Property ID: 526989. Kevin Nelson sent you a message: "Hi I am exited for my stay. I am interested in an airport shuttle. And I have some mobility issues. I use a cane to walk. Is there handles in the bathroom if possible". Reply. © 2026 Expedia, Inc. All rights reserved. I want to unsubscribe from these emails',
        },
        workflowOutput({
          primaryFolder: 'bookings',
          isSpam: true,
          urgent: false,
        }),
      );

      expect(refined.primaryFolder).toBe('manage-stay');
      expect(refined.urgent).toBe(true);
      expect(refined.priority).toBe('P2');
      expect(refined.isSpam).toBe(false);
      expect(refined.humanAction).toBe('amend_or_cancel');
      expect(refined.suggestedTools).toContain('hms_find_reservation');
      expect(refined.policyFlags).toContain('refine:ota-guest-message');
    });

    it('routes Hotels.com guest early check-in inquiries to urgent manage-stay (Mehrez OUESLATI case)', () => {
      const refined = refineTriageOutput(
        {
          from: '0bfde47f-a8f5-44af-90ee-652b583dd90c_1a120791-ec06-456b-8f16-98d495162915@m.expediapartnercentral.com',
          subject: 'Hotels.com guest message from Mehrez OUESLATI',
          body: 'Mehrez OUESLATI sent you a message: "Good day, I have a booking from September 14 to 18th. I Will Land at Johannesburg on September 14th at 8:35. Is it possible to have my room at that time? Thank you". © 2026 Expedia, Inc. I want to unsubscribe',
        },
        workflowOutput({
          primaryFolder: 'bookings',
          isSpam: false,
        }),
      );

      expect(refined.primaryFolder).toBe('manage-stay');
      expect(refined.urgent).toBe(true);
      expect(refined.priority).toBe('P2');
      expect(refined.isSpam).toBe(false);
      expect(refined.policyFlags).toContain('refine:ota-guest-message');
    });

    it('does not route pre-stay subjects without processed-mailbox identity', () => {
      const refined = refineTriageOutput(
        {
          from: 'centurion@legacyhotels.co.za',
          subject: 'Pre Stay : Property HRCEN Confirmation No 14168848-1 Ms Mandi Hattingh',
          body: 'Ms Mandi Hattingh Arrival : 02-09-2026 Departure : 04-09-2026 Room Type : DLXKNG Confirmation No : 14168848-1 Address --> 103 Mosselbank Street Mobile --> 0798805549 Arrival time --> 7:00 PM',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('bookings');
      expect(refined.policyFlags).not.toContain('refine:pre-stay-notification');
    });

    it('routes night audit discrepancy reports from centurionnight to internal-partner', () => {
      const refined = refineTriageOutput(
        {
          from: 'Centurion Hotel Night Auditor <centurionnight@legacyhotels.co.za>',
          subject: 'Credit Limit & Rate Discrepancy Report-30  Aug 2026',
          body: 'Good morning, all Kindly find attached Discrepancy Report. Kind Regards Peter',
        },
        workflowOutput({
          primaryFolder: 'manage-stay',
        }),
      );

      expect(refined.primaryFolder).toBe('internal-partner');
      expect(refined.urgent).toBe(false);
      expect(refined.priority).toBe('P4');
      expect(refined.sourceScope).toBe('internal_property');
      expect(refined.policyFlags).toContain('refine:internal-operations-report');
    });

    it('routes H-Pay payment result notifications forwarded internally to money-billing', () => {
      const refined = refineTriageOutput(
        {
          from: 'Legacy Hotels <hotels@legacyhotels.co.za>',
          subject: 'FW: H-Pay: Payment result for reservation ID 22098684-1',
          body: 'Transaction ID: 442599-F5. Payment result for reservation ID 22098684-1. Amount: ZAR 2,450.00. Status: Successful.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('money-billing');
      expect(refined.overlays.payment).toBe(true);
      expect(refined.suggestedTools).toContain('hms_read_folio');
      expect(refined.policyFlags).toContain('refine:hospitality-cloud-finance');
    });

    it('routes explicit payment confirmations to money-billing with read_folio tool', () => {
      const refined = refineTriageOutput(
        {
          from: 'lerato@ashcortravels.co.za',
          subject: 'BOOKING REQUEST',
          body: 'Good day I have now managed to process the links, payments have been made. Thank you, Ms. Lerato Tshehla',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('money-billing');
      expect(refined.overlays.payment).toBe(true);
      expect(refined.humanAction).toBe('payment_or_finance');
      expect(refined.suggestedTools).toContain('hms_read_folio');
      expect(refined.policyFlags).toContain('refine:payment-confirmation-or-billing');
    });

    it('routes Kyocera printer scans and IT server maintenance notices to internal-partner', () => {
      const scanRefined = refineTriageOutput(
        {
          from: 'scans@legacyhotels.co.za',
          subject: 'Scans',
          body: '------------------- TASKalfa 3253ci [00:17:c8:8c:1e:63] -------------------',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );
      expect(scanRefined.primaryFolder).toBe('internal-partner');
      expect(scanRefined.policyFlags).toContain('refine:internal-operations-report');

      const serverRefined = refineTriageOutput(
        {
          from: 'support@legacyhotels.co.za',
          subject: 'Your Infor HMS interface server will restart at 12h00',
          body: 'Please note that your Infor HMS interface server will be restarted at 12:00. Infor HMS interfaces will be down during this time.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );
      expect(serverRefined.primaryFolder).toBe('internal-partner');
      expect(serverRefined.policyFlags).toContain('refine:internal-system-mapping');
    });

    it('routes guest cancellations with flexible phrasing to exceptions-recovery', () => {
      const refined = refineTriageOutput(
        {
          from: 'carla@2collaborate.co.za',
          subject: 'Re: Bookings for Marianna Seyffert & Samkelo Blom',
          body: 'Good evening You may cancel these two bookings. Thank you Carla',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('exceptions-recovery');
      expect(refined.policyFlags).toContain('refine:booking-cancel-or-release');
    });

    it('routes group RFQs with pax and room counts to groups-events', () => {
      const refined = refineTriageOutput(
        {
          from: 'Leisure3@discoverafricatravel.co.za',
          subject: 'DA11617 Group Accommodation Quote request -40 PAX /15 Rooms',
          body: 'Dear Reservation Team, Hope you are doing well. Please find the required details below: 40 PAX / 15 Rooms for Centurion Hotel.',
        },
        workflowOutput({
          primaryFolder: 'bookings',
        }),
      );

      expect(refined.primaryFolder).toBe('groups-events');
      expect(refined.policyFlags).toContain('refine:groups-events-work');
    });
  });
});

const applyDbAvailable = TEST_DB_AVAILABLE && (await probeTestDb());

describe.skipIf(!applyDbAvailable)('R22 Layer-3 durable apply', () => {
  async function seedUnsettledThread(
    db: DB,
    threadId: string,
    overrides: { spamAt?: Date | null; labelIds?: string[] } = {},
  ) {
    await db.insert(mailThread).values({
      id: threadId,
      transportId: TRANSPORT_ID,
      threadRootId: `<${threadId}@example.com>`,
      subject: 'Triage apply',
      snippet: 'Triage apply',
      latestMessageAt: new Date(),
      spamAt: overrides.spamAt ?? null,
      labelIds: overrides.labelIds ?? [],
    });
  }

  it('FortiMail spam apply sets spamAt and merges Quarantine label', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      await seedUnsettledThread(db, threadId);

      const result = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        output: workflowOutput({
          isSpam: true,
          policyFlags: ['refine:fortimail-spam'],
        }),
      });

      expect(result.applyMode).toBe('full');
      const [thread] = await db
        .select({ spamAt: mailThread.spamAt, labelIds: mailThread.labelIds })
        .from(mailThread)
        .where(eq(mailThread.id, threadId));
      expect(thread?.spamAt).not.toBeNull();

      const [quarantineLabel] = await db
        .select({ id: mailLabel.id })
        .from(mailLabel)
        .where(
          and(eq(mailLabel.transportId, TRANSPORT_ID), eq(mailLabel.name, 'Quarantine')),
        );
      expect(quarantineLabel).toBeDefined();
      expect(thread?.labelIds).toContain(quarantineLabel!.id);
    });
  });

  it('promo spam sets spamAt without Quarantine label', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      await seedUnsettledThread(db, threadId);

      const result = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        output: workflowOutput({
          isSpam: true,
          policyFlags: ['refine:promo-spam'],
        }),
      });

      expect(result.applyMode).toBe('full');
      const [thread] = await db
        .select({ spamAt: mailThread.spamAt, labelIds: mailThread.labelIds })
        .from(mailThread)
        .where(eq(mailThread.id, threadId));
      expect(thread?.spamAt).not.toBeNull();

      const quarantineLabels = await db
        .select({ id: mailLabel.id })
        .from(mailLabel)
        .where(
          and(eq(mailLabel.transportId, TRANSPORT_ID), eq(mailLabel.name, 'Quarantine')),
        );
      expect(quarantineLabels).toHaveLength(0);
      for (const row of quarantineLabels) {
        expect(thread?.labelIds ?? []).not.toContain(row.id);
      }
    });
  });

  it('re-apply promo spam after FortiMail strips Quarantine label', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const quarantineId = randomUUID();
      await db.insert(mailLabel).values({
        id: quarantineId,
        transportId: TRANSPORT_ID,
        name: 'Quarantine',
      });
      await seedUnsettledThread(db, threadId, { labelIds: [quarantineId] });

      await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        output: workflowOutput({
          isSpam: true,
          policyFlags: ['refine:fortimail-spam'],
        }),
      });

      await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        forceUnsettle: true,
        output: workflowOutput({
          isSpam: true,
          policyFlags: ['refine:promo-spam'],
        }),
      });

      const [thread] = await db
        .select({ spamAt: mailThread.spamAt, labelIds: mailThread.labelIds })
        .from(mailThread)
        .where(eq(mailThread.id, threadId));
      expect(thread?.spamAt).not.toBeNull();
      expect(thread?.labelIds ?? []).not.toContain(quarantineId);
    });
  });

  it('non-spam full apply clears spamAt and strips Quarantine label', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const quarantineId = randomUUID();
      await db.insert(mailLabel).values({
        id: quarantineId,
        transportId: TRANSPORT_ID,
        name: 'Quarantine',
      });
      await seedUnsettledThread(db, threadId, {
        spamAt: new Date(),
        labelIds: [quarantineId],
      });

      const result = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        forceUnsettle: true,
        output: workflowOutput({
          isSpam: false,
          primaryFolder: 'unknown-review',
          policyFlags: [],
        }),
      });

      expect(result.applyMode).toBe('full');
      const [thread] = await db
        .select({ spamAt: mailThread.spamAt, labelIds: mailThread.labelIds })
        .from(mailThread)
        .where(eq(mailThread.id, threadId));
      expect(thread?.spamAt).toBeNull();
      expect(thread?.labelIds ?? []).not.toContain(quarantineId);
    });
  });

  it('clears unlocked spamAt and joins internal-partner for forced not-spam', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const [internalPartner] = await db
        .select({ id: mailCategory.id })
        .from(mailCategory)
        .where(
          and(
            eq(mailCategory.transportId, TRANSPORT_ID),
            eq(mailCategory.slug, 'internal-partner'),
          ),
        )
        .limit(1);
      expect(internalPartner?.id).toBeTruthy();

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
      expect(memberships.map((row) => row.categoryId)).toContain(internalPartner!.id);
    });
  });

  it('apply keeps groups-events for legacy From (commercial work not stomped)', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      await seedUnsettledThread(db, threadId);
      const [groupsEvents] = await db
        .select({ id: mailCategory.id })
        .from(mailCategory)
        .where(
          and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'groups-events')),
        )
        .limit(1);
      expect(groupsEvents?.id).toBeTruthy();

      const result = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        forceUnsettle: true,
        from: 'crsa@legacyhotels.co.za',
        output: workflowOutput({
          isSpam: false,
          primaryFolder: 'groups-events',
          policyFlags: ['refine:groups-events-work'],
        }),
      });

      expect(result.applyMode).toBe('full');
      const memberships = await db
        .select({ categoryId: mailThreadCategory.categoryId })
        .from(mailThreadCategory)
        .where(
          and(
            eq(mailThreadCategory.threadId, threadId),
            eq(mailThreadCategory.transportId, TRANSPORT_ID),
          ),
        );
      expect(memberships.map((row) => row.categoryId)).toContain(groupsEvents!.id);
    });
  });
});
