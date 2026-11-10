
'use client';

import { useState } from 'react';
import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationWorkflowClient, ReservationWorkflowKind } from '@/lib/reservation-workflow/types';
import { effectiveAt, guestProfileReceipt, record, requestPath, text, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { QuoteOutputPanel, type SaveQuoteOutput } from './quote-output-panel';
import { useReservationWorkbench } from './use-reservation-workbench';
import { CreateEditor, resolveCreateCmsRecipientDefault } from './editors/create-editor';
import { QuoteEditor } from './editors/quote-editor';
import { AmendEditor } from './editors/amend-editor';
import { CancelEditor } from './editors/cancel-editor';
import { AddonsEditor } from './editors/addons-editor';
import { FilingEditor } from './editors/filing-editor';
import styles from './reservation-pane.module.css';

export type ReservationPaneProps = {
  source: ReservationSourceContext; snapshot: ReservationPaneSnapshot | null; loadError: string | null;
  client: ReservationWorkflowClient; onSnapshot(snapshot: ReservationPaneSnapshot): void;
  onOpenEvidence?: (ref: string) => void; onOpenAttachment?: (ref: string) => void; preview?: boolean; onSaveQuoteOutput?: SaveQuoteOutput;
};
const labels: Record<ReservationWorkflowKind, string> = { create: 'Create', quote: 'Quote', amend: 'Amend', cancel: 'Cancel', services: 'Add-Ons', filing: 'Filing', other: 'Other' };
const editors = { create: CreateEditor, quote: QuoteEditor, amend: AmendEditor, cancel: CancelEditor, services: AddonsEditor, filing: FilingEditor };
const actionKinds = Object.keys(editors) as Array<Exclude<ReservationWorkflowKind, 'other'>>;
function issueText(explanation: string) {
  if (/^Candidate read v2_[a-z0-9]+ failed\.$/i.test(explanation)) return 'An Infor search during email prefill failed. Search again to verify the details.';
  if (/^Candidate read v2_[a-z0-9]+ .+; coverage is not complete\.$/i.test(explanation)) return 'An Infor search during email prefill was incomplete. Search again to verify the details.';
  return explanation;
}

export function ReservationPane(props: ReservationPaneProps) {
  const workbench = useReservationWorkbench(props);
  const [checked, setChecked] = useState<string | null>(null);
  const [formReset, setFormReset] = useState(0);
  const [actionMenu, setActionMenu] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { source, preview = false } = props;
  const { snapshot, request, commands, busy } = workbench;
  const createBlocked = source.selfPreStay && request?.kind === 'create';
  const prefill = snapshot?.session.draft.prefill;
  const editor: WorkbenchEditorProps | null = snapshot && request ? { source, snapshot, request,
    view: { busy, error: workbench.error, preview, saving: workbench.saving }, commands, onOpenEvidence: props.onOpenEvidence } : null;
  const body = snapshot && request ? record(effectiveAt(snapshot, `${requestPath(request.id)}/body`)) : {};
  const ids = request?.kind === 'create' ? (Array.isArray(body.allocations) ? body.allocations.map(row => text(record(row).id)) : [])
    : request?.kind === 'amend' || request?.kind === 'cancel' ? (Array.isArray(record(body.targets).include) ? (record(body.targets).include as unknown[]).map(row => text(record(row).id)) : []) : [];
  const digestFor = (current: ReservationPaneSnapshot | null) => JSON.stringify({
    generation: current?.session.draft.generationId, request: request?.id,
    body: current && request ? Object.fromEntries(Object.entries(record(effectiveAt(current, `${requestPath(request.id)}/body`))).filter(([field]) => request.kind !== 'cancel' || field !== 'previewObservationRefs')) : {},
    overrides: Object.fromEntries(Object.entries(current?.session.draft.fieldOverrides ?? {}).filter(([path]) => request && (path === requestPath(request.id) || path.startsWith(`${requestPath(request.id)}/`)) && (request.kind !== 'cancel' || !path.startsWith(`${requestPath(request.id)}/body/previewObservationRefs`))).map(([path, value]) => [path, {state: value.state, value: value.value}])) });
  const digest = digestFor(snapshot);
  const quotePrepared = request?.kind === 'quote' && snapshot ? [...snapshot.session.draft.operationResults].reverse().find(row => row.workflow === 'quote' && row.requestId === request.id && row.status === 'prepared') : null;
  const quoteObservation = quotePrepared && snapshot?.session.draft.observations.find(row => quotePrepared.observationRefs.includes(row.ref) && row.kind === 'rate_availability');
  const quoteExtras = record(quoteObservation?.result).extrasReviewItems;
  const quoteReview = request && snapshot?.session.draft.staffReviews[`${requestPath(request.id)}/body`];
  const extrasNeedReview = Array.isArray(quoteExtras) && quoteExtras.some(item => typeof item === 'string' && item.trim()) &&
    !(quoteReview?.status === 'accepted' && Date.parse(quoteReview.at ?? '') >= Date.parse(quotePrepared?.updatedAt ?? '') && Date.parse(quoteReview.at ?? '') >= Date.parse(quoteObservation?.observedAt ?? ''));
  const check = async () => {
    if (!request || createBlocked || workbench.blocked) return;
    try {
      if (request.kind === 'create' && snapshot) {
        const root = `${requestPath(request.id)}/body`, shared = `${root}/shared`;
        const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
        const rooms = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
        const needsRecipient = rooms.some((room, index) => {
          const sectionIndex = sections.findIndex(section => section.id === room.dateSectionId);
          const bases = [`${root}/allocations/${index}/overrides`, `${root}/dateSections/${sectionIndex}/defaults`, shared];
          const inherited = (key: string) => {
            for (const base of bases) {
              const path = `${base}/${key}`;
              if (base !== shared && snapshot.session.draft.fieldOverrides[path]?.state === 'inherit') continue;
              const value = effectiveAt(snapshot, path);
              if (value !== undefined && value !== null) return value;
            }
            return undefined;
          };
          return inherited('cmsSend') === true && !text(inherited('cmsRecipient')).trim();
        });
        const recipient = resolveCreateCmsRecipientDefault(snapshot, request.id, source.sender);
        if (needsRecipient && recipient && !text(effectiveAt(snapshot, `${shared}/cmsRecipient`)).trim()) {
          await commands.edit(`${shared}/cmsRecipient`, recipient);
        }
      }
      await commands.review(request.kind === 'create' ? 'allocations' : request.kind === 'amend' || request.kind === 'cancel' ? 'targets' : 'request', ids);
      if (request.kind === 'create' || request.kind === 'amend' || request.kind === 'cancel') {
        for (const id of ids) {
          const prior = [...(workbench.latestSnapshot()?.operationResults ?? [])].reverse().find(row => row.workflow === request.kind && row.requestId === request.id && row.allocationId === id && ['succeeded', 'unknown'].includes(String(row.status)));
          if (prior?.status === 'succeeded') continue;
          if (prior?.status === 'unknown') throw new Error('Check the previous save outcome before checking this stay again.');
          if (request.kind === 'create' && workbench.latestSnapshot()?.preparationViews.some(view => view.requestId === request.id && view.allocationId === id && view.current)) continue;
          await commands.prepare(id);
        }
      } else await commands.prepare();
      setChecked(digestFor(workbench.latestSnapshot()));
    } catch { setChecked(null); }
  };
  const save = async () => {
    if (!request || createBlocked || preview || workbench.blocked || extrasNeedReview || checked !== digest) return;
    try {
      if (request.kind === 'create' || request.kind === 'amend' || request.kind === 'cancel') {
        for (const id of ids) {
          const result = [...(workbench.latestSnapshot()?.operationResults ?? [])].reverse().find(row => row.workflow === request.kind && row.requestId === request.id && row.allocationId === id && ['succeeded', 'unknown'].includes(String(row.status)));
          if (result?.status === 'succeeded') continue;
          if (result?.status === 'unknown') throw new Error('Check the previous save outcome before continuing.');
          await commands.execute(id);
        }
      } else await commands.execute();
      setChecked(null);
    } catch { /* controller displays the native failure */ }
  };
  const Editor = request && request.kind !== 'other' ? editors[request.kind] : null;
  const sourceChanged = snapshot?.session.sourceChanged === true;
  const disabled = busy || !snapshot || workbench.blocked || workbench.conflict || sourceChanged;
  const actionLocked = snapshot?.operationResults.some(row => row.requestId === request?.id && ['succeeded', 'unknown'].includes(text(row.status))) ||
    (request?.kind === 'create' && ids.some(id => Boolean(commands.guestProfilePending(id))));
  const scopedIssues = snapshot?.issues.filter(issue => issue.kind !== 'source_changed' && (!issue.path || !request || issue.path.startsWith(requestPath(request.id)))) ?? [];
  const allRoomsSaved = request?.kind === 'create' && ids.length > 0 && ids.every(id => snapshot?.operationResults.some(row =>
    row.workflow === 'create' && row.requestId === request.id && row.allocationId === id && row.status === 'succeeded'));
  const isEarlierIssue = (issue: typeof scopedIssues[number]) => !issue.path || Boolean(allRoomsSaved &&
    ['ambiguous_guest_profile', 'rate_availability_unavailable', 'mail_candidate_read_failed'].includes(issue.kind));
  const earlierIssues = scopedIssues.filter(isEarlierIssue);
  const currentIssues = scopedIssues.filter(issue => !isEarlierIssue(issue));
  return <div className={styles.pane} data-reservation-pane>
    <header className={styles.header}><div><strong>Nava</strong><span>{preview ? 'Interactive preview · Save disabled' : workbench.saving ? 'Saving changes…' : busy ? 'Checking Infor…' : 'Saved draft'}</span></div>
      <div className={styles.history}><button type="button" aria-label="Undo draft change" disabled={disabled || !snapshot?.session.revision} onClick={() => { void workbench.undo().catch(() => {}); }}>↶</button><button type="button" aria-label="Redo draft change" disabled={disabled || snapshot?.session.revision === snapshot?.session.revisionHead} onClick={() => { void workbench.redo().catch(() => {}); }}>↷</button></div>
    </header>
    <nav className={styles.actionNav} aria-label="Reservation actions"><div className={styles.actionBar}><div className={styles.tabs}>
      {snapshot?.requests.filter(row => !source.selfPreStay || row.kind !== 'create').map(row => <span className={styles.tabGroup} key={row.id}>
        <button type="button" className={row.id === request?.id ? styles.activeTab : ''} onClick={() => { workbench.setActiveId(row.id); setChecked(null); setActionMenu(null); setConfirmRemove(false); }}>{labels[row.kind]}</button>
        {row.id === request?.id && <button type="button" className={styles.tabChevron} aria-label={`Options for ${labels[row.kind]}`} aria-expanded={actionMenu === row.id}
          onClick={() => { setActionMenu(current => current === row.id ? null : row.id); setConfirmRemove(false); }}>▾</button>}
      </span>)}
      </div><select className={styles.actionAdd} aria-label="Add action" value="" disabled={!snapshot || busy || sourceChanged} onChange={event => { const kind = event.target.value as Exclude<ReservationWorkflowKind, 'other'>; if (kind && !(source.selfPreStay && kind === 'create')) { setActionMenu(null); void workbench.addAction(kind).catch(() => {}); } }}><option value="">+ Action</option>{actionKinds.filter(kind => !(source.selfPreStay && kind === 'create')).map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}</select>
    </div>
    {request && actionMenu === request.id && <div className={styles.actionMenu}>
      {actionLocked ? <p>This action has an Infor result and must stay in the draft.</p> : confirmRemove ? <>
        <p>Remove this draft action? Its unsaved details will be removed. Infor is unchanged.</p>
        <div className={styles.actionMenuButtons}><button type="button" onClick={() => setConfirmRemove(false)}>Keep action</button>
          <button type="button" disabled={disabled} onClick={() => { void commands.changeRows({ kind: 'remove_action', requestId: request.id })
            .then(() => { setActionMenu(null); setConfirmRemove(false); setChecked(null); }).catch(() => {}); }}>Remove action</button></div>
      </> : <button type="button" disabled={disabled} onClick={() => setConfirmRemove(true)}>Remove this action</button>}
    </div>}</nav>
    <div className={styles.sources}>{source.attachments.map(file => <button type="button" key={file.sourceRef} onClick={() => props.onOpenAttachment?.(file.sourceRef)}>{file.name}</button>)}</div>
    {(props.loadError || workbench.error) && <div className={styles.error} role="alert">{workbench.error || props.loadError}{workbench.conflict && <>
      {workbench.unresolvedPending.length > 0 && <div><p>These edits need to be entered again. Copy the values before discarding:</p>
        {workbench.unresolvedPending.map(edit => <p key={edit.path}><strong>{edit.label}:</strong> {edit.value || '(empty)'}</p>)}</div>}
      <div><button type="button" disabled={sourceChanged || busy || !workbench.applicablePendingCount} onClick={() => { void workbench.applyPending().catch(() => {}); }}>Apply my edits</button><button type="button" onClick={() => { workbench.discardPending(); setFormReset(value => value + 1); }}>Discard pending edits</button></div></>}</div>}
    {sourceChanged && snapshot && <div className={styles.notice}>
      <p>The email or attachments changed. Review the updated evidence; previous Infor checks will need to be repeated.</p>
      <details><summary>Review updated email</summary><div className={styles.changedSourceText}>{source.sourceText || 'Open this email in Outlook to review it.'}</div></details>
      {source.attachments.map(file => <button type="button" key={file.sourceRef} onClick={() => props.onOpenAttachment?.(file.sourceRef)}>Open {file.name}</button>)}
      {snapshot.operationResults.some(row => row.status === 'unknown')
        ? <><p>Check earlier save outcomes before continuing.</p>{snapshot.operationResults.filter(row => row.status === 'unknown').map(row =>
          <div key={text(row.id)}>{row.workflow === 'guest_profile' ? 'Guest profile outcome unknown.' : text(row.summary) || text(row.workflow)} <button type="button" disabled={busy} onClick={() => { void commands.reconcile(text(row.id)).catch(() => {}); }}>Check outcome</button></div>)}</>
        : <button type="button" disabled={busy || preview} onClick={() => { void workbench.reconcileSource().then(() => setChecked(null)).catch(() => {}); }}>I reviewed the updated evidence</button>}
    </div>}
    <main className={styles.content}>
      {!snapshot ? <div className={styles.empty}>{props.loadError ? 'This email could not be opened.' : 'Opening your email draft…'}</div>
        : !request ? <div className={styles.empty}><h2>What does this email need?</h2><p>Add an action to begin. Prefill will appear here when ready; your edits are saved.</p>{!source.selfPreStay && <button type="button" disabled={sourceChanged} onClick={() => { void workbench.addAction('create').catch(() => {}); }}>New booking</button>}</div>
        : createBlocked ? <div className={styles.empty}>This pre-stay email describes an existing reservation. Choose another action.</div>
        : Editor && editor ? <fieldset className={styles.sourceFieldset} disabled={sourceChanged}><Editor key={`${source.messageId}:${source.sourceHash}:${source.selectionEpoch}:${request.id}:${formReset}`} {...editor} />{(request.kind === 'create' || request.kind === 'amend') && snapshot.session.draft.proposal.content.services.some(service => service.ownerRequestId === request.id || request && snapshot.session.draft.proposal.content.requests.find(row => row.id === request.id)?.serviceRefs.includes(service.id)) && <AddonsEditor key={`addons:${source.messageId}:${source.sourceHash}:${source.selectionEpoch}:${request.id}:${formReset}`} {...editor} />}</fieldset>
        : <div className={styles.empty}><h2>What does this email need?</h2>
          <p>{text(body.requestedText) || 'No supported task was identified. If this email needs work, choose an action to open its fields.'}</p>{Boolean(body.separatedFrom) && <p>This request is retained for staff to handle separately. It is excluded from the room quote.</p>}
          <div className={styles.otherActions} aria-label="Choose an email action">
            {actionKinds.filter(kind => !(source.selfPreStay && kind === 'create')).map(kind => <button type="button" key={kind}
              disabled={disabled} onClick={() => { void workbench.addAction(kind).catch(() => {}); }}>{labels[kind]}</button>)}
          </div></div>}
      {request?.kind === 'quote' && snapshot && <QuoteOutputPanel source={source} snapshot={snapshot} requestId={request.id} save={props.onSaveQuoteOutput} latestSnapshot={workbench.latestSnapshot} readyForReply={workbench.readyForReply} blocked={busy || workbench.saving || workbench.blocked || workbench.conflict || sourceChanged} />}
      {['queued', 'running'].includes(prefill?.status ?? '') && <p className={styles.small}>{prefill?.status === 'queued' ? 'Prefill is queued.' : prefill?.phase === 'native_checks' ? 'Checking the extracted details in Infor.' : 'Reading the email and attachments.'} You can start editing now.</p>}
      {prefill?.status === 'failed' && <p className={styles.small}>Prefill did not finish. Your form still works. {(prefill.phase === 'native_checks' || prefill.attemptCount < 2) && <button type="button" disabled={disabled || workbench.saving} onClick={() => { void workbench.retryPrefill().catch(() => {}); }}>Retry prefill</button>}</p>}
      {currentIssues.map((issue, index) => <p className={styles.notice} key={index}>{issueText(issue.explanation)}</p>)}
      {earlierIssues.length > 0 && <details className={styles.earlierChecks}>
        <summary>Earlier email checks · {earlierIssues.length} {allRoomsSaved ? 'notices' : 'incomplete'}</summary>
        {earlierIssues.map((issue, index) => <p className={styles.notice} key={index}>{issueText(issue.explanation)}</p>)}
      </details>}
    </main>
    {request && !createBlocked && request.kind !== 'services' && request.kind !== 'other' && <footer className={styles.footer}>
      {request.kind === 'create' && snapshot?.preparationViews.filter(view => view.requestId === request.id && view.price && !snapshot.operationResults.some(row => row.workflow === 'create' && row.requestId === request.id && row.allocationId === view.allocationId && ['succeeded','unknown'].includes(text(row.status)))).map(view => <div key={view.allocationId} className={styles.price}><span>Room {ids.indexOf(view.allocationId) + 1} · {view.current ? 'Infor price' : 'Price needs refresh'}</span><strong>{view.price ? [view.price.currency, view.price.totalRate].filter(value => value != null).join(' ') : '—'}</strong></div>)}
      <div className={styles.actions}><button type="button" disabled={disabled || !ids.length && ['create','amend','cancel'].includes(request.kind)} onClick={() => { void check(); }}>Review & check</button>
        <button type="button" className={styles.primary} disabled={disabled || preview || extrasNeedReview || checked !== digest} onClick={() => { void save(); }}>{request.kind === 'quote' ? record(quoteObservation?.result).failureKind === 'proven_shortage' ? 'Generate unsent decline' : 'Generate unsent quote' : request.kind === 'cancel' ? 'Cancel in Infor' : request.kind === 'filing' ? 'File PDF in Infor' : 'Save in Infor'}</button></div>
      {workbench.blocked && <small>Apply the changed selection before checking.</small>}
      {snapshot?.operationResults.filter(row => row.requestId === request.id && row.status !== 'prepared').map(row => {
        const guest = row.workflow === 'guest_profile';
        const receipt = guestProfileReceipt(row);
        const missingReceipt = guest && row.status === 'succeeded' && !receipt;
        const summary = guest && (row.status === 'unknown' || missingReceipt) ? 'Guest profile'
          : receipt ? `Guest profile ${receipt.nativeId} created` : text(row.summary) || labels[request.kind];
        return <div className={styles.receipt} key={text(row.id)}>{summary} · {missingReceipt ? 'Needs confirmation' : text(row.status)}{!guest && row.confirmation ? ` · ${text(row.confirmation)}` : ''}{row.status === 'unknown' && <button type="button" onClick={() => { void commands.reconcile(text(row.id)).catch(() => {}); }}>Check outcome</button>}</div>;
      })}
    </footer>}
  </div>;
}
