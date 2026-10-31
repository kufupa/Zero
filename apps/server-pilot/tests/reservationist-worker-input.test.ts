import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { admitReservationistAttachment } from '../src/ai/reservationist-attachment-input.js';
import { buildReservationistWorkerInput, type ReservationistWorkerMessage } from '../src/ai/reservationist-worker-input.js';

const base = Date.now() - 600_000;
const at = (minutes: number) => new Date(base + minutes * 60_000);
const row = (id: string, minutes: number, overrides: Partial<ReservationistWorkerMessage> = {}): ReservationistWorkerMessage => ({
  id, transportId: 'mailbox', threadId: 'thread', direction: 'inbound', disclosure: 'guest',
  textBody: id, htmlBody: null, subject: null, receivedAt: at(minutes), sentAt: null,
  arrivedAt: at(minutes), createdAt: at(minutes), ...overrides,
});
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');

describe('reservationist worker input', () => {
  it('carries causal messages and business files while omitting later arrivals and a proven signature image', async () => {
    const rooming = Buffer.from('Two rooms for the earlier request');
    const unsupported = Buffer.from('workbook');
    const attachments = [
      { id: 'rooming', messageId: 'first', mimeType: 'text/plain', sizeBytes: rooming.length, sha256: hash(rooming), isInline: false, contentId: null, disclosure: 'guest' as const },
      { id: 'sheet', messageId: 'current', mimeType: 'application/vnd.ms-excel', sizeBytes: unsupported.length, sha256: hash(unsupported), isInline: false, contentId: null, disclosure: 'guest' as const },
      { id: 'logo', messageId: 'signature', mimeType: 'image/png', sizeBytes: 1, sha256: null, isInline: true, contentId: 'logo', disclosure: 'guest' as const },
      { id: 'later', messageId: 'later', mimeType: 'text/plain', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: false, contentId: null, disclosure: 'guest' as const },
    ];
    const bodies = new Map([['rooming', rooming], ['sheet', unsupported]]);
    const admit = vi.fn(async (metadata: Parameters<typeof admitReservationistAttachment>[0]['metadata']) => {
      const body = bodies.get(metadata.attachmentId)!;
      const locator = { messageId: metadata.messageId, mimeType: metadata.mimeType, sizeBytes: body.length, s3Key: `attachments/${metadata.messageId}/${metadata.attachmentId}` };
      return admitReservationistAttachment({
        metadata, scope: { ownerRef: 'mailbox', threadId: 'thread', requestAt: at(4).toISOString() },
        read: {
          attachmentId: metadata.attachmentId, authorizedAttachmentIds: new Set(bodies.keys()),
          signal: new AbortController().signal, resolveLocator: async () => locator,
          s3: { headObject: async () => ({ sizeBytes: body.length, contentType: metadata.mimeType }), getObjectBounded: async () => ({ body, contentType: metadata.mimeType }) } as never,
          revalidate: async () => true,
        },
      });
    });
    const result = await buildReservationistWorkerInput({
      transportId: 'mailbox', threadId: 'thread', triggerMessageId: 'current', requestId: 'request', propertyCode: 'HRCEN',
      messages: [row('first', 1), row('signature', 2, { textBody: 'Hello\nKind regards\ncid:logo' }),
        row('current', 4, { textBody: 'Please amend the stay. Card 4111 1111 1111 1111' }),
        row('later', 1, { arrivedAt: at(5), textBody: 'This arrived later despite its sender date.' })],
      attachments, sourceAt: new Date().toISOString(), deadlineAt: Date.now() + 60_000,
      signal: new AbortController().signal, admit,
    });
    expect(result.input.messages.map((m) => m.id)).toEqual(['first', 'signature', 'current']);
    expect(result.input.messages.at(-1)!.text).toContain('[card ••••1111]');
    expect(result.input.capabilities).toEqual({ pmsWrite: false, emailSend: false });
    expect(result.admissions.map((a) => [a.metadata.attachmentId, a.status])).toEqual([['rooming', 'admitted'], ['sheet', 'manual_required']]);
    expect(result.admissions[0]!.source?.pages).toEqual(['Two rooms for the earlier request']);
    expect(result.input.authorizedArtifacts).toHaveLength(2);
    expect(result.ignoredSignatures).toBe(1);
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it('refuses ambiguous ordering, missing business-file identity and an altered admission', async () => {
    const options = {
      transportId: 'mailbox', threadId: 'thread', triggerMessageId: 'current', requestId: 'request', propertyCode: 'HRCEN',
      messages: [row('current', 4)], attachments: [], sourceAt: new Date().toISOString(), deadlineAt: Date.now() + 60_000,
      signal: new AbortController().signal, admit: async (metadata: any) => ({ status: 'manual_required' as const, reason: 'unreadable', metadata, draftReady: false as const }),
    };
    await expect(buildReservationistWorkerInput({ ...options, messages: [row('tie', 4), row('current', 4)] })).rejects.toThrow('worker_intake_order_ambiguous');
    const attachment = { id: 'file', messageId: 'current', mimeType: 'text/plain', sizeBytes: 1, sha256: null, isInline: false, contentId: null, disclosure: 'guest' as const };
    await expect(buildReservationistWorkerInput({ ...options, attachments: [attachment] })).rejects.toThrow('worker_intake_attachment_identity_invalid');
    const recovered = await buildReservationistWorkerInput({ ...options, attachments: [attachment], resolveSourceHash: async () => 'b'.repeat(64) });
    expect(recovered.admissions[0]!.metadata.sourceHash).toBe('b'.repeat(64));
    await expect(buildReservationistWorkerInput({ ...options, attachments: [{ ...attachment, sha256: 'a'.repeat(64) }], admit: async (metadata) => {
      metadata.ownerRef = 'other';
      return { status: 'manual_required', reason: 'unreadable', metadata, draftReady: false };
    } })).rejects.toThrow('worker_intake_admission_mismatch');
  });

  it('keeps a prior footer image when an intervening message asks to use it', async () => {
    const image = { id: 'logo', messageId: 'first', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: true, contentId: 'logo', disclosure: 'guest' as const };
    const admit = vi.fn(async (metadata: any) => ({ status: 'manual_required' as const, reason: 'needs_review', metadata, draftReady: false as const }));
    const result = await buildReservationistWorkerInput({
      transportId: 'mailbox', threadId: 'thread', triggerMessageId: 'current', requestId: 'request', propertyCode: 'HRCEN',
      messages: [row('first', 1, { textBody: 'Hello\nKind regards\ncid:logo' }),
        row('middle', 2, { textBody: 'Please use that logo on the confirmation.' }),
        row('current', 3, { textBody: 'Please proceed.' })],
      attachments: [image], sourceAt: new Date().toISOString(), deadlineAt: Date.now() + 60_000,
      signal: new AbortController().signal, admit,
    });
    expect(result.ignoredSignatures).toBe(0);
    expect(result.admissions.map((a) => a.metadata.attachmentId)).toEqual(['logo']);
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('bounds admission by the deadline and passes the abort signal to the reader', async () => {
    let receivedSignal: AbortSignal | undefined;
    const admission = buildReservationistWorkerInput({
      transportId: 'mailbox', threadId: 'thread', triggerMessageId: 'current', requestId: 'request', propertyCode: 'HRCEN',
      messages: [row('current', 4)],
      attachments: [{ id: 'file', messageId: 'current', mimeType: 'text/plain', sizeBytes: 1, sha256: 'a'.repeat(64), isInline: false, contentId: null, disclosure: 'guest' }],
      sourceAt: new Date().toISOString(), deadlineAt: Date.now() + 150,
      signal: new AbortController().signal,
      admit: async (_metadata, signal) => { receivedSignal = signal; return new Promise(() => {}); },
    });
    await expect(admission).rejects.toThrow();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('rejects oversized raw HTML before parsing it', async () => {
    await expect(buildReservationistWorkerInput({
      transportId: 'mailbox', threadId: 'thread', triggerMessageId: 'current', requestId: 'request', propertyCode: 'HRCEN',
      messages: [row('current', 4, { textBody: null, htmlBody: 'x'.repeat(2_000_001) })], attachments: [],
      sourceAt: new Date().toISOString(), deadlineAt: Date.now() + 60_000,
      signal: new AbortController().signal, admit: async (metadata) => ({ status: 'manual_required', reason: 'unused', metadata, draftReady: false }),
    })).rejects.toThrow('worker_intake_context_limit');
  });
});
