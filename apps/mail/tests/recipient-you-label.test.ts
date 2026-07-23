import { describe, expect, it } from 'vitest';
import { shouldCollapseRecipientToYou } from '../lib/mail/recipient-you-label';

describe('shouldCollapseRecipientToYou', () => {
  const mailbox = 'navaai@legacyhotels.co.za';

  it('collapses To → You for inbound mail addressed to the active mailbox', () => {
    expect(
      shouldCollapseRecipientToYou({
        folder: 'inbox',
        to: [{ email: mailbox }],
        ccLength: 0,
        mailboxEmail: mailbox,
        fromEmail: 'aroransh17@gmail.com',
      }),
    ).toBe(true);
  });

  it('does not collapse external recipient to You when viewing outbound in inbox', () => {
    // Sent from navaai → aroransh while thread opened under inbox must show real To.
    expect(
      shouldCollapseRecipientToYou({
        folder: 'inbox',
        to: [{ email: 'aroransh17@gmail.com' }],
        ccLength: 0,
        mailboxEmail: mailbox,
        fromEmail: mailbox,
      }),
    ).toBe(false);
  });

  it('never collapses when from is the mailbox (sent-by-me), even if to is mailbox', () => {
    // Self-send / outbound viewed in inbox must not read as "To: You".
    expect(
      shouldCollapseRecipientToYou({
        folder: 'inbox',
        to: [{ email: mailbox }],
        ccLength: 0,
        mailboxEmail: mailbox,
        fromEmail: mailbox,
      }),
    ).toBe(false);
  });

  it('never collapses in sent folder', () => {
    expect(
      shouldCollapseRecipientToYou({
        folder: 'sent',
        to: [{ email: mailbox }],
        ccLength: 0,
        mailboxEmail: mailbox,
        fromEmail: 'aroransh17@gmail.com',
      }),
    ).toBe(false);
  });

  it('does not collapse when multiple recipients', () => {
    expect(
      shouldCollapseRecipientToYou({
        folder: 'inbox',
        to: [{ email: mailbox }, { email: 'other@example.com' }],
        ccLength: 0,
        mailboxEmail: mailbox,
        fromEmail: 'aroransh17@gmail.com',
      }),
    ).toBe(false);
  });

  it('matches mailbox email case-insensitively', () => {
    expect(
      shouldCollapseRecipientToYou({
        folder: 'inbox',
        to: [{ email: 'NavaAI@LegacyHotels.co.za' }],
        ccLength: 0,
        mailboxEmail: mailbox,
        fromEmail: 'aroransh17@gmail.com',
      }),
    ).toBe(true);
  });
});
