// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useController, type Control } from 'react-hook-form';
import { useRef, useSyncExternalStore } from 'react';
import { webcrypto } from 'node:crypto';

// Render the real composer, form, revision reducer, serializer and attachment hashing.
// Only the editor API, remote hooks and unrelated child controls are replaced.
const remote = vi.hoisted(() => ({
  draft: null as any,
  thread: null as any,
  fetchArtifact: vi.fn(),
  createDraft: vi.fn(),
  invalidateQueries: vi.fn(),
  setQueryState: vi.fn(),
}));
vi.mock('../hooks/use-drafts', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  useDraft: () => ({ data: remote.draft }),
  useEnsureEditableDraftForReply: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/use-threads', () => ({
  useThread: () => ({
    data: remote.thread,
    latestDraft: remote.thread ? remote.draft : null,
    aiDraftCandidates: [],
    refetch: async () => {},
  }),
}));
vi.mock('../hooks/use-connections', () => ({
  useActiveConnection: () => ({ data: { id: 'transport', email: 'staff@example.test' } }),
}));
vi.mock('../hooks/use-timezone', () => ({ useTimezone: () => 'UTC' }));
vi.mock('../hooks/use-undo-send', () => ({ useUndoSend: () => ({ handleUndoSend: vi.fn() }) }));
vi.mock('../lib/auth-client', () => ({ useSession: () => ({ data: null }) }));
vi.mock('react-hotkeys-hook', () => ({
  useHotkeysContext: () => ({ enableScope: vi.fn(), disableScope: vi.fn() }),
}));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../hooks/use-settings', () => ({ useSettings: () => ({ data: null }) }));
vi.mock('../hooks/use-optimistic-actions', () => ({
  useOptimisticActions: () => ({ optimisticDeleteDraft: vi.fn() }),
}));
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [
    key === 'draftId'
      ? 'draft-1'
      : remote.thread && key === 'mode'
        ? 'reply'
        : remote.thread && key === 'threadId'
          ? 'thread-1'
          : null,
    remote.setQueryState,
  ],
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: remote.createDraft }),
  useQueryClient: () => queryClient,
}));
const queryClient = {
  invalidateQueries: remote.invalidateQueries,
  fetchQuery: remote.fetchArtifact,
  removeQueries: vi.fn(),
};
const procedure = { queryKey: () => [], infiniteQueryKey: () => [], mutationOptions: () => ({}) };
const rpc = {
  drafts: {
    create: procedure,
    list: procedure,
    get: procedure,
    approve: procedure,
    getArtifact: { ...procedure, queryOptions: (input: any) => input },
  },
  mail: { unreadCounts: procedure, get: procedure, listThreads: procedure, send: procedure },
};
vi.mock('../providers/query-provider', () => ({ useTRPC: () => rpc }));
vi.mock('../lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('../lib/demo/local-actions', () => ({ demoUpsertDraft: vi.fn() }));
vi.mock('../lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter((value) => typeof value === 'string').join(' '),
  formatFileSize: (size: number) => `${size} bytes`,
  constructReplyBody: vi.fn(),
  constructForwardBody: vi.fn(),
}));
vi.mock('../lib/image-compression', () => ({ compressImages: async (files: File[]) => files }));
vi.mock('@tiptap/extension-emoji', () => ({ gitHubEmojis: [] }));
vi.mock('../paraglide/messages', () => ({
  m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../components/icons/icons', () => ({ CurvedArrow: () => null, X: () => null }));
vi.mock('../components/ui/recipient-autosuggest', () => ({
  RecipientAutosuggest: ({ control, name }: { control: Control<any>; name: string }) => {
    const { field } = useController({ control, name });
    return <output aria-label={`${name} recipients`}>{field.value.join(', ')}</output>;
  },
}));
vi.mock('../components/create/schedule-send-picker', () => ({ ScheduleSendPicker: () => null }));
vi.mock('../components/create/quote-history-expander', () => ({
  QuoteHistoryExpander: () => null,
}));
vi.mock('../components/create/toolbar', () => ({ Toolbar: () => null }));
vi.mock('../components/create/template-button', () => ({ TemplateButton: () => null }));
vi.mock('../components/create/image-compression-settings', () => ({
  ImageCompressionSettings: () => null,
}));
vi.mock('../components/ui/dialog', () => ({
  Dialog: () => null,
  DialogContent: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
}));
vi.mock('../components/ui/popover', () => ({
  Popover: ({ children }: any) => children,
  PopoverContent: ({ children }: any) => children,
  PopoverTrigger: ({ children }: any) => children,
}));
vi.mock('../components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => children,
  TooltipProvider: ({ children }: any) => children,
  TooltipTrigger: ({ children }: any) => children,
  TooltipContent: () => null,
}));

type EditorDouble = {
  getHTML: () => string;
  getText: () => string;
  subscribe: (listener: () => void) => () => void;
  edit: (html: string) => void;
  commands: { focus: () => void; setContent: (html: string, emitUpdate?: boolean) => void };
};
vi.mock('../hooks/use-compose-editor', () => ({
  default: (options: { initialValue: string; onLengthChange: () => void }) => {
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const editorRef = useRef<EditorDouble | null>(null);
    if (!editorRef.current) {
      let html = options.initialValue;
      const listeners = new Set<() => void>();
      const setContent = (content: string, emitUpdate = true) => {
        html = content;
        if (emitUpdate) optionsRef.current.onLengthChange();
        listeners.forEach((listener) => listener());
      };
      editorRef.current = {
        getHTML: () => html,
        getText: () => html.replace(/<[^>]*>/g, ''),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        edit: setContent,
        commands: { focus: () => {}, setContent },
      };
    }
    return editorRef.current;
  },
}));
vi.mock('@tiptap/react', () => ({
  EditorContent: ({ editor }: { editor: EditorDouble }) => {
    const html = useSyncExternalStore(editor.subscribe, editor.getHTML);
    return (
      <textarea
        aria-label="Reply body"
        value={html}
        onChange={(e) => editor.edit(e.target.value)}
      />
    );
  },
}));

import { EmailComposer } from '../components/create/email-composer';
import ReplyCompose from '../components/mail/reply-composer';

beforeEach(() => {
  vi.useFakeTimers();
  remote.draft = { content: '<p>Candidate reply</p>', subject: 'Candidate quote', updatedAt: '1' };
  remote.thread = null;
  remote.fetchArtifact.mockReset();
  remote.createDraft.mockReset().mockResolvedValue({ id: 'draft-1' });
  remote.invalidateQueries.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});
afterEach(() => {
  // The production component warns on unmounting a populated editor, even after save.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pdf(name: string, bytes: string) {
  const file = new File([bytes], name, { type: 'application/pdf', lastModified: 1 });
  // HappyDOM 12's File lacks arrayBuffer; preserve real File/FileReader behavior.
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(bytes).buffer,
  });
  return file;
}
const initialPdf = () => pdf('quote-v1.pdf', '%PDF-verified-v1');
const revisedPdf = () => pdf('quote-v2.pdf', '%PDF-verified-v2');
const props = () => ({
  initialTo: ['guest@example.test'],
  initialSubject: 'Candidate quote',
  initialMessage: '<p>Candidate reply</p>',
  syncReplyHeadersFromProps: true,
  onSendEmail: vi.fn().mockResolvedValue(false),
});
const body = () => screen.getByRole('textbox', { name: 'Reply body' }) as HTMLTextAreaElement;
const subject = () => screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement;
const attachmentNames = () =>
  screen
    .queryAllByRole('button', { name: /^Remove / })
    .map((button) => button.getAttribute('aria-label'));

