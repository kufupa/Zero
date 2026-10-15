import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('HMS lane claim order', () => {
  it('ranks staff_quote above other user reads after priority', () => {
    const source = readFileSync(new URL('../src/ai/run-ledger.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /orderBy\(\s*desc\(aiWorkflowRun\.priority\),\s*desc\(sql`CASE WHEN \$\{aiWorkflowRun\.readRequest\}->>'kind' = 'staff_quote' THEN 1 ELSE 0 END`\),\s*aiWorkflowRun\.createdAt/,
    );
  });
});
