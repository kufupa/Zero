import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./e2e/real-mail-launch-readonly.spec.ts', import.meta.url),
  'utf8',
);
const procedureAuditSource = readFileSync(
  new URL('./e2e/read-only-mail-procedure-audit.ts', import.meta.url),
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

const geometrySource = () => {
  const start = source.indexOf("test.describe('message-header geometry'");
  if (start < 0) throw new Error('Could not locate message-header geometry');
  return source.slice(start);
};

describe('real-mail message-header geometry safety contract', () => {
  it('uses only explicit read-only fixture configuration', () => {
    const fixture = sourceBetween(
      'function requireMessageHeaderGeometryFixture()',
      '\nfunction recordReadOnlyMailProcedureAudit',
    );

    expect(source).toContain("process.env.REAL_MAIL_UI_GATE === '1'");
    expect(fixture).toContain("process.env.REAL_MAIL_READ_ONLY !== '1'");
    expect(fixture).toContain('REAL_MAIL_MESSAGE_HEADER_THREAD_ID');
    expect(fixture).toContain('REAL_MAIL_MESSAGE_HEADER_RECIPIENT_MIN_LENGTH');
    expect(fixture).toContain('must be a positive non-PII integer');
    expect(fixture).toContain('return { threadId, recipientMinimumLength }');
  });

  it('proves recipient containment with layout-only measurements', () => {
    const geometry = geometrySource();

    expect(geometry).toContain('recipientSummary.boundingBox()');
    expect(geometry).toContain('element.scrollWidth <= element.clientWidth + 1');
    expect(geometry).toContain('recipientSummaryBox.x');
    expect(geometry).toContain('const recipientSummaryLength = await recipientSummary.evaluate');
    expect(geometry).toContain('return normalized.length;');
    expect(geometry).toContain('typeof recipientSummaryLength');
    expect(geometry).not.toContain('innerText');
  });

  it('requires a real non-overlapping inbox split before geometry proof', () => {
    const geometry = geometrySource();

    expect(geometry).toContain('listPanel.boundingBox()');
    expect(geometry).toContain('const splitPaneWidth = listPanelBox.width + threadPanelBox.width');
    expect(geometry).toContain('listPanelBox.width / splitPaneWidth');
    expect(geometry).toContain('listPanelBox.x + listPanelBox.width');
    expect(geometry).toContain('threadPanelBox.x + tolerance');
  });

  it('requires separate hit targets for each visible reply action', () => {
    const geometry = geometrySource();

    expect(geometry).toContain(
      'for (let firstIndex = 0; firstIndex < actionBoxes.length; firstIndex += 1)',
    );
    expect(geometry).toContain('firstActionBox.x + firstActionBox.width');
    expect(geometry).toContain('secondActionBox.y + secondActionBox.height');
    expect(geometry).toContain('reply action hit targets must not overlap');
  });

  it('uses a dedicated fail-closed mail-path parser without payload inspection', () => {
    const audit = sourceBetween(
      'function recordReadOnlyMailProcedureAudit',
      '\nasync function proveInboxListReady',
    );

    expect(source).toContain(
      "import { trpcMailProcedureNamesFromUrl } from './read-only-mail-procedure-audit';",
    );
    expect(audit).toContain('unclassified-mail-surface');
    expect(audit).toContain('mail.markAsRead');
    expect(audit).toContain('PAGE_REQUIRED_READ_ONLY_MAIL_PROCEDURES');
    expect(audit).not.toContain('postData');
    expect(audit).not.toContain('requestText');
    expect(procedureAuditSource).toContain('hasUnclassifiedMailSurface');
    expect(procedureAuditSource).toContain('decodeURIComponent(rawProcedurePath)');
    expect(procedureAuditSource).not.toContain('postData');
    expect(procedureAuditSource).not.toContain('requestText');
  });

  it('waits for tracked mail requests to settle before certifying read-only behavior', () => {
    const audit = sourceBetween(
      'function recordReadOnlyMailProcedureAudit',
      '\nasync function proveInboxListReady',
    );
    const geometry = geometrySource();

    expect(audit).toContain('inFlightMailRequests');
    expect(audit).toContain("page.on('requestfinished'");
    expect(audit).toContain("page.on('requestfailed'");
    expect(geometry).toContain('waitForReadOnlyMailProcedureAuditToSettle(procedureAudit)');
  });
});
