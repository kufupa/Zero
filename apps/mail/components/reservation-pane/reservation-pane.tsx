'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import styles from './reservation-pane.module.css';
import { initialReservationUiState, reduceReservationUi, type PendingReservationEdit } from '@/lib/reservation-workflow/reducer';
import type {
  ReservationFieldProjection,
  ReservationPaneSnapshot,
  ReservationRequestProjection,
  ReservationSourceContext,
  ReservationWorkflowClient,
  ReservationWorkflowKind,
} from '@/lib/reservation-workflow/types';

export type ReservationPaneProps = {
  source: ReservationSourceContext;
  snapshot: ReservationPaneSnapshot | null;
  loadError: string | null;
  client: ReservationWorkflowClient;
  onSnapshot: (snapshot: ReservationPaneSnapshot) => void;
  onOpenEvidence?: (ref: string) => void;
  onOpenAttachment?: (ref: string) => void;
};

const KIND_LABEL: Record<ReservationWorkflowKind, string> = {
  create: 'Create', quote: 'Quote', amend: 'Amend', cancel: 'Cancel', services: 'Services', filing: 'Filing', other: 'Other',
};
const KINDS: ReservationWorkflowKind[] = ['create', 'quote', 'amend', 'cancel', 'services', 'filing'];
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const text = (value: unknown): string => {
  if (value == null || (record(value)?.kind === 'none')) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(text).join(', ');
  return String(record(value)?.name ?? record(value)?.meaning ?? record(value)?.code ?? '');
};
const encoded = (value: string | number) => encodeURIComponent(String(value));
const requestPath = (request: ReservationRequestProjection) => `/proposal/content/requests/${encoded(request.id)}`;
const hasValue = (value: unknown) => value !== null && value !== undefined
  && !(record(value)?.kind === 'none') && !(typeof value === 'string' && value.trim() === '');
const humanize = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
const sameIdentityText = (left: unknown, right: unknown) => text(left).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase()
  === text(right).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

function guestSelectionMatches(snapshot: ReservationPaneSnapshot, path: string, guest: { firstName: unknown; lastName: unknown; email?: unknown }): boolean {
  const selection = snapshot.fields[path];
  const ref = selection?.override?.state === 'set' && typeof selection.value === 'string' ? selection.value : null;
  if (!ref) return false;
  const observation = snapshot.session.draft.observations.find((item) => item.ref === ref && item.kind === 'guest_candidate'
    && item.status === 'complete' && ((Array.isArray(item.criteria.fieldPaths) && item.criteria.fieldPaths.includes(path))
      || item.criteria.fieldPath === path));
  const result = record(observation?.result);
  const candidates: unknown[] = Array.isArray(result?.candidates) ? result.candidates : [];
  return candidates.some((value) => {
    const candidate = record(value);
    return Boolean(candidate && sameIdentityText(candidate.firstName, guest.firstName)
      && sameIdentityText(candidate.lastName, guest.lastName)
      && (!hasValue(guest.email) || sameIdentityText(candidate.email, guest.email)) && hasValue(candidate.nativeId));
  });
}

function draftAtPath(snapshot: ReservationPaneSnapshot, path: string): unknown {
  const parts = path.split('/').slice(1).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  let value: unknown = snapshot.session.draft;
  for (const part of parts) {
    if (Array.isArray(value)) {
      const numericIndex = Number(part);
      value = Number.isInteger(numericIndex) && numericIndex >= 0 && String(numericIndex) === part
        ? value[numericIndex] : value.find((item) => record(item)?.id === part);
    }
    else if (record(value)) value = value[part];
    else return undefined;
  }
  return value;
}

function valueFor(snapshot: ReservationPaneSnapshot, path: string): unknown {
  const field = snapshot.fields[path];
  return field ? field.value : draftAtPath(snapshot, path);
}

function inheritedValue(snapshot: ReservationPaneSnapshot, paths: string[]): unknown {
  for (const path of paths) {
    const field = snapshot.fields[path];
    const override = field?.override;
    if (override) {
      if (override.state === 'unknown' || override.state === 'none' || override.state === 'clear') return null;
      if (override.state === 'set') return field.value;
      if (override.state === 'inherit') {
        const base = draftAtPath(snapshot, path);
        if (base !== null && base !== undefined && record(base)?.kind !== 'none') return field.value;
        continue;
      }
    }
    const base = draftAtPath(snapshot, path);
    if (base !== null && base !== undefined && record(base)?.kind !== 'none') return field?.value ?? base;
  }
  return null;
}

function fieldOrBase(snapshot: ReservationPaneSnapshot, path: string, base: unknown): unknown {
  return Object.hasOwn(snapshot.fields, path) ? snapshot.fields[path]?.value : base;
}

function createSections(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection) {
  const body = requestPath(request) + '/body';
  const row = record(draftAtPath(snapshot, body));
  const dateSections = valueFor(snapshot, `${body}/dateSections`);
  const allocationRows = valueFor(snapshot, `${body}/allocations`);
  if (!row || !Array.isArray(dateSections) || !Array.isArray(allocationRows)) return { body, data: null, sections: [], allocations: [] };
  const data = { ...row, dateSections, allocations: allocationRows };
  const sections = dateSections.map((value, index) => ({ value: record(value) ?? {}, index }));
  const allocations = allocationRows.map((value, index) => ({ value: record(value) ?? {}, index }));
  return { body, data, sections, allocations };
}

function emptyRoomAllocation(dateSectionId: string) {
  return {
    id: `room_${crypto.randomUUID().replaceAll('-', '')}`,
    dateSectionId,
    overrides: {},
    guest: { firstName: null, lastName: null, email: null, mobile: null,
      profileIntent: 'existing_or_unknown', candidateRefs: [], suggestedRef: null },
    occupancy: { adults: null, childCount: null, childAges: null },
    priceObservationRefs: [],
  };
}

function isInputReady(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const { body, data, sections, allocations } = createSections(snapshot, request);
  if (!data || allocations.length === 0) return false;
  if (sections.some(({ value: section }) => typeof section.requestedRooms === 'number'
      && allocations.filter(({ value }) => value.dateSectionId === section.id).length !== section.requestedRooms)) return false;
  const readyScalar = (path: string) => hasValue(valueFor(snapshot, path));
  if (!readyScalar(`${body}/shared/guaranteeType`)) return false;
  return allocations.every(({ value: allocation, index }) => {
    const dateIndex = Array.isArray(data.dateSections)
      ? data.dateSections.findIndex((entry) => record(entry)?.id === allocation.dateSectionId) : -1;
    const allocRoot = `${body}/allocations/${index}`;
    const sectionRoot = `${body}/dateSections/${Math.max(0, dateIndex)}`;
    const arrival = valueFor(snapshot, `${sectionRoot}/arrival`);
    const departure = valueFor(snapshot, `${sectionRoot}/departure`);
    const room = inheritedValue(snapshot, [`${allocRoot}/overrides/roomType`, `${sectionRoot}/defaults/roomType`, `${body}/shared/roomType`]);
    const rate = inheritedValue(snapshot, [`${allocRoot}/overrides/ratePlan`, `${sectionRoot}/defaults/ratePlan`, `${body}/shared/ratePlan`]);
    const guest = record(allocation.guest) ?? {};
    const firstName = fieldOrBase(snapshot, `${allocRoot}/guest/firstName`, guest.firstName);
    const lastName = fieldOrBase(snapshot, `${allocRoot}/guest/lastName`, guest.lastName);
    const adults = fieldOrBase(snapshot, `${allocRoot}/occupancy/adults`, record(allocation.occupancy)?.adults);
    const children = fieldOrBase(snapshot, `${allocRoot}/occupancy/childCount`, record(allocation.occupancy)?.childCount);
    const ages = fieldOrBase(snapshot, `${allocRoot}/occupancy/childAges`, record(allocation.occupancy)?.childAges);
    const childCount = typeof children === 'number' ? children : null;
    const ageList = Array.isArray(ages) ? ages : [];
    const ageReady = childCount !== null && ageList.length === childCount
      && Array.from(ageList).every((age) => typeof age === 'number' && age >= 0 && age <= 17);
    const profileSelected = guestSelectionMatches(snapshot, `${allocRoot}/guest/nativeSelectionRef`, {
      firstName, lastName, email: fieldOrBase(snapshot, `${allocRoot}/guest/email`, guest.email),
    });
    const required = [
      `${sectionRoot}/arrival`, `${sectionRoot}/departure`, `${allocRoot}/guest/firstName`, `${allocRoot}/guest/lastName`,
      `${allocRoot}/occupancy/adults`, `${allocRoot}/occupancy/childCount`, `${allocRoot}/overrides/roomType`, `${allocRoot}/overrides/ratePlan`,
    ];
    const accepted = required.every((path) => !snapshot.fields[path]?.required || snapshot.fields[path]?.review === 'accepted');
    return hasValue(arrival) && hasValue(departure) && hasValue(room) && hasValue(rate) && hasValue(firstName) && hasValue(lastName)
      && typeof adults === 'number' && adults >= 1 && ageReady && accepted && profileSelected;
  });
}

