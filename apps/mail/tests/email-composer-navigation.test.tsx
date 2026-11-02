/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useController } from 'react-hook-form';
import { EmailComposer } from '../components/create/email-composer';
import { flushComposeBeforeLeave, registerComposeFlush, registerComposeUnsavedCheck, runComposeSwitch } from '../lib/mail/compose-flush-registry';

const mocks = vi.hoisted(() => ({
  save: vi.fn(), navigate: vi.fn(), toast: vi.fn(), bodyChanged: null as null | (() => void),
  editorHtml: '<p>Quoted</p>',
  editor: { getHTML: () => mocks.editorHtml, getText: () => 'Quoted', commands: { focus: vi.fn(), setContent: vi.fn(), clearContent: vi.fn() } },
}));
vi.mock('@/hooks/use-compose-editor', () => ({ default: (options: { onLengthChange: () => void }) => { mocks.bodyChanged = options.onLengthChange; return mocks.editor; } }));
vi.mock('@tiptap/react', () => ({ EditorContent: () => <div>Editor</div> }));
vi.mock('@/hooks/use-settings', () => ({ useSettings: () => ({ data: { settings: {} } }) }));
vi.mock('@/hooks/use-threads', () => ({ useThread: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-drafts', () => ({ useDraft: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-optimistic-actions', () => ({ useOptimisticActions: () => ({ optimisticDeleteDraft: vi.fn() }) }));
vi.mock('nuqs', () => ({ useQueryState: (key: string) => [key === 'threadId' ? 'thread-a' : null, vi.fn()] }));
vi.mock('@/providers/query-provider', () => ({ useTRPC: () => ({
  drafts: { create: { mutationOptions: () => ({}) }, list: { queryKey: () => ['drafts'] }, get: { queryKey: () => ['draft'] } },
  mail: { get: { queryKey: () => ['mail'] }, unreadCounts: { queryKey: () => ['unread'] }, listThreads: { infiniteQueryKey: () => ['threads'] } },
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
  RecipientAutosuggest: ({ control, name, onValueChange }: { control: any; name: string; onValueChange: () => void }) => {
    const { field } = useController({ control, name });
    return <><input aria-label={name} value={(field.value ?? []).join(',')} onChange={(event) => {
      field.onChange(event.target.value ? event.target.value.split(',') : []); onValueChange();
    }} /><input type="email" aria-label={`pending-${name}`} /></>;
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

function Harness({ initialSubject = 'Original', initialAttachments = [], initialTo = ['guest@example.com'] }: { initialSubject?: string; initialAttachments?: File[]; initialTo?: string[] }) {
  const [open, setOpen] = useState(true);
  return <>
    {open && <EmailComposer initialMessage="<p>Quoted</p>" initialSubject={initialSubject}
      initialTo={initialTo} initialAttachments={initialAttachments} onSendEmail={async () => false} />}
    <button onClick={() => { void runComposeSwitch(() => { mocks.navigate(); setOpen(false); }); }}>Open another</button>
  </>;
}

beforeEach(() => {
  mocks.editorHtml = '<p>Quoted</p>'; mocks.bodyChanged = null;
  mocks.save.mockReset().mockResolvedValue({ id: 'draft-1' });
  mocks.navigate.mockReset(); mocks.toast.mockReset();
  registerComposeFlush(null); registerComposeUnsavedCheck(null);
});
afterEach(() => { cleanup(); registerComposeFlush(null); registerComposeUnsavedCheck(null); });

describe('real composer draft handoff', () => {
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
    mocks.editorHtml = '';
    act(() => { mocks.bodyChanged?.(); });
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ body: '', to: '', subject: '' }));
  });

  it('keeps an unfinished recipient input open instead of discarding it', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('pending-to'), { target: { value: 'partial@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open another' }));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect((screen.getByLabelText('pending-to') as HTMLInputElement).value).toBe('partial@example.com');
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
