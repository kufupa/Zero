/**
 * Pure deadline admission for HMS read branches.
 * Worst-case queue + login + nav + reads + capture + cleanup must fit run deadline.
 */
import { CLEANUP_RESERVE_MS } from '../ai/run-ledger.js';
import { HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS } from './browser-artifacts.js';

/** Default Playwright/page timeout used for login and navigation budgets. */
const DEFAULT_PAGE_TIMEOUT_MS = 15_000;

/**
 * Documented worst-case components for one read branch under the 150s run deadline.
 * Sum is the constant admission floor; includes CLEANUP_RESERVE_MS.
 */
export const READ_BRANCH_WORST_CASE_COMPONENTS = {
  /** Bounded queue wait before session lock (waiter cap × short wait budget). */
  QUEUE_WAIT_MS: 30_000,
  LOGIN_MS: DEFAULT_PAGE_TIMEOUT_MS,
  NAVIGATION_MS: DEFAULT_PAGE_TIMEOUT_MS,
  /** Find + up to two followup reads under reservation plan caps. */
  READS_MS: 45_000,
  CAPTURE_FINALIZE_MS: HMS_BROWSER_CAPTURE_FINALIZE_TIMEOUT_MS,
  CLEANUP_RESERVE_MS,
} as const;

export const READ_BRANCH_WORST_CASE_MS =
  READ_BRANCH_WORST_CASE_COMPONENTS.QUEUE_WAIT_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.LOGIN_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.NAVIGATION_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.READS_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.CAPTURE_FINALIZE_MS +
  READ_BRANCH_WORST_CASE_COMPONENTS.CLEANUP_RESERVE_MS;

export type AdmitReadBranchCode = 'RUN_DEADLINE' | 'DEADLINE_ADMISSION_REJECTED';

export type AdmitReadBranchResult =
  | { ok: true }
  | { ok: false; code: AdmitReadBranchCode };

export function admitReadBranch(input: {
  deadlineAt: Date;
  now: Date;
  worstCaseMs?: number;
}): AdmitReadBranchResult {
  const worstCaseMs = input.worstCaseMs ?? READ_BRANCH_WORST_CASE_MS;
  const remaining = input.deadlineAt.getTime() - input.now.getTime();
  if (remaining <= 0) {
    return { ok: false, code: 'RUN_DEADLINE' };
  }
  if (remaining < worstCaseMs) {
    return { ok: false, code: 'DEADLINE_ADMISSION_REJECTED' };
  }
  return { ok: true };
}
