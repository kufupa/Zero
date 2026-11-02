/** @vitest-environment happy-dom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SelectedEmailBlock } from '@/components/nava-pane/blocks/selected-email';
import { WorkstationEmailPayloadSchema } from '@/lib/workstation/bridge-protocol';
import { activeEmailFromMessage, buildPreviewBridge } from '@/lib/workstation/web-pane-bridge';

afterEach(cleanup);

const nativeEmail = (entryId: string, storeId = 'native-store') => WorkstationEmailPayloadSchema.parse({
  entryId, storeId, internetMessageId: `<${entryId}@example.test>`, subject: 'Same subject',
  senderEmail: 'guest@example.test', senderName: 'Guest', receivedTime: '2026-11-02T10:00:00Z',
  bodyText: 'Example', bodyHtml: '<p>Example</p>',
});
const webEmail = (id: string, transportId = 'web-mailbox') => activeEmailFromMessage({
  id, threadId: 'thread', direction: 'inbound', isDraft: false, messageId: `<${id}@example.test>`,
  subject: 'Same subject', sender: { email: 'guest@example.test', name: 'Guest' }, to: [], cc: [],
  receivedOn: '2026-11-02T10:00:00Z', body: 'Example', processedHtml: '<p>Example</p>',
} as Parameters<typeof activeEmailFromMessage>[0], transportId);

function expectIdentity(entryId: string, storeId: string, internetMessageId: string) {
  const selection = screen.getByRole('region', { name: 'Selected email' });
  expect(selection.getAttribute('data-nava-entry-id')).toBe(entryId);
  expect(selection.getAttribute('data-nava-store-id')).toBe(storeId);
  expect(selection.getAttribute('data-nava-internet-message-id')).toBe(internetMessageId);
}

describe('selected email rendered identity', () => {
  it('updates exact Outlook bridge identities even for equal subjects', () => {
    const { rerender } = render(<SelectedEmailBlock activeEmail={nativeEmail('native-A')} />);
    expectIdentity('native-A', 'native-store', '<native-A@example.test>');
    rerender(<SelectedEmailBlock activeEmail={nativeEmail('native-B')} />);
    expectIdentity('native-B', 'native-store', '<native-B@example.test>');
  });

  it('updates exact web bridge identities in their own namespace', () => {
    const first = webEmail('row-A');
    const second = webEmail('row-B');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const { rerender } = render(<SelectedEmailBlock activeEmail={buildPreviewBridge(first).activeEmail} />);
    expectIdentity('row-A', 'web-mailbox', '<row-A@example.test>');
    rerender(<SelectedEmailBlock activeEmail={buildPreviewBridge(second).activeEmail} />);
    expectIdentity('row-B', 'web-mailbox', '<row-B@example.test>');
  });

  it('leaves missing identity fields absent and removes the selection on deselection', () => {
    const email = nativeEmail('native-A');
    delete email.storeId;
    delete email.internetMessageId;
    const { rerender } = render(<SelectedEmailBlock activeEmail={email} />);
    const selection = screen.getByRole('region', { name: 'Selected email' });
    expect(selection.getAttribute('data-nava-entry-id')).toBe('native-A');
    expect(selection.hasAttribute('data-nava-store-id')).toBe(false);
    expect(selection.hasAttribute('data-nava-internet-message-id')).toBe(false);
    rerender(<SelectedEmailBlock activeEmail={null} />);
    expect(screen.queryByRole('region', { name: 'Selected email' })).toBeNull();
  });
});
