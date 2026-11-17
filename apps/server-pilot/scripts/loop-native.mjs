import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Drafts live in a disposable local database; live mailbox metadata is read only.
const [inputFile, outputDir] = process.argv.slice(2);
const pilot = process.env.LOOP_PILOT_ROOT;
const isolatedUrl = process.env.LOOP_ISOLATED_DATABASE_URL;
if (!inputFile || !outputDir || !pilot || !process.env.DATABASE_URL) throw Error('loop_native_configuration_missing');
const input = JSON.parse(await readFile(inputFile, 'utf8'));
const sourceOnly = input.selectionOnly || input.candidate?.kind === 'mail_candidate';
if (!sourceOnly && !isolatedUrl) throw Error('loop_native_configuration_missing');
if (isolatedUrl && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(isolatedUrl).hostname)) throw Error('loop_database_must_be_local');
const load = file => import(pathToFileURL(resolve(pilot, file)).href);
const [client, mail, auth, state, quote, create, amend, cancel, filing] = await Promise.all([
  load('src/db/client.ts'), load('src/db/schema/mail.ts'), load('src/db/schema/auth.ts'),
  load('src/ai/reservation-workflow-v2-state.ts'), load('src/ai/reservation-workflow-v2-quote.ts'),
  load('src/ai/reservation-workflow-v2-tools.ts'), load('src/ai/reservation-workflow-v2-amend.ts'),
  load('src/ai/reservation-workflow-v2-cancel.ts'), load('src/ai/reservation-workflow-v2-filing.ts'),
]);
const live = client.createDb(process.env.DATABASE_URL);
const liveStarted = performance.now();
const attachmentSnapshot = files => files.map(file => ({
  id: file.id, messageId: file.messageId ?? file.message_id, filename: file.filename,
  mimeType: file.mimeType ?? file.mime_type, sizeBytes: Number(file.sizeBytes ?? file.size_bytes),
  sha256: file.sha256 ?? null, sourceAttachmentId: file.sourceAttachmentId ?? file.source_attachment_id ?? null,
  s3Key: file.s3Key ?? file.s3_key ?? null, isInline: file.isInline ?? file.is_inline,
  contentId: file.contentId ?? file.content_id ?? null,
})).sort((a, b) => a.id.localeCompare(b.id));
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
  if (input.attachmentSnapshot && JSON.stringify(attachmentSnapshot(current.attachments)) !== JSON.stringify(input.attachmentSnapshot))
    throw Error('live_attachments_changed');
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
      const attachmentRows = await db.select({ attachment: mail.attachment }).from(mail.attachment)
        .innerJoin(mail.message, eq(mail.attachment.messageId, mail.message.id))
        .where(eq(mail.message.threadId, input.source.threadId));
      const attachments = attachmentSnapshot(attachmentRows.map(row => row.attachment));
      if (JSON.stringify(attachments) !== JSON.stringify(attachmentSnapshot(current.attachments))) throw Error('live_attachments_changed');
      const selection = await loadSyncedQuoteSelectionFromMailbox({ db, transportId: input.transport.id, messageId: input.source.messageId,
        includeThreadState: true, sourceCutoffOnly: true, includeVisionImages: true, trackVisionImages: true, signal: AbortSignal.timeout(60_000) });
      if (!selection) throw Error('live_selection_unavailable');
      const evidence = await reservationArrivalEvidence(db, input.source.messageId);
      return { selection, source: input.source, attachmentSnapshot: attachments, mailboxAddress: input.transport.email,
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
if (sourceOnly) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const result = input.selectionOnly ? { ...input.loaded, stages: [], requests: 0 } : { candidate: input.mailCandidate,
    stages: [{ name: 'candidate_lookup', seconds: (performance.now() - liveStarted) / 1000, result: input.mailCandidate }], requests: 0 };
  await writeFile(join(outputDir, 'native.json'), JSON.stringify(result,
    (_, value) => value instanceof Uint8Array ? { loopBytes: Buffer.from(value).toString('base64') } : value), { mode: 0o600 });
} else {
const { db, conn } = client.createDb(isolatedUrl);
client.__setDbForTests({ db, conn });
await mkdir(outputDir, { recursive: true, mode: 0o700 });
const actorId = randomUUID();
const transportId = input.transport.id;
const propertyCode = input.propertyCode;
const addresses = value => (value ?? []).map(item => typeof item === 'string' ? item : item?.email).filter(item => typeof item === 'string' && item.trim());
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
let requestCount = 0;
const assumptions = [];
const checkpoint = stages => writeFile(join(outputDir, 'native.json'), JSON.stringify({ stages, assumptions, requests: requestCount }), { mode: 0o600 });
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
  if (input.candidate) {
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
    const quotePath = relative => `/proposal/content/requests/${encodeURIComponent(request.id)}/body/${relative}`;
    const editQuote = async (relative, value, reason) => {
      const edited = await state.editReservationWorkflowV2Draft(stateCtx, { ...await refresh(), fieldPath: quotePath(relative),
        value: { state: 'set', value, updatedAt: new Date().toISOString() } });
      if (edited.status !== 'ok') throw Error(`quote_simulated_edit:${edited.status}`);
      assumptions.push({ requestId: request.id, field: relative, value, reason });
    };
    const reviewQuote = async fieldPath => {
      const reviewed = await state.reviewReservationWorkflowV2Draft(stateCtx, { ...await refresh(), fieldPath,
        decision: 'accepted', note: 'Replay simulation; not staff approval' });
      if (reviewed.status !== 'ok') throw Error(`quote_simulated_review:${reviewed.status}`);
      assumptions.push({ requestId: request.id, field: fieldPath, reason: 'Replay accepted proposed field for an unsent illustration' });
    };
    if (request.kind === 'quote') {
      await editQuote('outputIntent/artifacts', ['email_quote', 'pdf_quote', 'xlsx_quote'], 'Requested replay outputs');
      if (request.body.salesStrategy == null) await editQuote('salesStrategy', 'BAR', 'Illustrative public-rate search');
      if (request.body.provisionalBookingRequested == null)
        await editQuote('provisionalBookingRequested', false, 'Quote-only replay; no booking is made');
      for (const [index, group] of request.body.groups.entries()) {
        if (group.quantity == null) await editQuote(`groups/${index}/quantity`, 1, 'Illustrative one-room scenario; extracted count is missing');
        if (group.quantity == null || group.quantity === 1) {
          if (group.occupancy.scope == null || group.occupancy.scope === 'unknown')
            await editQuote(`groups/${index}/occupancy/scope`, 'per_room', 'Illustrative single-room occupancy');
          if (group.occupancy.adults == null) await editQuote(`groups/${index}/occupancy/adults`, 1, 'Illustrative one-adult occupancy');
          if (group.occupancy.childCount == null && !group.occupancy.childAges?.length)
            await editQuote(`groups/${index}/occupancy/childCount`, 0, 'Illustrative scenario without children');
        }
      }
    }
    const lookedUp = await stage('lookup', request.id, async () => lookup({ ...ctx, signal: AbortSignal.timeout(70_000) },
      { ...await refresh(), requestId: request.id }), stages);
    if (request.kind === 'quote') {
      await refresh();
      const discovery = quote.compileReservationWorkflowV2Quote(current.draft, request, false);
      const priced = lookedUp.quotes?.find(row => row.requestId === request.id && row.status === 'priced');
      if (discovery.status === 'ok' && priced) {
        for (const [index, group] of discovery.input.groups.entries()) {
          if (discovery.input.salesStrategy !== 'BAR') continue;
          const offers = (priced.quote?.rateOptions ?? []).filter(row => row.groupId === group.id && row.roomCode &&
            row.rateCode === 'BAR' && row.contract === false && row.matchesRequest === true &&
            row.mealPlan === group.mealPlan && (!group.rateCode || group.rateCode === row.rateCode) &&
            (!group.roomCodes?.length || group.roomCodes.length === 1 && group.roomCodes[0] === row.roomCode) &&
            Number.isSafeInteger(row.totalMinor) && row.totalMinor > 0)
            .sort((a, b) => a.totalMinor - b.totalMinor || a.roomCode.localeCompare(b.roomCode));
          const offer = offers[0];
          if (!offer) continue;
          for (const [field, value] of [['roomCodes', [offer.roomCode]], ['ratePlan', offer.rateCode], ['mealPlan', offer.mealPlan]])
            await editQuote(`groups/${index}/${field}`, value, 'Illustrative matching BAR offer from HMS');
        }
      }
    }
    const targets = request.kind === 'create' ? request.body.allocations ?? [] :
      ['amend', 'cancel'].includes(request.kind) ? request.body.targets?.include ?? [] : [null];
    for (const target of targets.length ? targets : [null]) {
      const result = await stage('prepare', request.id, async () => prepare({ ...ctx, signal: AbortSignal.timeout(70_000) }, { ...await refresh(), requestId: request.id,
        ...(target ? { allocationId: target.id } : {}) }), stages);
      if (request.kind === 'quote' && result.status === 'prepared') {
        await refresh();
        const compiled = quote.compileReservationWorkflowV2Quote(current.draft, request, true, Boolean(result.unavailableInventory));
        if (compiled.issue === 'quote_requires_staff_acceptance') {
          for (const path of compiled.fields.filter(field => field.startsWith('/') && !field.includes(':'))) await reviewQuote(path);
        }
        await refresh();
        const observation = current.draft.observations.find(row => row.ref === result.observationRef);
        if (observation?.result?.extrasReviewItems?.length) await reviewQuote(quotePath('').replace(/\/$/, ''));
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
  await writeFile(join(outputDir, 'native.json'), JSON.stringify({ stages, assumptions, requests: requests.length }, null, 2), { mode: 0o600 });
  }
} finally {
  client.__setDbForTests(null);
  await conn.end();
}
}
