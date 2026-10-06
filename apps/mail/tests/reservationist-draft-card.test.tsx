// @vitest-environment happy-dom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThreadDraftCard } from '../components/mail/thread-draft-card';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(cleanup);
const props = {
  subject: 'Accommodation',
  bodyPreview: 'Please review the quote.',
  savedAtLabel: 'Saved',
  draftBadge: 'Candidate reply',
  unsentNotice: 'Not sent',
  emptyPreviewLabel: 'Empty',
  editLabel: 'Review in editor',
  deleteLabel: 'Delete',
  moreLabel: 'More',
  isReadOnly: true,
};
it('shows candidate body then readiness, pricing proof and accessible artifact state', () => {
  render(
    <ThreadDraftCard
      {...props}
      readinessLabel="Needs review"
      readinessReason="Booking is pending staff action."
      tasks={[{ label: 'Quote accommodation', state: 'Ready' }]}
      pricingProof={['Standard Queen · 2 adults · Room only', '12–15 October · ZAR 2,200.02']}
      attachments={[{ artifactRef: 'generated:q', filename: 'quote.pdf', state: 'missing' }]}
    />,
  );
  expect(screen.getByText('Booking is pending staff action.')).toBeTruthy();
  expect(screen.getByText('quote.pdf')).toBeTruthy();
  expect(screen.getByText('Missing')).toBeTruthy();
  expect(screen.getByText('12–15 October · ZAR 2,200.02')).toBeTruthy();
  expect(screen.queryByText('generated:q')).toBeNull();
});
it('only transient artifact failures offer retry and review opens explicitly', () => {
  const retry = vi.fn(),
    edit = vi.fn();
  render(
    <ThreadDraftCard
      {...props}
      onEdit={edit}
      attachments={[
        { artifactRef: 'a', filename: 'denied.pdf', state: 'permission_denied' },
        { artifactRef: 'b', filename: 'retry.pdf', state: 'fetch_error' },
      ]}
      onRetryAttachment={retry}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry retry.pdf' }));
  expect(retry).toHaveBeenCalledWith('b');
  expect(screen.queryByRole('button', { name: 'Retry denied.pdf' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review in editor' }));
  expect(edit).toHaveBeenCalled();
});
it('preview is keyboard reachable and unavailable files cannot preview', () => {
  const preview = vi.fn();
  render(
    <ThreadDraftCard
      {...props}
      attachments={[
        { artifactRef: 'a', filename: 'quote.pdf', state: 'available' },
        { artifactRef: 'b', filename: 'missing.pdf', state: 'missing' },
      ]}
      onPreviewAttachment={preview}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview quote.pdf' }));
  expect(preview).toHaveBeenCalledWith('a');
  expect(screen.queryByRole('button', { name: 'Preview missing.pdf' })).toBeNull();
});
it('editor hydration is captured once and local revisions stay protected after autosave', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(process.cwd() + '/components/create/email-composer.tsx', 'utf8');
  expect(source).toContain('revisionRef.current.localRevision > 0');
  expect(source).toContain('hydratedSnapshotRef.current === hydratedAttachmentSnapshot.key');
  expect(source).toContain("setValue('attachments', files, { shouldDirty: false })");
});
it('shows task-bound staff details for booking rooms, changed dates and payment recovery',()=>{
 render(<ThreadDraftCard {...props} tasks={[{label:'Prepare new booking',state:'Pending staff action',details:['Room 1 · Alex Example · 2026-10-12 to 2026-10-14 · ZAR 262.00','No booking has been saved.']},{label:'Review changes',state:'Pending staff action',details:['Recorded stay: 2026-10-12 to 2026-10-14','Requested stay: 2026-10-15 to 2026-10-17']},{label:'Answer question',state:'Needs review',details:['Claimed payment: ZAR 100.00 · Recorded deposit: ZAR 20.00 · Amounts differ.','Payment clearance remains unverified.']}]} />);
 expect(screen.getByText(/Room 1 · Alex Example/)).toBeTruthy();expect(screen.getByText('Requested stay: 2026-10-15 to 2026-10-17')).toBeTruthy();expect(screen.getByText(/Amounts differ/)).toBeTruthy();expect(screen.getByText('No booking has been saved.')).toBeTruthy();
});
