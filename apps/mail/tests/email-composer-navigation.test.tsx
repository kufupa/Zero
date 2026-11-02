/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useController } from 'react-hook-form';
import { EmailComposer } from '../components/create/email-composer';
import ReplyCompose from '../components/mail/reply-composer';
import { flushComposeBeforeLeave, registerComposeFlush, registerComposeUnsavedCheck, runComposeSwitch } from '../lib/mail/compose-flush-registry';

const mocks = vi.hoisted(() => ({
  save: vi.fn(), navigate: vi.fn(), toast: vi.fn(), bodyChanged: null as null | (() => void),
  replyMode: false, mode: 'reply', draft: null as any, setQuery: vi.fn(), refetch: vi.fn(),
  enableScope: vi.fn(), disableScope: vi.fn(), ensure: vi.fn(),
  editorHtml: '<p>Quoted</p>',
  editor: { getHTML: () => mocks.editorHtml, getText: () => mocks.editorHtml.replace(/<[^>]+>/g, ''), commands: { focus: vi.fn(), setContent: vi.fn(), clearContent: vi.fn() } },
}));
vi.mock('@/hooks/use-compose-editor', () => ({ default: (options: { onLengthChange: () => void }) => { mocks.bodyChanged = options.onLengthChange; return mocks.editor; } }));
vi.mock('@tiptap/react', () => ({ EditorContent: () => <div>Editor</div> }));
vi.mock('@/hooks/use-settings', () => ({ useSettings: () => ({ data: { settings: {} } }) }));
vi.mock('@/hooks/use-threads', () => ({ useThread: () => mocks.replyMode ? {
  data: { latest: { id: 'message-1', threadId: 'thread-a', sender: { email: 'guest@example.com' },
    to: [{ email: 'hotel@example.com' }], cc: [{ email: 'copy@example.com' }], subject: 'Request', decodedBody: 'Request' },
    messages: [] }, latestDraft: mocks.draft, aiDraftCandidates: [], refetch: mocks.refetch,
} : { data: undefined } }));
vi.mock('@/hooks/use-drafts', () => ({ useDraft: () => ({ data: mocks.replyMode ? mocks.draft : undefined }),
  isAssistedDraft: (draft: { origin?: string } | null) => draft?.origin === 'ai',
  useEnsureEditableDraftForReply: () => ({ mutateAsync: mocks.ensure }),
}));
vi.mock('@/hooks/use-connections', () => ({ useActiveConnection: () => ({ data: { email: 'hotel@example.com' } }) }));
vi.mock('@/hooks/use-timezone', () => ({ useTimezone: () => 'UTC' }));
vi.mock('@/hooks/use-undo-send', () => ({ useUndoSend: () => ({ handleUndoSend: vi.fn() }) }));
vi.mock('@/lib/auth-client', () => ({ useSession: () => ({ data: { user: { email: 'hotel@example.com' } } }) }));
vi.mock('react-hotkeys-hook', () => ({ useHotkeysContext: () => ({ enableScope: mocks.enableScope, disableScope: mocks.disableScope }) }));
vi.mock('@/hooks/use-optimistic-actions', () => ({ useOptimisticActions: () => ({ optimisticDeleteDraft: vi.fn() }) }));
vi.mock('nuqs', () => ({ useQueryState: (key: string) => [key === 'threadId' ? 'thread-a'
  : mocks.replyMode && key === 'mode' ? mocks.mode : mocks.replyMode && key === 'draftId' ? mocks.draft?.id ?? null : null, mocks.setQuery] }));
