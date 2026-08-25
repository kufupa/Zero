import { describe, expect, it } from 'vitest';
import { refineTriageOutput } from '../src/ai/triage.js';

function modelOutput(category: 'at-risk' | 'new-bookings' | 'ops' | 'spam', urgent: boolean) {
  return {
    category,
    urgent,
    confidence: 0.9,
    rationale: 'synthetic model result',
    policyFlags: [],
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
