import { describe, expect, it } from 'vitest';
import { MAIL_ARTIFACT_BACKTEST_PHASE } from '../src/ops/mail-artifact-backtest.js';

describe('mail artifact backtest placeholder', () => {
  it('stays blocked until Gate G1', () => {
    expect(MAIL_ARTIFACT_BACKTEST_PHASE).toBe('blocked_until_g1');
  });
});
