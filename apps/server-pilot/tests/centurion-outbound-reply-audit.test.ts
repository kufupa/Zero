import {
  assertCenturionAuditRunnerSourceSafe,
  assertCompleteFinalAuditRows,
  buildSemanticReviewWorkItems,
  canonicalizeMessageId,
  classifyCenturionOutboundReply,
  createAuditReference,
  extractCenturionAuditEvidence,
  finalAuditResolutionSchema,
  finalizeDirectAuditRow,
  freezeCenturionIdentitySet,
  mergeSemanticReviewDecisions,
  opaqueAuditRowSchema,
  pageAuditRows,
  renderPrivateManualLinkLedger,
  resolveCenturionHeaderParent,
  semanticReviewerResultSchema,
} from '../src/ops/centurion-outbound-reply-audit';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const sharedMailbox = 'centurion@example.test';

describe('Centurion outbound reply audit', () => {
  it('canonicalizes one bracketed Message-ID', () => {
    expect(canonicalizeMessageId('  <Parent@Example.Test>  ')).toBe('parent@example.test');
    expect(canonicalizeMessageId('<one@example.test> <two@example.test>')).toBeNull();
  });

  it('uses one eligible In-Reply-To parent despite historical References', () => {
    const resolution = resolveCenturionHeaderParent({
      sharedMailbox,
      outboundCreatedAt: '2026-08-01T12:00:00.000Z',
      inReplyTo: '<direct@example.test>',
      references: ['<old@example.test>', '<direct@example.test>'],
      candidates: [
        {
          auditRef: 'audit-00000000-0000-4000-8000-000000000001',
          messageIdHeader: '<direct@example.test>',
          fromAddress: 'guest@example.test',
          direction: 'inbound',
          createdAt: '2026-08-01T11:00:00.000Z',
        },
        {
          auditRef: 'audit-00000000-0000-4000-8000-000000000002',
          messageIdHeader: '<old@example.test>',
          fromAddress: 'guest@example.test',
          direction: 'inbound',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    });

    expect(resolution).toEqual({
      state: 'linked',
      kind: 'in_reply_to',
      parentRef: 'audit-00000000-0000-4000-8000-000000000001',
      candidateCount: 1,
    });
    expect(
      classifyCenturionOutboundReply({
        header: resolution,
        structuralEvidence: 'none',
        correspondentEvidence: false,
        automationEvidence: 'none',
      }),
    ).toMatchObject({
      label: 'gold_header_linked',
      corpusUse: 'paired_evaluation',
      parentRef: 'audit-00000000-0000-4000-8000-000000000001',
    });
  });

  it('uses only the final References token without In-Reply-To', () => {
    const resolution = resolveCenturionHeaderParent({
      sharedMailbox,
      outboundCreatedAt: '2026-08-01T12:00:00.000Z',
      inReplyTo: null,
      references: ['<history@example.test>', '<direct@example.test>'],
      candidates: [
        {
          auditRef: 'audit-00000000-0000-4000-8000-000000000003',
          messageIdHeader: '<direct@example.test>',
          fromAddress: 'guest@example.test',
          direction: 'inbound',
          createdAt: '2026-08-01T11:00:00.000Z',
        },
        {
          auditRef: 'audit-00000000-0000-4000-8000-000000000004',
          messageIdHeader: '<history@example.test>',
          fromAddress: 'guest@example.test',
          direction: 'inbound',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    });

    expect(resolution).toEqual({
      state: 'linked',
      kind: 'references',
      parentRef: 'audit-00000000-0000-4000-8000-000000000003',
      candidateCount: 1,
    });
  });

  it('never accepts an inbound-direction Centurion BCC copy as a parent', () => {
    const resolution = resolveCenturionHeaderParent({
      sharedMailbox,
      outboundCreatedAt: '2026-08-01T12:00:00.000Z',
      inReplyTo: '<bcc-copy@example.test>',
      references: [],
      candidates: [
        {
          auditRef: 'audit-00000000-0000-4000-8000-000000000005',
          messageIdHeader: '<bcc-copy@example.test>',
          fromAddress: sharedMailbox,
          direction: 'inbound',
          createdAt: '2026-08-01T11:00:00.000Z',
        },
      ],
    });

    expect(resolution).toEqual({
      state: 'unresolved',
      kind: 'in_reply_to',
      parentRef: null,
      candidateCount: 0,
    });
  });

  it('rejects every frozen Centurion alias as a direct-header parent', () => {
    const resolution = resolveCenturionHeaderParent({
      sharedMailbox,
      centurionIdentities: [sharedMailbox, 'centurion-alias@example.test'],
      outboundCreatedAt: '2026-08-01T12:00:00.000Z',
      inReplyTo: '<alias-copy@example.test>',
      references: [],
      candidates: [
        {
          auditRef: 'audit-00000000-0000-4000-8000-000000000099',
          messageIdHeader: '<alias-copy@example.test>',
          fromAddress: 'centurion-alias@example.test',
          direction: 'inbound',
          createdAt: '2026-08-01T11:00:00.000Z',
        },
      ],
    });

    expect(resolution).toMatchObject({
      state: 'unresolved',
      parentRef: null,
      candidateCount: 0,
    });
  });

  it('requires a header parent to precede the outbound message event', () => {
    const input: Parameters<typeof resolveCenturionHeaderParent>[0] = {
      sharedMailbox,
      outboundCreatedAt: '2026-08-01T12:00:00.000Z',
      outboundEventAt: '2026-08-01T09:00:00.000Z',
      inReplyTo: '<parent@example.test>',
      references: [],
      candidates: [
        {
          auditRef: 'audit-00000000-0000-4000-8000-000000000098',
          messageIdHeader: '<parent@example.test>',
          fromAddress: 'guest@example.test',
          direction: 'inbound' as const,
          createdAt: '2026-08-01T08:00:00.000Z',
          eventAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    };

    expect(resolveCenturionHeaderParent(input)).toMatchObject({
      state: 'unresolved',
      parentRef: null,
    });
  });

  it('reports exact candidate count for ambiguous direct headers', () => {
    const candidates = ['1', '2', '3'].map((suffix) => ({
      auditRef: `audit-00000000-0000-4000-8000-0000000000${suffix}`,
      messageIdHeader: '<duplicate@example.test>',
      fromAddress: `guest-${suffix}@example.test`,
      direction: 'inbound' as const,
      createdAt: '2026-08-01T11:00:00.000Z',
    }));
    const resolution = resolveCenturionHeaderParent({
      sharedMailbox,
      outboundCreatedAt: '2026-08-01T12:00:00.000Z',
      inReplyTo: '<duplicate@example.test>',
      references: [],
      candidates,
    });

    expect(resolution).toMatchObject({
      state: 'ambiguous',
      candidateCount: 3,
    });
    expect(
      classifyCenturionOutboundReply({
        header: resolution,
        structuralEvidence: 'none',
        correspondentEvidence: false,
        automationEvidence: 'none',
      }),
    ).toMatchObject({
      candidateCount: 3,
      label: 'possible_reply_parent_unknown',
    });
  });

  it('preserves unresolved direct headers as parent-unknown evidence', () => {
    const resolution = resolveCenturionHeaderParent({
      sharedMailbox,
      outboundCreatedAt: '2026-08-01T12:00:00.000Z',
      inReplyTo: '<missing@example.test>',
      references: [],
      candidates: [],
    });

    expect(
      classifyCenturionOutboundReply({
        header: resolution,
        structuralEvidence: 'none',
        correspondentEvidence: false,
        automationEvidence: 'none',
      }),
    ).toMatchObject({
      label: 'possible_reply_parent_unknown',
      classificationState: 'ambiguous',
      corpusUse: 'style_template_only',
    });
  });

  it('classifies old-correspondent evidence without a parent as style-only', () => {
    expect(
      classifyCenturionOutboundReply({
        header: { state: 'absent', kind: null, parentRef: null },
        structuralEvidence: 'none',
        correspondentEvidence: true,
        automationEvidence: 'none',
      }),
    ).toMatchObject({
      label: 'possible_old_correspondent_reply_parent_unknown',
      classificationState: 'ambiguous',
      corpusUse: 'style_template_only',
    });
  });

  it('keeps uncertain automation out of the corpus', () => {
    expect(
      classifyCenturionOutboundReply({
        header: { state: 'absent', kind: null, parentRef: null },
        structuralEvidence: 'none',
        correspondentEvidence: false,
        automationEvidence: 'suspected',
      }),
    ).toMatchObject({
      label: 'unclassifiable',
      classificationState: 'unclassifiable',
      corpusUse: 'exclude',
    });
  });

  it('keeps oversized source material out of the corpus', () => {
    expect(
      classifyCenturionOutboundReply({
        header: { state: 'absent', kind: null, parentRef: null },
        structuralEvidence: 'none',
        correspondentEvidence: false,
        automationEvidence: 'none',
        bodyState: 'too_large',
      }),
    ).toMatchObject({
      label: 'unclassifiable',
      classificationState: 'unclassifiable',
      corpusUse: 'exclude',
    });
  });

  it('extracts one outermost quote marker and bounds oversized input', () => {
    expect(
      extractCenturionAuditEvidence({
        subject: null,
        textBody: 'Thanks.\n\nOn Tuesday, Guest wrote:\n> Previous message',
        htmlBody: '<blockquote><blockquote>History</blockquote></blockquote>',
      }),
    ).toMatchObject({
      structuralEvidence: 'quote_or_reply_marker',
      automationEvidence: 'none',
      bodyState: 'usable',
    });

    expect(
      extractCenturionAuditEvidence({
        subject: null,
        textBody: 'x'.repeat(16),
        htmlBody: null,
        maxChars: 8,
      }),
    ).toMatchObject({
      structuralEvidence: 'none',
      bodyState: 'too_large',
    });
  });

  it('only treats deterministic delivery-status evidence as automation', () => {
    expect(
      extractCenturionAuditEvidence({
        subject: 'Delivery Status Notification (Failure)',
        textBody: 'This is the mail system at host.example.test.',
        htmlBody: null,
      }).automationEvidence,
    ).toBe('delivery_status');

    expect(
      extractCenturionAuditEvidence({
        subject: 'Out of office',
        textBody: 'I am away until Monday.',
        htmlBody: null,
      }).automationEvidence,
    ).toBe('suspected');
  });

  it('uses random per-run opaque references and rejects raw report fields', () => {
    const first = createAuditReference();
    const second = createAuditReference();
    expect(first).toMatch(/^audit-[0-9a-f-]{36}$/);
    expect(second).toMatch(/^audit-[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);

    expect(() =>
      opaqueAuditRowSchema.parse({
        auditRef: first,
        parentRef: null,
        label: 'no_reply_evidence',
        classificationState: 'classified',
        evidence: ['no_signal'],
        reason: 'NO_REPLY_SIGNAL',
        candidateCount: 0,
        corpusUse: 'style_template_only',
        body: 'must be rejected',
      }),
    ).toThrow();
  });

  it('rejects final rows with arbitrary evidence or an unbound header parent', () => {
    const base = {
      auditRef: createAuditReference(),
      relationKind: null,
      method: 'header_in_reply_to' as const,
      corpusUse: 'paired_evaluation' as const,
      reviewReceiptDigest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    expect(() =>
      finalAuditResolutionSchema.parse({
        ...base,
        parentRef: null,
        linkStatus: 'header_confirmed',
        evidence: ['in_reply_to'],
      }),
    ).toThrow('CENTURION_AUDIT_FINAL_HEADER_PARENT_REQUIRED');
    expect(() =>
      finalAuditResolutionSchema.parse({
        ...base,
        parentRef: createAuditReference(),
        linkStatus: 'header_confirmed',
        evidence: ['raw guest name'],
      }),
    ).toThrow();
  });

  it('paginates by the complete created-at and id cursor', () => {
    const rows = [
      { id: 'a', createdAt: '2026-08-01T10:00:00.000Z' },
      { id: 'b', createdAt: '2026-08-01T10:00:00.000Z' },
      { id: 'c', createdAt: '2026-08-01T11:00:00.000Z' },
    ];
    const first = pageAuditRows(rows, null, 2);
    const second = pageAuditRows(rows, first.nextCursor, 2);

    expect(first.rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(second.rows.map((row) => row.id)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
  });

  it('refuses runner source with write or egress paths', () => {
    expect(() => assertCenturionAuditRunnerSourceSafe('db.insert({})')).toThrow(
      'CENTURION_AUDIT_SOURCE_UNSAFE',
    );
    expect(() =>
      assertCenturionAuditRunnerSourceSafe("import { request } from 'node:https';"),
    ).toThrow('CENTURION_AUDIT_SOURCE_UNSAFE');
    for (const unsafeSource of [
      'fetch("https://example.test")',
      'new S3Client({})',
      'worker.enqueue({})',
      'proxy.send({})',
      'mastra.generate({})',
      'telemetry.emit({})',
    ]) {
      expect(() => assertCenturionAuditRunnerSourceSafe(unsafeSource)).toThrow(
        'CENTURION_AUDIT_SOURCE_UNSAFE',
      );
    }
    expect(() =>
      assertCenturionAuditRunnerSourceSafe("import postgres from 'postgres'; await sql`SELECT 1`;"),
    ).not.toThrow();
  });

  it('keeps the production runner to one read-only database session', () => {
    const source = readFileSync(
      new URL('../scripts/audit-centurion-outbound-replies.ts', import.meta.url),
      'utf8',
    );

    expect(() => assertCenturionAuditRunnerSourceSafe(source)).not.toThrow();
    expect(source).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(source).toContain('SHOW transaction_read_only');
    expect(source).toContain('max: 1');
    expect(source).toContain('char_length(m.text_body)');
    expect(source).toContain('CENTURION_AUDIT_MAX_BODY_CHARS');
    expect(source).toContain('CENTURION_AUDIT_SCHEMA_VERSION,');
    expect(source).toContain("'source-ledger.json'");
    expect(source).toContain('statSync');
    expect(source).toContain("'/inheritance:r'");
    expect(source).not.toContain("'/reset'");
    expect(source).toContain('TRANSPORT_ALIASES');
    expect(source).toContain('freezeCenturionIdentitySet');
    expect(source).toContain('buildSemanticReviewWorkItems');
    expect(source).toContain('mergeSemanticReviewDecisions');
    expect(source).toContain('mail_thread');
    expect(source).toContain('mail_draft');
    expect(source).toContain('WITH relevant_drafts AS');
    expect(source).toContain('m.message_id_header');
    expect(source).toContain('participantAddresses');
    expect(source).toContain('jsonb_array_elements_text');
    expect(source).toContain('quotePatterns');
    expect(source).toContain("lower(coalesce(m.subject, ''))");
    expect(source).toContain('LIMIT ${pageSize}');
    expect(source).toContain("expandedContextPath: 'expanded-context.json'");
    expect(source).toContain('assignedReviewerRule');
    expect(source).toContain('digest(sourceLedger)');
    expect(source).toContain('CENTURION_AUDIT_BODY_CHUNK_INVALID');
    expect(source).toContain('CENTURION_AUDIT_REVIEW_RESULT_PATH_INVALID');
    expect(source).toContain('file !== `${result.reviewerId}.json`');
    expect(source).toContain('digest(body) !== chunk.digest');
    expect(source).toContain('recomputedDirectRows');
    expect(source).toContain('identityCount: manifest.identityCount');
    expect(source).toContain('identityDigest: manifest.identityDigest');
    expect(source).toContain('identityAddresses');
    expect(source).toContain('recomputedInitialRows');
    expect(source).toContain('makeParentCandidates(sources)');
    expect(source).toContain("'active-run.lock'");
    expect(source).toContain("'manual-link-ledger.md'");
    expect(source).toContain("flag: 'wx'");
    expect(source).toContain('CENTURION_AUDIT_INCOMPLETE_');
    expect(source).toContain('preparePhase');
    expect(source).toMatch(
      /} catch \{\s+assertRunLockOwner\(outputRoot, runRef\);\s+rmSync\(activeLockPath\(outputRoot\), \{ force: false \}\);/s,
    );
    expect(source.match(/\bpostgres\(/g)).toHaveLength(1);
    expect(source).not.toContain('CENTURION_SHARED_MAILBOX');
  });

  it('freezes a normalized complete Centurion identity inventory', () => {
    const identitySet = freezeCenturionIdentitySet({
      primary: ' Centurion@Example.Test ',
      aliases: ['Centurion+Reservations@Example.Test', 'centurion+groups@example.test'],
    });

    expect(identitySet.addresses).toEqual([
      'centurion@example.test',
      'centurion+groups@example.test',
      'centurion+reservations@example.test',
    ]);
    expect(identitySet.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() =>
      freezeCenturionIdentitySet({
        primary: 'centurion@example.test',
        aliases: ['CENTURION@example.test'],
      }),
    ).toThrow('CENTURION_AUDIT_IDENTITY_DUPLICATE');
  });

  it('orders semantic candidates without allowing self or future parents', () => {
    const outbound = createAuditReference();
    const quotedExternal = createAuditReference();
    const priorStaff = createAuditReference();
    const future = createAuditReference();
    const work = buildSemanticReviewWorkItems({
      runRef: createAuditReference(),
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceLedgerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetRefs: [outbound],
      snapshot: [
        {
          auditRef: quotedExternal,
          createdAt: '2026-08-01T10:00:00.000Z',
          direction: 'inbound',
          isCenturionSender: false,
          subjectDigest: 'sha256:subject',
          participantDigests: ['sha256:guest'],
          threadRef: 'thread-a',
          quotedParentRefs: [],
        },
        {
          auditRef: priorStaff,
          createdAt: '2026-08-01T10:30:00.000Z',
          direction: 'outbound',
          isCenturionSender: true,
          subjectDigest: 'sha256:subject',
          participantDigests: ['sha256:guest'],
          threadRef: 'thread-a',
          quotedParentRefs: [],
        },
        {
          auditRef: outbound,
          createdAt: '2026-08-01T11:00:00.000Z',
          direction: 'outbound',
          isCenturionSender: true,
          subjectDigest: 'sha256:subject',
          participantDigests: ['sha256:guest'],
          threadRef: 'thread-a',
          quotedParentRefs: [quotedExternal],
        },
        {
          auditRef: future,
          createdAt: '2026-08-01T12:00:00.000Z',
          direction: 'inbound',
          isCenturionSender: false,
          subjectDigest: 'sha256:subject',
          participantDigests: ['sha256:guest'],
          threadRef: 'thread-a',
          quotedParentRefs: [],
        },
      ],
    });

    expect(work).toHaveLength(1);
    expect(work[0]!.candidateSet.map((candidate) => candidate.parentRef)).toEqual([
      quotedExternal,
      priorStaff,
    ]);
    expect(work[0]!.expectedManifestRefCount).toBe(4);
    expect(work[0]!.workItemDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('retains an earlier microsecond-resolution semantic parent', () => {
    const parent = createAuditReference();
    const outbound = createAuditReference();
    const [work] = buildSemanticReviewWorkItems({
      runRef: createAuditReference(),
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceLedgerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetRefs: [outbound],
      snapshot: [
        {
          auditRef: parent,
          createdAt: '2026-08-01T10:00:00.123456Z',
          direction: 'inbound',
          isCenturionSender: false,
          subjectDigest: 'sha256:parent',
          participantDigests: ['sha256:guest'],
          threadRef: 'thread-a',
          quotedParentRefs: [],
        },
        {
          auditRef: outbound,
          createdAt: '2026-08-01T10:00:00.123457Z',
          direction: 'outbound',
          isCenturionSender: true,
          subjectDigest: 'sha256:outbound',
          participantDigests: ['sha256:guest'],
          threadRef: 'thread-a',
          quotedParentRefs: [],
        },
      ],
    });

    expect(work!.candidateSet.map((candidate) => candidate.parentRef)).toEqual([parent]);
  });

  it('requires ordered full-manifest receipts before semantic-new finalization', () => {
    const outbound = createAuditReference();
    const context = createAuditReference();
    const snapshot = [
      {
        auditRef: context,
        createdAt: '2026-08-01T10:00:00.000Z',
        direction: 'inbound' as const,
        isCenturionSender: false,
        subjectDigest: 'sha256:context',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
      {
        auditRef: outbound,
        createdAt: '2026-08-01T11:00:00.000Z',
        direction: 'outbound' as const,
        isCenturionSender: true,
        subjectDigest: 'sha256:outbound',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
    ];
    const [work] = buildSemanticReviewWorkItems({
      runRef: createAuditReference(),
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceLedgerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetRefs: [outbound],
      manifestChunkSize: 1,
      snapshot,
    });
    const receipts = work!.manifestChunks.map((chunk, chunkIndex) => ({
      chunkIndex,
      chunkDigest: chunk.digest,
    }));

    expect(
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot,
        workItems: [work!],
        decisions: [
          {
            workItemId: work!.workItemId,
            workItemDigest: work!.workItemDigest,
            reviewerId: 'reviewer-one',
            linkStatus: 'semantic_new',
            parentRef: null,
            relationKind: null,
            method: 'full_corpus_exhausted',
            evidence: ['full_corpus_exhausted'],
            chunkReceipts: receipts,
          },
        ],
      }),
    ).toMatchObject([
      {
        auditRef: outbound,
        linkStatus: 'semantic_new',
        parentRef: null,
      },
    ]);

    expect(() =>
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot,
        workItems: [work!],
        decisions: [
          {
            workItemId: work!.workItemId,
            workItemDigest: work!.workItemDigest,
            reviewerId: 'reviewer-one',
            linkStatus: 'semantic_new',
            parentRef: null,
            relationKind: null,
            method: 'full_corpus_exhausted',
            evidence: ['full_corpus_exhausted'],
            chunkReceipts: [...receipts].reverse(),
          },
        ],
      }),
    ).toThrow('CENTURION_AUDIT_RECEIPT_INVALID');
  });

  it('requires independent exact-parent consensus and rejects future links', () => {
    const outbound = createAuditReference();
    const parent = createAuditReference();
    const future = createAuditReference();
    const snapshot = [
      {
        auditRef: parent,
        createdAt: '2026-08-01T10:00:00.000Z',
        direction: 'inbound' as const,
        isCenturionSender: false,
        subjectDigest: 'sha256:parent',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
      {
        auditRef: outbound,
        createdAt: '2026-08-01T11:00:00.000Z',
        direction: 'outbound' as const,
        isCenturionSender: true,
        subjectDigest: 'sha256:outbound',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
      {
        auditRef: future,
        createdAt: '2026-08-01T12:00:00.000Z',
        direction: 'inbound' as const,
        isCenturionSender: false,
        subjectDigest: 'sha256:future',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
    ];
    const [work] = buildSemanticReviewWorkItems({
      runRef: createAuditReference(),
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceLedgerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetRefs: [outbound],
      snapshot,
    });
    const receipts = work!.manifestChunks.map((chunk, chunkIndex) => ({
      chunkIndex,
      chunkDigest: chunk.digest,
    }));
    const decision = (reviewerId: string, parentRef: string) => ({
      workItemId: work!.workItemId,
      workItemDigest: work!.workItemDigest,
      reviewerId,
      linkStatus: 'semantic_linked' as const,
      parentRef,
      relationKind: 'reply_to_external' as const,
      method: 'candidate_quote_match' as const,
      evidence: ['outermost_quote'] as Array<'outermost_quote'>,
      chunkReceipts: receipts,
    });

    expect(
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot,
        workItems: [work!],
        decisions: [decision('reviewer-one', parent), decision('reviewer-two', parent)],
      }),
    ).toMatchObject([
      {
        auditRef: outbound,
        linkStatus: 'semantic_linked',
        parentRef: parent,
        relationKind: 'reply_to_external',
      },
    ]);
    expect(() =>
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot,
        workItems: [work!],
        decisions: [decision('reviewer-one', future), decision('reviewer-two', future)],
      }),
    ).toThrow('CENTURION_AUDIT_SEMANTIC_PARENT_INVALID');
  });

  it('rejects a decision from an unassigned reviewer identity', () => {
    const outbound = createAuditReference();
    const parent = createAuditReference();
    const snapshot = [
      {
        auditRef: parent,
        createdAt: '2026-08-01T10:00:00.000Z',
        direction: 'inbound' as const,
        isCenturionSender: false,
        subjectDigest: 'sha256:parent',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
      {
        auditRef: outbound,
        createdAt: '2026-08-01T11:00:00.000Z',
        direction: 'outbound' as const,
        isCenturionSender: true,
        subjectDigest: 'sha256:outbound',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
    ];
    const [work] = buildSemanticReviewWorkItems({
      runRef: createAuditReference(),
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceLedgerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetRefs: [outbound],
      snapshot,
    });
    const chunkReceipts = work!.manifestChunks.map((chunk, chunkIndex) => ({
      chunkIndex,
      chunkDigest: chunk.digest,
    }));

    expect(() =>
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot,
        workItems: [work!],
        decisions: [
          {
            workItemId: work!.workItemId,
            workItemDigest: work!.workItemDigest,
            reviewerId: 'reviewer-intruder',
            linkStatus: 'semantic_linked',
            parentRef: parent,
            relationKind: 'reply_to_external',
            method: 'candidate_subject_participants',
            evidence: ['normalized_subject'],
            chunkReceipts,
          },
        ],
      }),
    ).toThrow('CENTURION_AUDIT_REVIEWER_UNASSIGNED');
  });

  it('rejects semantic status and evidence mismatches', () => {
    expect(() =>
      semanticReviewerResultSchema.parse({
        schemaVersion: 1,
        runRef: createAuditReference(),
        reviewerId: 'reviewer-one',
        decisions: [
          {
            workItemId: `work-${createAuditReference()}`,
            workItemDigest:
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            reviewerId: 'reviewer-one',
            linkStatus: 'automation_system',
            parentRef: null,
            relationKind: null,
            method: 'automation_deterministic',
            evidence: ['outermost_quote'],
            chunkReceipts: [
              {
                chunkIndex: 0,
                chunkDigest:
                  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            ],
          },
        ],
      }),
    ).toThrow('CENTURION_AUDIT_REVIEW_AUTOMATION_EVIDENCE_INVALID');
  });

  it('rejects work-item mutation and relation kinds inconsistent with parent ownership', () => {
    const priorStaff = createAuditReference();
    const outbound = createAuditReference();
    const snapshot = [
      {
        auditRef: priorStaff,
        createdAt: '2026-08-01T10:00:00.000Z',
        direction: 'outbound' as const,
        isCenturionSender: true,
        subjectDigest: 'sha256:prior-staff',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
      {
        auditRef: outbound,
        createdAt: '2026-08-01T11:00:00.000Z',
        direction: 'outbound' as const,
        isCenturionSender: true,
        subjectDigest: 'sha256:outbound',
        participantDigests: ['sha256:guest'],
        threadRef: 'thread-a',
        quotedParentRefs: [],
      },
    ];
    const [work] = buildSemanticReviewWorkItems({
      runRef: createAuditReference(),
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceLedgerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetRefs: [outbound],
      snapshot,
    });
    const receipts = work!.manifestChunks.map((chunk, chunkIndex) => ({
      chunkIndex,
      chunkDigest: chunk.digest,
    }));
    const decisions = ['reviewer-one', 'reviewer-two'].map((reviewerId) => ({
      workItemId: work!.workItemId,
      workItemDigest: work!.workItemDigest,
      reviewerId,
      linkStatus: 'semantic_linked' as const,
      parentRef: priorStaff,
      relationKind: 'reply_to_external' as const,
      method: 'candidate_thread_context' as const,
      evidence: ['thread_context'] as Array<'thread_context'>,
      chunkReceipts: receipts,
    }));

    expect(() =>
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot,
        workItems: [work!],
        decisions,
      }),
    ).toThrow('CENTURION_AUDIT_SEMANTIC_RELATION_INVALID');
    expect(() =>
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot,
        workItems: [{ ...work!, shardId: 'shard-0002' }],
        decisions: decisions.map((decision) => ({
          ...decision,
          relationKind: 'reply_to_prior_staff' as const,
        })),
      }),
    ).toThrow('CENTURION_AUDIT_WORK_ITEM_DIGEST_INVALID');

    const inboundStaffSnapshot = [{ ...snapshot[0]!, direction: 'inbound' as const }, snapshot[1]!];
    const [inboundStaffWork] = buildSemanticReviewWorkItems({
      runRef: createAuditReference(),
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceLedgerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetRefs: [outbound],
      snapshot: inboundStaffSnapshot,
    });
    expect(() =>
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot: inboundStaffSnapshot,
        workItems: [inboundStaffWork!],
        decisions: decisions.map((decision) => ({
          ...decision,
          workItemId: inboundStaffWork!.workItemId,
          workItemDigest: inboundStaffWork!.workItemDigest,
          relationKind: 'reply_to_prior_staff' as const,
        })),
      }),
    ).toThrow('CENTURION_AUDIT_SEMANTIC_RELATION_INVALID');

    const outboundExternalSnapshot = [
      { ...snapshot[0]!, direction: 'outbound' as const, isCenturionSender: false },
      snapshot[1]!,
    ];
    const [outboundExternalWork] = buildSemanticReviewWorkItems({
      runRef: createAuditReference(),
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceLedgerDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      targetRefs: [outbound],
      snapshot: outboundExternalSnapshot,
    });
    expect(() =>
      mergeSemanticReviewDecisions({
        expectedOutboundRefs: [outbound],
        snapshot: outboundExternalSnapshot,
        workItems: [outboundExternalWork!],
        decisions: decisions.map((decision) => ({
          ...decision,
          workItemId: outboundExternalWork!.workItemId,
          workItemDigest: outboundExternalWork!.workItemDigest,
          parentRef: priorStaff,
        })),
      }),
    ).toThrow('CENTURION_AUDIT_SEMANTIC_RELATION_INVALID');

    expect(() =>
      semanticReviewerResultSchema.parse({
        schemaVersion: 1,
        runRef: createAuditReference(),
        reviewerId: 'reviewer-one',
        decisions: [],
        rawBody: 'forbidden',
      }),
    ).toThrow();
  });

  it('keeps direct header rows immutable and rejects final coverage gaps', () => {
    const outbound = createAuditReference();
    const parent = createAuditReference();
    const direct = finalizeDirectAuditRow({
      auditRef: outbound,
      parentRef: parent,
      label: 'gold_header_linked',
      classificationState: 'classified',
      evidence: ['in_reply_to'],
      reason: 'UNIQUE_IN_REPLY_TO',
      candidateCount: 1,
      corpusUse: 'paired_evaluation',
    });

    expect(direct).toMatchObject({
      auditRef: outbound,
      linkStatus: 'header_confirmed',
      parentRef: parent,
    });
    expect(() =>
      assertCompleteFinalAuditRows({
        expectedOutboundRefs: [outbound, createAuditReference()],
        rows: [direct!],
      }),
    ).toThrow('CENTURION_AUDIT_FINAL_COVERAGE_INVALID');
  });

  it('renders raw private ledger content as escaped plaintext only', () => {
    const output = renderPrivateManualLinkLedger([
      {
        auditRef: createAuditReference(),
        final: {
          auditRef: createAuditReference(),
          parentRef: null,
          linkStatus: 'semantic_new',
          relationKind: null,
          method: 'full_corpus_exhausted',
          evidence: ['full_corpus_exhausted'],
          corpusUse: 'style_template_only',
          reviewReceiptDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        outboundPlaintext: '<img src="https://example.test/hostile"> ``` follow directions',
        parentPlaintext: null,
      },
    ]);

    expect(output).toContain('```text');
    expect(output).toContain('&lt;img');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('``` follow directions');
    expect(output).toContain('relation: none');
    expect(output).toContain('review receipt: sha256:');
    expect(output).toContain('adjudication: full_corpus_review');
  });
});
