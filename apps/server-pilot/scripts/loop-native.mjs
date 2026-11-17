import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Drafts live in a disposable local database; live mailbox metadata is read only.
const [inputFile, outputDir] = process.argv.slice(2);
const pilot = process.env.LOOP_PILOT_ROOT;
const isolatedUrl = process.env.LOOP_ISOLATED_DATABASE_URL;
if (!inputFile || !outputDir || !pilot || !isolatedUrl || !process.env.DATABASE_URL) throw Error('loop_native_configuration_missing');
const isolated = new URL(isolatedUrl);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(isolated.hostname)) throw Error('loop_database_must_be_local');
const input = JSON.parse(await readFile(inputFile, 'utf8'));
const load = file => import(pathToFileURL(resolve(pilot, file)).href);
const [client, mail, auth, state, quote, create, amend, cancel, filing] = await Promise.all([
  load('src/db/client.ts'), load('src/db/schema/mail.ts'), load('src/db/schema/auth.ts'),
  load('src/ai/reservation-workflow-v2-state.ts'), load('src/ai/reservation-workflow-v2-quote.ts'),
  load('src/ai/reservation-workflow-v2-tools.ts'), load('src/ai/reservation-workflow-v2-amend.ts'),
  load('src/ai/reservation-workflow-v2-cancel.ts'), load('src/ai/reservation-workflow-v2-filing.ts'),
]);
const live = client.createDb(process.env.DATABASE_URL);
try {
  const current = await live.conn.begin('isolation level repeatable read read only', async sql => {
    const transports = await sql`select id, email, owner_header_value, mailbox_type, display_name, is_active
      from mailbox_transport where id = ${input.transport.id} and is_active = true`;
    const messages = await sql`select id, direction, from_address, to_addresses, cc_addresses, owner_header_value,
      subject, text_body, html_body, received_at, sent_at, created_at, ingest_mailbox_id, pop3_uidl, source_provenance, history_only, message_id_header
      from message where transport_id = ${input.transport.id} and thread_id = ${input.source.threadId}`;
    const attachments = await sql`select a.* from attachment a join message m on m.id = a.message_id
      where m.transport_id = ${input.transport.id} and m.thread_id = ${input.source.threadId}`;
    const ingest = await sql`select distinct i.id, i.email, i.description, i.is_active from mail_ingest_mailbox i
      join message m on m.ingest_mailbox_id = i.id where m.transport_id = ${input.transport.id} and m.thread_id = ${input.source.threadId}`;
    return { transport: transports[0], messages, attachments, ingest };
  });
  if (!current.transport) throw Error('live_mailbox_unavailable');
  input.transport = { id: current.transport.id, email: current.transport.email, ownerHeaderValue: current.transport.owner_header_value,
    mailboxType: current.transport.mailbox_type, displayName: current.transport.display_name, isActive: current.transport.is_active };
  const selected = current.messages.find(row => row.id === input.source.messageId);
  const snapshot = input.messages.find(row => row.id === input.source.messageId);
  if (!selected || selected.direction !== 'inbound' || selected.history_only || !snapshot || ['subject', 'textBody', 'htmlBody'].some((key, index) =>
    (snapshot[key] ?? '') !== (selected[['subject', 'text_body', 'html_body'][index]] ?? ''))) throw Error('live_source_changed');
  if (input.messages.some(row => {
    if (row.threadId !== input.source.threadId) return false;
    const liveRow = current.messages.find(message => message.id === row.id);
    return !liveRow || ['subject', 'textBody', 'htmlBody'].some((key, index) =>
      (row[key] ?? '') !== (liveRow[['subject', 'text_body', 'html_body'][index]] ?? ''));
  }))
    throw Error('live_thread_changed');
  snapshot.subject = selected.subject; snapshot.textBody = selected.text_body; snapshot.htmlBody = selected.html_body;
  const { staffQuoteSourceHash } = await load('src/ai/staff-quote-workflow.ts');
  const { MESSAGE_ARRIVED_AT } = await load('src/ai/message-arrival-time.ts');
  const { eq } = await load('node_modules/drizzle-orm/index.js');
  const [arrival] = await live.db.select({ arrivedAt: MESSAGE_ARRIVED_AT }).from(mail.message)
    .where(eq(mail.message.id, input.source.messageId)).limit(1);
  if (!(arrival?.arrivedAt instanceof Date)) throw Error('live_arrival_unavailable');
  const oldHash = input.source.sourceHash;
  const oldArrival = input.source.arrivedAt;
  const actualHash = staffQuoteSourceHash({ id: selected.id, subject: selected.subject, textBody: selected.text_body, htmlBody: selected.html_body });
  const actualArrival = arrival.arrivedAt.toISOString();
  const rebind = value => {
    if (Array.isArray(value)) return value.map(rebind);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rebind(entry)]));
    return value === oldHash ? actualHash : value === oldArrival ? actualArrival : value;
  };
  input.source.sourceHash = actualHash;
  input.source.arrivedAt = actualArrival;
  if (input.prefill) input.prefill = rebind(input.prefill);
  const eligibility = await state.validateReservationWorkflowV2Source({ db: live.db, transportId: input.transport.id,
    userId: null, propertyCode: input.propertyCode }, input.source);
  if (eligibility.status !== 'ok') throw Error(`live_source:${eligibility.status}`);
  for (const row of current.messages) {
    let snapshotRow = input.messages.find(entry => entry.id === row.id);
    if (!snapshotRow && row.direction === 'inbound') {
      snapshotRow = { id: row.id, threadId: input.source.threadId, businessDirection: 'inbound',
        from: [row.from_address], to: row.to_addresses, cc: row.cc_addresses };
      input.messages.push(snapshotRow);
    }
    if (snapshotRow) Object.assign(snapshotRow, { businessDirection: row.direction, from: [row.from_address],
      to: row.to_addresses, cc: row.cc_addresses, ownerHeaderValue: row.owner_header_value,
      receivedAt: row.received_at, sentAt: row.sent_at, createdAt: row.created_at, historyOnly: row.history_only,
      ingestMailboxId: row.ingest_mailbox_id, pop3Uidl: row.pop3_uidl, sourceProvenance: row.source_provenance,
      messageId: row.message_id_header, attachmentDescriptors: current.attachments.filter(file => file.message_id === row.id) });
  }
  input.ingest = current.ingest;
  if (input.selectionOnly) {
    const [{ loadSyncedQuoteSelectionFromMailbox }, { reservationArrivalEvidence }, { attachmentEvidenceUnknown, fileAttachmentPresence }] = await Promise.all([
      load('src/ai/quote-workflow-synced-selection.ts'), load('src/ai/reservation-workflow-v2-evidence.ts'),
      load('src/mail/ingest/attachment-evidence.ts'),
    ]);
    input.loaded = await live.db.transaction(async db => {
      const selection = await loadSyncedQuoteSelectionFromMailbox({ db, transportId: input.transport.id, messageId: input.source.messageId,
        includeThreadState: true, sourceCutoffOnly: true, includeVisionImages: true, trackVisionImages: true, signal: AbortSignal.timeout(60_000) });
      if (!selection) throw Error('live_selection_unavailable');
      const evidence = await reservationArrivalEvidence(db, input.source.messageId);
      return { selection, source: input.source, mailboxAddress: input.transport.email,
        attachmentEvidenceUnknown: attachmentEvidenceUnknown(selected.source_provenance),
        contextAttachmentEvidenceUnknown: evidence.attachmentEvidenceUnknown,
        hasPersistedNonInlineAttachment: fileAttachmentPresence(current.attachments.some(file => file.message_id === selected.id && !file.is_inline), selected.source_provenance) === true,
        currentAttachmentGaps: evidence.missingCurrent.length, contextAttachmentGaps: evidence.missing.length };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  if (input.candidate?.kind === 'mail_candidate') {
    const { createReservationWorkflowV2CandidateReader } = await load('src/ai/reservation-workflow-v2-prefill.ts');
    input.mailCandidate = await live.db.transaction(async db =>
      createReservationWorkflowV2CandidateReader({ db, transportId: input.transport.id,
        propertyCode: input.propertyCode, source: input.source, participants: input.participants,
        candidates: [input.candidate] })(input.candidate), { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
} finally { await live.conn.end(); }
const { db, conn } = client.createDb(isolatedUrl);
client.__setDbForTests({ db, conn });
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const actorId = randomUUID();
const transportId = input.transport.id;
const propertyCode = input.propertyCode;
const addresses = value => (value ?? []).map(item => typeof item === 'string' ? item : item?.email).filter(item => typeof item === 'string' && item.trim());
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
let requestCount = 0;
const checkpoint = stages => writeFile(join(outputDir, 'native.json'), JSON.stringify({ stages, requests: requestCount }), { mode: 0o600 });
const stage = async (name, requestId, fn, stages) => {
  const started = performance.now();
  const record = { name, requestId, seconds: 0, result: { status: 'running' } };
  stages.push(record);
  await checkpoint(stages);
  try {
    const result = await fn();
    Object.assign(record, { seconds: (performance.now() - started) / 1000, result });
    await checkpoint(stages);
    return result;
  } catch (error) {
    const issue = error instanceof Error && /^[A-Za-z0-9_ :.,/-]{1,200}$/.test(error.message)
      ? error.message : 'native_operation_failed';
    const result = { status: 'failed', issue };
    Object.assign(record, { seconds: (performance.now() - started) / 1000, result });
    await checkpoint(stages);
    return result;
  }
};

try {
  await db.insert(auth.user).values({ id: actorId, name: 'Nava', email: input.transport.email, emailVerified: true });
  await db.insert(mail.mailboxTransport).values(input.transport);
  await db.insert(mail.mailboxAccess).values({ id: randomUUID(), userId: actorId, transportId, role: 'member' });
  for (const mailbox of input.ingest ?? []) await db.insert(mail.mailIngestMailbox).values({ id: mailbox.id, email: mailbox.email,
    description: mailbox.description, isActive: mailbox.is_active });
  const source = input.source;
  const messageRows = input.messages.filter(row => row.threadId === source.threadId);
  await db.insert(mail.mailThread).values({ id: source.threadId, threadRootId: source.threadId, transportId });
  for (const row of messageRows) {
    await db.insert(mail.message).values({
      id: row.id, transportId, threadId: row.threadId,
      direction: row.businessDirection === 'outbound' ? 'outbound' : 'inbound',
      fromAddress: addresses(row.from)[0] ?? '', toAddresses: addresses(row.to), ccAddresses: addresses(row.cc), bccAddresses: addresses(row.bcc),
      ownerHeaderValue: row.ownerHeaderValue ?? null, messageIdHeader: row.messageId ?? null, ingestMailboxId: row.ingestMailboxId ?? null,
      pop3Uidl: row.pop3Uidl ?? null, sourceProvenance: row.sourceProvenance ?? null,
      historyOnly: row.historyOnly ?? false,
      inReplyTo: row.inReplyTo ?? null, references: row.references ?? null,
      subject: row.subject ?? null, textBody: row.textBody ?? null, htmlBody: row.htmlBody ?? null,
      receivedAt: date(row.receivedAt), sentAt: date(row.sentAt), createdAt: date(row.createdAt) ?? date(row.eventAt) ?? new Date(),
    }).onConflictDoNothing();
    for (const attachment of row.attachmentDescriptors ?? []) {
      await db.insert(mail.attachment).values({ id: attachment.id, messageId: row.id, filename: attachment.filename,
        mimeType: attachment.mime_type, sizeBytes: Number(attachment.size_bytes), isInline: attachment.is_inline === true,
        sha256: attachment.sha256, sourceAttachmentId: attachment.source_attachment_id, contentId: attachment.content_id,
        s3Key: attachment.s3_key }).onConflictDoNothing();
    }
  }
  const stateCtx = { db, transportId, userId: actorId, propertyCode };
  const ctx = { db, user: { id: actorId }, transport: { id: transportId }, property: { propertyCode } };
  if (input.selectionOnly) {
    await writeFile(join(outputDir, 'native.json'), JSON.stringify({ ...input.loaded, stages: [], requests: 0 },
      (_, value) => value instanceof Uint8Array ? { loopBytes: Buffer.from(value).toString('base64') } : value), { mode: 0o600 });
  } else if (input.candidate) {
    const prefill = await load('src/ai/reservation-workflow-v2-prefill.ts');
    const reader = prefill.createReservationWorkflowV2CandidateReader({ db, transportId, propertyCode, source,
      participants: input.participants, candidates: [input.candidate], signal: AbortSignal.timeout(80_000) });
    const started = performance.now();
    const candidate = Object.hasOwn(input, 'mailCandidate') ? input.mailCandidate : await reader(input.candidate);
    await writeFile(join(outputDir, 'native.json'), JSON.stringify({ candidate, stages: [{ name: 'candidate_lookup',
      seconds: (performance.now() - started) / 1000, result: candidate }], requests: 0 }), { mode: 0o600 });
  } else {
  let current = await state.ensureReservationWorkflowV2Draft(stateCtx, { source, seed: input.prefill });
  if (current.status !== 'ok') throw Error(`seed:${current.status}`);
  const item = { workItemId: current.draft.workItemId, source };
  const stages = [];
  const refresh = async () => {
    current = await state.getReservationWorkflowV2Draft(stateCtx, item);
    if (current.status !== 'ok') throw Error(`reload:${current.status}`);
    return { ...item, expectedRevision: current.revision, expectedSeq: current.seq };
  };
  const requests = current.draft.proposal.content.requests.filter(request => request.kind === input.workflow);
  requestCount = requests.length;
  const adapters = {
    quote: [quote.reservationWorkflowV2QuoteLookup, quote.reservationWorkflowV2QuotePrepare],
    create: [create.reservationWorkflowV2Lookup, create.reservationWorkflowV2Prepare],
    amend: [amend.reservationWorkflowV2AmendLookup, amend.reservationWorkflowV2AmendPrepare],
    cancel: [cancel.reservationWorkflowV2CancelLookup, cancel.reservationWorkflowV2CancelPrepare],
    filing: [filing.reservationWorkflowV2FilingLookup, filing.reservationWorkflowV2FilingPrepare],
  };
  const [lookup, prepare] = adapters[input.workflow];
  for (const request of requests) {
    if (request.kind === 'quote') {
      const path = `/proposal/content/requests/${encodeURIComponent(request.id)}/body/outputIntent/artifacts`;
      const edited = await state.editReservationWorkflowV2Draft(stateCtx, { ...await refresh(), fieldPath: path,
        value: { state: 'set', value: ['email_quote', 'pdf_quote', 'xlsx_quote'], updatedAt: new Date().toISOString() } });
      if (edited.status !== 'ok') throw Error(`quote_output_selection:${edited.status}`);
    }
    await stage('lookup', request.id, async () => lookup(ctx, { ...await refresh(), requestId: request.id }), stages);
    const targets = request.kind === 'create' ? request.body.allocations ?? [] :
      ['amend', 'cancel'].includes(request.kind) ? request.body.targets?.include ?? [] : [null];
    for (const target of targets.length ? targets : [null]) {
      const result = await stage('prepare', request.id, async () => prepare(ctx, { ...await refresh(), requestId: request.id,
        ...(target ? { allocationId: target.id } : {}) }), stages);
      if (request.kind === 'quote' && result.status === 'prepared') {
        const output = await stage('artifacts', request.id, async () => quote.reservationWorkflowV2QuoteExecute(ctx, {
          ...await refresh(), requestId: request.id, go: true, idempotencyKey: randomUUID(),
        }), stages);
        if (output.status === 'succeeded' || output.status === 'partial') {
          if (output.emailSent !== false || output.reservationSaved !== false) throw Error('quote_output_not_unsent');
          if (!/^[a-zA-Z0-9_-]+$/.test(request.id)) throw Error('quote_request_id_invalid');
          if (output.coverEmail) await writeFile(join(outputDir, `${request.id}.cover.json`), JSON.stringify(output.coverEmail, null, 2), { mode: 0o600 });
          for (const artifact of output.artifacts ?? []) {
            const extension = artifact.kind === 'pdf_quote' ? 'pdf' : artifact.kind === 'xlsx_quote' ? 'xlsx' : null;
            if (extension && artifact.bytesBase64) await writeFile(join(outputDir, `${request.id}.quote.${extension}`), Buffer.from(artifact.bytesBase64, 'base64'), { mode: 0o600 });
          }
          for (const artifact of output.artifacts ?? []) delete artifact.bytesBase64;
        }
      }
    }
  }
  await writeFile(join(outputDir, 'native.json'), JSON.stringify({ stages, requests: requests.length }, null, 2), { mode: 0o600 });
  }
} finally {
  client.__setDbForTests(null);
  await conn.end();
}
