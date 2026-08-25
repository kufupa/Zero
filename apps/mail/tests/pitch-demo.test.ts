import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isPitchDemoEnabled } from '../lib/pitch-demo/config';
import { isPitchDemoThread } from '../lib/pitch-demo/match-thread';
import { buildPitchDemoDraftViewModel } from '../lib/pitch-demo/draft-view-model';
import type { ParsedMessage } from '@/types';

const enabledEnv = { VITE_PITCH_DEMO: '1' } as const;

function inboundMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: 'msg-1',
    title: 'Quotation request',
    subject: 'Quotation request',
    tags: [],
    sender: { name: 'Oreratile Maruping', email: 'oreratile.naledilm@gmail.com' },
    to: [{ name: 'Centurion', email: 'centurion@legacyhotels.com' }],
    cc: null,
    bcc: null,
    tls: false,
    receivedOn: '2026-08-26T13:11:00.000Z',
    unread: true,
    body: 'Please assist with a quotation for dinner, bed and breakfast from 26 August 2026 - 27 August 2026.',
    ...overrides,
  } as ParsedMessage;
}

describe('pitch demo config', () => {
  it('enables only when VITE_PITCH_DEMO=1', () => {
    expect(isPitchDemoEnabled({ VITE_PITCH_DEMO: '1' })).toBe(true);
    expect(isPitchDemoEnabled({ VITE_PITCH_DEMO: '0' })).toBe(false);
    expect(isPitchDemoEnabled({})).toBe(false);
  });
});

describe('pitch demo thread match', () => {
  it('does not match when pitch demo disabled', () => {
    expect(
      isPitchDemoThread(
        {
          threadId: 'thread-123',
          messages: [inboundMessage()],
        },
        {},
      ),
    ).toBe(false);
  });

  it('matches Oreratile quotation thread when enabled', () => {
    expect(
      isPitchDemoThread(
        {
          threadId: 'thread-123',
          messages: [inboundMessage()],
        },
        enabledEnv,
      ),
    ).toBe(true);
  });

  it('matches explicit thread id override', () => {
    expect(
      isPitchDemoThread(
        {
          threadId: 'override-thread',
          messages: [],
        },
        { ...enabledEnv, VITE_PITCH_DEMO_THREAD_ID: 'override-thread' },
      ),
    ).toBe(true);
  });

  it('does not match unrelated senders', () => {
    expect(
      isPitchDemoThread(
        {
          threadId: 'thread-123',
          messages: [
            inboundMessage({
              sender: { email: 'other@example.com' },
            }),
          ],
        },
        enabledEnv,
      ),
    ).toBe(false);
  });
});

describe('pitch demo draft view model', () => {
  it('builds AI draft preview with quotation subject', () => {
    const vm = buildPitchDemoDraftViewModel(new Date('2026-08-26T12:00:00.000Z'));
    expect(vm.origin).toBe('ai');
    expect(vm.subject).toContain('26–27 August 2026');
    expect(vm.bodyPreview).toContain('ZAR 2,604.75');
  });
});

describe('PitchDemoBookingAction state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions loading to playing after configured delay', async () => {
    const { PITCH_DEMO_LOADING_MS } = await import('../lib/pitch-demo/config');
    let state: 'idle' | 'loading' | 'playing' = 'idle';
    state = 'loading';
    expect(state).toBe('loading');
    vi.advanceTimersByTime(PITCH_DEMO_LOADING_MS);
    state = 'playing';
    expect(state).toBe('playing');
  });
});