function isRequestPrepared(snapshot: ReservationPaneSnapshot, request: ReservationRequestProjection): boolean {
  const allocations = createSections(snapshot, request).allocations;
  return allocations.length > 0 && allocations.every(({ value }) => {
    const allocationId = String(value.id ?? '');
    return snapshot.preparationViews.some((view) => view.requestId === request.id && view.allocationId === allocationId && view.current);
  });
}

export function ReservationPane({ source, snapshot, loadError, client, onSnapshot, onOpenEvidence, onOpenAttachment }: ReservationPaneProps) {
  const [ui, dispatch] = useReducer(reduceReservationUi, source.selectionEpoch, initialReservationUiState);
  const sourceRef = useRef(source);
  const snapshotRef = useRef(snapshot);
  const pending = useRef(new Map<string, PendingReservationEdit>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const sequence = useRef(0);
  const triedPrepare = useRef(new Set<string>());
  const activeRequestRef = useRef<string | null>(null);
  const activeKindRef = useRef<ReservationWorkflowKind>('create');
  sourceRef.current = source;
  snapshotRef.current = snapshot;

  useEffect(() => {
    pending.current.clear();
    triedPrepare.current.clear();
    activeRequestRef.current = null;
    activeKindRef.current = 'create';
    dispatch({ type: 'source-changed', selectionEpoch: source.selectionEpoch });
  }, [source.selectionEpoch, source.messageId]);

  useEffect(() => {
    if (!snapshot || snapshot.sourceMessageId !== source.messageId) return;
    dispatch({ type: 'snapshot-received', snapshot });
    if (!activeRequestRef.current || !snapshot.requests.some((request) => request.id === activeRequestRef.current)) {
      const create = snapshot.requests.find((request) => request.kind === 'create');
      const first = create ?? snapshot.requests[0];
      activeRequestRef.current = first?.id ?? null;
      activeKindRef.current = first?.kind ?? 'create';
    }
  }, [snapshot, source.messageId]);

  const activeRequest = snapshot?.requests.find((request) => request.id === activeRequestRef.current)
    ?? snapshot?.requests.find((request) => request.kind === activeKindRef.current);
  const activeKind = activeRequest?.kind ?? activeKindRef.current;
  const activeFields = useMemo(() => activeRequest?.fieldPaths ?? [], [activeRequest]);

  const applySnapshot = useCallback((next: ReservationPaneSnapshot, bound: ReservationSourceContext) => {
    if (sourceRef.current.selectionEpoch !== bound.selectionEpoch || sourceRef.current.messageId !== bound.messageId
      || next.sourceMessageId !== bound.messageId) return;
    snapshotRef.current = next;
    onSnapshot(next);
  }, [onSnapshot]);

  const enqueue = useCallback((label: string, bound: ReservationSourceContext, action: () => Promise<void>) => {
    const run = queue.current.then(async () => {
      if (sourceRef.current.selectionEpoch !== bound.selectionEpoch || sourceRef.current.messageId !== bound.messageId) return;
      dispatch({ type: 'set-busy', action: label });
      try {
        await action();
        if (sourceRef.current.selectionEpoch === bound.selectionEpoch) {
          dispatch({ type: 'action-error', message: null });
          dispatch({ type: 'set-busy', action: null });
        }
      } catch (error) {
        if (sourceRef.current.selectionEpoch === bound.selectionEpoch) {
          dispatch({ type: 'action-error', message: error instanceof Error ? error.message : 'Reservation action did not complete.' });
        }
      }
    });
    queue.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const stage = useCallback((path: string, value: unknown, state: PendingReservationEdit['state'] = 'set') => {
    const edit = { path, value, state, sequence: ++sequence.current };
    pending.current.set(path, edit);
    dispatch({ type: 'stage-edit', edit });
  }, []);

  const flushEdits = useCallback(async (bound: ReservationSourceContext, paths?: string[]) => {
    const allowed = paths ? new Set(paths) : null;
    const edits = [...pending.current.values()].filter((edit) => !allowed || allowed.has(edit.path));
    if (!edits.length) return;
    let current = snapshotRef.current;
    if (!current) throw new Error('The source-bound reservation draft is still loading.');
    for (const edit of edits) {
      const request = current.requests.find((item) => edit.path.startsWith(`${requestPath(item)}/`));
      if (!request) throw new Error('This value has no matching field in the saved v2 request; the server did not accept a local-only draft.');
      const next = await client.edit({ source: bound, snapshot: current, requestId: request.id,
        fieldPath: edit.path, state: edit.state, ...(edit.state === 'set' ? { value: edit.value } : {}) });
      current = next;
      applySnapshot(next, bound);
      const valid = edit.state === 'set' ? hasValue(edit.value) : edit.state === 'none' || edit.state === 'clear';
      if (valid) {
        current = await client.review({ source: bound, snapshot: current, fieldPath: edit.path, decision: 'accepted' });
        applySnapshot(current, bound);
      }
      if (pending.current.get(edit.path)?.sequence === edit.sequence) pending.current.delete(edit.path);
      dispatch({ type: 'edit-acknowledged', sequence: edit.sequence });
    }
  }, [applySnapshot, client]);

  const saveEdits = useCallback((paths?: string[]) => {
    const bound = sourceRef.current;
    return enqueue('Saving reservation edits', bound, () => flushEdits(bound, paths));
  }, [enqueue, flushEdits]);

  const editOnBlur = useCallback((path: string) => { void saveEdits([path]); }, [saveEdits]);
  const editValue = useCallback((path: string): unknown => {
    const pendingEdit = pending.current.get(path);
    return pendingEdit ? pendingEdit.state === 'set' ? pendingEdit.value : null : snapshotRef.current?.fields[path]?.value ?? null;
  }, []);

  const chooseRequest = useCallback((request: ReservationRequestProjection) => {
    activeRequestRef.current = request.id;
    activeKindRef.current = request.kind;
    dispatch({ type: 'action-error', message: null });
  }, []);

  const refreshNative = useCallback(() => {
    const bound = sourceRef.current;
    const current = snapshotRef.current;
    if (!current || !activeRequest) return;
    void enqueue('Checking current Infor records and availability', bound, async () => {
      let saved = snapshotRef.current ?? current;
      if (pending.current.size) {
        await flushEdits(bound);
        saved = snapshotRef.current ?? saved;
      }
      const next = await client.lookup({ source: bound, snapshot: saved, requestId: activeRequest.id });
      applySnapshot(next, bound);
    });
  }, [activeRequest, applySnapshot, client, enqueue, flushEdits]);

  const prepareAll = useCallback(async (auto = false) => {
    const bound = sourceRef.current;
    const current = snapshotRef.current;
    const request = current?.requests.find((item) => item.id === activeRequestRef.current)
      ?? current?.requests.find((item) => item.kind === 'create');
    if (!current || !request || request.kind !== 'create') return;
    const { allocations } = createSections(current, request);
    if (!allocations.length || !isInputReady(current, request)) return;
    const key = `${bound.selectionEpoch}:${current.session.revision}:${request.id}`;
    if (auto && triedPrepare.current.has(key)) return;
    triedPrepare.current.add(key);
    if (pending.current.size) {
      await flushEdits(bound);
    }
    let latest = snapshotRef.current ?? current;
    for (const allocation of allocations) {
      const next = await client.prepare({ source: bound, snapshot: latest, requestId: request.id, allocationId: String(allocation.value.id ?? '') });
      latest = next;
      applySnapshot(next, bound);
      if (next.serviceNotice) throw new Error(next.serviceNotice);
    }
  }, [applySnapshot, client, flushEdits]);

  useEffect(() => {
    if (!snapshot || activeKind !== 'create' || !activeRequest || snapshot.preparation.state === 'current') return;
    if (!isInputReady(snapshot, activeRequest)) return;
    const key = `${source.selectionEpoch}:${snapshot.session.revision}:${activeRequest.id}`;
    if (triedPrepare.current.has(key)) return;
    const timer = window.setTimeout(() => {
      void enqueue('Checking current Infor price and availability', source, () => prepareAll(true));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [activeKind, activeRequest, enqueue, prepareAll, snapshot, source]);

  const runGo = useCallback(() => {
    const bound = sourceRef.current;
    void enqueue('Creating reservations in Infor', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      let current = snapshotRef.current;
      const request = current?.requests.find((item) => item.id === activeRequestRef.current);
      if (!current || !request || request.kind !== 'create') throw new Error('Only connected Create requests can be sent to Infor in this release.');
      const { allocations } = createSections(current, request);
      if (!allocations.length) throw new Error('This saved Create request has no room allocations to submit.');
      if (!isInputReady(current, request)) throw new Error('Complete each room, select the exact existing guest profile, and review its required values first.');
      if (!isRequestPrepared(current, request)) throw new Error('Native price and availability are stale. Wait for the automatic Infor check before Go.');
      for (const allocation of allocations) {
        const allocationId = String(allocation.value.id ?? '');
        const alreadyDone = current.operationResults.some((result) => result.requestId === request.id
          && result.allocationId === allocationId && result.workflow === 'create' && result.status === 'succeeded');
        if (alreadyDone) continue;
        const uncertain = current.operationResults.some((result) => result.requestId === request.id
          && result.allocationId === allocationId && result.workflow === 'create' && result.status === 'unknown');
        if (uncertain) throw new Error(`Room ${allocationId} has an uncertain save. Reconcile it before retrying.`);
        const idempotencyKey = crypto.randomUUID();
        current = await client.execute({ source: bound, snapshot: current, requestId: request.id, allocationId, idempotencyKey });
        applySnapshot(current, bound);
        const outcome = current.operationResults.find((result) => result.id === idempotencyKey)
          ?? [...current.operationResults].reverse().find((result) => result.requestId === request.id && result.allocationId === allocationId);
        if (!outcome || outcome.status !== 'succeeded') {
          throw new Error(current.serviceNotice ?? (outcome?.status === 'unknown'
            ? 'Infor save outcome is uncertain. Reconcile the room before retrying.'
            : `Infor did not confirm room ${allocationId}.`));
        }
      }
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const reconcile = useCallback((operationId: string) => {
    const bound = sourceRef.current;
    void enqueue('Reconciling the Infor save outcome', bound, async () => {
      const current = snapshotRef.current;
      if (!current) return;
      const next = await client.reconcile({ source: bound, snapshot: current, operationId });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue]);

  const undoRedo = useCallback((direction: 'undo' | 'redo') => {
    const bound = sourceRef.current;
    void enqueue(direction === 'undo' ? 'Undoing last edit' : 'Redoing edit', bound, async () => {
      if (pending.current.size) await flushEdits(bound);
      const current = snapshotRef.current;
      if (!current) return;
      const next = direction === 'undo' ? await client.undo({ source: bound, snapshot: current })
        : await client.redo({ source: bound, snapshot: current });
      applySnapshot(next, bound);
    });
  }, [applySnapshot, client, enqueue, flushEdits]);

  const reviewRequired = activeFields.some((path) => {
    const field = snapshot?.fields[path];
    return field?.required && (field.review !== 'accepted' || !hasValue(field.value));
  });
  const hasUncertain = snapshot?.operationResults.some((result) => result.requestId === activeRequest?.id && result.status === 'unknown') ?? false;
  const canGo = Boolean(snapshot && activeRequest?.kind === 'create' && activeRequest.supported
    && isRequestPrepared(snapshot, activeRequest) && !reviewRequired && !ui.pendingEdits.length
    && !ui.busyAction && !hasUncertain);
  const displayedResult = snapshot?.operationResults.filter((result) => result.requestId === activeRequest?.id) ?? [];

  return (
    <div className={styles.pane} data-reservation-pane="v2" data-source-message={source.messageId}>
      <header className={styles.header}>
        <div className={styles.brand}><span className={styles.brandMark}>N</span><span><b>Nava</b><small>Reservations</small></span></div>
        <div className={styles.history}>
          <button type="button" onClick={() => undoRedo('undo')} disabled={!snapshot || Boolean(ui.busyAction)} aria-label="Undo edit">↶</button>
          <button type="button" onClick={() => undoRedo('redo')} disabled={!snapshot || Boolean(ui.busyAction)} aria-label="Redo edit">↷</button>
        </div>
      </header>
      <section className={styles.sourceCard} aria-label="Selected email">
        <div className={styles.sourceMeta}>✉ <span>Selected email</span>{source.receivedAt && <time>{source.receivedAt}</time>}</div>
        <strong>{source.subject || 'Untitled email'}</strong><small>{source.sender || 'Sender unavailable'}</small>
        {source.attachments.length > 0 && <div className={styles.attachmentList}>
          {source.attachments.map((item) => <button type="button" key={item.sourceRef} disabled={item.uploadability !== 'ready' || !onOpenAttachment}
            onClick={() => onOpenAttachment?.(item.sourceRef)}><span>▤</span>{item.name}<small>{item.uploadability === 'ready' ? 'Ready' : item.uploadability}</small></button>)}
        </div>}
      </section>
      {loadError && <div className={styles.alert} role="alert">{loadError}</div>}
      {snapshot?.session.draft.status === 'prefill_failed' && <div className={styles.notice} role="status">Reservation details could not be prefilled. Nothing has been sent to Infor; fields below show only saved server values.</div>}
      {!snapshot && !loadError && <div className={styles.notice} role="status">Opening this source-bound reservation draft…</div>}
      {snapshot && <>
        <nav className={styles.tabs} aria-label="Reservation workflows">
          {KINDS.map((kind) => {
            const matches = snapshot.requests.filter((request) => request.kind === kind);
            return <button key={kind} type="button" className={activeKind === kind ? styles.activeTab : ''}
              aria-pressed={activeKind === kind} onClick={() => {
                const match = matches.find((request) => request.id === activeRequest?.id) ?? matches[0];
                if (match) chooseRequest(match);
                else { activeRequestRef.current = null; activeKindRef.current = kind; dispatch({ type: 'action-error', message: null }); }
              }}>{KIND_LABEL[kind]}{matches.length > 1 && <small>{matches.length}</small>}</button>;
          })}
        </nav>
        <main className={styles.main}>
          {activeRequest ? <>
            <div className={styles.titleRow}><div><small className={styles.eyebrow}>{KIND_LABEL[activeRequest.kind]}</small><h1>{activeRequest.text || `${KIND_LABEL[activeRequest.kind]} reservation work`}</h1></div>
              <span className={activeRequest.supported ? styles.connected : styles.notConnected}>{activeRequest.supported ? 'Connected' : 'Review only'}</span></div>
            {snapshot.issues.filter((issue) => !issue.path || issue.path.startsWith(`${requestPath(activeRequest)}/`)).map((issue, index) =>
              <div className={styles.issueLine} key={`${issue.kind}-${index}`}><b>{humanize(issue.kind)}</b><span>{issue.explanation}</span></div>)}
            {displayedResult.some((result) => result.status === 'succeeded') && <div className={styles.notice}>At least one room already has an HMS confirmation. Later edits and undo affect the draft only; they do not change a saved reservation.</div>}
            {activeRequest.kind === 'create'
                ? <CreateEditor snapshot={snapshot} request={activeRequest} onStage={stage} onBlur={editOnBlur} editValue={editValue}
                  busy={Boolean(ui.busyAction) || ui.pendingEdits.length > 0}
                  onOpenEvidence={onOpenEvidence} onPrepare={() => { void enqueue('Checking Infor now', sourceRef.current, () => prepareAll(false)); }}
                  onLookup={refreshNative} />
              : activeRequest.kind === 'filing'
                ? <FilingEditor snapshot={snapshot} request={activeRequest} source={source} onOpenAttachment={onOpenAttachment} />
                : activeRequest.kind === 'quote'
                  ? <QuoteEditor snapshot={snapshot} request={activeRequest} onStage={stage} onBlur={editOnBlur} editValue={editValue} onOpenEvidence={onOpenEvidence} />
                  : <RequestReview snapshot={snapshot} request={activeRequest} />}
            {displayedResult.map((result, index) => <OperationResult key={String(result.id ?? index)} result={result}
              onReconcile={reconcile} busy={Boolean(ui.busyAction)} />)}
            {activeRequest.kind !== 'create' && <div className={styles.notice}>This v2 request is visible from saved source facts. Its native operation is not connected in the current UI route, so no Go action is offered.</div>}
          </> : <>
            <div className={styles.titleRow}><div><small className={styles.eyebrow}>{KIND_LABEL[activeKind]}</small><h1>{activeKind === 'create' ? 'New reservation' : `${KIND_LABEL[activeKind]} request`}</h1></div></div>
            {activeKind === 'create'
              ? <div className={styles.alert}>The saved v2 draft has no Create request row. Forms cannot be saved until the server seeds an editable request; no local-only draft will be treated as real.</div>
              : <div className={styles.notice}>No {KIND_LABEL[activeKind].toLowerCase()} request is present in this email’s saved v2 draft.</div>}
          </>}
        </main>
        <footer className={styles.footer}>
          <div className={styles.footerMessage} aria-live="polite">
            {ui.busyAction ? <><span className={styles.spinner} />{ui.busyAction}</> : ui.actionError ?? snapshot.serviceNotice ?? (activeRequest?.kind === 'create' && isRequestPrepared(snapshot, activeRequest)
              ? 'Current Infor unsaved form and price are ready for review.' : snapshot.preparation.message)}
          </div>
          {ui.pendingEdits.length > 0 && <button type="button" className={styles.secondaryButton} disabled={Boolean(ui.busyAction)} onClick={() => { void saveEdits(); }}>Save {ui.pendingEdits.length} edit{ui.pendingEdits.length === 1 ? '' : 's'}</button>}
          {activeKind === 'create' && activeRequest && <button type="button" className={styles.goButton} disabled={!canGo} onClick={runGo}>Create · {createSections(snapshot, activeRequest).allocations.length} room reservations</button>}
        </footer>
      </>}
    </div>
  );
}

type EditorProps = {
  snapshot: ReservationPaneSnapshot;
  request: ReservationRequestProjection;
  busy?: boolean;
  onStage: (path: string, value: unknown, state?: PendingReservationEdit['state']) => void;
  onBlur: (path: string) => void;
  editValue: (path: string) => unknown;
  onOpenEvidence?: (ref: string) => void;
};

function CreateEditor(props: EditorProps & { busy: boolean; onPrepare: () => void; onLookup: () => void }) {
  const { snapshot, request } = props;
  const sections = createSections(snapshot, request);
  const data = sections.data;
  if (!data) return <div className={styles.alert}>The saved Create request has no v2 booking body. Wait for source prefill or report the draft as invalid; there is no safe fallback DTO.</div>;
  const partyFields = [
    ['bookingAgency', 'Agency'], ['organization', 'Organization'], ['arAccount', 'A/R account'],
  ] as const;
  const body = sections.body;
  return <>
    <div className={styles.sectionHeader}><div><h2>Rate and payer</h2><p>Choose native codes and preserve shared values. Nightly price is observed from Infor, never typed here.</p></div></div>
    <div className={styles.card}>
      <CodeField {...props} path={`${body}/shared/ratePlan`} label="Shared rate plan" help="Native code; price and availability come from Infor." />
      {partyFields.map(([key, label]) => <PartyField key={key} {...props} path={`${body}/shared/${key}`} label={label} />)}
      <div className={styles.twoCol}>
        <CodeField {...props} path={`${body}/shared/guaranteeType`} label="Guarantee type" />
        <CodeField {...props} path={`${body}/shared/track`} label="Track" />
      </div>
      <TextField {...props} path={`${body}/shared/reasonForStay`} label="Reason for stay" />
      <div className={styles.fixedValue}><span>Source of business</span><b>{text(props.editValue(`${body}/shared/sourceOfBusiness`)) || 'Not set by the saved draft'}</b><small>Bound to the selected mailbox; no alternate source is inferred.</small></div>
      <TextField {...props} path={`${body}/shared/billingReference`} label="Billing reference" />
    </div>

    <div className={styles.sectionHeader}><div><h2>Dates and room allocation</h2><p>Each room retains its own guest and occupancy. Empty child ages remain unknown—not zero.</p></div></div>
    <div className={styles.twoCol}><button type="button" className={styles.secondaryButton} onClick={props.onLookup}>Refresh native guest and party matches</button>
      <button type="button" className={styles.secondaryButton} onClick={props.onPrepare}>Refresh current Infor price</button></div>
    {sections.sections.map(({ value: section, index }) => {
      const sectionRoot = `${body}/dateSections/${index}`;
      const allocationCount = sections.allocations.filter(({ value }) => value.dateSectionId === section.id).length;
      return <section className={styles.card} key={String(section.id ?? index)}>
        <div className={styles.cardTitle}><b>{text(section.title) || `Date section ${index + 1}`}</b><small>{text(section.requestedRooms) || 'Room count unresolved'}</small></div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${sectionRoot}/arrival`} label="Arrival" type="date" />
          <TextField {...props} path={`${sectionRoot}/departure`} label="Departure" type="date" />
        </div>
        <div className={styles.fixedValue}><span>Requested rooms / existing allocations</span><b>{text(section.requestedRooms) || 'Unresolved'} / {allocationCount}</b>
          <small>Addition persists as a source-bound edit. Removing/reordering rows awaits server rebasing of index-bound review and evidence paths.</small></div>
        {typeof section.requestedRooms === 'number' && allocationCount !== section.requestedRooms && <small className={styles.problem}>Room count and saved allocation rows differ. Create stays blocked until the server draft is structurally reconciled.</small>}
        <button type="button" className={styles.secondaryButton} disabled={props.busy || typeof section.id !== 'string'} onClick={() => {
          const allocationPath = `${body}/allocations`;
          const requestedRoomsPath = `${sectionRoot}/requestedRooms`;
          const nextRows = [...sections.allocations.map(({ value }) => value), emptyRoomAllocation(String(section.id))];
          props.onStage(allocationPath, nextRows);
          props.onStage(requestedRoomsPath, allocationCount + 1);
          props.onBlur(allocationPath);
          props.onBlur(requestedRoomsPath);
        }}>Add room to these dates</button>
        <CodeField {...props} path={`${sectionRoot}/defaults/roomType`} label="Default room category" />
        <CodeField {...props} path={`${sectionRoot}/defaults/ratePlan`} label="Default rate plan" />
      </section>;
    })}
    {sections.allocations.map(({ value: allocation, index }) => {
      const allocationRoot = `${body}/allocations/${index}`;
      const occupancy = record(allocation.occupancy) ?? {};
      const guest = record(allocation.guest) ?? {};
      const agePath = `${allocationRoot}/occupancy/childAges`;
      const ageValue = props.editValue(agePath);
      const ages = Array.isArray(ageValue) ? ageValue : Array.isArray(occupancy.childAges) ? occupancy.childAges : [];
      const countValue = fieldOrBase(snapshot, `${allocationRoot}/occupancy/childCount`, occupancy.childCount);
      const childCount = typeof countValue === 'number' ? countValue : null;
      const profileChoicePath = `${allocationRoot}/guest/nativeSelectionRef`;
      return <section className={styles.card} key={String(allocation.id ?? index)}>
        <div className={styles.cardTitle}><b>Room reservation {index + 1}</b><small>{text(allocation.dateSectionId) ? `Dates: ${text(allocation.dateSectionId)}` : 'Date section not assigned'}</small></div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${allocationRoot}/guest/firstName`} label="Guest first name" />
          <TextField {...props} path={`${allocationRoot}/guest/lastName`} label="Guest last name" />
        </div>
        <div className={styles.twoCol}>
          <TextField {...props} path={`${allocationRoot}/guest/email`} label="Guest email" type="email" />
          <TextField {...props} path={`${allocationRoot}/guest/mobile`} label="Guest mobile" type="tel" />
        </div>
        <GuestProfileStatus snapshot={snapshot} path={profileChoicePath} guest={guest}
          expected={{ firstName: Object.hasOwn(snapshot.fields, `${allocationRoot}/guest/firstName`)
            ? props.editValue(`${allocationRoot}/guest/firstName`) : guest.firstName,
            lastName: Object.hasOwn(snapshot.fields, `${allocationRoot}/guest/lastName`)
              ? props.editValue(`${allocationRoot}/guest/lastName`) : guest.lastName,
            email: Object.hasOwn(snapshot.fields, `${allocationRoot}/guest/email`)
              ? props.editValue(`${allocationRoot}/guest/email`) : guest.email }}
          onStage={props.onStage} onBlur={props.onBlur} />
        <div className={styles.twoCol}>
          <TextField {...props} path={`${allocationRoot}/occupancy/adults`} label="Adults" type="number" min={1} max={20} />
          <TextField {...props} path={`${allocationRoot}/occupancy/childCount`} label="Children" type="number" min={0} max={12} hideState
            blurPaths={[`${allocationRoot}/occupancy/childCount`, agePath]}
            onValue={(value) => {
              if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 12) {
                props.onStage(`${allocationRoot}/occupancy/childCount`, value);
                props.onStage(agePath, Array.from({ length: value }, (_, ageIndex) => ages[ageIndex] ?? null));
              } else {
                props.onStage(`${allocationRoot}/occupancy/childCount`, undefined, 'unknown');
                props.onStage(agePath, undefined, 'unknown');
              }
            }} />
        </div>
        {childCount !== null && childCount > 0 && <div className={styles.ageGrid}>
          <span>Child ages — one exact age for each child</span>
        <FieldValueState {...props} path={agePath} />
          {Array.from({ length: childCount }, (_, ageIndex) => <TextField key={ageIndex} {...props}
            path={`${agePath}/${ageIndex}`} label={`Child ${ageIndex + 1} age`} type="number" min={0} max={17}
            valueOverride={ages[ageIndex] ?? null} blurPath={agePath} hideState onValue={(value) => {
              const next = [...ages]; next[ageIndex] = value === null ? null : Number(value); props.onStage(agePath, next);
            }} />)}
          {ages.length !== childCount || ages.some((age) => typeof age !== 'number')
            ? <small className={styles.problem}>Child count and complete ages must match.</small> : null}
        </div>}
        <ScopedCodeField {...props} path={`${allocationRoot}/overrides/roomType`} label="Room category for this room" inherited={text(props.editValue(`${body}/dateSections/${Math.max(0, sections.sections.findIndex((entry) => entry.value.id === allocation.dateSectionId))}/defaults/roomType`)) || 'Date-section default'} />
        <ScopedCodeField {...props} path={`${allocationRoot}/overrides/ratePlan`} label="Rate plan for this room" inherited={text(props.editValue(`${body}/dateSections/${Math.max(0, sections.sections.findIndex((entry) => entry.value.id === allocation.dateSectionId))}/defaults/ratePlan`)) || text(props.editValue(`${body}/shared/ratePlan`)) || 'Shared rate plan'} />
        <div className={styles.fixedValue}><span>Charge category</span><b>Infor default</b><small>Per-room charge-category override is not supported by the connected native Create tool.</small></div>
        <TextField {...props} path={`${allocationRoot}/overrides/reservationNote`} label="Reservation note" multiline />
        {Array.isArray(allocation.priceObservationRefs) && allocation.priceObservationRefs.length > 0 && <small className={styles.help}>Native price evidence: {allocation.priceObservationRefs.length} observation reference(s).</small>}
      </section>;
    })}
    {sections.allocations.length === 0 && <div className={styles.notice}>No room allocations yet. Add one to a date section above to build the reservation.</div>}
    <NativePriceSummary snapshot={snapshot} request={request} />

    <div className={styles.sectionHeader}><div><h2>Booker and confirmation</h2><p>Booker remains distinct from each reservation guest.</p></div></div>
    <section className={styles.card}>
      <div className={styles.twoCol}><TextField {...props} path={`${body}/shared/bookerName`} label="Booker name" /><TextField {...props} path={`${body}/shared/bookerContact`} label="Booker contact" /></div>
      <BooleanField {...props} path={`${body}/shared/cmsSend`} label="Send an HMS confirmation" />
      {Boolean(props.editValue(`${body}/shared/cmsSend`)) && <>
        <CodeField {...props} path={`${body}/shared/cmsMessageId`} label="Confirmation message code" />
        <TextField {...props} path={`${body}/shared/cmsRecipient`} label="Confirmation recipient" type="email" />
      </>}
    </section>

    {snapshot.session.draft.proposal.content.services.some((service) => service.ownerRequestId === request.id)
      ? <div className={styles.notice}>This email also contains service requests. They remain separately visible in the saved draft; Create will not silently apply them.</div> : null}
    <div className={styles.policyLine}>Shared fields apply to each room unless a room-level value is explicitly set.</div>
  </>;
}

function FieldShell({ path, label, field, children, onOpenEvidence }: {
  path: string; label: string; field?: ReservationFieldProjection; children: ReactNode; onOpenEvidence?: (ref: string) => void;
}) {
  const showEvidence = Boolean(field && (field.provenance === 'source' || field.provenance === 'inferred' || field.provenance === 'assumption'));
  return <div className={styles.field} data-path={path}>
    <div className={styles.labelRow}><label htmlFor={path}>{label}</label><div className={styles.fieldStatus}>
      {showEvidence && <span className={styles.purpleDot} title={`From ${field?.provenance}`}>●</span>}
      {field?.required && field.review !== 'accepted' ? <span className={styles.required}>Review</span>
        : field?.review === 'accepted' ? <span className={styles.accepted}>✓ Reviewed</span> : null}
    </div></div>
    {children}
    {field?.issue && <small className={styles.problem}>{field.issue}</small>}
    {showEvidence && <details className={styles.evidence}><summary>Why this value?</summary><div>
      {field?.evidenceRefs.map((ref) => <button key={ref} type="button" disabled={!onOpenEvidence} onClick={() => onOpenEvidence?.(ref)}>{ref}</button>)}
      {!field?.evidenceRefs.length && <small>Evidence reference is not available.</small>}
    </div></details>}
  </div>;
}

function TextField(props: EditorProps & { path: string; label: string; type?: 'text' | 'email' | 'date' | 'number' | 'tel'; min?: number; max?: number; multiline?: boolean; help?: string; valueOverride?: unknown; onValue?: (value: unknown) => void; blurPath?: string; blurPaths?: string[]; hideState?: boolean }) {
  const field = props.snapshot.fields[props.path];
  const value = props.valueOverride !== undefined ? props.valueOverride : props.editValue(props.path);
  const rawValue = text(value);
  const inputValue = props.type === 'date' && rawValue.length > 10 ? rawValue.slice(0, 10) : rawValue;
  const commitOnBlur = () => {
    const paths = props.blurPaths ?? [props.blurPath ?? props.path];
    for (const path of paths) props.onBlur(path);
  };
  const input = <input id={props.path} className={styles.input} type={props.type ?? 'text'} value={inputValue} min={props.min} max={props.max}
    onChange={(event: ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value;
      const next = props.type === 'number' ? raw === '' ? null : Number(raw) : raw;
      props.onValue ? props.onValue(next) : props.onStage(props.path, next, raw === '' ? 'none' : 'set');
    }} onBlur={commitOnBlur} />;
  return <FieldShell path={props.path} label={props.label} field={field} onOpenEvidence={props.onOpenEvidence}>
    {props.multiline ? <textarea id={props.path} className={styles.textarea} rows={3} value={text(value)} onChange={(event) => props.onStage(props.path, event.target.value, event.target.value ? 'set' : 'none')} onBlur={commitOnBlur} /> : input}
    {!props.hideState && <FieldValueState {...props} path={props.blurPath ?? props.path} />}
    {props.help && <small className={styles.help}>{props.help}</small>}
  </FieldShell>;
}

function CodeField(props: EditorProps & { path: string; label: string; help?: string; hideState?: boolean }) {
  const field = props.snapshot.fields[props.path];
  const value = props.editValue(props.path);
  return <FieldShell path={props.path} label={props.label} field={field} onOpenEvidence={props.onOpenEvidence}>
    <div className={styles.codeControl}><input id={props.path} className={styles.input} value={text(value)} placeholder="Native code"
      onChange={(event) => props.onStage(props.path, event.target.value, event.target.value ? 'set' : 'none')} onBlur={() => props.onBlur(props.path)} />
      <span aria-hidden="true">⌄</span></div>
    {!props.hideState && <FieldValueState {...props} path={props.path} />}
    <select className={styles.select} disabled value="" aria-label={`${props.label} native meaning options`}><option value="">Native code meanings appear after HMS catalog lookup</option></select>
    <small className={styles.help}>{props.help ?? 'Code is typed here. The current native tool returns validation/price for this code, not a reusable code catalogue.'}</small>
  </FieldShell>;
}

function PartyField(props: EditorProps & { path: string; label: string }) {
  const current = record(props.editValue(props.path)) ?? {};
  const field = props.snapshot.fields[props.path];
  const selectionPath = `${props.path}/nativeSelectionRef`;
  const selection = props.snapshot.fields[selectionPath];
  const selectedRef = selection?.override?.state === 'set' && typeof selection.value === 'string' ? selection.value : null;
  const tail = props.path.split('/').pop();
  const role = tail === 'bookingAgency' || tail === 'agency' ? 'agency' : tail === 'arAccount' ? 'ar_account' : 'organization';
  const candidates = props.snapshot.session.draft.observations.flatMap((observation) => {
    if (observation.kind !== 'party_candidate' || observation.status !== 'complete'
        || observation.criteria.role !== role || observation.criteria.fieldPath !== selectionPath) return [];
    const results = record(observation.result);
    const rows = Array.isArray(results?.candidates) ? results.candidates : [];
    return rows.map((candidate) => ({ observationRef: observation.ref, candidate: record(candidate) })).filter((item) => item.candidate);
  });
  const selectedCandidate = candidates.find((item) => item.observationRef === selectedRef)?.candidate;
  const selectedMatches = Boolean(selectedCandidate && sameIdentityText(selectedCandidate.name, current.name) && hasValue(selectedCandidate.nativeId));
  return <FieldShell path={props.path} label={props.label} field={field} onOpenEvidence={props.onOpenEvidence}>
    <input id={props.path} className={styles.input} value={String(current.name ?? '')} placeholder="Enter the requested party name"
      onChange={(event) => props.onStage(props.path, { ...current, name: event.target.value, suggestedRef: current.suggestedRef ?? null, candidateRefs: current.candidateRefs ?? [] }, event.target.value ? 'set' : 'none')}
      onBlur={() => props.onBlur(props.path)} />
    <FieldValueState {...props} path={props.path} />
    {selectedMatches && <small className={styles.accepted}>Native candidate selected and reviewed.</small>}
    {selectedRef && !selectedMatches && <small className={styles.problem}>Saved native selection no longer matches this party name. Select a matching result again.</small>}
    {!selectedMatches && candidates.map(({ observationRef, candidate }, index) => {
      const exact = sameIdentityText(candidate?.name, current.name) && hasValue(candidate?.nativeId);
      return <div className={styles.candidateOption} key={`${observationRef}-${String(candidate?.nativeId ?? index)}`}>
        <span><b>{text(candidate?.name)}</b><small>Infor profile {text(candidate?.nativeId)}</small></span>
        {exact ? <button type="button" onClick={() => { props.onStage(selectionPath, observationRef); props.onBlur(selectionPath); }}>Select</button>
          : <small>Search result does not exactly match the entered party name.</small>}
      </div>;
    })}
    {!selectedMatches && <small className={styles.help}>{candidates.length ? 'Select the exact host-observed match.' : 'Refresh native matches; a typed name alone is not a profile selection.'}</small>}
  </FieldShell>;
}

function ScopedCodeField(props: EditorProps & { path: string; label: string; inherited: string }) {
  const field = props.snapshot.fields[props.path];
  const ownsValue = ['set', 'none', 'clear'].includes(field?.override?.state ?? '');
  const [own, setOwn] = useState(ownsValue);
  useEffect(() => { setOwn(ownsValue); }, [field?.override?.updatedAt, field?.override?.state]);
  const mode = own ? 'own' : field?.override?.state === 'unknown' ? 'unknown' : 'inherit';
  return <div className={styles.scoped}>
    <FieldShell path={`${props.path}-mode`} label={props.label} field={field} onOpenEvidence={props.onOpenEvidence}>
      <select id={`${props.path}-mode`} className={styles.select} value={mode} onChange={(event) => {
        const value = event.target.value;
        if (value === 'own') {
          setOwn(true);
          if (!ownsValue) { props.onStage(props.path, undefined, 'none'); props.onBlur(props.path); }
          return;
        }
        if (value !== 'inherit' && value !== 'unknown') return;
        setOwn(false);
        props.onStage(props.path, undefined, value);
        props.onBlur(props.path);
      }}>
        <option value="inherit">Inherit · {props.inherited || 'default'}</option><option value="own">Own value</option><option value="unknown">Unknown</option>
      </select>
    </FieldShell>
    {mode === 'own' && <CodeField {...props} hideState />}
  </div>;
}

function FieldValueState(props: EditorProps & { path: string }) {
  const current = props.snapshot.fields[props.path]?.override?.state;
  const label = current === 'set' ? 'Own value' : current === 'unknown' ? 'Unknown'
    : current === 'none' || current === 'clear' ? 'No value' : current === 'inherit' ? 'Inherited' : 'Source value';
  return <div className={styles.valueState}>
    <small>{label}</small>
    {current !== 'inherit' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'inherit'); props.onBlur(props.path); }}>Use source / inherit</button>}
    {current !== 'unknown' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'unknown'); props.onBlur(props.path); }}>Mark unknown</button>}
    {current !== 'none' && current !== 'clear' && <button type="button" onClick={() => { props.onStage(props.path, undefined, 'none'); props.onBlur(props.path); }}>Clear value</button>}
  </div>;
}

function BooleanField(props: EditorProps & { path: string; label: string }) {
  const value = props.editValue(props.path);
  return <FieldShell path={props.path} label={props.label} field={props.snapshot.fields[props.path]} onOpenEvidence={props.onOpenEvidence}>
    <select id={props.path} className={styles.select} value={value == null ? '' : value ? 'true' : 'false'} onChange={(event) => {
      const next = event.target.value;
      props.onStage(props.path, next === 'true' ? true : next === 'false' ? false : undefined,
        next === '' ? 'unknown' : next === 'none' ? 'none' : 'set');
      props.onBlur(props.path);
    }}><option value="">Unknown</option><option value="none">No value</option><option value="true">Yes</option><option value="false">No</option></select>
  </FieldShell>;
}

function GuestProfileStatus({ snapshot, path, guest, expected, onStage, onBlur }: {
  snapshot: ReservationPaneSnapshot; path: string; guest: Record<string, unknown>;
  expected: { firstName: unknown; lastName: unknown; email: unknown };
  onStage: EditorProps['onStage']; onBlur: EditorProps['onBlur'];
}) {
  const selectedValue = valueFor(snapshot, path);
  const selectedRef = snapshot.fields[path]?.override?.state === 'set' && typeof selectedValue === 'string' ? selectedValue : null;
  const selectedObservation = selectedRef ? snapshot.session.draft.observations.find((item) => item.ref === selectedRef && item.kind === 'guest_candidate') : null;
  const candidates = snapshot.session.draft.observations.filter((item) => item.kind === 'guest_candidate'
    && item.criteria.requestId === path.split('/')[4] && item.status === 'complete'
    && ((Array.isArray(item.criteria.fieldPaths) && item.criteria.fieldPaths.includes(path)) || item.criteria.fieldPath === path)).flatMap((item) => {
      const result = record(item.result);
      return Array.isArray(result?.candidates) ? result.candidates.map((candidate) => ({ observationRef: item.ref, candidate: record(candidate) })) : [];
    }).filter((item): item is { observationRef: string; candidate: Record<string, unknown> } => Boolean(item.candidate));
  const selected = guestSelectionMatches(snapshot, path, expected) ? selectedRef : null;
  return <div className={selected ? styles.profileReady : styles.profileWarning} data-profile-path={path}>
    <b>{selected ? 'Existing guest profile selected' : selectedRef ? 'Selection no longer matches this guest' : 'Select an existing Infor guest profile'}</b>
    <span>{selectedObservation ? `Native match · ${selectedObservation.status}` : selectedRef ?? 'A typed name alone is not a profile selection.'}</span>
    {!selected && candidates.length > 0 && <div className={styles.candidateList}>
      {candidates.map(({ observationRef, candidate }, index) => {
        const matchesGuest = sameIdentityText(candidate.firstName, expected.firstName) && sameIdentityText(candidate.lastName, expected.lastName)
          && (!hasValue(expected.email) || sameIdentityText(candidate.email, expected.email)) && hasValue(candidate.nativeId);
        return <div className={styles.candidateOption} key={`${observationRef}-${String(candidate.nativeId ?? index)}`}>
          <span><b>{text(candidate.firstName)} {text(candidate.lastName)}</b><small>{text(candidate.email) || `Profile ${text(candidate.nativeId)}`}</small></span>
          {matchesGuest ? <button type="button" onClick={() => { onStage(path, observationRef); onBlur(path); }}>Select</button>
            : <small>Does not exactly match the entered guest identity.</small>}
        </div>;
      })}
    </div>}
    {!selected && <small>{candidates.length ? 'Matches are evidence only until a source-bound profile selection is recorded.' : 'Refresh native matches after entering the guest name. A typed name alone will not select an existing profile.'}</small>}
  </div>;
}

function NativePriceSummary({ snapshot, request }: { snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection }) {
  const allocations = createSections(snapshot, request).allocations;
  if (allocations.length === 0) return null;
  return <div className={styles.priceList} aria-label="Native Infor price and availability">
    {allocations.map(({ value: allocation }) => {
      const id = String(allocation.id ?? '');
      const view = snapshot.preparationViews.find((item) => item.requestId === request.id && item.allocationId === id);
      const price = record(view?.price);
      const hasPrice = Boolean(price && hasValue(price.currency) && hasValue(price.averageRate) && hasValue(price.totalRate));
      return <div className={styles.priceRow} key={id}>
        <span>Room {id || 'reservation'}</span>
        {hasPrice && price ? <b>{text(price.currency)} {text(price.averageRate)} / night · {text(price.totalRate)} total</b>
          : <small>{view?.issue ? humanize(view.issue) : 'No native price has been returned for this room.'}</small>}
        <small>{view?.current ? 'Current HMS price and availability' : 'Not confirmed current; Go stays blocked'}</small>
      </div>;
    })}
  </div>;
}

function QuoteEditor(props: EditorProps) {
  const body = `${requestPath(props.request)}/body`;
  const quote = record(draftAtPath(props.snapshot, body));
  if (!quote || !Array.isArray(quote.groups)) return <div className={styles.alert}>The saved Quote request has no v2 quote body.</div>;
  const groups = quote.groups.map((value, index) => ({ value: record(value) ?? {}, index }));
  const client = record(quote.client) ?? {};
  const parties = record(quote.parties) ?? {};
  const money = Array.isArray(quote.requestedMoney) ? quote.requestedMoney : [];
  const intent = record(quote.outputIntent) ?? {};
  return <>
    <div className={styles.notice}>Quote groups remain whole-party or per-room as stated; no adult split or booking is inferred. Outputs below are intent only and remain unsent.</div>
    <div className={styles.sectionHeader}><div><h2>Stay requirements</h2><p>Native prices are read-only observations; no nightly amount override.</p></div></div>
    {groups.map(({ value: group, index }) => {
      const root = `${body}/groups/${index}`;
      const occupancy = record(group.occupancy) ?? {};
      return <section className={styles.card} key={String(group.id ?? index)}>
        <div className={styles.cardTitle}><b>Quote group {index + 1}</b><small>{text(occupancy.scope) || 'Occupancy scope unresolved'}</small></div>
        <div className={styles.twoCol}><TextField {...props} path={`${root}/arrival`} label="Arrival" type="date" /><TextField {...props} path={`${root}/departure`} label="Departure" type="date" /></div>
        <div className={styles.twoCol}><TextField {...props} path={`${root}/quantity`} label="Rooms" type="number" min={1} /><CodeField {...props} path={`${root}/board`} label="Board code" /></div>
        <CodeField {...props} path={`${root}/ratePlan`} label="Rate plan code" />
        <FieldShell path={`${root}/roomCodes`} label="Requested room categories" field={props.snapshot.fields[`${root}/roomCodes`]}>
          <div className={styles.readValue}>{Array.isArray(group.roomCodes) && group.roomCodes.length ? group.roomCodes.join(', ') : 'No room category resolved'}</div>
        </FieldShell>
        <FieldShell path={`${root}/occupancy/scope`} label="Occupancy applies to" field={props.snapshot.fields[`${root}/occupancy/scope`]}>
          <select id={`${root}/occupancy/scope`} className={styles.select} value={text(props.editValue(`${root}/occupancy/scope`))} onChange={(event) => {
            props.onStage(`${root}/occupancy/scope`, event.target.value); props.onBlur(`${root}/occupancy/scope`);
          }}><option value="">Unresolved</option><option value="per_room">Per room</option><option value="whole_group">Whole group</option><option value="unresolved">Unresolved</option></select>
        </FieldShell>
        <div className={styles.twoCol}><TextField {...props} path={`${root}/occupancy/adults`} label="Adults" type="number" min={1} /><TextField {...props} path={`${root}/occupancy/childCount`} label="Children" type="number" min={0} /></div>
        <FieldShell path={`${root}/occupancy/childAges`} label="Child ages" field={props.snapshot.fields[`${root}/occupancy/childAges`]}>
          <div className={styles.readValue}>{Array.isArray(occupancy.childAges) ? occupancy.childAges.map((age) => age == null ? 'unknown' : String(age)).join(', ') || 'None' : 'Unknown'}</div>
        </FieldShell>
      </section>;
    })}
    <div className={styles.sectionHeader}><div><h2>Commercial and client details</h2></div></div>
    <section className={styles.card}>
      <PartyField {...props} path={`${body}/parties/agency`} label="Agency" />
      <PartyField {...props} path={`${body}/parties/company`} label="Company" />
      <TextField {...props} path={`${body}/salesStrategy`} label="Sales strategy" />
      <TextField {...props} path={`${body}/client/attention`} label="Attention" />
      <div className={styles.twoCol}><TextField {...props} path={`${body}/client/email`} label="Email" type="email" /><TextField {...props} path={`${body}/client/telephone`} label="Telephone" type="tel" /></div>
      <TextField {...props} path={`${body}/notes`} label="Quote notes" multiline />
    </section>
    <section className={styles.card}>
      <div className={styles.cardTitle}><b>Requested amounts</b><small>Source claims only</small></div>
      {money.length === 0 ? <div className={styles.readValue}>No requested amount</div> : money.map((value, index) => {
        const item = record(value) ?? {};
        return <div className={styles.moneyRow} key={String(item.id ?? index)}>
          <b>{[text(item.amount), text(item.currency)].filter(Boolean).join(' ') || 'Amount unresolved'}</b>
          <span>{text(item.unit) || 'Unit unresolved'} · {humanize(text(item.scope) || 'unresolved')}</span>
          <small>Targets: {Array.isArray(item.targetRefs) ? item.targetRefs.length : 0} · evidence refs: {Array.isArray(item.sourceRefs) ? item.sourceRefs.length : 0}</small>
        </div>;
      })}
      <div className={styles.fixedValue}><span>Unsent outputs requested</span><b>{Array.isArray(intent.artifacts) && intent.artifacts.length ? intent.artifacts.map((item) => humanize(String(item))).join(', ') : 'None mapped'}</b><small>No reply, PDF, or spreadsheet is generated by this connected route yet.</small></div>
    </section>
    {Object.keys(client).length === 0 && <span className={styles.help}>No client identity was extracted.</span>}
  </>;
}

function FilingEditor({ snapshot, request, source, onOpenAttachment }: {
  snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection; source: ReservationSourceContext;
  onOpenAttachment?: (ref: string) => void;
}) {
  const linkedRefs = draftAtPath(snapshot, `${requestPath(request)}/documentRefs`);
  const requestDocs = Array.isArray(linkedRefs) ? linkedRefs : [];
  const docs = snapshot.session.draft.proposal.content.documents.filter((document) =>
    document.ownerRequestId === request.id || requestDocs.includes(document.id));
  const targetScope = draftAtPath(snapshot, `${bodyPath(request)}/targets`);
  return <>
    <div className={styles.sectionHeader}><div><h2>Filing source and destination</h2><p>Files stay bound to admitted email bytes and exact existing reservation targets.</p></div></div>
    {docs.length === 0 ? <div className={styles.notice}>No document is bound to this Filing request.</div> : docs.map((document) => {
      const attachment = source.attachments.find((item) => item.sourceRef === document.documentSourceRef);
      return <section className={styles.card} key={document.id}>
        <div className={styles.cardTitle}><b>{humanize(document.kind)}</b><small>{document.handling === 'filing_requested' ? 'Filing requested' : document.handling}</small></div>
        {attachment ? <div className={styles.attachmentBound}><b>{attachment.name}</b><small>{attachment.mimeType ?? 'Unknown file type'} · {attachment.uploadability}</small>
          {onOpenAttachment && <button type="button" className={styles.inlineButton} disabled={attachment.uploadability !== 'ready'} onClick={() => onOpenAttachment(attachment.sourceRef)}>Open admitted attachment</button>}</div>
          : <div className={styles.alert}>Saved source evidence ref: {document.documentSourceRef}. It does not match a host attachment ID; no file-bytes binding is available yet.</div>}
        <div className={styles.fixedValue}><span>Targets in saved request</span><b>{document.targetRefs.length || 'Unresolved'}</b><small>No destination is inferred from a guest name.</small></div>
      </section>;
    })}
    {!docs.length && source.attachments.length > 0 && <section className={styles.card}>
      <div className={styles.cardTitle}><b>Attachments on selected email</b><small>No filing document is linked to them</small></div>
      {source.attachments.map((attachment) => <div className={styles.attachmentBound} key={attachment.sourceRef}>
        <b>{attachment.name}</b><small>{attachment.mimeType ?? 'Unknown file type'} · {attachment.uploadability}</small>
        {onOpenAttachment && <button type="button" className={styles.inlineButton} disabled={attachment.uploadability !== 'ready'} onClick={() => onOpenAttachment(attachment.sourceRef)}>Open admitted attachment</button>}
      </div>)}
    </section>}
    {record(targetScope) && <section className={styles.card}>
      <div className={styles.cardTitle}><b>Saved target scope</b><small>{humanize(String(record(targetScope)?.mode ?? 'unresolved'))}</small></div>
      {['include', 'exclude'].map((side) => {
        const refs = record(targetScope)?.[side];
        const list = Array.isArray(refs) ? refs : [];
        return <div className={styles.targetScope} key={side}><b>{humanize(side)}</b>{list.length
          ? list.map((value, index) => <small key={index}>{JSON.stringify(value)}</small>)
          : <small>None recorded</small>}</div>;
      })}
    </section>}
    <div className={styles.notice}>Filing execution is not connected in the current route. No local receipt or success state is created.</div>
  </>;
}

function RequestReview({ snapshot, request }: { snapshot: ReservationPaneSnapshot; request: ReservationRequestProjection }) {
  const fields = request.fieldPaths.map((path) => ({ path, field: snapshot.fields[path] }))
    .filter((item) => item.field && !item.path.endsWith('/id'));
  return <>
    <div className={styles.notice}>This v2 request is visible from the saved source draft. A dedicated task form is not connected yet; the fields below are read-only.</div>
    <section className={styles.card}>{fields.map(({ path, field }) => <div className={styles.readRow} key={path}>
      <b>{humanize(path.split('/').pop() ?? 'Field')}</b><span>{text(field?.value) || 'Not provided'}</span>
      {field?.provenance !== 'unknown' && <small>Source: {field?.provenance}</small>}
    </div>)}</section>
  </>;
}

function OperationResult({ result, onReconcile, busy }: { result: Record<string, unknown>; onReconcile: (operationId: string) => void; busy: boolean }) {
  const status = text(result.status) || 'Unknown';
  return <section className={styles.result}>
    <div><b>{text(result.summary) || `${humanize(text(result.workflow) || 'operation')} · ${text(result.allocationId) || ''}`}</b><span className={styles.resultStatus}>{humanize(status)}</span></div>
    {hasValue(result.confirmation) && <p>Confirmation <strong>{text(result.confirmation)}</strong></p>}
    {hasValue(result.summary) && <small>{text(result.summary)}</small>}
    {status === 'unknown' && typeof result.id === 'string' && <button type="button" className={styles.secondaryButton} disabled={busy}
      onClick={() => onReconcile(result.id as string)}>Check Infor outcome</button>}
  </section>;
}
