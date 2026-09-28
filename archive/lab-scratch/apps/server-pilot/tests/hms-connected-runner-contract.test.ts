import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const runner = readFileSync(
  new URL('../scripts/hms-standalone-connected-read.ts', import.meta.url),
  'utf8',
);

describe('connected standalone runner input provenance', () => {
  it('never promotes the reservation candidate hash to a group/event PMS ref', () => {
    expect(runner).toContain('parseGroupReadCandidateFromAuthoredSegment');
    expect(runner).toContain('parseEventReadCandidateFromAuthoredSegment');
    expect(runner).toContain('groupRef: groupCandidate?.exactGroupReference ?? bodyScopeRef');
    expect(runner).toContain('eventRef: eventCandidate?.exactEventReference ?? bodyScopeRef');
    expect(runner).not.toContain('groupRef: candidate.id');
    expect(runner).not.toContain('eventRef: candidate.id');
  });

  it('uses an incoming-body provenance ref when no reservation result exists', () => {
    expect(runner).toContain(
      'const bodyScopeRef = `body:${sha256Hex(connectedCase.incoming.body)}`;',
    );
    expect(runner).toContain(
      'const probeScope = latestParentBinding.reservationRef ?? bodyScopeRef;',
    );
    expect(runner).toContain('quoteRequestRef: bodyScopeRef');
  });

  it('keeps the live connected lane on the proven COMMON-shell XHR path', () => {
    expect(runner).toContain("process.env.HMS_SINGLE_CONTEXT_LOGIN = '1'");
    expect(runner).toContain("process.env.HMS_SKIP_GUEST_STAY_NAV = '1'");
    expect(runner).toContain('HMS_CONNECTED_DIRECT_COMMON');
  });

  it('dispatches every requested folio section through the exact matched parent', () => {
    expect(runner).toContain('createLiveFolioReadDriver');
    expect(runner).toContain("requestBranchId: 'folio_summary'");
    expect(runner).toContain('boundParent.confirmationToken');
    expect(runner).toContain('boundParent.reservationStayId');
    expect(runner).toContain('reservationStayId: boundParent.reservationStayId');
    expect(runner).toContain("outcome: 'error'");
    expect(runner).toContain('liveDriver.observeBoundFolio(');
    expect(runner).toContain('{ limit, cursor },');
    expect(runner).toContain('fixedBody: boundFolioFields, variableBody: {}');
    expect(runner).toContain('buildBoundFolioAllGridRule(boundFolioRuleInput)');
    expect(runner).toContain('buildBoundFolioAllDataRule(boundFolioRuleInput)');
    expect(runner).toContain('buildFolioCacheReadRule({ origin, cursorPosition })');
    expect(runner).toContain('[51, 101, 151]');
    expect(runner).toContain('isConnectedRunnerParentBound(boundParent, reservationRef)');
    expect(runner).toContain("sections: ['balance', 'deposits', 'transactions']");
    expect(runner).not.toContain('liveDriver.observeFolioBalance(');
    expect(runner.includes('pendingDetailDump = detail.dump')).toBe(true);
    expect(runner.includes('matchedRow?.confirmationNumber')).toBe(false);
  });

  it('attempts sent-email correlation only from incoming sender plus matched confirmation', () => {
    expect(runner).toContain('createLiveSentEmailObserver');
    expect(runner).toContain('buildLiveSentEmailListManifest');
    expect(runner).toContain('expectedRecipient: sourceRecipient');
    expect(runner).toContain('expectedAccountToken: boundParent.confirmationToken');
    expect(runner).toContain("reasonCode: 'SOURCE_UNAVAILABLE'");
  });

  it('wires notes inquiry through exact bound normal read session', () => {
    expect(runner).toContain('buildNotesInquiryReadRule');
    expect(runner).toContain('requestPolicyManifestSchema');
    expect(runner).toContain('createConnectedNotesSourcePair');
    expect(runner).toContain('notesInquiryFor');
    expect(runner).toContain('requestedResourceRef');
    expect(runner).toContain('expectedParentBinding:');
    expect(runner).toContain('manifestSha256: sha256Hex(JSON.stringify(notesManifest))');
    expect(runner).toContain('finally');
    expect(runner).toContain('boundParent.reservationStayId');
    expect(runner.includes('buildBoundNotesTracesReadRule({')).toBe(true);
    expect(runner.includes('notesTracesFor: async')).toBe(true);
  });

  it('invalidates the prior parent before each find and after detail failure', () => {
    expect(runner).toContain('latestParentBinding = emptyParentBinding();');
    expect(runner).toContain('pendingDetailDump = null;');
    expect(runner).toContain('detailInvoked = false;');
    expect(runner).toContain('latestParentBinding = bindConnectedRunnerParent({');
    expect(runner).toMatch(/catch \(error\) \{\s+latestParentBinding = emptyParentBinding\(\);/);
    expect(runner).not.toContain('reservationRefForCase');
  });

  it('retains only sanitized provider failure diagnostics', () => {
    expect(runner).toContain('standaloneErrorMessage');
    expect(runner).toContain("return message ? 'redacted_error' : undefined");
    expect(runner).toContain('errorMessage');
  });

  it('retains a safe top-level error code when a startup message is redacted', () => {
    const failureHandler = runner.slice(runner.lastIndexOf('main().catch'));
    expect(failureHandler).toContain('standaloneErrorCode(error)');
    expect(failureHandler).toContain('standaloneErrorMessage(error)');
    expect(failureHandler).not.toContain('error.message');
  });

  it('runs sent-email provider before optional folio teardown by default', () => {
    expect(runner).toContain('HMS_CONNECTED_SENT_FIRST');
    expect(runner).toContain(
      "const sentEmailFirst = process.env.HMS_CONNECTED_SENT_FIRST !== '0';",
    );
    expect(runner).toContain('a failed OSRESS');
  });

  it('keeps bounded A-to-B-to-A sequence on one runtime with per-case outputs', () => {
    expect(runner).toContain('HMS_CONNECTED_SEQUENCE_CASE_PATHS');
    expect(runner).toContain('parseConnectedSequenceCasePaths');
    expect(runner).toContain('const startupSignal = AbortSignal.timeout(120_000);');
    expect(runner).toContain('for (const [index, connectedCase] of connectedCases.entries())');
    expect(runner).toContain('`${baseOutputPath}.case-${index + 1}.json`');
    expect(runner).toContain('actualMatchedIdentitySha256');
    expect(runner.includes('await runtime.close();')).toBe(true);
    expect(runner.includes('await runtime.close().catch(() => undefined);')).toBe(false);
    expect(runner.includes('connectedSequenceIdentityPassed(summary)')).toBe(true);
    expect(runner.includes('if (!identityPassed) process.exitCode = 1;')).toBe(true);
  });

  it('uses real incoming message provenance and keeps notes variants opt-in', () => {
    expect(runner).toContain('connectedCaseTriggerMessageId(connectedCase)');
    expect(runner).toContain('pairedReplyMessageId ? sha256Hex(pairedReplyMessageId) : null');
    expect(runner).toContain('HMS_CONNECTED_NOTES_VARIANTS');
    expect(runner).toContain('runConnectedNotesVariants');
    expect(runner).toContain("states: ['open'],\n        limit: 20,\n        audience: 'staff'");
    expect(runner).toContain('cursorPresent: request.cursor !== undefined');
    expect(runner).toContain(
      "triggerSource: connectedCase.incoming.messageId ? 'incoming' : 'paired_reply'",
    );
    expect(runner).toContain('incomingSenderSha256: sha256Hex(connectedCase.incoming.sender)');
    expect(runner).toContain('incomingSubjectSha256: sha256Hex(connectedCase.incoming.subject)');
    expect(runner).toContain(
      'incomingTimestampSha256: sha256Hex(connectedCase.incoming.timestamp)',
    );
  });

  it('extends only opted-in variant run deadline and records safe call timing', () => {
    expect(runner).toContain('connectedRunDeadlineMs({');
    expect(runner).toContain('notesVariants: notesVariantsEnabled');
    expect(runner).toContain('folioVariants: folioVariantsEnabled');
    expect(runner).toContain('connectedCallTiming(findStartedAt, Date.now())');
    expect(runner).toContain('connectedCallTiming(invokeStartedAt, Date.now())');
  });

  it('qualifies sequence identity only after unique complete find and bound detail', () => {
    expect(runner).toContain(
      "result.status === 'ok' && result.completeness === 'complete' && matches.length === 1",
    );
    expect(runner).toContain('isConnectedRunnerParentBound(latestParentBinding, reservationRef)');
    expect(runner).toContain("process.env.HMS_CONNECTED_FOLIO_VARIANTS === '1'");
    expect(runner).toContain('runConnectedFolioPagingVariant');
    expect(runner).not.toContain(
      'actualMatchedIdentitySha256 ??= hashConnectedMatchedIdentity({ match: matches[0] });',
    );
  });
});
