import { clearTimeout, setTimeout } from 'node:timers';

export type BudgetClock = { now(): number; schedule(callback: () => void, delayMs: number): () => void };
const systemClock: BudgetClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** A case-local product read budget; only evaluator-only metadata work may suspend it. */
export class PausableBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private remainingMs: number;
  private activeSince: number;
  private pausedSince = 0;
  private pausedMs = 0;
  private depth = 0;
  private cancelTimer: (() => void) | undefined;
  private disposed = false;

  constructor(readonly budgetMs: number, private readonly clock: BudgetClock = systemClock) {
    if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new RangeError('Invalid candidate read budget');
    this.signal = this.controller.signal;
    this.remainingMs = budgetMs;
    this.activeSince = clock.now();
    this.arm();
  }

  private charge(now: number) {
    this.remainingMs = Math.max(0, this.remainingMs - Math.max(0, now - this.activeSince));
    this.activeSince = now;
  }

  private arm() {
    if (this.disposed || this.signal.aborted || this.depth) return;
    if (this.remainingMs <= 0) {
      this.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      return;
    }
    this.cancelTimer = this.clock.schedule(() => {
      this.cancelTimer = undefined;
      this.charge(this.clock.now());
      this.arm();
    }, this.remainingMs);
  }

  /** The returned idempotent release resumes the shared budget after the last nested suspension. */
  pause(): () => void {
    if (this.disposed || this.signal.aborted) return () => {};
    const now = this.clock.now();
    if (this.depth === 0) {
      this.charge(now);
      this.cancelTimer?.();
      this.cancelTimer = undefined;
      if (this.remainingMs <= 0) { this.arm(); return () => {}; }
      this.pausedSince = now;
    }
    this.depth++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.disposed || !this.depth) return;
      if (--this.depth === 0) {
        const finished = this.clock.now();
        this.pausedMs += Math.max(0, finished - this.pausedSince);
        this.activeSince = finished;
        this.arm();
      }
    };
  }

  dispose() {
    if (this.disposed) return;
    const now = this.clock.now();
    if (this.depth) this.pausedMs += Math.max(0, now - this.pausedSince);
    else if (!this.signal.aborted) this.charge(now);
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.disposed = true;
  }

  snapshot() {
    const now = this.clock.now();
    const remainingMs = this.disposed || this.signal.aborted || this.depth ? this.remainingMs
      : Math.max(0, this.remainingMs - Math.max(0, now - this.activeSince));
    return { budgetMs: this.budgetMs, activeMs: this.budgetMs - remainingMs,
      pausedMs: this.pausedMs + (this.depth && !this.disposed ? Math.max(0, now - this.pausedSince) : 0),
      expired: this.signal.aborted, disposed: this.disposed };
  }
}
