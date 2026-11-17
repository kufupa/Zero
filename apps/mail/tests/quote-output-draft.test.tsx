/** @vitest-environment happy-dom */
import { createHash, webcrypto } from 'node:crypto';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuoteOutput } from '../lib/reservation-workflow/quote-output';
import type { ReservationPaneSnapshot, ReservationSourceContext } from '../lib/reservation-workflow/types';
import type { PaneBridge } from '../lib/workstation/pane-bridge-types';

const fixture = vi.hoisted(() => ({ output: null as QuoteOutput | null }));
vi.mock('../lib/reservation-workflow/quote-output', async (load) => ({
  ...await load<typeof import('../lib/reservation-workflow/quote-output')>(),
  getQuotePackageOutput: () => fixture.output,
}));
vi.mock('../providers/query-provider', () => ({ trpcClient: {} }));
vi.mock('../lib/workstation/mutations-in-flight', () => ({ beginMutation: () => {}, endMutation: () => {} }));

import { useQuoteOutput } from '../components/reservation-pane/use-quote-output';

const source: ReservationSourceContext = {
  mailboxId: 'mailbox', propertyId: 'HRCEN', messageId: 'message', threadId: 'thread', sourceHash: 'hash',
  selectionEpoch: 1, subject: 'Availability', sender: 'sender@example.com', arrivedAt: '2026-11-16T12:00:00Z',
  internetMessageId: '<message@example.com>', attachments: [],
};
const email = {
  entryId: 'source', storeId: 'store', folderEntryId: 'inbox', subject: 'Availability',
  senderEmail: 'sender@example.com', senderName: 'Sender', receivedTime: '', bodyText: '', bodyHtml: '',
  internetMessageId: '<message@example.com>',
};
const location = { entryId: 'draft', storeId: 'store', folderEntryId: 'drafts', folderName: 'Drafts' };
const artifact = (kind: 'pdf_quote' | 'xlsx_quote', fileName: string, content: string) => {
  const bytes = Buffer.from(content);
  return { kind, fileName, mimeType: 'application/octet-stream', sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') };
};
const input = { snapshot: {} as ReservationPaneSnapshot, requestId: 'request', html: '<p>Quote attached.</p>' };

type Attachment = { fileName: string; base64Data: string };
function makeHost({ readback, subjectReadback, timeoutOnce = false }: { readback?: string; subjectReadback?: string; timeoutOnce?: boolean } = {}) {
  const attachments: Attachment[] = [];
  let to = email.senderEmail, subject = email.subject;
  const sendCommand = vi.fn(async (action: string, payload: Record<string, unknown>) => {
    switch (action) {
      case 'GET_ACTIVE_EMAIL': return email;
      case 'CREATE_REPLY_DRAFT': return location;
      case 'UPDATE_DRAFT':
        if (timeoutOnce) { timeoutOnce = false; throw new Error('Update timed out'); }
        to = String(payload.to); subject = String(payload.subject);
        return location;
      case 'GET_ATTACHMENT_METADATA': return attachments.map((item, index) => ({ index, fileName: item.fileName,
        byteSize: Buffer.from(item.base64Data, 'base64').length }));
      case 'ADD_ATTACHMENT_TO_DRAFT':
        attachments.push({ fileName: String(payload.fileName), base64Data: String(payload.base64Data) });
        return true;
      case 'READ_ATTACHMENT_BASE64': {
        const index = Number(payload.attachmentIndex), item = attachments[index]!;
        return { index, fileName: item.fileName, byteSize: Buffer.from(item.base64Data, 'base64').length, base64Data: item.base64Data };
      }
      case 'GET_EMAIL_BY_ENTRY_ID': return { ...email, ...location, bodyText: 'Quote attached.', to: readback ?? to, subject: subjectReadback ?? subject, cc: '' };
      default: throw new Error(`Unexpected command ${action}`);
    }
  });
  const bridge = { activeEmail: email, supportsAction: () => true, capabilities: { preservesAttachmentFilenames: true }, sendCommand } as unknown as PaneBridge;
  return { bridge, sendCommand, attachments };
}

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, _options: unknown, run: (lock: object) => unknown) => run({}) } });
  fixture.output = { requestId: 'request', operationId: 'quote-1', observationRef: 'observation',
    cover: { to: 'alternate@example.com', subject: 'Quote', body: 'Quote attached.' },
    artifacts: [artifact('pdf_quote', 'quote.pdf', 'pdf bytes'), artifact('xlsx_quote', 'quote.xlsx', 'xlsx bytes')],
    failures: [], issues: [], stale: false, inventoryDecline: false };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Outlook quote draft recipient', () => {
  it('addresses the selected recipient and verifies the two attachments', async () => {
    const host = makeHost();
    const { result } = renderHook(() => useQuoteOutput({ source, configuration: null, bridge: host.bridge, isCurrentSource: () => true }));
    let outcome;
    await act(async () => { outcome = await result.current.createOutlookReply(input); });
    expect(outcome).toMatchObject({ status: 'created' });
    expect(host.sendCommand).toHaveBeenCalledWith('UPDATE_DRAFT', expect.objectContaining({ entryId: 'draft', storeId: 'store', folderEntryId: 'drafts', to: 'alternate@example.com', cc: '', bcc: '', subject: 'Re: Availability' }));
    expect(host.attachments.map(item => item.fileName)).toEqual(['quote.pdf', 'quote.xlsx']);
  });

  it.each(['sender@example.com', 'Display Name'])('does not claim success when Outlook returns %s', async (readback) => {
    const host = makeHost({ readback });
    const { result } = renderHook(() => useQuoteOutput({ source, configuration: null, bridge: host.bridge, isCurrentSource: () => true }));
    let outcome;
    await act(async () => { outcome = await result.current.createOutlookReply(input); });
    expect(outcome).toMatchObject({ status: 'unknown', message: expect.stringContaining('verify the recipient') });
    expect(host.attachments).toHaveLength(2);
  });

  it('does not claim success when the saved reply subject differs', async () => {
    const host = makeHost({ subjectReadback: 'Different subject' });
    const { result } = renderHook(() => useQuoteOutput({ source, configuration: null, bridge: host.bridge, isCurrentSource: () => true }));
    let outcome;
    await act(async () => { outcome = await result.current.createOutlookReply(input); });
    expect(outcome).toMatchObject({ status: 'unknown' });
    expect(host.attachments).toHaveLength(2);
  });

  it('retries an uncertain recipient update without making a second draft', async () => {
    const host = makeHost({ timeoutOnce: true });
    const firstPane = renderHook(() => useQuoteOutput({ source, configuration: null, bridge: host.bridge, isCurrentSource: () => true }));
    let first, second;
    await act(async () => { first = await firstPane.result.current.createOutlookReply(input); });
    firstPane.unmount();
    const secondPane = renderHook(() => useQuoteOutput({ source, configuration: null, bridge: host.bridge, isCurrentSource: () => true }));
    await act(async () => { second = await secondPane.result.current.createOutlookReply(input); });
    expect(first).toMatchObject({ status: 'unknown' });
    expect(second).toMatchObject({ status: 'created' });
    expect(host.sendCommand.mock.calls.filter(([action]) => action === 'CREATE_REPLY_DRAFT')).toHaveLength(1);
    const updates = host.sendCommand.mock.calls.filter(([action]) => action === 'UPDATE_DRAFT');
    expect(updates).toHaveLength(2);
    expect(updates[0]![1].operationId).toBe(updates[1]![1].operationId);
  });
});
