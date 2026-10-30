/**
 * Phase-A live proof CLI + ops front-door contracts (no pilot RDS).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  acquireHmsOperationLock,
  isFreshProof,
  rankExactMailCandidates,
  runAcceptG1,
  selectLatestInboundProofRows,
  validateRequestRuleCounts,
  type ProofCandidateMailRow,
} from '../src/ops/hms-live-proof.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('hms live proof Phase A contracts', () => {
  const mailRow = (
    id: string,
    subject: string,
    receivedAt: string,
    options: Partial<
      Pick<ProofCandidateMailRow, 'threadId' | 'direction' | 'createdAt'>
    > = {},
  ): ProofCandidateMailRow => ({
    id,
    threadId: options.threadId ?? `thread-${id}`,
    transportId: 'transport-centurion',
    textBody: null,
    htmlBody: null,
    subject,
    receivedAt: new Date(receivedAt),
    sentAt: null,
    direction: options.direction ?? 'inbound',
    createdAt: options.createdAt ?? null,
  });

  it('proof-video is a registered remote action with no lookup argv', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    expect(proof).toMatch(/action !== 'proof-video'/);
    expect(proof).toMatch(/runProofVideo/);
    expect(proof).toMatch(/createCandidateTools/);
    expect(proof).toMatch(/createPhaseAProofRuntime/);
    expect(
      readFileSync(join(here, '..', 'src', 'ops', 'hms-proof-composition.ts'), 'utf8'),
    ).toMatch(/createProductionHmsProofRuntime/);
    expect(
      readFileSync(join(here, '..', 'src', 'ai', 'worker.ts'), 'utf8'),
    ).not.toMatch(/createProductionHmsProofRuntime|createHmsLiveProofRuntime/);
    expect(proof).toMatch(/hms_find_reservation/);
    expect(proof).toMatch(/executionClass: 'live_proof'/);
    expect(proof).toMatch(/assertNoLookupArgv/);
    expect(proof).toMatch(/argv\.length !== 1/);
    expect(proof).toMatch(/OperatorExit/);
    expect(proof).toMatch(/throw new OperatorExit/);
    expect(proof).toMatch(/PHASE_A_PROOF_READY/);
    expect(proof).toMatch(/playwright-1\.63\.0-chromium-1243/);
  });

  it(
    'emits one failure line for a pre-dispatch operator exit',
    () => {
      const serverPilot = join(here, '..');
      const proof = join(serverPilot, 'src', 'ops', 'hms-live-proof.ts');
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', proof, 'invalid-action'],
        {
          cwd: serverPilot,
          encoding: 'utf8',
          env: {
            ...process.env,
            DATABASE_URL: '',
            VITEST_ALLOW_PILOT_RDS: '',
          },
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(10);
      expect(output.match(/HMS_FAIL code=UNKNOWN_SAFE/g)).toHaveLength(1);
    },
    20_000,
  );

  it('defers terminal output until DB and operation-lock cleanup succeeds', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    const waitBody = proof.slice(
      proof.indexOf('function emitWait('),
      proof.indexOf('function emitG1Wait('),
    );
    const failBody = proof.slice(
      proof.indexOf('function emitFail('),
      proof.indexOf('function assertNoLookupArgv('),
    );
    expect(waitBody).not.toMatch(/process\.stdout\.write/);
    expect(failBody).not.toMatch(/process\.stdout\.write/);
    expect(proof.indexOf('await closeDb()')).toBeLessThan(
      proof.indexOf('process.stdout.write(`${operatorExit.line}\\n`)'),
    );
    expect(proof.indexOf('releaseOperationLock?.()')).toBeLessThan(
      proof.indexOf('process.stdout.write(`${operatorExit.line}\\n`)'),
    );
  });

  it('discovers proof candidates beyond oldest-250 and includes outbound n° subjects', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    expect(proof).toMatch(/limit = 24/);
    expect(proof).toMatch(/maxRows = 5000/);
    expect(proof).toMatch(/eq\(message\.transportId, transportId\)/);
    expect(proof).toMatch(/coalesce[\s\S]*receivedAt[\s\S]*sentAt/i);
    expect(proof).toMatch(/\\d\{6,14\}-\\d\{1,4\}/);
    expect(proof).not.toMatch(/limit = 12,\s*maxRows = 250/);
    expect(proof).not.toMatch(
      /catch \(err\)[\s\S]{0,260}mapRuntimeFail\(err\)[\s\S]{0,80}continue;/,
    );
  });

  it('walks all 5,000 rows and prioritizes n° candidates oldest-first', () => {
    const rows: ProofCandidateMailRow[] = Array.from(
      { length: 4_997 },
      (_, index) =>
        mailRow(
          `empty-${String(index).padStart(4, '0')}`,
          '',
          '2026-01-01T00:00:00.000Z',
        ),
    );
    rows.push(
      mailRow(
        'ndeg-later',
        'Reservation confirmation n°12345678-2',
        '2026-01-03T00:00:00.000Z',
      ),
      mailRow(
        'generic-oldest',
        'Confirmation: CONF-1001',
        '2026-01-01T00:00:00.000Z',
      ),
      mailRow(
        'ndeg-oldest',
        'Reservation confirmation n°12345678-1',
        '2026-01-02T00:00:00.000Z',
      ),
    );

    const selected = rankExactMailCandidates(rows, 24);
    expect(selected.slice(0, 2).map((item) => item.messageId)).toEqual([
      'ndeg-oldest',
      'ndeg-later',
    ]);
    expect(selected[0]?.candidate.value).toBe('12345678-1');
    expect(selected.some((item) => item.messageId === 'generic-oldest')).toBe(
      true,
    );
  });

  it('deduplicates ranked candidates and enforces the proof cap', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      mailRow(
        `unique-${String(index).padStart(2, '0')}`,
        `Reservation confirmation n°87654321-${index + 1}`,
        new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      ),
    );
    rows.push(
      mailRow(
        'duplicate-later',
        'Reservation confirmation n°87654321-1',
        '2026-01-02T00:00:00.000Z',
      ),
    );

    const selected = rankExactMailCandidates(rows, 24);
    expect(selected).toHaveLength(24);
    expect(new Set(selected.map((item) => item.candidate.value)).size).toBe(24);
    expect(selected[0]?.messageId).toBe('unique-00');
    expect(selected.some((item) => item.messageId === 'duplicate-later')).toBe(
      false,
    );
  });

  it('selects the newest inbound per thread before ranking proof candidates', () => {
    const rows = [
      mailRow(
        'historical-inbound',
        'Reservation confirmation n°12345678-1',
        '2026-01-01T00:00:00.000Z',
        {
          threadId: 'thread-current',
          createdAt: new Date('2026-01-01T01:00:00.000Z'),
        },
      ),
      mailRow(
        'newer-outbound',
        'Reservation confirmation n°12345678-2',
        '2026-01-03T00:00:00.000Z',
        {
          threadId: 'thread-current',
          direction: 'outbound',
          createdAt: new Date('2026-01-03T01:00:00.000Z'),
        },
      ),
      mailRow(
        'current-inbound',
        'Reservation confirmation n°12345678-3',
        '2026-01-02T00:00:00.000Z',
        {
          threadId: 'thread-current',
          createdAt: new Date('2026-01-02T01:00:00.000Z'),
        },
      ),
      mailRow(
        'other-thread-inbound',
        'Reservation confirmation n°87654321-1',
        '2026-01-04T00:00:00.000Z',
      ),
    ];

    const currentRows = selectLatestInboundProofRows(rows);
    expect(currentRows.map((row) => row.id)).toEqual([
      'current-inbound',
      'other-thread-inbound',
    ]);
    expect(
      rankExactMailCandidates(currentRows).map((anchor) => anchor.messageId),
    ).toEqual(['current-inbound', 'other-thread-inbound']);
  });

  it('rejects future, reversed, expired, and overlong proof windows', () => {
    const now = Date.parse('2026-08-05T08:00:00.000Z');
    expect(
      isFreshProof(
        '2026-08-05T07:59:00.000Z',
        '2026-08-05T08:01:00.000Z',
        now,
      ),
    ).toBe(true);
    expect(
      isFreshProof(
        '2026-08-05T08:01:00.000Z',
        '2026-08-05T08:02:00.000Z',
        now,
      ),
    ).toBe(false);
    expect(
      isFreshProof(
        '2026-08-05T07:59:00.000Z',
        '2026-08-05T07:58:00.000Z',
        now,
      ),
    ).toBe(false);
    expect(
      isFreshProof(
        '2026-08-04T07:59:00.000Z',
        '2026-08-05T08:01:00.000Z',
        now,
      ),
    ).toBe(false);
  });

  it('accepts only unique known positive request-rule counters', () => {
    const allowed = new Set(['live-login-post', 'live-osress-search-exact']);
    expect(
      validateRequestRuleCounts(
        [
          { ruleId: 'live-login-post', count: 2 },
          { ruleId: 'live-osress-search-exact', count: 1 },
        ],
        allowed,
      ),
    ).toBe(true);
    expect(
      validateRequestRuleCounts(
        [
          { ruleId: 'live-osress-search-exact', count: 1 },
          { ruleId: 'live-osress-search-exact', count: 1 },
        ],
        allowed,
      ),
    ).toBe(false);
    expect(
      validateRequestRuleCounts(
        [{ ruleId: 'unknown', count: 1 }],
        allowed,
      ),
    ).toBe(false);
    expect(
      validateRequestRuleCounts(
        [{ ruleId: 'live-osress-search-exact', count: 0 }],
        allowed,
      ),
    ).toBe(false);
  });

  it('emits success only after runtime and DB close with receipt-file digest', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    const runtimeClose = proof.lastIndexOf('await runtime.close()');
    const dbClose = proof.lastIndexOf('await closeDb()');
    const provisional = proof.lastIndexOf("state: 'provisional'");
    const lockRelease = proof.lastIndexOf('releaseOperationLock?.()');
    const success = proof.lastIndexOf("emitOk('PHASE_A_PROOF_EVIDENCE_V1')");
    expect(runtimeClose).toBeGreaterThan(-1);
    expect(dbClose).toBeGreaterThan(runtimeClose);
    expect(provisional).toBeGreaterThan(dbClose);
    expect(lockRelease).toBeGreaterThan(provisional);
    expect(success).toBeGreaterThan(lockRelease);
    expect(proof).toMatch(/dbCloseFailed/);
    expect(proof).toMatch(
      /receiptSha256:\s*sha256Hex\(`\$\{JSON\.stringify\(receipt!\)\}\\n`\)/,
    );
    expect(proof).not.toMatch(/runtime\.close\(\)\.catch/);
    expect(proof).not.toMatch(/conn\.end\(\)\.catch/);
  });

  it('fails closed on PM2 inspection, deletion, save, or identity drift', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    expect(proof).toMatch(/out\.status !== 0 \|\| out\.error/);
    expect(proof).toMatch(/PM2 inspection failed/);
    expect(proof).toMatch(/deleted\.status !== 0 \|\| deleted\.error/);
    expect(proof).toMatch(/saved\.status !== 0 \|\| saved\.error/);
    expect(proof).toMatch(/pm2DescribeHms\(\)\.present/);
    expect(proof).toMatch(/running\.execPath !== expectedPath/);
    const startBody = proof.slice(
      proof.indexOf('function startHmsPm2'),
      proof.indexOf('export type ExactMailAnchor'),
    );
    expect(startBody).not.toMatch(/pm2', \['save'\]/);
    expect(proof).toMatch(/running\.startedAt/);
    expect(proof).toMatch(/shadow!\.processStartedAt !== hms\.startedAt/);
  });

  it('checks each forbidden table fingerprint and derives policy blocks', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    expect(proof).toMatch(/string_agg/);
    expect(proof).toMatch(/after\[key\]\.count !== before\[key\]\.count/);
    expect(proof).toMatch(
      /after\[key\]\.fingerprint !== before\[key\]\.fingerprint/,
    );
    expect(proof).not.toMatch(/const policyBlockDelta = 0/);
    expect(proof).toMatch(/terminalMetrics\.failureClass === 'POLICY_BLOCK'/);
  });

  it('ops-hms-proof.sh exposes exact public grammar', () => {
    const script = readFileSync(
      join(here, '..', 'deploy', 'ops-hms-proof.sh'),
      'utf8',
    );
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    expect(script).toMatch(/reservation\|accept-g1\|artifact-video\|live-wave/);
    expect(script).toMatch(/fetch-artifact/);
    expect(script).toMatch(/HMS_ARTIFACT_FETCHED_V1/);
    expect(script).toMatch(/receipt\.expiresAt/);
    expect(script).not.toMatch(/TRANSFER_PENDING/);
    expect(script).toMatch(/proof-video/);
    expect(proof).toMatch(/G1_ACCEPTED/);
    expect(script).toMatch(/HMS_ROLLBACK_OK/);
    expect(script).toMatch(
      /PLAYWRIGHT_BROWSERS_PATH=.*\/opt\/nava\/ms-playwright/,
    );
    expect(script).toMatch(
      /HMS_CHROMIUM_EXECUTABLE_PATH=\/opt\/nava\/chromium\/chrome/,
    );
    expect(script).not.toMatch(/confirmation|candidateId|--thread/);
  });

  it('reservation stages source and privately transfers verified receipt and video', () => {
    const script = readFileSync(
      join(here, '..', 'deploy', 'ops-hms-proof.sh'),
      'utf8',
    );
    expect(script).toMatch(
      /sync-ec2-git-bundle\.sh[\s\S]*--plan-snapshot[\s\S]*mail-artifact-reservation-chain/,
    );
    expect(script).toMatch(/install-hms-browser\.sh/);
    expect(script).toMatch(/hms-browser-proof-transfer\/v1/);
    expect(script).toMatch(/s3api put-object/);
    expect(script).toMatch(/--server-side-encryption AES256/);
    expect(script).toMatch(/--query ServerSideEncryption/);
    expect(script).not.toMatch(/head-object/);
    expect(script).toMatch(/receipt\.v1\.json/);
    expect(script).toMatch(/video\.webm/);
    expect(script).toMatch(/sha256/i);
    expect(script).toMatch(/\.tmp\/hms-browser-proof/);
    expect(script).toMatch(/chmod 700/);
    expect(script).toMatch(/chmod 600/);
    expect(script).toMatch(/icacls/);
    expect(script).toMatch(/MSYS2_ARG_CONV_EXCL/);
    expect(script).toMatch(/deliveryAttestation/);
    expect(script).toMatch(/productionOriginAttested:true/);
    expect(script).not.toMatch(/productionOrigin:/);
    expect(script).toMatch(
      /find "\/opt\/nava\/releases\/\$REV" \\\( -type f -o -type d \\\) -perm \/022/,
    );
    expect(script).toMatch(/mktemp \/tmp\/nava-hms-proof-preflight/);
    expect(script).not.toMatch(/aws s3 cp \/dev\/null/);
    expect(script).toMatch(/s3api delete-object/);
    expect(script).not.toMatch(/list-objects-v2/);
    expect(script).toMatch(
      /TRANSFER_BUCKET="nava-zero-mail-845242190536-af-south-1"/,
    );
    expect(script).not.toMatch(/HMS_PROOF_TRANSFER_BUCKET/);
    expect(script).toMatch(/EXPECTED_ACCOUNT_ID="845242190536"/);
    expect(script).toMatch(/purge_expired_local_proofs/);
    expect(script).toMatch(/receipt\.artifactId!==gate\.artifactId/);
    expect(script).toMatch(/Object\.keys\(rule\.Filter\)\.length===1/);
    expect(script).toMatch(/exactPrefix\(transfer,target\)/);
    expect(script).toMatch(/put-bucket-lifecycle-configuration/);
    expect(script).toMatch(/archive-raw-mime-30d/);
    expect(script).toMatch(/archive-attachments-30d/);
    expect(script).toMatch(/abort-incomplete-multipart-1d/);
    expect(script).toMatch(/INTELLIGENT_TIERING/);
    expect(script).not.toMatch(/expire-raw-mime-30d|expire-attachments-90d/);
    expect(script).toMatch(
      /Number\(multipart\.AbortIncompleteMultipartUpload\?\.DaysAfterInitiation\)!==1/,
    );
    expect(script.indexOf('if [ "$STOP_RC" -ne 0 ]')).toBeLessThan(
      script.indexOf(
        'process.stdout.write(require(\\"fs\\").readFileSync(process.argv[1],\\"utf8\\"))',
      ),
    );
    expect(script.indexOf('apply_local_acl "$DEST" directory')).toBeLessThan(
      script.indexOf(
        'aws s3 cp "s3://${TRANSFER_BUCKET}/${TRANSFER_PREFIX}/receipt.v1.json"',
      ),
    );
  });

  it('installs durable purge without making role proof app-writable', () => {
    const install = readFileSync(
      join(here, '..', 'deploy', 'install-hms-browser.sh'),
      'utf8',
    );
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    expect(install).not.toMatch(/chown\s+-R\s+ubuntu:ubuntu\s+"\$NAVA_ROOT"/);
    expect(install).toMatch(/ROLE_PROOF_DIR="\/etc\/nava"/);
    expect(install).toMatch(/hms-read-role-proof\.v1\.json/);
    expect(install).toMatch(/nava-hms-artifact-purge\.timer/);
    expect(install).toMatch(/systemctl enable --now/);
    expect(install).not.toMatch(/install[\s\S]{0,160}LEGACY_ROLE_PROOF_PATH/);
    expect(install).toMatch(/chown -R root:root "\$CHROMIUM_DIR" "\$BROWSERS_DIR"/);
    expect(install).toMatch(/chown root:root "\$NAVA_ROOT" "\$\{NAVA_ROOT\}\/shared"/);
    expect(install).toMatch(/RUNTIME_DIR="\$\{NAVA_ROOT\}\/shared\/hms-runtime"/);
    expect(proof).toMatch(/'\/opt\/nava\/shared\/hms-runtime'/);
    expect(install).toMatch(/hms-dependency-revision\.txt/);
    expect(install).toMatch(/chmod 0444/);
    expect(install).not.toMatch(/EXPECTED_FFMPEG_REV|FFMPEG_EXE/);
    expect(install).toMatch(/chromium\.executablePath\(\)/);
    expect(install).not.toMatch(/playwright-core\/lib\/server\/registry/);
    expect(install).not.toMatch(/find "\$BROWSERS_DIR".*-name 'chromium-\*'/);
    expect(proof).toMatch(/purgeExpiredHmsBrowserArtifacts/);
    expect(proof).toMatch(/purge-artifacts/);
  });

  it('accept-g1 validates full checkpoint and atomically revokes stale acceptance', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    const script = readFileSync(
      join(here, '..', 'deploy', 'ops-hms-proof.sh'),
      'utf8',
    );
    expect(proof).toMatch(/gate\.schemaVersion !== 1/);
    expect(proof).toMatch(/gate\.planPath !== PHASE_A_PLAN_PATH/);
    expect(proof).toMatch(/resetPhaseAGateToAwaiting/);
    expect(proof).toMatch(/writeAtomicJson\(phaseAGatePath\(\)/);
    expect(proof).toMatch(/Number\.isFinite\(expiresAt\)/);
    expect(proof).toMatch(/receipt!\.roleProofSha256 !== gate!\.roleProofSha256/);
    expect(proof).toMatch(/receipt!\.roleProofExpiresAt !== gate!\.roleProofExpiresAt/);
    expect(proof).toMatch(/gate\.deliveryAttestedAt/);
    expect(proof).toMatch(/state: 'provisional'/);
    expect(proof).toMatch(/action === 'accept-g1'/);
    expect(script).toMatch(/HMS_G1_DELIVERY_SEALED/);
    expect(proof).toMatch(/action !== 'accept-g1'/);
    expect(script).toMatch(/node "\$PROOF_JS" accept-g1/);
  });

  it('revokes accepted G1 state when evidence disappears', () => {
    const root = mkdtempSync(join(tmpdir(), 'hms-g1-revoke-'));
    const gatePath = join(root, 'gate.json');
    const revisionPath = join(root, 'revision');
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts);
    const sourceRevision = 'phase-a-test-0123456789abcdef';
    writeFileSync(revisionPath, sourceRevision);
    writeFileSync(
      gatePath,
      `${JSON.stringify({
        schemaVersion: 1,
        state: 'accepted',
        planPath:
          'docs/superpowers/plans/2026-08-04-mail-read-artifact-reservation-chain.md',
        artifactId: '00000000-0000-4000-8000-000000000001',
        receiptSha256: 'a'.repeat(64),
        sourceRevision,
        roleProofSha256: 'b'.repeat(64),
        roleProofExpiresAt: '2999-01-01T00:00:00.000Z',
        writtenAt: new Date().toISOString(),
        deliveryAttestedAt: new Date().toISOString(),
        acceptedAt: new Date().toISOString(),
      })}\n`,
    );
    const prior = {
      gate: process.env.HMS_PHASE_A_GATE_PATH,
      revision: process.env.NAVA_PROOF_SOURCE_REVISION_PATH,
      artifacts: process.env.HMS_BROWSER_ARTIFACT_ROOT,
    };
    process.env.HMS_PHASE_A_GATE_PATH = gatePath;
    process.env.NAVA_PROOF_SOURCE_REVISION_PATH = revisionPath;
    process.env.HMS_BROWSER_ARTIFACT_ROOT = artifacts;
    try {
      let exit: unknown;
      try {
        runAcceptG1();
      } catch (error) {
        exit = error;
      }
      expect(exit).toMatchObject({
        exitCode: 3,
        line: 'G1_WAIT code=PROOF_STALE',
      });
      const revoked = JSON.parse(readFileSync(gatePath, 'utf8'));
      expect(revoked.state).toBe('awaiting_continue');
      expect(revoked).not.toHaveProperty('acceptedAt');
    } finally {
      if (prior.gate === undefined) delete process.env.HMS_PHASE_A_GATE_PATH;
      else process.env.HMS_PHASE_A_GATE_PATH = prior.gate;
      if (prior.revision === undefined)
        delete process.env.NAVA_PROOF_SOURCE_REVISION_PATH;
      else process.env.NAVA_PROOF_SOURCE_REVISION_PATH = prior.revision;
      if (prior.artifacts === undefined)
        delete process.env.HMS_BROWSER_ARTIFACT_ROOT;
      else process.env.HMS_BROWSER_ARTIFACT_ROOT = prior.artifacts;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never promotes an undelivered provisional gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'hms-g1-provisional-'));
    const gatePath = join(root, 'gate.json');
    const gate = {
      schemaVersion: 1,
      state: 'provisional',
      planPath:
        'docs/superpowers/plans/2026-08-04-mail-read-artifact-reservation-chain.md',
      artifactId: '00000000-0000-4000-8000-000000000001',
      receiptSha256: 'a'.repeat(64),
      sourceRevision: 'phase-a-test-0123456789abcdef',
      roleProofSha256: 'b'.repeat(64),
      roleProofExpiresAt: '2999-01-01T00:00:00.000Z',
      writtenAt: new Date().toISOString(),
    };
    writeFileSync(gatePath, `${JSON.stringify(gate)}\n`);
    const prior = process.env.HMS_PHASE_A_GATE_PATH;
    process.env.HMS_PHASE_A_GATE_PATH = gatePath;
    try {
      expect(() => runAcceptG1()).toThrow();
      expect(JSON.parse(readFileSync(gatePath, 'utf8')).state).toBe(
        'provisional',
      );
    } finally {
      if (prior === undefined) delete process.env.HMS_PHASE_A_GATE_PATH;
      else process.env.HMS_PHASE_A_GATE_PATH = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes live operations with a process-owner lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'hms-operation-lock-'));
    const prior = process.env.HMS_SHARED_DIR;
    process.env.HMS_SHARED_DIR = root;
    try {
      const release = acquireHmsOperationLock();
      expect(() => acquireHmsOperationLock()).toThrow();
      release();
      const releaseAgain = acquireHmsOperationLock();
      releaseAgain();
    } finally {
      if (prior === undefined) delete process.env.HMS_SHARED_DIR;
      else process.env.HMS_SHARED_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a held operation lock using the platform lock contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hms-operation-stale-lock-'));
    const prior = process.env.HMS_SHARED_DIR;
    process.env.HMS_SHARED_DIR = root;
    try {
      if (process.platform === 'linux') {
        const lock = join(root, '.hms-live-operation.v2.lock');
        const holder = spawn(
          'flock',
          ['-n', lock, '-c', 'printf locked; cat >/dev/null'],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        try {
          const [output] = await new Promise<[Buffer]>((resolve, reject) => {
            holder.stdout?.once('data', (chunk: Buffer) => resolve([chunk]));
            holder.once('error', reject);
          });
          expect(output.toString()).toBe('locked');
          expect(() => acquireHmsOperationLock()).toThrow();
        } finally {
          holder.stdin?.end();
          if (holder.exitCode === null) await new Promise<void>((resolve) => {
            holder.once('exit', () => resolve());
          });
        }

        const release = acquireHmsOperationLock();
        release();
        expect(existsSync(lock)).toBe(true);
      } else {
        const lock = join(root, '.hms-live-operation.lock');
        mkdirSync(lock);
        writeFileSync(
          join(lock, 'owner.v1.json'),
          `${JSON.stringify({ pid: 999_999, bootId: 'stale', processStart: '0' })}\n`,
        );
        const release = acquireHmsOperationLock();
        release();
        expect(existsSync(lock)).toBe(false);
      }
    } finally {
      if (prior === undefined) delete process.env.HMS_SHARED_DIR;
      else process.env.HMS_SHARED_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shares one atomic operation lock with immutable source publication', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    const sync = readFileSync(
      join(here, '..', 'deploy', 'sync-ec2-git-bundle.sh'),
      'utf8',
    );
    expect(proof).toMatch(/\.acquire-\$\{randomUUID\(\)\}/);
    expect(proof).toMatch(/renameSync\(candidate, path\)/);
    expect(proof).toMatch(/\.hms-live-operation\.v2\.lock/);
    expect(proof).toMatch(/spawnSync\('flock', \['-n', '3'\]/);
    expect(proof).toMatch(/spawnSync\('flock', \['-u', '3'\]/);
    expect(sync).toMatch(
      /OPERATION_LOCK=\/opt\/nava\/shared\/hms-runtime\/\.hms-live-operation\.v2\.lock/,
    );
    expect(sync).toMatch(/trap cleanup_remote EXIT\s+acquire_operation_lock/);
    expect(sync).toMatch(/release_operation_lock/);
    expect(sync).toMatch(/flock -n 8/);
    expect(sync).toMatch(/flock -u 8/);
    expect(sync.indexOf('acquire_operation_lock')).toBeLessThan(
      sync.indexOf('sudo mv -T \\"\\$STAGING\\" \\"\\$FINAL\\"'),
    );
  });

  it('binds candidate discovery to the authorized HMS transport and timeout', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    expect(proof).toMatch(
      /selectOldestExactCandidates\(\s*databaseUrl: string,\s*transportId: string/,
    );
    expect(proof).toMatch(/eq\(message\.transportId, transportId\)/);
    expect(proof).toMatch(
      /hmsConfig\.expectedTransportId !== CENTURION_TRANSPORT_ID/,
    );
    expect(proof).toMatch(/set_config\('statement_timeout'/);
    expect(proof).toMatch(/left\(\$\{message\.textBody\}, 4096\)/);
    expect(proof).toMatch(/left\(\$\{message\.htmlBody\}, 4096\)/);
    expect(proof).toMatch(
      /rankExactMailCandidates\(rows, limit, processingDeadline\)/,
    );
  });

  it('proof-video discovers only current inbound trigger rows', () => {
    const proof = readFileSync(
      join(here, '..', 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    const proofVideo = proof.slice(
      proof.indexOf('async function runProofVideo()'),
    );
    const selectorStart = proof.indexOf(
      'async function selectCurrentInboundExactCandidates(',
    );
    const selectorEnd = proof.indexOf(
      'async function selectOldestExactCandidate(',
      selectorStart,
    );
    const selector = proof.slice(selectorStart, selectorEnd);
    expect(proofVideo).toMatch(/selectCurrentInboundExactCandidates\(/);
    expect(proofVideo).not.toMatch(/selectOldestExactCandidates\(/);
    expect(selector).toMatch(/selectDistinctOn\(\[message\.threadId\]/);
    expect(selector).toMatch(/eq\(message\.direction, 'inbound'\)/);
    expect(selector).toMatch(/receivedAt\} DESC NULLS LAST/);
    expect(selector).toMatch(/desc\(message\.createdAt\)/);
    expect(selector).toMatch(/desc\(message\.id\)/);
    expect(selector).toMatch(/textBody: message\.textBody/);
    expect(selector).toMatch(/htmlBody: message\.htmlBody/);
    expect(selector).toMatch(/subject: message\.subject/);
    expect(selector).toMatch(
      /rankExactMailCandidates\([\s\S]*processingDeadline,\s*true/,
    );
    expect(selector).not.toMatch(/left\(/);
  });

  it('allowlist file is sorted unique repo-relative paths', () => {
    const raw = readFileSync(
      join(here, '..', 'deploy', 'mail-artifact-reservation-chain-files.txt'),
      'utf8',
    );
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines).toContain('apps/server-pilot/src/ops/hms-live-proof.ts');
    expect(lines).toContain('apps/server-pilot/deploy/ops-hms-proof.sh');
    expect([...lines].sort()).toEqual(lines);
    expect(new Set(lines).size).toBe(lines.length);
    const plan = readFileSync(
      join(
        here,
        '..',
        '..',
        '..',
        'docs',
        'superpowers',
        'plans',
        '2026-08-04-mail-read-artifact-reservation-chain.md',
      ),
      'utf8',
    );
    const planAllowlist =
      /source-snapshot allowlist with exactly these repo-relative paths[\s\S]*?```text\r?\n([\s\S]*?)```/.exec(
        plan,
      )?.[1];
    expect(planAllowlist).toBeDefined();
    expect(lines).toEqual(
      planAllowlist!
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    for (const buildInput of [
      'apps/server-pilot/package.json',
      'apps/server-pilot/tsconfig.json',
      'package.json',
      'packages/tsconfig/base.json',
      'packages/tsconfig/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]) {
      expect(lines).not.toContain(buildInput);
    }
    const sync = readFileSync(
      join(here, '..', 'deploy', 'sync-ec2-git-bundle.sh'),
      'utf8',
    );
    expect(sync).toMatch(/git archive/);
    expect(sync).toMatch(/sha256sum -c/);
    expect(sync).toMatch(/s3api delete-object/);
    expect(sync).toMatch(/put-bucket-lifecycle-configuration/);
    expect(sync).toMatch(/HmsProofSourceExpire1Day/);
    expect(sync).toMatch(/is_phase_b_overlay/);
    expect(sync).toMatch(/mail-artifact-backtest\.ts/);
    expect(sync).toMatch(/if is_phase_b_overlay "\$rel"; then\s+continue/);
    expect(sync).toMatch(/value\.testedBaseCommit!==currentBaseCommit/);
    expect(sync).toMatch(/currentSourceSha256!==value\.testedSourceSha256/);
    expect(sync).toMatch(
      /git -C "\$REPO_ROOT" diff --quiet "\$BASE_COMMIT" -- "\$build_input"/,
    );
    expect(sync).toMatch(/base build input differs from tested commit/);
    expect(sync).toMatch(/Object\.keys\(filter\)\.length===1/);
    expect(sync).toMatch(/\.staging-\$\{TRANSFER_UUID\}/);
    expect(sync).toMatch(/--package-import-method=copy/);
    expect(sync).toMatch(/BUILD_SYMLINKS\.json/);
    expect(sync).toMatch(/-type f -o -type d/);
    expect(sync).toMatch(/chown -R root:root/);
    expect(sync).toMatch(/chmod -R a\+rX,a-w/);
    expect(sync).toMatch(
      /const info=fs\.lstatSync\(current\);[\s\S]*info\.isSymbolicLink\(\)/,
    );
    expect(sync).toMatch(/unbound release input drift/);
    expect(sync).toMatch(/mv -T/);
    expect(sync).not.toMatch(/rm -rf \$\{RELEASE_DIR\}/);
    expect(sync).not.toMatch(/cp -a \$\{EC2_REPO_PATH\}/);
    expect(
      sync.indexOf(
        'cp -p "$GATE_REPORT" "${STAGE_DIR}/gate/hms-read-gate-report.json"',
      ),
    ).toBeLessThan(
      sync.indexOf('> "${STAGE_DIR}/MANIFEST.sha256"'),
    );
  });

  it('sync front door rejects unknown and extra arguments before deployment', () => {
    const sync = readFileSync(
      join(here, '..', 'deploy', 'sync-ec2-git-bundle.sh'),
      'utf8',
    );
    expect(sync).toMatch(/if \[ "\$#" -eq 0 \]; then/);
    expect(sync).toMatch(
      /elif \[ "\$#" -eq 2 \] && \[ "\$1" = "--plan-snapshot" \]; then/,
    );
    expect(sync).toMatch(/else\s+echo "usage:[^"]+" >&2\s+exit 2/);
  });

  it('generic deploy and boot verify HMS absence and proof invalidation', () => {
    for (const name of ['deploy-ec2.sh', 'pm2-boot.sh']) {
      const script = readFileSync(join(here, '..', 'deploy', name), 'utf8');
      expect(script, name).toMatch(/ensure_hms_absent\(\)/);
      expect(script, name).toMatch(/pm2 jlist/);
      expect(script, name).toMatch(/pm2 save/);
      expect(script, name).not.toMatch(
        /pm2 delete hms-ai-worker[^\n]*\|\| true/,
      );
      expect(script, name).toMatch(/invalidate_hms_proofs\(\)/);
      expect(script, name).toMatch(/\[ ! -e "\$path" \]/);
    }
  });

  it('SSM formatter preserves ResponseCode', () => {
    const fmt = readFileSync(
      join(here, '..', 'deploy', 'ssm-format-invocation.cjs'),
      'utf8',
    );
    expect(fmt).toMatch(/ResponseCode/);
    expect(fmt).toMatch(/StatusDetails/);
    const runner = readFileSync(
      join(here, '..', 'deploy', 'ssm-run-command.sh'),
      'utf8',
    );
    expect(runner).toMatch(/exit 70/);
    expect(runner).toMatch(/ResponseCode/);
    expect(runner).toMatch(/SSM_DELIVERY_TIMEOUT_SECONDS:=60/);
    expect(runner).toMatch(/SSM_EXECUTION_TIMEOUT_SECONDS:=900/);
    expect(runner).toMatch(/executionTimeout/);
    expect(runner).toMatch(/cancel_command_and_wait/);
    expect(runner).toMatch(/Pending\|InProgress\|Delayed\|Cancelling/);
    expect(runner).toMatch(/trap on_signal HUP INT TERM/);
    expect(runner).toMatch(/if \[ "\$#" -ne 1 \]; then/);
    expect(runner).toMatch(/if ! COMMAND_ID="\$\(/);
    expect(runner).toMatch(/if ! INVOCATION_JSON="\$\(print_invocation\)"/);
    expect(runner).toMatch(
      /Success\)\s+\[\s*"\$RESPONSE_CODE" = "0" \] && exit 0/,
    );
    expect(runner).not.toMatch(/Success\)[\s\S]{0,180}exit "\$RESPONSE_CODE"/);
  });

  it('binds live proof to the safe fixture gate and keeps cleanup armed', () => {
    const script = readFileSync(
      join(here, '..', 'deploy', 'ops-hms-proof.sh'),
      'utf8',
    );
    expect(script).toMatch(/bash "\$READ_GATE" --fixture-only/);
    expect(script).toMatch(/hms-read-gate-report\.json/);
    expect(script.indexOf('ARMED=1')).toBeLessThan(
      script.indexOf('node "$PROOF_JS" status'),
    );
    expect(script.indexOf('if [ "$STOP_RC" -ne 0 ]')).toBeLessThan(
      script.indexOf('ARMED=0'),
    );
  });

  it('writes production env through a validated atomic temp file', () => {
    const script = readFileSync(
      join(here, '..', 'deploy', 'write-ec2-env.sh'),
      'utf8',
    );
    expect(script).toMatch(/mktemp/);
    expect(script).toMatch(/fsyncSync/);
    expect(script).toMatch(/mv -f -- "\$ENV_TMP" "\$ENV_PATH"/);
    expect(script.indexOf('SMTP_HOST must be')).toBeLessThan(
      script.indexOf('mktemp'),
    );
    expect(script).not.toMatch(/cat > "\$ENV_PATH"/);
    expect(script).toMatch(
      /append_env HMS_CHROMIUM_EXECUTABLE_PATH "\/opt\/nava\/chromium\/chrome"/,
    );
  });

  it('disables RDS TLS only for a loopback disposable database', () => {
    const loopbackUrl = ['postgresql:/', '/127.0.0.1/disposable_test'].join('');
    const remoteUrl = ['postgresql:/', '/db.example.invalid/production'].join('');
    expect(getPostgresSslOptions(loopbackUrl)).toBe(false);
    expect(getPostgresSslOptions(remoteUrl)).toMatchObject({
      rejectUnauthorized: true,
    });

    const client = readFileSync(
      join(here, '..', 'src', 'db', 'client.ts'),
      'utf8',
    );
    expect(client).toMatch(/getPostgresSslOptions\(url\)/);
  });

  it('hms-read-gate rejects unknown modes and extra arguments before tests', () => {
    const gate = join(here, '..', 'deploy', 'hms-read-gate.sh');
    const gateSource = readFileSync(gate, 'utf8');
    expect(gateSource).toMatch(/require_clean_base_build_inputs/);
    expect(gateSource).toMatch(/require_bound_release_inputs/);
    expect(gateSource).toMatch(/unbound release input drift/);
    expect(gateSource).toMatch(/fs\.lstatSync\(file\)\.isSymbolicLink\(\)/);
    expect(gateSource).toMatch(/apps\/server-pilot\/vitest\.config\.ts/);
    expect(gateSource).toMatch(/apps\/server-pilot\/evals\/hms/);
    expect(gateSource).toMatch(/packages\/testing/);
    expect(gateSource).toMatch(/src\/mail\/artifacts\/read-artifact\.ts/);
    expect(gateSource).toMatch(/tests\/hms-artifact\.test\.ts/);
    expect(gateSource).toMatch(
      /git -C "\$REPO_ROOT" diff --quiet "\$TESTED_BASE_COMMIT" -- "\$build_input"/,
    );
    const suites = (start: string, end: string) =>
      gateSource
        .slice(gateSource.indexOf(start), gateSource.indexOf(end))
        .match(/tests\/[a-z0-9-]+\.test\.ts/g) ?? [];
    const commonSuites = [
      'tests/hms-contracts.test.ts',
      'tests/hms-request-policy.test.ts',
      'tests/hms-runtime.test.ts',
      'tests/hms-browser-artifacts.test.ts',
      'tests/hms-live-guest-stay.test.ts',
      'tests/hms-live-proof.test.ts',
      'tests/hms-artifact.test.ts',
      'tests/hms-discovery.test.ts',
      'tests/hms-adapter.test.ts',
      'tests/hms-live-read-manifest.test.ts',
      'tests/hms-thread-context.test.ts',
      'tests/hms-candidate-agent.test.ts',
      'tests/hms-candidate-state.test.ts',
      'tests/hms-production-boundary.test.ts',
      'tests/hms-shadow.test.ts',
      'tests/ai-workflow-run-contract.test.ts',
      'tests/ai-worker-contract.test.ts',
      'tests/deploy-config.test.ts',
      'tests/ai-eval-runner.test.ts',
    ];
    expect(
      suites('if [ "$MODE" = "--full" ]', 'elif [ "$MODE" = "--fixture-only" ]'),
    ).toEqual(commonSuites);
    expect(
      suites(
        'elif [ "$MODE" = "--fixture-only" ]',
        'echo "== hms-read-gate: playwright fixture config',
      ),
    ).toEqual(commonSuites);
    expect(gateSource.match(/--maxWorkers=1/g)).toHaveLength(2);
    const bash =
      process.platform === 'win32'
        ? spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout
            .split(/\r?\n/)
            .find((line) => line.toLowerCase().includes('git'))!
        : 'bash';
    for (const args of [['--unknown'], ['--fixture-only', 'extra']]) {
      const result = spawnSync(bash, [gate, ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      });
      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toMatch(/usage:/);
    }
  });

  it('fetch-artifact rejects malformed IDs and extra arguments before AWS', () => {
    const script = join(here, '..', 'deploy', 'ops-hms-proof.sh');
    const bash =
      process.platform === 'win32'
        ? spawnSync('where.exe', ['bash'], { encoding: 'utf8' }).stdout
            .split(/\r?\n/)
            .find((line) => line.toLowerCase().includes('git'))!
        : 'bash';
    const invalidArgv = [
      ['fetch-artifact', 'not-a-uuid', 'receipt'],
      [
        'fetch-artifact',
        '00000000-0000-4000-8000-000000000001',
        'video',
        'extra',
      ],
    ];
    for (const args of invalidArgv) {
      const result = spawnSync(bash, [script, ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      });
      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).toMatch(/usage:/);
    }
  });
});
