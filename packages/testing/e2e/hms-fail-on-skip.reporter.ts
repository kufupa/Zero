import type {
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

/**
 * HMS fixture gate: skipped tests must fail the run (zero-skip policy).
 */
class HmsFailOnSkipReporter implements Reporter {
  private skipped: string[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') {
      this.skipped.push(test.titlePath().join(' › '));
    }
  }

  async onEnd(): Promise<void> {
    if (this.skipped.length === 0) return;
    throw new Error(
      `HMS fixture forbids skipped tests:\n${this.skipped.map((t) => `  - ${t}`).join('\n')}`,
    );
  }
}

export default HmsFailOnSkipReporter;
