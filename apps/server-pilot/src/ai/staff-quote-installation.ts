import {
  ARTIFACT_MAX_INPUT_BYTES,
  ARTIFACT_MAX_OUTPUT_BYTES,
  extractEmbeddedPdfText,
  type SandboxRunner,
  type SandboxResult,
} from '../mail/artifacts/read-artifact.js';
import {
  createReservationistSelectedRatePolicyResolver,
  type ReservationistRatePolicyDocument,
} from './reservationist-rate-policy-source.js';
import {
  createReservationistBusinessServices,
  type ReservationistPartyRead,
} from './reservationist-business-services.js';
import { createExistingOwnerNativeQuoteReader } from './reservationist-evaluation-composition.js';
import { PartyRateFailure } from './party-rate-failure.js';
import {
  bindCenturionHmsMailboxProperty,
  type MailboxHmsOriginFields,
} from '../hms/mailbox-hms-origin-bind.js';
import { staffQuoteInstallationEnvName } from '../hms/hms-read-target.js';
import {
  PROVISIONAL_QUOTE_SCRIPT,
  quoteTraceAsyncEnabled,
  runProvisionalQuoteChild,
} from './staff-quote-trace-async.js';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { quoteDigest } from '../quote-proposal/quote-revision.js';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

type BusinessOptions = Parameters<typeof createReservationistBusinessServices>[0];
type Context = Parameters<NonNullable<BusinessOptions['resolveSelectedPolicy']>>[0];
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const privateRoot = resolve(repo, '.private');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const configurationSchema = z
  .object({
    tenantId: z.string().min(1),
    owner: z
      .object({
        cdpUrl: z.string().url(),
        browserOwnership: z.literal('borrowed'),
        propertyCode: z.string().min(1),
        secretPath: z.string().min(1),
      })
      .strict(),
    outputDir: z.string().min(1),
    ratePolicyConfigurationPath: z.string().min(1),
    // Optional hotel/staff-approved dinner pricing; Centurion's default is applied during validation below.
    dinnerAddOn: z
      .object({
        amountMinor: z.number().int().positive().max(100_000_000),
        unit: z.enum(['per_person_per_night', 'per_room_per_night', 'per_person']),
        label: z.string().trim().min(1).max(120),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StaffQuoteInstallationConfiguration = z.infer<typeof configurationSchema>;

/** Centurion default dinner add-on. Same values validation already applied for HRCEN. */
export const CENTURION_DINNER_ADD_ON = Object.freeze({
  amountMinor: 35_000,
  unit: 'per_person_per_night' as const,
  label: 'Dinner Allowance',
});
export type InstalledStaffQuoteServiceOptions = Pick<
  BusinessOptions,
  'authorizationId' | 'authorizeContext' | 'signer'
> & {
  /** Reports the private evidence directory of a completed capture run. */
  onEvidenceDirectory?: (evidenceDirectory: string) => void;
  /** Provisional mode only (QUOTE_TRACE_ASYNC=on): settles when that capture's trace has finished. */
  onTraceFinish?: (finished: Promise<void>) => void;
  /** Trigger mailbox origin. Da Vinci identity must not take the Centurion HMS slot. */
  mailboxOrigin?: MailboxHmsOriginFields;
  /** Selects the HRDAV install when quoting Da Vinci. Omitted keeps Centurion. */
  propertyCode?: string;
  /**
   * Spawn env snapped while the parent holds this property lock.
   * Must include HMS_PROPERTY_LOCK_HELD and PANE_STAY_TENANT_ID.
   * Unset when this process is the lock owner.
   */
  childEnv?: NodeJS.ProcessEnv;
};

/** Copy the parent-held lock token and tenant into a quote child env. */
export function spawnEnvWithHeldLock(
  env: NodeJS.ProcessEnv,
  childEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  if (!childEnv) return env;
  const held = childEnv.HMS_PROPERTY_LOCK_HELD;
  if (!held) return env;
  const next: NodeJS.ProcessEnv = { ...env, HMS_PROPERTY_LOCK_HELD: held };
  const tenantId = childEnv.PANE_STAY_TENANT_ID;
  if (typeof tenantId === 'string' && tenantId) next.PANE_STAY_TENANT_ID = tenantId;
  return next;
}

/** Provisional mode: the final result must match the provisional capture the reader accepted. */
async function verifyProvisionalQuoteFinal(evidenceDirectory: string): Promise<void> {
  const limit = 20 * 1024 * 1024;
  const provisional = JSON.parse(
    checkedPrivateFile(join(evidenceDirectory, 'result.provisional.json'), limit).toString(),
  ) as Record<string, unknown>;
  const final = JSON.parse(
    checkedPrivateFile(join(evidenceDirectory, 'result.json'), limit).toString(),
  ) as Record<string, unknown>;
  if (
    (final.audit as { status?: unknown } | undefined)?.status !== 'complete' ||
    final.outcome !== 'quote' ||
    final.evidenceDirectory !== evidenceDirectory ||
    final.observedAt !== provisional.observedAt ||
    quoteDigest(final.requested) !== quoteDigest(provisional.requested) ||
    quoteDigest(final.groups) !== quoteDigest(provisional.groups)
  )
    throw new Error('staff_quote_trace_finish_changed');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return isAbsolute(path) && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
function checkedPrivateFile(path: string, limit: number): Buffer {
  if (!inside(privateRoot, path)) throw new Error('staff_quote_private_path_invalid');
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== path ||
    info.size < 1 ||
    info.size > limit
  )
    throw new Error('staff_quote_private_file_invalid');
  const bytes = readFileSync(path);
  if (bytes.length !== info.size) throw new Error('staff_quote_private_file_changed');
  return bytes;
}
export function validateStaffQuoteInstallationConfiguration(
  raw: unknown,
): StaffQuoteInstallationConfiguration {
  const configuration = configurationSchema.parse(raw),
    url = new URL(configuration.owner.cdpUrl);
  if (
    !['http:', 'ws:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isAbsolute(configuration.owner.secretPath) ||
    !inside(join(privateRoot, 'playwright-quote'), configuration.outputDir) ||
    !inside(privateRoot, configuration.ratePolicyConfigurationPath)
  )
    throw new Error('staff_quote_installation_invalid');
  return configuration.owner.propertyCode === 'HRCEN' && !configuration.dinnerAddOn
    ? {
        ...configuration,
        dinnerAddOn: { ...CENTURION_DINNER_ADD_ON },
      }
    : configuration;
}

/** HRCEN keeps the unsuffixed prod env; every other hotel uses `_${propertyCode}`. Omitted stays HRCEN. */
function staffQuoteConfigurationEnvName(propertyCode?: string): string {
  return staffQuoteInstallationEnvName(propertyCode ?? 'HRCEN');
}

/** Reads only the installed descriptor, never credentials or a browser. */
export function readInstalledStaffQuoteConfiguration(
  propertyCode?: string,
): StaffQuoteInstallationConfiguration {
  const path = process.env[staffQuoteConfigurationEnvName(propertyCode)];
  if (!path) throw new Error('staff_quote_installation_unavailable');
  return validateStaffQuoteInstallationConfiguration(
    JSON.parse(checkedPrivateFile(path, 1024 * 1024).toString()),
  );
}

// The same installed, networkless Poppler sandbox used by the original source owner.
const pdfImage = 'sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94';
const run = promisify(execFile);
const pdfRunner: SandboxRunner = async (tool, inputPath, signal) => {
  signal?.throwIfAborted();
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  const [file, parent, canonical] = await Promise.all([
    lstat(inputPath),
    lstat(dirname(inputPath)),
    realpath(inputPath),
  ]);
  if (
    uid === undefined ||
    gid === undefined ||
    uid < 1 ||
    gid < 1 ||
    !/^\/tmp\/nava-pdf-[A-Za-z0-9_-]+\/document\.pdf$/.test(inputPath) ||
    basename(inputPath) !== 'document.pdf' ||
    file.isSymbolicLink() ||
    !file.isFile() ||
    file.uid !== uid ||
    file.gid !== gid ||
    file.mode & 0o077 ||
    file.size < 1 ||
    file.size > ARTIFACT_MAX_INPUT_BYTES ||
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.uid !== uid ||
    parent.mode & 0o077 ||
    canonical !== inputPath
  )
    throw new Error('staff_quote_pdf_input_invalid');
  const originalHash = sha(await readFile(inputPath)),
    name = `reservationist-pdf-${randomUUID()}`;
  const toolArgs =
    tool === 'pdfinfo'
      ? ['/input/document.pdf']
      : ['-layout', '-enc', 'UTF-8', '-eol', 'unix', '/input/document.pdf', '-'];
  const args = [
    '-n',
    '/usr/bin/docker',
    'run',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '32',
    '--memory',
    '256m',
    '--memory-swap',
    '256m',
    '--cpus',
    '1',
    '--user',
    `${uid}:${gid}`,
    '--mount',
    'type=bind,src=/usr,dst=/usr,readonly',
    '--mount',
    'type=bind,src=/lib,dst=/lib,readonly',
    '--mount',
    'type=bind,src=/lib64,dst=/lib64,readonly',
    '--mount',
    `type=bind,src=${inputPath},dst=/input/document.pdf,readonly`,
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777',
    '--workdir',
    '/tmp',
    '--entrypoint',
    '/usr/bin/env',
    pdfImage,
    '-i',
    'PATH=/usr/bin',
    'LANG=C.UTF-8',
    '/usr/bin/prlimit',
    '--cpu=5:5',
    '--as=536870912:536870912',
    `--fsize=${ARTIFACT_MAX_OUTPUT_BYTES}:${ARTIFACT_MAX_OUTPUT_BYTES}`,
    '--nofile=32:32',
    '--nproc=16:16',
    '--core=0:0',
    '--',
    `/usr/bin/${tool}`,
    ...toolArgs,
  ];
  let result: SandboxResult | undefined;
  let failed = false;
  let failure: unknown;
  try {
    result = await new Promise<SandboxResult>((accept, reject) => {
      const child = spawn('/usr/bin/sudo', args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin' },
        signal,
        timeout: 15000,
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let outSize = 0,
        errSize = 0,
        limited = false;
      child.stdout.on('data', (chunk: Buffer) => {
        outSize += chunk.length;
        if (outSize > ARTIFACT_MAX_OUTPUT_BYTES) {
          limited = true;
          child.kill('SIGKILL');
        } else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errSize += chunk.length;
        if (errSize > 65536) {
          limited = true;
          child.kill('SIGKILL');
        } else stderr.push(chunk);
      });
      child.once('error', reject);
      child.once('close', (code) =>
        accept({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: limited ? -1 : (code ?? -1),
        }),
      );
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    await run('/usr/bin/sudo', ['-n', '/usr/bin/docker', 'rm', '-f', name], {
      timeout: 5000,
      maxBuffer: 65536,
    }).catch(() => undefined);
  }
  if (sha(await readFile(inputPath)) !== originalHash)
    throw new Error('staff_quote_pdf_source_changed');
  if (failed) throw failure;
  return result!;
};

const documentSchema = z
  .object({
    kind: z.enum(['family_invoice', 'hotel_rate_terms']).optional(),
    ref: z.string().min(1),
    propertyCode: z.string().min(1),
    ownerRef: z.string().min(1),
    messageId: z.string().min(1),
    threadId: z.string().min(1),
    messageAt: z.string().min(1),
    attachmentId: z.string().min(1),
    sourceHash: hashSchema,
    path: z.string().min(1),
    locator: z
      .object({
        s3Key: z.string().min(1),
        byteSize: z.number().int().positive().max(ARTIFACT_MAX_INPUT_BYTES),
      })
      .passthrough(),
    authoredDate: z.string().optional(),
    rateCode: z.string().optional(),
    board: z.enum(['room_only', 'breakfast', 'dinner_bed_breakfast']).optional(),
    publicationAt: z.string().optional(),
    acquisitionReceiptPath: z.string().optional(),
    acquisitionReceiptSHA256: hashSchema.optional(),
  })
  .passthrough();
const rateConfigurationSchema = z
  .object({
    version: z.literal('source-native-invoice-rate-policy-v1'),
    ownerRef: z.string().min(1),
    propertyCode: z.string().min(1),
    documents: z.array(documentSchema).max(64),
    corpusPaths: z.array(z.string().min(1)).min(1).max(4).optional(),
  })
  .passthrough();
const originalRowSchema = z
  .object({
    id: z.string(),
    transportId: z.string(),
    direction: z.string(),
    threadId: z.string(),
    eventAt: z.string(),
    attachmentDescriptors: z
      .array(
        z
          .object({
            id: z.string(),
            messageId: z.string(),
            s3Key: z.string(),
            contentType: z.string(),
            byteSize: z.number(),
            inline: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** Promoted original-document ownership checks; installed paths are trusted, requests never provide locators. */
export function createStaffQuoteRatePolicyDocumentReader(options: {
  configurationPath: string;
  authorizeContext: BusinessOptions['authorizeContext'];
}) {
  const configurationPath = options.configurationPath,
    authorize = options.authorizeContext;
  return async (
    ctx: Context,
    family: {
      propertyCode: string;
      rateCode: string;
      board: import('../quote-proposal/quote-revision.js').Board;
    },
  ): Promise<readonly ReservationistRatePolicyDocument[]> => {
    const guard = async () => {
      ctx.signal.throwIfAborted();
      if (!(await authorize(ctx))) throw new Error('staff_quote_policy_unauthorized');
      ctx.signal.throwIfAborted();
    };
    await guard();
    const bytes = checkedPrivateFile(configurationPath, 1024 * 1024),
      identity = sha(bytes);
    const configuration = rateConfigurationSchema.parse(JSON.parse(bytes.toString()));
    if (
      configuration.ownerRef !== ctx.input.authorizationScope?.ownerRef ||
      configuration.propertyCode !== ctx.input.propertyCode
    )
      throw new Error('staff_quote_policy_scope_invalid');
    const paths = configuration.corpusPaths ?? [
      '.private/reservationist-backtest/corpus/messages.jsonl',
      '.private/connected-mailbox-corpus/centurion-nine-day-4a8bb7ad-2d78-4d9a-92b2-9a5f31d2dd67/messages.jsonl',
    ];
    const rows = new Map<string, z.infer<typeof originalRowSchema>>(),
      originals = new Map<string, string>();
    for (const configuredPath of paths) {
      const path = resolve(repo, configuredPath),
        source = checkedPrivateFile(path, 64 * 1024 * 1024);
      originals.set(path, sha(source));
      for (const line of source.toString().split('\n')) {
        if (!line.trim()) continue;
        const row = originalRowSchema.safeParse(JSON.parse(line));
        if (row.success && !rows.has(row.data.id)) rows.set(row.data.id, row.data);
      }
    }
    const documents: ReservationistRatePolicyDocument[] = [];
    for (const configured of configuration.documents) {
      const terms = configured.kind === 'hotel_rate_terms';
      if (
        configured.propertyCode !== family.propertyCode ||
        (!terms && (configured.rateCode !== family.rateCode || configured.board !== family.board))
      )
        continue;
      if (
        !Number.isFinite(Date.parse(configured.messageAt)) ||
        !Number.isFinite(Date.parse(ctx.input.clock.causalAt))
      )
        throw new Error('staff_quote_policy_clock_invalid');
      if (Date.parse(configured.messageAt) > Date.parse(ctx.input.clock.causalAt)) continue;
      const row = rows.get(configured.messageId),
        descriptor = row?.attachmentDescriptors?.find(
          (item) => item.id === configured.attachmentId,
        );
      if (
        !row ||
        row.transportId !== configuration.ownerRef ||
        configured.ownerRef !== row.transportId ||
        row.direction !== 'outbound' ||
        row.threadId !== configured.threadId ||
        row.eventAt !== configured.messageAt ||
        descriptor?.messageId !== row.id ||
        descriptor.s3Key !== configured.locator.s3Key ||
        descriptor.contentType !== 'application/pdf' ||
        descriptor.byteSize !== configured.locator.byteSize
      )
        throw new Error('staff_quote_policy_descriptor_invalid');
      const path = resolve(repo, configured.path),
        body = checkedPrivateFile(path, ARTIFACT_MAX_INPUT_BYTES);
      if (body.length !== descriptor.byteSize || sha(body) !== configured.sourceHash)
        throw new Error('staff_quote_policy_original_changed');
      originals.set(path, configured.sourceHash);
      if (terms) {
        if (
          configured.publicationAt !== row.eventAt ||
          configured.authoredDate !== undefined ||
          configured.rateCode !== undefined ||
          configured.board !== undefined ||
          !configured.acquisitionReceiptPath ||
          !configured.acquisitionReceiptSHA256
        )
          throw new Error('staff_quote_policy_publication_invalid');
        const receiptPath = resolve(repo, configured.acquisitionReceiptPath),
          receiptBytes = checkedPrivateFile(receiptPath, 4 * 1024 * 1024);
        if (sha(receiptBytes) !== configured.acquisitionReceiptSHA256)
          throw new Error('staff_quote_policy_receipt_changed');
        originals.set(receiptPath, configured.acquisitionReceiptSHA256);
        const receipts = JSON.parse(receiptBytes.toString()) as Array<{
          metadata?: Record<string, unknown>;
          scopeBinding?: Record<string, unknown>;
          locator?: Record<string, unknown>;
          [key: string]: unknown;
        }>;
        const receipt = receipts.find(
            (item) =>
              item.metadata?.attachmentId === descriptor.id && item.metadata.messageId === row.id,
          ),
          md = receipt?.metadata,
          scope = receipt?.scopeBinding;
        if (
          !receipt ||
          !md ||
          !scope ||
          receipt.status !== 'acquired' ||
          receipt.authority !== 'authorized_corpus_read' ||
          typeof receipt.localPath !== 'string' ||
          resolve(receipt.localPath) !== path ||
          md.sourceHash !== configured.sourceHash ||
          md.ownerRef !== row.transportId ||
          md.threadId !== row.threadId ||
          md.messageAt !== row.eventAt ||
          md.mimeType !== descriptor.contentType ||
          md.sizeBytes !== descriptor.byteSize ||
          md.inline !== descriptor.inline ||
          md.disclosure !== 'staff_only' ||
          receipt.locator?.s3Key !== descriptor.s3Key ||
          scope.ownerRef !== row.transportId ||
          scope.threadId !== row.threadId ||
          scope.disclosure !== 'staff_only' ||
          typeof scope.requestAt !== 'string' ||
          !(Date.parse(row.eventAt) < Date.parse(scope.requestAt)) ||
          receipt.sourceSnapshotHash !== scope.sourceSnapshotHash
        )
          throw new Error('staff_quote_policy_receipt_invalid');
      } else if (!configured.authoredDate || !configured.rateCode || !configured.board)
        throw new Error('staff_quote_policy_family_invalid');
      const extracted = await extractEmbeddedPdfText(
        {
          body,
          declaredSize: body.length,
          declaredMime: 'application/pdf',
          objectMime: 'application/pdf',
        },
        { runner: pdfRunner, signal: ctx.signal },
      );
      if (extracted.data.reason !== 'text' || !extracted.data.text)
        throw new Error('staff_quote_policy_pdf_unavailable');
      const pages = extracted.data.text.split('\f');
      while (pages.at(-1)?.trim() === '') pages.pop();
      const common = {
        ref: configured.ref,
        propertyCode: configured.propertyCode,
        ownerRef: configured.ownerRef,
        messageId: row.id,
        threadId: row.threadId,
        messageAt: row.eventAt,
        direction: 'outbound' as const,
        attachmentId: descriptor.id,
        sourceHash: configured.sourceHash,
        body,
        pages,
      };
      documents.push(
        terms
          ? { ...common, kind: 'hotel_rate_terms', publicationAt: configured.publicationAt! }
          : {
              ...common,
              kind: 'family_invoice',
              authoredDate: configured.authoredDate!,
              rateCode: configured.rateCode!,
              board: configured.board!,
            },
      );
      await guard();
    }
    if (sha(checkedPrivateFile(configurationPath, 1024 * 1024)) !== identity)
      throw new Error('staff_quote_policy_configuration_changed');
    for (const [path, hash] of originals)
      if (sha(checkedPrivateFile(path, 64 * 1024 * 1024)) !== hash)
        throw new Error('staff_quote_policy_original_changed');
    await guard();
    return documents;
  };
}

/** Installed real services. The authorized caller owns the existing property advisory lock. */
export function getInstalledStaffQuoteServices(
  options: InstalledStaffQuoteServiceOptions,
  staffApproval?: Parameters<typeof createReservationistBusinessServices>[1],
): ReturnType<typeof createReservationistBusinessServices> {
  const envName = staffQuoteConfigurationEnvName(options.propertyCode);
  const path = process.env[envName];
  if (!path) throw new Error('staff_quote_installation_unavailable');
  const bytes = checkedPrivateFile(path, 1024 * 1024),
    identity = sha(bytes);
  const configuration = validateStaffQuoteInstallationConfiguration(JSON.parse(bytes.toString()));
  const guard = () => {
    if (
      process.env[envName] !== path ||
      sha(checkedPrivateFile(path, 1024 * 1024)) !== identity
    )
      throw new Error('staff_quote_installation_changed');
  };
  const authorizeContext: BusinessOptions['authorizeContext'] = async (ctx) => {
    guard();
    ctx.signal.throwIfAborted();
    if (
      ctx.input.propertyCode !== configuration.owner.propertyCode ||
      ctx.input.capabilities.pmsWrite !== false ||
      ctx.input.capabilities.emailSend !== false
    )
      return false;
    const allowed = await options.authorizeContext(ctx);
    guard();
    ctx.signal.throwIfAborted();
    return allowed;
  };
  // Provisional mode: the next capture in this lock starts only after the previous trace finished.
  let traceFinishBefore: Promise<void> = Promise.resolve();
  const native = createExistingOwnerNativeQuoteReader({
    owner: configuration.owner,
    outputDir: configuration.outputDir,
    dispatch: async (request) => {
      const resultPath = join(configuration.outputDir, `quote-dispatch-${randomUUID()}.json`);
      if (quoteTraceAsyncEnabled()) {
        const outcome = await runProvisionalQuoteChild({
          executable: request.executable,
          args: [
            '--input-type=module',
            '-e',
            PROVISIONAL_QUOTE_SCRIPT,
            resultPath,
            request.args[0]!,
            request.args[2]!,
            configuration.outputDir,
          ],
          env: spawnEnvWithHeldLock(request.env, options.childEnv),
          signal: request.signal,
          timeoutMs: request.timeout,
          resultPath,
          previousFinish: traceFinishBefore,
          verifyFinal: verifyProvisionalQuoteFinal,
        });
        if (outcome.kind === 'provisional') {
          traceFinishBefore = outcome.finished;
          options.onEvidenceDirectory?.(outcome.evidenceDirectory);
          options.onTraceFinish?.(outcome.finished);
          return { stdout: 'Evidence: ' + outcome.evidenceDirectory + '\n', traceFinish: 'pending' as const };
        }
        traceFinishBefore = Promise.resolve();
        const settled = JSON.parse(checkedPrivateFile(resultPath, 1024 * 1024).toString()) as {
          evidenceDirectory?: string;
        };
        if (!settled.evidenceDirectory) throw new Error('staff_quote_native_capture_unavailable');
        options.onEvidenceDirectory?.(settled.evidenceDirectory);
        return { stdout: 'Evidence: ' + settled.evidenceDirectory + '\n' };
      }
      const script =
        "import {writeFileSync} from 'node:fs';const {fetchQuote}=await import(process.argv[2]);const result=await fetchQuote({requestPath:process.argv[3],outputDir:process.argv[4]});writeFileSync(process.argv[1],JSON.stringify({evidenceDirectory:result.evidenceDirectory}),{mode:0o600,flag:'wx'});process.exit(0);";
      try {
        await run(
          request.executable,
          [
            '--input-type=module',
            '-e',
            script,
            resultPath,
            request.args[0]!,
            request.args[2]!,
            configuration.outputDir,
          ],
          {
            env: spawnEnvWithHeldLock(request.env, options.childEnv),
            signal: request.signal,
            timeout: request.timeout,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch {
        request.signal.throwIfAborted();
        throw new Error('staff_quote_native_unavailable');
      }
      const result = JSON.parse(checkedPrivateFile(resultPath, 1024 * 1024).toString()) as {
        evidenceDirectory?: string;
      };
      if (!result.evidenceDirectory) throw new Error('staff_quote_native_capture_unavailable');
      options.onEvidenceDirectory?.(result.evidenceDirectory);
      return { stdout: 'Evidence: ' + result.evidenceDirectory + '\n' };
    },
  });
  const readParty = async (
    kind: 'organization' | 'bookingAgency',
    query: string,
    signal: AbortSignal,
  ): Promise<ReservationistPartyRead> => {
    guard();
    signal.throwIfAborted();
    const bound = bindCenturionHmsMailboxProperty({
      propertyCode: configuration.owner.propertyCode,
      origin: options.mailboxOrigin ?? {},
    });
    if (!bound.ok) throw new PartyRateFailure(bound.code);
    await mkdir(configuration.outputDir, { recursive: true, mode: 0o700 });
    const requestPath = join(configuration.outputDir, `party-${randomUUID()}.json`),
      resultPath = requestPath + '.result.json';
    await writeFile(
      requestPath,
      JSON.stringify({
        propertyCode: configuration.owner.propertyCode,
        kind,
        query: { [kind === 'organization' ? 'organizationName' : 'bookingAgencyName']: query },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const script =
      "import {writeFileSync} from 'node:fs';const {lookupParty}=await import(process.argv[2]);const result=await lookupParty({requestPath:process.argv[3]});writeFileSync(process.argv[1],JSON.stringify(result),{mode:0o600,flag:'wx'});process.exit(0);";
    try {
      await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          script,
          resultPath,
          join(repo, 'apps/server-pilot/tooling/playwright-quote/party-lookup.mjs'),
          requestPath,
        ],
        {
          signal,
          timeout: 300000,
          maxBuffer: 1024 * 1024,
          env: {
            ...(options.childEnv ?? process.env),
            HMS_STAGEHAND_CDP_URL: configuration.owner.cdpUrl,
            HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
            HMS_QUOTE_SECRET_PATH: configuration.owner.secretPath,
          },
        },
      );
    } catch {
      signal.throwIfAborted();
      throw new PartyRateFailure('staff_quote_party_unavailable');
    }
    const payload = JSON.parse(
      checkedPrivateFile(resultPath, ARTIFACT_MAX_INPUT_BYTES).toString(),
    ) as {
      outcome: ReservationistPartyRead['outcome'];
      evidenceDirectory: string;
      candidates: ReservationistPartyRead['candidates'];
    };
    if (
      !['resolved', 'ambiguous', 'no_match'].includes(payload.outcome) ||
      !inside(join(privateRoot, 'pms-pipeline/party-lookup/out'), payload.evidenceDirectory) ||
      !Array.isArray(payload.candidates) ||
      payload.candidates.some(
        (candidate) => !candidate.nativeId || !candidate.displayName || candidate.kind !== kind,
      )
    )
      throw new PartyRateFailure('staff_quote_party_invalid');
    const evidence = checkedPrivateFile(
      join(payload.evidenceDirectory, 'result.json'),
      ARTIFACT_MAX_INPUT_BYTES,
    );
    if (quoteDigest(JSON.parse(evidence.toString())) !== quoteDigest(payload))
      throw new PartyRateFailure('staff_quote_party_changed');
    guard();
    signal.throwIfAborted();
    return {
      ref: 'native-party:' + sha(evidence),
      sha256: sha(evidence),
      observedAt: new Date().toISOString(),
      kind,
      query,
      outcome: payload.outcome,
      candidates: payload.candidates,
    };
  };
  return createReservationistBusinessServices(
    {
      ...options,
      authorizeContext,
      readParty,
      readQuote: async (request, signal) => {
        guard();
        const result = await native(request, signal);
        guard();
        return result;
      },
      resolvePolicy: async () => null,
      resolveSelectedPolicy: createReservationistSelectedRatePolicyResolver({
        authorizeContext,
        readDocuments: createStaffQuoteRatePolicyDocumentReader({
          configurationPath: configuration.ratePolicyConfigurationPath,
          authorizeContext,
        }),
      }),
    },
    staffApproval,
  );
}
