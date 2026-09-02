import { buildDashboard } from '../src/ops/nava-fte-dashboard';
import {
  advanceLogStream,
  applyDemoEvents,
  buildDemoAgents,
  buildDemoTimeline,
  demoTimelineDurationMs,
  flushLogStream,
  initialDemoState,
  renderDemoBoard,
  renderIdleBoard,
} from '../src/ops/nava-demo-script';
import { navaWordmark } from '../src/ops/nava-fte-dashboard-view';
import { NAVA_HOURS_CAVEAT, type NavaHoursStats } from '../src/ops/nava-fte-hours';
import { describe, expect, it } from 'vitest';

const hours: NavaHoursStats = {
  asOf: '2026-08-25T22:24:55.657Z',
  threadCount: 2403,
  threadsWithOutbound: 301,
  inboundOnlyThreads: 2102,
  nEligibleFirstResponse: 77,
  medianFirstResponseMinutes: 42,
  p90FirstResponseMinutes: 180,
  droppedNegativeOrMissing: 3,
  caveat: NAVA_HOURS_CAVEAT,
};

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('nava-demo-script auto-replay', () => {
  const dashboard = buildDashboard(hours);

  it('wordmark reads NAVA', () => {
    const plain = stripAnsi(navaWordmark());
    expect(plain.split('\n')[0]!.startsWith('██   ██')).toBe(true);
    expect(plain).not.toContain('MAVA');
  });

  it('idle board explains corpus and waits for Enter — no mix yet', () => {
    const { board, footer } = renderIdleBoard(dashboard);
    const plain = stripAnsi(board);
    expect(plain).toContain('What is loaded');
    expect(plain).toContain('3268');
    expect(plain).toContain('+164 msgs');
    expect(plain).toContain('Press Enter to run Nava analysis');
    expect(plain).not.toContain('stay-human-at-risk');
    expect(footer).toContain('Enter start analysis');
    expect(footer).not.toContain('Gemini');
  });

  it('timeline spans medium duration and finishes on dash', () => {
    const events = buildDemoTimeline();
    const duration = demoTimelineDurationMs(events);
    expect(duration).toBeGreaterThanOrEqual(30_000);
    expect(duration).toBeLessThanOrEqual(50_000);
    expect(events.some((e) => e.kind === 'finish')).toBe(true);
    expect(buildDemoAgents().length).toBeGreaterThanOrEqual(20);

    let state = { ...initialDemoState(), phase: 'running' as const };
    state = applyDemoEvents(state, events, -1, duration);
    expect(state.phase).toBe('dash');
    expect(state.logs.some((line) => /2403/.test(line))).toBe(true);
    expect(state.logs.some((line) => /Delta since last run/.test(line))).toBe(true);
    expect(state.logs.some((line) => /Loop 0[1-6]/.test(line))).toBe(true);
    expect(state.agents.filter((a) => a.status === 'done').length).toBeGreaterThan(10);
  });

  it('mid-run board shows parallel agents without requiring Enter', () => {
    const events = buildDemoTimeline();
    let state = { ...initialDemoState(), phase: 'running' as const };
    state = applyDemoEvents(state, events, -1, 12_000);
    const { board, footer } = renderDemoBoard(dashboard, state);
    const plain = stripAnsi(board);
    expect(plain).toContain('Sub-agents');
    expect(plain).toMatch(/batch-00[1-6]/);
    expect(footer).toContain('analysis running');
    expect(footer).not.toContain('Enter deploy');
  });

  it('live notes typewriter reveals chars then flushes on finish', () => {
    let state = {
      ...initialDemoState(),
      phase: 'running' as const,
      streamQueue: ['Delta since last run: +164 messages'],
    };
    state = advanceLogStream(state, 50, 80);
    expect(state.logs.length).toBe(0);
    expect(state.streamLine).toContain('Delta');
    expect(state.streamChars).toBeGreaterThan(0);
    expect(state.streamChars).toBeLessThan(state.streamLine!.length);

    const { board } = renderDemoBoard(dashboard, state);
    expect(stripAnsi(board)).toContain('Live notes');
    expect(stripAnsi(board)).toContain('▌');

    state = flushLogStream(state);
    expect(state.logs[0]).toContain('+164');
    expect(state.streamLine).toBeNull();
  });

  it('dash board includes Hermes families and no fake money', () => {
    const { board, footer } = renderDemoBoard(dashboard, {
      ...initialDemoState(),
      phase: 'dash',
    });
    const plain = stripAnsi(board);
    expect(plain).toContain('security_quarantine');
    expect(plain).toContain('payment_gateway_pop');
    expect(plain).toContain('stay-human-at-risk');
    expect(plain).toContain('SynXis');
    expect(plain).toContain(NAVA_HOURS_CAVEAT);
    expect(plain).not.toContain('£');
    expect(plain).not.toContain('FTE hours saved');
    expect(footer).toContain('Enter open live chat');
  });
});