vi.mock('@/providers/query-provider', () => ({ useTRPC: () => ({
  drafts: { create: { mutationOptions: () => ({}) }, approve: { mutationOptions: () => ({}) }, list: { queryKey: () => ['drafts'] }, get: { queryKey: () => ['draft'] } },
  mail: { send: { mutationOptions: () => ({}) }, get: { queryKey: () => ['mail'] }, unreadCounts: { queryKey: () => ['unread'] }, listThreads: { infiniteQueryKey: () => ['threads'] } },
}) }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: mocks.save }),
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('@/lib/demo/runtime', () => ({ isFrontendOnlyDemo: () => false }));
vi.mock('@/lib/demo/local-actions', () => ({ demoUpsertDraft: vi.fn() }));
vi.mock('@/lib/schemas', () => ({ serializeFiles: async (files: File[]) => files.map((file) => ({ name: file.name, type: file.type, base64: 'ZmFrZQ==' })) }));
vi.mock('@/lib/image-compression', () => ({ compressImages: async (files: File[]) => files }));
vi.mock('sonner', () => ({ toast: { error: mocks.toast, success: vi.fn() } }));
vi.mock('@/paraglide/messages', () => ({ m: new Proxy({}, { get: () => () => '' }) }));
vi.mock('@/components/ui/recipient-autosuggest', () => ({
  RecipientAutosuggest: ({ control, name, onValueChange, onPendingClear }: { control: any; name: string; onValueChange: () => void; onPendingClear?: () => void }) => {
    const { field } = useController({ control, name });
    return <><input aria-label={name} value={(field.value ?? []).join(',')} onChange={(event) => {
      field.onChange(event.target.value ? event.target.value.split(',') : []); onValueChange();
    }} /><input type="email" aria-label={`pending-${name}`} onChange={(event) => {
      if (!event.currentTarget.value.trim()) onPendingClear?.();
    }} onKeyDown={(event) => {
      if (event.key !== 'Enter' || !event.currentTarget.value.trim()) return;
      field.onChange([...(field.value ?? []), event.currentTarget.value.trim()]);
      onValueChange();
      event.currentTarget.value = '';
      onPendingClear?.();
    }} /></>;
  },
}));
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Dialog: Wrap, DialogContent: Wrap, DialogDescription: Wrap, DialogFooter: Wrap, DialogHeader: Wrap, DialogTitle: Wrap };
});
vi.mock('../components/ui/tooltip', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Tooltip: Wrap, TooltipContent: Wrap, TooltipProvider: Wrap, TooltipTrigger: Wrap };
});
vi.mock('@/components/ui/popover', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Popover: Wrap, PopoverContent: Wrap, PopoverTrigger: Wrap };
});
vi.mock('../components/create/schedule-send-picker', () => ({ ScheduleSendPicker: () => null }));
vi.mock('../components/create/template-button', () => ({ TemplateButton: () => null }));
vi.mock('../components/create/toolbar', () => ({ Toolbar: () => null }));
vi.mock('../components/create/quote-history-expander', () => ({ QuoteHistoryExpander: () => null }));
vi.mock('../components/create/image-compression-settings', () => ({ ImageCompressionSettings: () => null }));

function Harness({ initialSubject = 'Original', initialAttachments = [], initialTo = ['guest@example.com'], initialCc = [], initialBcc = [], syncHeaders = false, seed = 'reply' }: {
  initialSubject?: string; initialAttachments?: File[]; initialTo?: string[]; initialCc?: string[];
  initialBcc?: string[]; syncHeaders?: boolean; seed?: string;
}) {
  const [open, setOpen] = useState(true);
  return <>
    {open && <EmailComposer initialMessage="<p>Quoted</p>" initialSubject={initialSubject}
      initialTo={initialTo} initialCc={initialCc} initialBcc={initialBcc} initialAttachments={initialAttachments}
      syncReplyHeadersFromProps={syncHeaders} replyHeaderSeed={seed} onSendEmail={async () => false} />}
    <button onClick={() => { void runComposeSwitch(() => { mocks.navigate(); setOpen(false); }); }}>Open another</button>
  </>;
}

beforeEach(() => {
  mocks.editorHtml = '<p>Quoted</p>'; mocks.bodyChanged = null;
  mocks.replyMode = false; mocks.mode = 'reply'; mocks.draft = null; mocks.setQuery.mockReset();
  mocks.refetch.mockReset().mockResolvedValue(undefined);
  mocks.save.mockReset().mockResolvedValue({ id: 'draft-1' });
  mocks.navigate.mockReset(); mocks.toast.mockReset();
  registerComposeFlush(null); registerComposeUnsavedCheck(null);
});
afterEach(() => { cleanup(); registerComposeFlush(null); registerComposeUnsavedCheck(null); });

