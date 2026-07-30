import { describe, expect, it } from 'vitest';
import * as demoRuntime from '../lib/demo/runtime';

type MailSendInput = Record<string, unknown>;

type BuildMailSendInput = <T extends MailSendInput>(
  input: T,
  options: { frontendOnlyDemo: boolean; fromEmail: string },
) => T & { fromEmail?: string };

function buildMailSendInput<T extends MailSendInput>(
  input: T,
  options: { frontendOnlyDemo: boolean; fromEmail: string },
): T & { fromEmail?: string } {
  const helper = (
    demoRuntime as typeof demoRuntime & {
      buildMailSendInput?: BuildMailSendInput;
    }
  ).buildMailSendInput;

  if (!helper) {
    throw new Error('buildMailSendInput is not implemented');
  }
  return helper(input, options);
}

const sendPaths = [
  {
    path: 'compose',
    input: {
      to: [{ email: 'guest@example.test' }],
      subject: 'Booking',
      message: '<p>Hello</p>',
    },
  },
  {
    path: 'reply',
    input: {
      to: [{ email: 'guest@example.test' }],
      subject: 'Re: Booking',
      message: '<p>Reply</p>',
      replyToMessageId: 'message-1',
      isForward: false,
    },
  },
  {
    path: 'forward',
    input: {
      to: [{ email: 'guest@example.test' }],
      subject: 'Fwd: Booking',
      message: '<p>Forward</p>',
      replyToMessageId: 'message-1',
      isForward: true,
    },
  },
] as const;

describe('mail send input sender identity', () => {
  it.each(sendPaths)('$path live input omits fromEmail', ({ input }) => {
    const result = buildMailSendInput(input, {
      frontendOnlyDemo: false,
      fromEmail: 'Local Name <local@example.test>',
    });

    expect(result).toMatchObject(input);
    expect(result).not.toHaveProperty('fromEmail');
  });

  it.each(sendPaths)('$path frontend-only demo input includes fromEmail', ({ input }) => {
    const result = buildMailSendInput(input, {
      frontendOnlyDemo: true,
      fromEmail: 'Local Name <local@example.test>',
    });

    expect(result).toMatchObject(input);
    expect(result).toHaveProperty(
      'fromEmail',
      'Local Name <local@example.test>',
    );
  });
});