it('waits for saved reply artifact bytes before staff typing can autosave, then preserves explicit removal', async () => {
  const bytes = '%PDF-saved-reply';
  const sourceHash = Array.from(
    new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  remote.draft = {
    id: 'draft-1',
    content: '<p>Saved reply</p>',
    subject: 'Saved subject',
    updatedAt: '1',
    origin: 'manual',
    attachments: [
      {
        artifactRef: 'saved-pdf',
        filename: 'saved-reply.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        sourceHash,
        state: 'available',
      },
    ],
  };
  const message = {
    id: 'message-1',
    subject: 'Guest request',
    sender: { email: 'guest@example.test', name: 'Guest' },
    to: [],
    cc: [],
    decodedBody: 'Guest request',
    threadId: 'thread-1',
  };
  remote.thread = { messages: [message], latest: message };
  let resolveArtifact!: (value: any) => void;
  remote.fetchArtifact.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveArtifact = resolve;
      }),
  );
  const rendered = render(<ReplyCompose />);
  expect(screen.queryByRole('textbox', { name: 'Reply body' })).toBeNull();
  expect(
    screen
      .getAllByRole('status')
      .map((status) => status.textContent)
      .join(' '),
  ).toContain('Loading');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(remote.createDraft).not.toHaveBeenCalled();
  await act(async () => {
    resolveArtifact({ base64: btoa(bytes) });
  });
  await vi.waitFor(() => expect(attachmentNames()).toEqual(['Remove saved-reply.pdf']));
  fireEvent.change(body(), { target: { value: '<p>Staff edited saved reply</p>' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(remote.createDraft).toHaveBeenLastCalledWith(
    expect.objectContaining({
      body: '<p>Staff edited saved reply</p>',
      attachments: [expect.objectContaining({ name: 'saved-reply.pdf', base64: btoa(bytes) })],
    }),
  );
  remote.draft = {
    ...remote.draft,
    content: '<p>Staff edited saved reply</p>',
    revisionKey: 'later-refetch',
    attachments: [{ ...remote.draft.attachments[0], sourceHash: 'a'.repeat(64) }],
  };
  rendered.rerender(<ReplyCompose />);
  expect(body().value).toBe('<p>Staff edited saved reply</p>');
  expect(attachmentNames()).toEqual(['Remove saved-reply.pdf']);
  fireEvent.click(screen.getByRole('button', { name: 'Remove saved-reply.pdf' }));
  await settle();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(remote.createDraft).toHaveBeenLastCalledWith(
    expect.objectContaining({ body: '<p>Staff edited saved reply</p>', attachments: [] }),
  );
  rendered.rerender(<ReplyCompose />);
  expect(body().value).toBe('<p>Staff edited saved reply</p>');
  expect(attachmentNames()).toEqual([]);
});

it('waits for the selected saved draft metadata before exposing an empty editable reply', () => {
  const message = {
    id: 'message-1',
    subject: 'Guest request',
    sender: { email: 'guest@example.test', name: 'Guest' },
    to: [],
    cc: [],
    decodedBody: 'Guest request',
    threadId: 'thread-1',
  };
  remote.thread = { messages: [message], latest: message };
  remote.draft = null;
  const rendered = render(<ReplyCompose />);
  expect(screen.queryByRole('textbox', { name: 'Reply body' })).toBeNull();
  remote.draft = {
    id: 'draft-1',
    content: '<p>Saved without files</p>',
    subject: 'Saved subject',
    attachments: [],
  };
  rendered.rerender(<ReplyCompose />);
  expect(body().value).toBe('<p>Saved without files</p>');
  expect(attachmentNames()).toEqual([]);
});

it('keeps a saved reply read-only when fetched attachment bytes do not match the owned hash', async () => {
  const message = {
    id: 'message-1',
    subject: 'Guest request',
    sender: { email: 'guest@example.test', name: 'Guest' },
    to: [],
    cc: [],
    decodedBody: 'Guest request',
    threadId: 'thread-1',
  };
  remote.thread = { messages: [message], latest: message };
  remote.draft = {
    id: 'draft-1',
    content: '<p>Saved reply</p>',
    subject: 'Saved subject',
    attachments: [
      {
        artifactRef: 'saved-pdf',
        filename: 'saved-reply.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 6,
        sourceHash: 'a'.repeat(64),
        state: 'available',
      },
    ],
  };
  remote.fetchArtifact.mockResolvedValue({ base64: btoa('%PDF-X') });
  render(<ReplyCompose />);
  await vi.waitFor(() =>
    expect(
      screen
        .getAllByRole('status')
        .map((status) => status.textContent)
        .join(' '),
    ).toContain('Attachment unavailable'),
  );
  expect(screen.queryByRole('textbox', { name: 'Reply body' })).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(remote.createDraft).not.toHaveBeenCalled();
});
async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  });
}
async function staffEdits(container: HTMLElement) {
  fireEvent.change(body(), { target: { value: '<p>Staff reviewed reply</p>' } });
  fireEvent.change(subject(), { target: { value: 'Staff reviewed subject' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove quote-v1.pdf' }));
  await settle();
  fireEvent.change(container.querySelector('#attachment-input')!, {
    target: { files: [pdf('staff-note.pdf', '%PDF-staff-note')] },
  });
  await settle();
}
function expectStaffEdits() {
  expect(body().value).toBe('<p>Staff reviewed reply</p>');
  expect(subject().value).toBe('Staff reviewed subject');
  expect(attachmentNames()).toEqual(['Remove staff-note.pdf']);
}

it('hydrates the initially verified PDF and server draft without causing an autosave', async () => {
  const input = props();
  remote.draft = {
    content: '<p>Persisted candidate reply</p>',
    subject: 'Persisted candidate quote',
    updatedAt: '1',
  };
  const rendered = render(<EmailComposer {...input} />);
  expect(attachmentNames()).toEqual([]);
  rendered.rerender(
    <EmailComposer
      {...input}
      initialSubject={remote.draft.subject}
      hydratedAttachmentSnapshot={{ key: 'draft-1:verified-v1', files: [initialPdf()] }}
    />,
  );
  expect(attachmentNames()).toEqual(['Remove quote-v1.pdf']);
  expect(body().value).toBe('<p>Persisted candidate reply</p>');
  expect(subject().value).toBe('Persisted candidate quote');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(remote.createDraft).not.toHaveBeenCalled();
  expect(input.onSendEmail).not.toHaveBeenCalled();
});

it('preserves staff body, subject and attachment replacement on server refetch and artifact revision', async () => {
  const input = props();
  const rendered = render(
    <EmailComposer
      {...input}
      hydratedAttachmentSnapshot={{ key: 'draft-1:verified-v1', files: [initialPdf()] }}
    />,
  );
  await staffEdits(rendered.container);
  remote.draft = {
    content: '<p>New server reply</p>',
    subject: 'New server quote',
    updatedAt: '2',
  };
  rendered.rerender(
    <EmailComposer
      {...input}
      initialSubject={remote.draft.subject}
      hydratedAttachmentSnapshot={{ key: 'draft-1:verified-v2', files: [revisedPdf()] }}
    />,
  );
  expectStaffEdits();
  expect(screen.getByRole('button', { name: 'Attach reviewed draft files' })).toBeTruthy();
  expect(remote.createDraft).not.toHaveBeenCalled();
  expect(input.onSendEmail).not.toHaveBeenCalled();
});

it.each(['body', 'subject', 'attachment removal'] as const)(
  'a staff %s edit independently prevents later server and artifact replacement',
  async (field) => {
    const input = props();
    const rendered = render(
      <EmailComposer
        {...input}
        hydratedAttachmentSnapshot={{ key: 'draft-1:verified-v1', files: [initialPdf()] }}
      />,
    );
    if (field === 'body') {
      fireEvent.change(body(), { target: { value: '<p>Body edit only</p>' } });
    } else if (field === 'subject') {
      fireEvent.change(subject(), { target: { value: 'Subject edit only' } });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Remove quote-v1.pdf' }));
      await settle();
    }
    remote.draft = {
      content: '<p>Server replacement</p>',
      subject: 'Server replacement',
      updatedAt: '2',
    };
    rendered.rerender(
      <EmailComposer
        {...input}
        initialSubject={remote.draft.subject}
        hydratedAttachmentSnapshot={{ key: 'draft-1:verified-v2', files: [revisedPdf()] }}
      />,
    );
    expect(body().value).toBe(
      field === 'body' ? '<p>Body edit only</p>' : '<p>Candidate reply</p>',
    );
    expect(subject().value).toBe(field === 'subject' ? 'Subject edit only' : 'Candidate quote');
    expect(attachmentNames()).toEqual(
      field === 'attachment removal' ? [] : ['Remove quote-v1.pdf'],
    );
    expect(input.onSendEmail).not.toHaveBeenCalled();
  },
);

it('continues syncing reply-all recipients after staff edits without replacing the subject or body', () => {
  const input = props();
  const rendered = render(<EmailComposer {...input} />);
  fireEvent.change(subject(), { target: { value: 'Staff reviewed subject' } });
  fireEvent.change(body(), { target: { value: '<p>Staff reviewed reply</p>' } });
  rendered.rerender(
    <EmailComposer
      {...input}
      initialTo={['guest@example.test', 'organizer@example.test']}
      initialCc={['manager@example.test']}
      initialBcc={['archive@example.test']}
      initialSubject="Refetched server subject"
    />,
  );
  expect(screen.getByLabelText('to recipients').textContent).toBe(
    'guest@example.test, organizer@example.test',
  );
  expect(screen.getByLabelText('cc recipients').textContent).toBe('manager@example.test');
  expect(screen.getByLabelText('bcc recipients').textContent).toBe('archive@example.test');
  expect(body().value).toBe('<p>Staff reviewed reply</p>');
  expect(subject().value).toBe('Staff reviewed subject');
});

it('retains staff edit ownership after successful autosave and later server/artifact refresh', async () => {
  const input = props();
  const rendered = render(
    <EmailComposer
      {...input}
      hydratedAttachmentSnapshot={{ key: 'draft-1:verified-v1', files: [initialPdf()] }}
    />,
  );
  await staffEdits(rendered.container);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(remote.createDraft).toHaveBeenCalledTimes(1);
  expect(remote.createDraft).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'draft-1',
      body: '<p>Staff reviewed reply</p>',
      subject: 'Staff reviewed subject',
      attachments: [
        expect.objectContaining({ name: 'staff-note.pdf', base64: btoa('%PDF-staff-note') }),
      ],
    }),
  );
  expect(remote.invalidateQueries).toHaveBeenCalled();
  remote.draft = {
    content: '<p>Stale server refetch</p>',
    subject: 'Stale subject',
    updatedAt: '3',
  };
  rendered.rerender(
    <EmailComposer
      {...input}
      initialSubject={remote.draft.subject}
      hydratedAttachmentSnapshot={{ key: 'draft-1:verified-v3', files: [revisedPdf()] }}
    />,
  );
  expectStaffEdits();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3100);
  });
  expect(remote.createDraft).toHaveBeenCalledTimes(1);
  expect(input.onSendEmail).not.toHaveBeenCalled();
});