describe('real composer draft handoff', () => {
  it('keeps edited headers through stale refreshes and re-derives recipients on mode change', async () => {
    const view = render(<Harness syncHeaders initialTo={['first@example.com']} initialSubject="Original" />);
    const to = screen.getByLabelText('to') as HTMLInputElement;
    const subject = screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement;
    fireEvent.change(to, { target: { value: '' } });
    fireEvent.change(subject, { target: { value: '' } });
    view.rerender(<Harness syncHeaders initialTo={['stale@example.com']} initialSubject="Stale" />);
    expect(to.value).toBe(''); expect(subject.value).toBe('');
    await act(async () => { await flushComposeBeforeLeave(); });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ to: '', subject: '' }));
    view.rerender(<Harness syncHeaders initialTo={['older@example.com']} initialSubject="Older" />);
    expect(to.value).toBe(''); expect(subject.value).toBe('');
    view.rerender(<Harness syncHeaders seed="replyAll" initialTo={['reply-all@example.com']} initialSubject="Re: Request" />);
    expect(to.value).toBe('reply-all@example.com'); expect(subject.value).toBe('');
  });

  it.each(['to', 'cc', 'bcc'])('keeps uncommitted %s input during a draft refresh', async (field) => {
    const view = render(<Harness syncHeaders />);
    if (field !== 'to') fireEvent.click(screen.getByRole('button', { name: field === 'cc' ? 'Cc' : 'Bcc' }));
    const pending = screen.getByLabelText(`pending-${field}`) as HTMLInputElement;
    fireEvent.change(pending, { target: { value: 'unfinished@example.com' } });
    const incoming = { [`initial${field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'}`]: ['other@example.com'] };
    view.rerender(<Harness syncHeaders initialSubject="Updated" {...incoming} />);
    expect(screen.getByLabelText(`pending-${field}`)).toBe(pending);
    expect(pending.value).toBe('unfinished@example.com');
  });

  it.each(['to', 'cc', 'bcc'])('applies a delayed %s refresh after pending input is cleared', (field) => {
    const initial = { [`initial${field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'}`]: ['old@example.com'] };
    const incoming = { [`initial${field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'}`]: ['saved@example.com'] };
    const view = render(<Harness syncHeaders {...initial} />);
    const pending = screen.getByLabelText(`pending-${field}`) as HTMLInputElement;
    fireEvent.change(pending, { target: { value: 'unfinished@example.com' } });
    view.rerender(<Harness syncHeaders {...incoming} />);
    expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('old@example.com');
    fireEvent.change(pending, { target: { value: '' } });
    expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('saved@example.com');
  });

  it('keeps a locally committed recipient instead of a delayed refresh', () => {
    const view = render(<Harness syncHeaders initialTo={['old@example.com']} />);
    const pending = screen.getByLabelText('pending-to') as HTMLInputElement;
    fireEvent.change(pending, { target: { value: 'new@example.com' } });
    view.rerender(<Harness syncHeaders initialTo={['saved@example.com']} />);
    fireEvent.keyDown(pending, { key: 'Enter' });
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('old@example.com,new@example.com');
  });

  it.each(['to', 'cc', 'bcc'])('replaces committed %s on forward while keeping pending input', (field) => {
    const view = render(<Harness syncHeaders seed="reply" initialTo={['old-to@example.com']}
      initialCc={['old-cc@example.com']} initialBcc={['old-bcc@example.com']} />);
    const pending = screen.getByLabelText(`pending-${field}`) as HTMLInputElement;
    fireEvent.change(pending, { target: { value: 'new@example.com' } });
    view.rerender(<Harness syncHeaders seed="forward" initialTo={[]} initialCc={[]} initialBcc={[]} />);
    expect(screen.getByLabelText(`pending-${field}`)).toBe(pending);
    expect(pending.value).toBe('new@example.com');
    expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(pending, { key: 'Enter' });
    expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('new@example.com');
    if (field !== 'to') expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('');
  });

  it('does not save an untouched quoted draft', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(['subject', 'to', 'cc', 'bcc'])('saves changed or cleared %s with an unchanged body before navigating', async (field) => {
    render(<Harness />);
    if (field === 'subject') fireEvent.change(screen.getByPlaceholderText('Re: Design review feedback'), { target: { value: '' } });
    else {
      if (field === 'cc') fireEvent.click(screen.getByRole('button', { name: 'Cc' }));
      if (field === 'bcc') fireEvent.click(screen.getByRole('button', { name: 'Bcc' }));
      fireEvent.change(screen.getByLabelText(field), { target: { value: field === 'to' ? '' : `${field}@example.com` } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      [field]: field === 'subject' || field === 'to' ? '' : `${field}@example.com`, body: '<p>Quoted</p>',
    }));
  });

  it('saves a body reverted to its initial quote after an earlier save', async () => {
    render(<Harness />);
    mocks.editorHtml = '<p>Edited</p>';
    act(() => { mocks.bodyChanged?.(); });
    await act(async () => { await flushComposeBeforeLeave(); });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ body: '<p>Edited</p>' }));
    mocks.editorHtml = '<p>Quoted</p>';
    act(() => { mocks.bodyChanged?.(); });
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ body: '<p>Quoted</p>' }));
  });

  it('saves clearing the existing body even without recipients or subject', async () => {
    render(<Harness initialSubject="" initialTo={[]} />);
    mocks.editorHtml = '<p>Edited</p>';
    act(() => { mocks.bodyChanged?.(); });
    await act(async () => { await flushComposeBeforeLeave(); });
    mocks.editorHtml = '';
    act(() => { mocks.bodyChanged?.(); });
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ body: '', to: '', subject: '' }));
  });

  it('keeps an unfinished recipient input open instead of discarding it', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('pending-to'), { target: { value: 'partial@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect((screen.getByLabelText('pending-to') as HTMLInputElement).value).toBe('partial@example.com');
  });

  it('still flushes committed edits through the legacy leave path with a pending recipient', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText('Re: Design review feedback'), { target: { value: 'Changed' } });
    fireEvent.change(screen.getByLabelText('pending-to'), { target: { value: 'partial@example.com' } });
    await act(async () => { await flushComposeBeforeLeave(); });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Changed' }));
    expect((screen.getByLabelText('pending-to') as HTMLInputElement).value).toBe('partial@example.com');
  });

  it.each(['cc', 'bcc'])('keeps unfinished %s text when its field is toggled', async (field) => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: field === 'cc' ? 'Cc' : 'Bcc' });
    fireEvent.click(button);
    const input = screen.getByLabelText(`pending-${field}`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'partial@example.com' } });
    fireEvent.click(button);
    expect(screen.getByLabelText(`pending-${field}`)).toBe(input);
    expect(input.value).toBe('partial@example.com');
    expect(mocks.toast).toHaveBeenCalledWith('Finish adding the email address before hiding this field.');
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(button);
    expect(screen.queryByLabelText(`pending-${field}`)).toBeNull();
  });

  it('saves an attachment added immediately before navigation', async () => {
    const view = render(<Harness />);
    const file = new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' });
    fireEvent.change(view.container.querySelector('#attachment-input')!, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ attachments: [expect.objectContaining({ name: 'receipt.pdf' })] }));
  });

  it('saves an attachment removal even when no replacement exists', async () => {
    const file = new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' });
    render(<Harness initialAttachments={[file]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove receipt.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ attachments: [] }));
  });

  it('keeps the composer open if a header save fails', async () => {
    mocks.save.mockRejectedValue(new Error('save failed'));
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText('Re: Design review feedback'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Re: Design review feedback')).toBeTruthy();
  });

  it('keeps the composer inert while a selection commit is pending', async () => {
    let finish!: () => void;
    render(<Harness />);
    const subject = screen.getByPlaceholderText('Re: Design review feedback');
    const pending = runComposeSwitch(() => new Promise<void>((resolve) => { finish = resolve; }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(subject.closest('[inert]')).not.toBeNull();
    await act(async () => { finish(); await pending; });
    expect(subject.closest('[inert]')).toBeNull();
  });

  it('locks a replacement composer before its parent layout effect', async () => {
    let finish!: () => void;
    const pending = runComposeSwitch(() => new Promise<void>((resolve) => { finish = resolve; }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const observed = vi.fn();
    function LayoutProbe() {
      useLayoutEffect(() => {
        observed(Boolean(screen.getByPlaceholderText('Re: Design review feedback').closest('[inert]')));
      }, []);
      return <Harness />;
    }
    render(<LayoutProbe />);
    expect(observed).toHaveBeenCalledWith(true);
    await act(async () => { finish(); await pending; });
    expect(screen.getByPlaceholderText('Re: Design review feedback').closest('[inert]')).toBeNull();
  });

  it('saves a newer header revision made during an in-flight save', async () => {
    let finish!: (value: { id: string }) => void;
    mocks.save.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ id: 'draft-1' });
    render(<Harness />);
    const subject = screen.getByPlaceholderText('Re: Design review feedback');
    fireEvent.change(subject, { target: { value: 'First edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    fireEvent.change(subject, { target: { value: 'Second edit' } });
    await act(async () => { finish({ id: 'draft-1' }); });
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'Second edit' }));
  });
});


describe('mounted reply header persistence', () => {
  beforeEach(() => { mocks.replyMode = true; });

  it('preserves cleared headers on refresh and after reopening', async () => {
    mocks.draft = { id: 'draft-1', origin: 'manual', headersSaved: true, to: ['custom@example.com'], cc: [], bcc: [], subject: 'Custom', content: '<p>Quoted</p>' };
    const view = render(<ReplyCompose />);
    const to = screen.getByLabelText('to') as HTMLInputElement;
    const subject = screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement;
    fireEvent.change(to, { target: { value: '' } });
    fireEvent.change(subject, { target: { value: '' } });
    mocks.draft = { ...mocks.draft, to: ['stale@example.com'], subject: 'Stale' };
    view.rerender(<ReplyCompose />);
    expect(to.value).toBe(''); expect(subject.value).toBe('');
    await act(async () => { await flushComposeBeforeLeave(); });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ to: '', subject: '' }));
    view.unmount();
    mocks.draft = { ...mocks.draft, to: [], subject: null };
    render(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('');
    expect((screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement).value).toBe('');
  });

  it.each([null, ''])('derives recipients and subject for a pristine generated draft with subject %s', (subject) => {
    mocks.draft = { id: 'draft-1', origin: 'ai', headersSaved: false, to: [], cc: [], bcc: [], subject, content: '<p>Quoted</p>' };
    render(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('guest@example.com');
    expect((screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement).value).toBe('Re: Request');
  });

  it('preserves a partially cleared subject while deriving untouched AI recipients', () => {
    mocks.draft = { id: 'draft-1', origin: 'ai', headersSaved: false,
      savedHeaderFields: { to: false, cc: false, bcc: false, subject: true },
      to: [], cc: [], bcc: [], subject: '', content: '<p>Quoted</p>' };
    render(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('guest@example.com');
    expect((screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement).value).toBe('');
  });

  it('preserves a partially cleared To while deriving an untouched subject', () => {
    mocks.draft = { id: 'draft-1', origin: 'ai', headersSaved: false,
      savedHeaderFields: { to: true, cc: false, bcc: false, subject: false },
      to: [], cc: [], bcc: [], subject: null, content: '<p>Quoted</p>' };
    render(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('');
    expect((screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement).value).toBe('Re: Request');
  });

  it('preserves a partially cleared Cc while deriving untouched reply-all To', () => {
    mocks.mode = 'replyAll';
    mocks.draft = { id: 'draft-1', origin: 'ai', headersSaved: false,
      savedHeaderFields: { to: false, cc: true, bcc: false, subject: false },
      to: [], cc: [], bcc: [], subject: null, content: '<p>Quoted</p>' };
    render(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('guest@example.com');
    expect(screen.queryByLabelText('cc')).toBeNull();
  });

  it('derives untouched reply-all Cc when a partial update supplies To', () => {
    mocks.mode = 'replyAll';
    mocks.draft = { id: 'draft-1', origin: 'ai', headersSaved: false,
      savedHeaderFields: { to: true, cc: false, bcc: false, subject: false },
      to: ['custom@example.com'], cc: [], bcc: [], subject: null, content: '<p>Quoted</p>' };
    render(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('custom@example.com');
    expect((screen.getByLabelText('cc') as HTMLInputElement).value).toBe('copy@example.com');
  });

  it('keeps an intentionally empty To even when saved Cc is populated', () => {
    mocks.draft = { id: 'draft-1', origin: 'ai', headersSaved: true, to: [], cc: ['copy@example.com'], bcc: [], subject: 'Custom', content: '<p>Quoted</p>' };
    render(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('cc') as HTMLInputElement).value).toBe('copy@example.com');
  });

  it('derives recipients for reply-all and forward without restoring an edited subject', () => {
    mocks.draft = { id: 'draft-1', origin: 'manual', headersSaved: true, to: ['custom@example.com'], cc: [], bcc: [], subject: 'Custom', content: '<p>Quoted</p>' };
    const view = render(<ReplyCompose />);
    fireEvent.change(screen.getByPlaceholderText('Re: Design review feedback'), { target: { value: '' } });
    mocks.mode = 'replyAll'; view.rerender(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('guest@example.com');
    expect((screen.getByLabelText('cc') as HTMLInputElement).value).toBe('copy@example.com');
    expect((screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement).value).toBe('');
    mocks.mode = 'forward'; view.rerender(<ReplyCompose />);
    expect((screen.getByLabelText('to') as HTMLInputElement).value).toBe('');
    expect((screen.getByPlaceholderText('Re: Design review feedback') as HTMLInputElement).value).toBe('');
  });
});
