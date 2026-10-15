import { describe, expect, it } from 'vitest';
import { NO_ACTION_SOP } from '../src/ai/aop/no-action-sop.js';

describe('NO_ACTION_SOP', () => {
  it('starts with Applies only when', () => {
    expect(NO_ACTION_SOP.startsWith('Applies only when')).toBe(true);
  });
});
