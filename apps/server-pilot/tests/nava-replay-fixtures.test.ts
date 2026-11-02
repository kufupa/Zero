import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Fixture = {
  version: number;
  sourceSha256: string;
  cases: Array<{
    id: string;
    workflow: string;
    threadId: string;
    messageId: string;
    staffReplyMessageId: string;
    expected: { readAs: string; staffEvidence: string; coverage: string; artifactPolicy: Record<string, unknown> };
  }>;
};
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/nava-replay-staff.json', import.meta.url)), 'utf8')) as Fixture;

describe('historical replay fixture manifest', () => {
  it('keeps independent staff-evidence cases for every pilot workflow', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(fixture.cases.map((item) => item.id)).size).toBe(fixture.cases.length);
    for (const workflow of ['triage', 'quote', 'create', 'filing', 'amend']) {
      const cases = fixture.cases.filter((item) => item.workflow === workflow);
      expect(cases).toHaveLength(3);
      expect(new Set(cases.map((item) => item.threadId)).size).toBe(3);
      for (const item of cases) {
        expect(item.threadId).toMatch(/^[0-9a-f-]{36}$/);
        expect(item.messageId).toMatch(/^[0-9a-f-]{36}$/);
        expect(item.staffReplyMessageId).toMatch(/^[0-9a-f-]{36}$/);
        expect(item.messageId).not.toBe(item.staffReplyMessageId);
        expect(item.expected.readAs).toBeTruthy();
        expect(item.expected.staffEvidence).toBeTruthy();
        expect(item.expected.coverage).toBeTruthy();
        expect(item.expected.artifactPolicy).toBeTruthy();
      }
    }
  });
});