it('adds revised verified files only on explicit attach while retaining staff edits and deduplicating bytes', async () => {
  // SHA-256 completes on Node's real crypto queue, independently of fake timers.
  vi.useRealTimers();
  const input = props();
  const rendered = render(
    <EmailComposer
      {...input}
      hydratedAttachmentSnapshot={{ key: 'draft-1:verified-v1', files: [initialPdf()] }}
    />,
  );
  await staffEdits(rendered.container);
  const snapshot = {
    key: 'draft-1:verified-v2',
    files: [revisedPdf(), pdf('staff-note-renamed.pdf', '%PDF-staff-note')],
  };
  rendered.rerender(<EmailComposer {...input} hydratedAttachmentSnapshot={snapshot} />);
  expectStaffEdits();
  fireEvent.click(screen.getByRole('button', { name: 'Attach reviewed draft files' }));
  await waitFor(() =>
    expect(attachmentNames()).toEqual(['Remove staff-note.pdf', 'Remove quote-v2.pdf']),
  );
  expect(body().value).toBe('<p>Staff reviewed reply</p>');
  expect(subject().value).toBe('Staff reviewed subject');
  expect(screen.queryByRole('button', { name: 'Attach reviewed draft files' })).toBeNull();
  await waitFor(
    () =>
      expect(remote.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            expect.objectContaining({ name: 'staff-note.pdf', base64: btoa('%PDF-staff-note') }),
            expect.objectContaining({ name: 'quote-v2.pdf', base64: btoa('%PDF-verified-v2') }),
          ],
        }),
      ),
    { timeout: 4000 },
  );
  expect(input.onSendEmail).not.toHaveBeenCalled();
});
