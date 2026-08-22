import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./e2e/real-mail-compose-close-honesty.spec.ts', import.meta.url),
  'utf8',
);

const sourceBetween = (start: string, end: string) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Could not locate ${start}`);
  }

  return source.slice(startIndex, endIndex);
};

describe('real-mail reply viewport safety contract', () => {
  it('requires explicitly configured disposable mail resources', () => {
    expect(source).toContain("process.env.REAL_MAIL_UI_GATE === '1'");
    expect(source).toContain("process.env.REAL_MAIL_READ_ONLY === '0'");
    expect(source).toContain('REAL_MAIL_REPLY_VIEWPORT_THREAD_ID');
    expect(source).toContain('REAL_MAIL_REPLY_VIEWPORT_DRAFT_ID');
    expect(source).toContain('REAL_MAIL_REPLY_VIEWPORT_DRAFT_MARKER');
    expect(source).toContain(
      'requires an explicit dedicated thread, disposable draft ID, and draft marker',
    );
    expect(source).toContain('await openU3DedicatedThread(page, testThreadId);');
    expect(source).toContain(
      'await expectU3TestDraft(page, reply.composer, testDraftId, testDraftMarker);',
    );
    expect(source).toContain(
      'await expectU3TestDraft(page, replyAll.composer, testDraftId, testDraftMarker);',
    );
  });

  it('uses browser actionability checks for U3 reply controls', () => {
    const clickHelper = sourceBetween(
      'async function clickVisibleU3RoleButton',
      '\nasync function openReply',
    );

    expect(clickHelper).toContain('await candidate.click({ timeout: 1_000 });');
    expect(clickHelper).not.toContain('candidate.evaluate');
  });

  it('deletes only the configured draft after a successful request', () => {
    const cleanup = sourceBetween(
      'async function discardU3ReplyDraft',
      "\ntest.describe('real-mail compose-close honesty'",
    );

    expect(cleanup).toContain('await expectU3DraftId(page, expectedDraftId);');
    expect(cleanup).toContain('isExpectedU3DraftDeleteRequest(res.request(), expectedDraftId)');
    expect(source).toContain('new URL(request.url()).pathname.endsWith(\'/drafts.delete\')');
    expect(source).toContain(
      'trpcDraftIdFromRequestPayload(JSON.parse(postData) as unknown) === expectedDraftId',
    );
    expect(cleanup).toContain('await expect(editor).toContainText(expectedDraftMarker');
    expect(cleanup).toContain('await editor.click();');
    expect(cleanup).toContain('await discard.click();');
    expect(cleanup).toContain(
      "expect(deleteResponse.ok(), 'reply draft deletion request must succeed').toBe(true);",
    );
    expect(cleanup).toContain('.not.toBe(expectedDraftId);');
  });
});
