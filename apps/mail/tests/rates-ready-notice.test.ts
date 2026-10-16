import { describe, expect, it, vi } from 'vitest';
import {
  canOpenRatesReadyMail,
  openRatesReadyMail,
  ratesReadyNotices,
  ratesReadyToastTitle,
  type OwnStaffQuoteJob,
} from '../lib/quote-workflow/rates-ready-notice';

const A: OwnStaffQuoteJob = {
  runId: 'job-a',
  status: 'running',
  messageId: 'mail-a',
  threadId: 'thread-a',
  emailKey: '<a@example.invalid>',
  subject: 'Suite for Friday',
  entryId: 'entry-a',
  refused: false,
};

const other = { openMessageId: 'mail-b', openEmailKey: '<b@example.invalid>', notifiedIds: new Set<string>() };

describe('rates ready notice', () => {
  it('toasts once when a job on another mail becomes terminal', () => {
    const first = ratesReadyNotices({ prev: [A], next: [{ ...A, status: 'done' }], ...other });
    expect(first).toEqual([
      { runId: 'job-a', title: 'Rates ready · Suite for Friday', threadId: 'thread-a', entryId: 'entry-a' },
    ]);
    expect(ratesReadyToastTitle({ refused: false, subject: 'Suite for Friday' })).toBe(
      'Rates ready · Suite for Friday',
    );
    expect(
      ratesReadyNotices({
        prev: [{ ...A, status: 'done' }],
        next: [{ ...A, status: 'done' }],
        ...other,
        notifiedIds: new Set(['job-a']),
      }),
    ).toEqual([]);
    expect(
      ratesReadyNotices({
        prev: [A],
        next: [{ ...A, status: 'done', refused: true }],
        ...other,
      })[0]?.title,
    ).toBe('HMS answered · Suite for Friday');
    expect(ratesReadyToastTitle({ refused: true, subject: 'Suite for Friday' })).toBe(
      'HMS answered · Suite for Friday',
    );
    expect(ratesReadyNotices({ prev: [], next: [{ ...A, status: 'done' }], ...other })[0]?.runId).toBe('job-a');
  });

  it('does not toast a job already marked notified', () => {
    expect(
      ratesReadyNotices({
        prev: [],
        next: [{ ...A, status: 'done' }],
        ...other,
        notifiedIds: new Set(['job-a']),
      }),
    ).toEqual([]);
  });

  it('does not toast the open mail', () => {
    const done = { ...A, status: 'done' as const };
    expect(
      ratesReadyNotices({
        prev: [A],
        next: [done],
        openMessageId: 'mail-a',
        openEmailKey: '<x>',
        notifiedIds: new Set(),
      }),
    ).toEqual([]);
    expect(
      ratesReadyNotices({
        prev: [],
        next: [done],
        openMessageId: 'mail-b',
        openEmailKey: '<a@example.invalid>',
        notifiedIds: new Set(),
      }),
    ).toEqual([]);
  });

  it('opens webmail via onOpenThread and Outlook via displayMessageForm when present', () => {
    const onOpenThread = vi.fn();
    const displayMessageForm = vi.fn();
    openRatesReadyMail({ threadId: 'thread-a', entryId: 'entry-a' }, { onOpenThread, displayMessageForm });
    expect(onOpenThread).toHaveBeenCalledWith('thread-a');
    openRatesReadyMail({ threadId: 'thread-a', entryId: 'entry-a' }, { displayMessageForm });
    expect(displayMessageForm).toHaveBeenCalledWith('entry-a');
    expect(canOpenRatesReadyMail({})).toBe(false);
    expect(canOpenRatesReadyMail({ onOpenThread })).toBe(true);
  });
});
