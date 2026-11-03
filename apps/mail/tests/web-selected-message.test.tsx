/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ParsedMessage } from '@/types';
import { MessageList } from '@/components/mail/thread-display';

vi.mock('@/hooks/use-connections', () => ({
  useActiveConnection: () => ({ data: { id: 'transport-1', email: 'staff@example.com' } }),
}));
vi.mock('@/hooks/use-timezone', () => ({ useTimezone: () => 'UTC' }));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/mail/mail-display', () => ({
  default: ({ emailData }: { emailData: ParsedMessage }) => <article>{emailData.subject}</article>,
  ThreadAttachments: () => null,
}));
vi.mock('@/components/mail/reply-composer', () => ({
  default: () => <input aria-label="draft" defaultValue="unsaved text" />,
}));

function email(id: string, direction: 'inbound' | 'outbound', threadId = 'thread-1'): ParsedMessage {
  return {
    id, direction, threadId, title: id, subject: id, tags: [],
    sender: { email: direction === 'inbound' ? 'guest@example.com' : 'staff@example.com' },
    to: [{ email: 'staff@example.com' }], cc: null, bcc: null, tls: true,
    receivedOn: '2026-11-01T12:00:00.000Z', unread: false, body: id,
    processedHtml: id, blobUrl: '', messageId: `<${id}@example.com>`,
  };
}

const messages = [email('A', 'inbound'), email('B', 'inbound'), email('staff-reply', 'outbound')];

function Harness() {
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(null);
  return <MessageList messages={messages} sourceMessageId={sourceMessageId} currentThreadId="thread-1"
    onSelectSourceMessage={(message) => setSourceMessageId(message.id)}
    isFullscreen={false} isMobile={false} mode="reply" activeReplyId="A" />;
}

function messageButton(id: string) {
  const row = document.querySelector(`[data-message-id="${id}"]`);
  if (!row) throw new Error(`missing ${id}`);
  return within(row as HTMLElement).queryByRole('button', { name: /Nava/ });
}

afterEach(cleanup);

describe('thread message selection', () => {
  it('selects A/B/A, excludes staff replies, and leaves the reply draft mounted', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    render(<Harness />);
    expect(messageButton('staff-reply')).toBeNull();
    const draft = screen.getByLabelText('draft') as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'draft being typed' } });
    fireEvent.click(messageButton('A')!);
    expect(messageButton('A')?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(messageButton('B')!);
    expect(messageButton('B')?.getAttribute('aria-pressed')).toBe('true');
    expect(messageButton('A')?.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(messageButton('A')!);
    expect(messageButton('A')?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('draft')).toBe(draft);
    expect(draft.value).toBe('draft being typed');
  });

  it('does not highlight a linked-thread email as the current thread selection', () => {
    const select = vi.fn();
    render(<MessageList messages={[email('linked', 'inbound', 'thread-2')]} currentThreadId="thread-1"
      sourceMessageId="linked" onSelectSourceMessage={select} isFullscreen={false} isMobile={false} />);
    expect(messageButton('linked')?.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(messageButton('linked')!);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'linked', threadId: 'thread-2' }));
  });

  it('focuses an exact message link even when Nava selection controls are closed', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    render(<MessageList messages={messages} currentThreadId="thread-1" sourceMessageId="A"
      isFullscreen={false} isMobile={false} />);
    const row = document.querySelector('[data-message-id="A"]');
    expect(row?.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row);
    expect(scroll).toHaveBeenCalledOnce();
    expect(messageButton('A')).toBeNull();
  });
});
