'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { autoTransferHistory, effectiveAt, nativeChoices, nativeRecommendationLeads, partialNativeLeads, record, requestPath, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import styles from '../reservation-pane.module.css';
import { FieldReview, FieldSource } from './stay-fields';

/** Keep dropdowns inside the pane's scrolling viewport, including above the footer. */
export function usePickerPosition(open: boolean, picker: RefObject<HTMLDivElement | null>): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !picker.current) return;
    const element = picker.current, main = element.closest('main');
    const fit = () => {
      const bounds = element.getBoundingClientRect(), viewport = main?.getBoundingClientRect();
      const below = Math.max(0, Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight) - bounds.bottom - 8);
      const above = Math.max(0, bounds.top - Math.max(0, viewport?.top ?? 0) - 8);
      const flip = below < 240 && above > below;
      setPosition({ top: flip ? 'auto' : 'calc(100% + 3px)', bottom: flip ? 'calc(100% + 3px)' : 'auto',
        maxHeight: Math.min(240, flip ? above : below) });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(element); if (main) observer?.observe(main);
    fit(); window.addEventListener('resize', fit); main?.addEventListener('scroll', fit, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit); main?.removeEventListener('scroll', fit, true); };
  }, [open, picker]);
  return position;
}

/** One editable code/identity search with persistent access to native alternatives. */
export function NativePicker({ label, path, editor, kind, allowNone = false, compact = false, hint, disabled = false, partyRole = false }: {
  label: string; path: string; editor: WorkbenchEditorProps; kind?: string; allowNone?: boolean; compact?: boolean; hint?: string; disabled?: boolean; partyRole?: boolean;
}) {
  const id = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const party = partyRole || /\/(bookingAgency|organization|arAccount)$/.test(path);
  const entity = party || path.endsWith('/nativeSelectionRef');
  const selectionPath = party ? `${path}/nativeSelectionRef` : path;
  const guestPath = !party && entity ? path.replace(/\/nativeSelectionRef$/, '') : null;
  const inputPath = party ? `${path}/name` : guestPath ? `${guestPath}/lastName` : path;
  const autoTransfer = party ? autoTransferHistory(editor.snapshot, path) : null;
  const amendTrack = editor.request.kind === 'amend' && kind === 'track';
  const savedValue = valueAt(editor.snapshot, inputPath);
  const trackDisplay = amendTrack ? text(record(savedValue).display) : '';
  // HMS guest search is by surname. Keep first name separate; a name's last
  // token is not necessarily its surname (for example, "van der Merwe").
  const saved = party ? text(valueAt(editor.snapshot, `${path}/name`)) : amendTrack && typeof savedValue === 'object'
    ? text(record(savedValue).lookupCode) : text(savedValue);
  const choiceKind = kind ?? (party ? 'party_candidate' : undefined);
  const catalogueField = ['create', 'quote', 'amend'].includes(editor.request.kind) &&
    ['room_type', 'room_type_for_charge', 'rate_plan', 'reason_for_stay', 'guarantee', 'cms_message', 'source_of_business', 'track'].includes(choiceKind ?? '');
  const observedChoices = nativeChoices(editor.snapshot, entity ? selectionPath : path, choiceKind);
  const availableChoices = choiceKind === 'reason_for_stay' ? observedChoices
    .filter(row => /^(business|leisure(?: guest)?)$/i.test(row.label))
    .map(row => ({ ...row, label: /^leisure/i.test(row.label) ? 'Leisure' : 'Business' })) : observedChoices;
  const [query, setQuery] = useState(saved);
  const [catalogueSearch, setCatalogueSearch] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const position = usePickerPosition(open, pickerRef);
  const [dirty, setDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [trackReady, setTrackReady] = useState(false);
  const trackPreviousRefs = useRef(new Set<string>());
  const trackLookupScope = useRef('');
  const trackScope = amendTrack ? (JSON.stringify(effectiveAt(editor.snapshot, `${requestPath(editor.request.id)}/body/targets`)) ?? '') : '';
  const loadingRef = useRef(false);
  const editVersion = useRef(0);
  const loadChoices = async () => {
    if (loadingRef.current) return;
    if (amendTrack) {
      setTrackReady(false);
      trackPreviousRefs.current = new Set(editor.snapshot.session.draft.observations.map(observation => observation.ref));
      trackLookupScope.current = trackScope;
    }
    loadingRef.current = true; setLoading(true); setLookupError(null);
    try {
      await saveSearch();
      if (catalogueField && editor.commands.lookupChoices) await editor.commands.lookupChoices(path);
      else await editor.commands.lookup();
      if (amendTrack) setTrackReady(true);
    } catch { setLookupError('Infor choices could not load. Try again.'); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  const openChoices = () => {
    if (!open) setCatalogueSearch(null);
    setOpen(true); setActiveIndex(-1);
    if ((amendTrack && !open) || (!choices.length && !lookupError && (entity ? Boolean(query.trim()) : true))) void loadChoices();
  };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (!pickerRef.current?.contains(event.target as Node)) { setOpen(false); setActiveIndex(-1); }
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss, true);
    };
  }, [open]);
  const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const recommendations = !dirty || normalized(query) === normalized(saved)
    ? nativeRecommendationLeads(editor.snapshot, selectionPath, choiceKind).slice(0, 3) : [];
  const recommendationRank = (value: string) => {
    const index = recommendations.findIndex(lead => normalized(lead.value) === normalized(value));
    return index < 0 ? recommendations.length : index;
  };
  const candidateRefs = entity ? record(valueAt(editor.snapshot, party ? path : guestPath ?? '')).candidateRefs : null;
  const rank = (ref: string) => Array.isArray(candidateRefs) && candidateRefs.includes(ref) ? candidateRefs.indexOf(ref) : Number.MAX_SAFE_INTEGER;
  const ordered = [...availableChoices].sort((left, right) => rank(left.ref) - rank(right.ref) || recommendationRank(left.value) - recommendationRank(right.value));
  const trackScopeChanged = amendTrack && trackReady && trackLookupScope.current !== trackScope;
  const choices = amendTrack ? trackReady && !loading && !trackScopeChanged
    ? ordered.filter(row => !trackPreviousRefs.current.has(row.ref)) : []
    : guestPath ? ordered.slice(0, 3) : ordered;
  const leads = entity && (!dirty || normalized(query) === normalized(saved))
    ? partialNativeLeads(editor.snapshot, selectionPath, choiceKind).slice(0, 3) : [];
  useEffect(() => { if (!dirty) setQuery(saved); }, [saved, dirty]);
  useEffect(() => () => { if (amendTrack) editor.commands.setUncommitted(path, false); }, [path, amendTrack]);
  const editValue = (value: string) => party ? { name: value, candidateRefs: [], suggestedRef: null } : value;
  const editPath = party ? path : inputPath;
  const choose = async (ref: string, value: string, label: string) => {
    editVersion.current += 1;
    const before = editVersion.current;
    try { if (entity) await editor.commands.selectNative(selectionPath, ref);
      else await editor.commands.edit(path, amendTrack ? { lookupCode: value, display: label } : value);
      if (editVersion.current === before) {
        if (amendTrack) editor.commands.setUncommitted(path, false);
        setCatalogueSearch(null); setDirty(false); setOpen(false); setActiveIndex(-1);
      } }
    catch { /* controller retains failure */ }
  };
  const saveSearch = async () => {
    if (!dirty || amendTrack) return;
    const before = editVersion.current;
    await editor.commands.edit(editPath, editValue(query));
    if (editVersion.current === before) setDirty(false);
  };
  const searchRecommendation = async (value: string) => {
    if (loadingRef.current) return;
    editVersion.current += 1;
    const before = editVersion.current;
    setActiveIndex(-1);
    if (catalogueField) setCatalogueSearch(value);
    else {
      setQuery(value); setDirty(true);
      editor.commands.stageEdit(editPath, editValue(value));
    }
    loadingRef.current = true; setLoading(true); setLookupError(null);
    try {
      if (!catalogueField) {
        await editor.commands.edit(editPath, editValue(value));
        if (editVersion.current !== before) return;
        setDirty(false);
      }
      if (catalogueField && editor.commands.lookupChoices) await editor.commands.lookupChoices(path);
      else await editor.commands.lookup();
    } catch { setLookupError('Infor choices could not load. Try again.'); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  const search = catalogueSearch ?? (dirty || entity ? query : '');
  const visible = choices.filter(row => !search || `${row.value} ${row.label} ${row.detail ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const shown = visible.length ? visible : choices;
  const selectionOverride = editor.snapshot.session.draft.fieldOverrides[selectionPath];
  const selectedRef = entity ? selectionOverride && selectionOverride.state !== 'inherit'
    ? valueAt(editor.snapshot, selectionPath)
    : valueAt(editor.snapshot, selectionPath) ?? (party ? record(valueAt(editor.snapshot, path)).suggestedRef : valueAt(editor.snapshot, `${guestPath}/suggestedRef`)) : null;
  const verifiedLeads = new Map(editor.snapshot.session.draft.observations.flatMap(observation => {
    const criteria = record(observation.criteria);
    return criteria.kind === 'verified_native_row' && typeof criteria.leadObservationRef === 'string' &&
      choices.some(choice => choice.ref === observation.ref) ? [[criteria.leadObservationRef, observation.ref] as const] : [];
  }));
  const selectedVerified = entity && editor.snapshot.session.draft.observations.find(observation => observation.ref === selectedRef &&
    record(observation.criteria).kind === 'verified_native_row' && choices.some(choice => choice.ref === observation.ref));
  const selectedChoice = choices.find(row => entity ? row.ref === selectedRef : row.value === saved);
  const display = open && catalogueSearch !== null ? catalogueSearch : dirty || open ? query : guestPath
    ? selectedChoice?.label || [text(valueAt(editor.snapshot, `${guestPath}/firstName`)), saved].filter(Boolean).join(' ')
    : amendTrack && trackDisplay && trackDisplay !== saved ? `${saved} — ${trackDisplay}`
    : !entity && selectedChoice && selectedChoice.label !== saved ? choiceKind === 'reason_for_stay' ? selectedChoice.label : `${saved} — ${selectedChoice.label}` : query;
  const activeId = open && activeIndex >= 0 && shown[activeIndex] ? `${id}-option-${activeIndex}` : undefined;
  useEffect(() => {
    if (!activeId) return;
    const option = document.getElementById(activeId), menu = option?.closest('[role=listbox]');
    if (!(menu instanceof HTMLElement) || !option) return;
    const bounds = option.getBoundingClientRect(), viewport = menu.getBoundingClientRect();
    const top = viewport.top + menu.clientTop, bottom = top + menu.clientHeight;
    if (bounds.bottom > bottom) menu.scrollTop += Math.ceil(bounds.bottom - bottom);
    else if (bounds.top < top) menu.scrollTop -= Math.ceil(top - bounds.top);
  }, [activeId, recommendations.length]);
  return <div data-field-path={path} className={`${styles.field} ${compact ? styles.compactField : ''}`}><div className={styles.fieldLabel}><label htmlFor={id}>{label}</label>{!compact && <FieldSource editor={editor} path={path} label={label} />}</div><div ref={pickerRef} className={`${styles.picker} ${styles.controlSlot}`}>
    <div className={styles.pickerInput}><input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list"
      aria-activedescendant={activeId}
      value={display} disabled={disabled || reviewing} onFocus={openChoices} onClick={openChoices} placeholder={guestPath ? 'Surname to find in Infor' : allowNone ? 'None / find in Infor' : 'Code or search'} onChange={event => {
        editVersion.current += 1;
        const value = event.target.value; setCatalogueSearch(null); setQuery(value); setDirty(true); setOpen(true); setActiveIndex(-1);
        if (amendTrack) editor.commands.setUncommitted(path, true);
        else editor.commands.stageEdit(editPath, editValue(value));
      }}
      onBlur={() => { void saveSearch().catch(() => {}); }} onKeyDown={event => {
        if (event.key === 'Escape') {
          if (amendTrack) { setQuery(saved); setDirty(false); editor.commands.setUncommitted(path, false); }
          setOpen(false); setActiveIndex(-1);
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); if (!open) openChoices();
          setActiveIndex(index => shown.length ? (event.key === 'ArrowDown' ? Math.min(index + 1, shown.length - 1) : index < 0 ? shown.length - 1 : Math.max(0, index - 1)) : -1);
        }
        if (event.key === 'Enter') { event.preventDefault(); const row = open && (shown[activeIndex] ?? (visible.length === 1 ? visible[0] : undefined));
          if (row) void choose(row.ref, row.value, row.label); else void saveSearch().catch(() => {}); }
      }} />
      <button type="button" aria-label={`Show ${label} choices`} disabled={disabled || reviewing} onMouseDown={event => event.preventDefault()} onClick={() => open ? setOpen(false) : openChoices()}>⌄</button></div>
    {open && !disabled && <div id={`${id}-options`} role="listbox" className={styles.options} style={position}>
      {recommendations.length > 0 && <div role="group" aria-label="Suggested searches">
        <small><strong>Suggested searches</strong> · Check the Infor matches before selecting.</small>
        {recommendations.map(lead => <button key={`${lead.ref}:${lead.value}`} type="button" disabled={loading || reviewing || editor.view.busy}
          onMouseDown={event => event.preventDefault()} onClick={() => { void searchRecommendation(lead.value); }}>
          <strong>{lead.value}</strong>{lead.label !== lead.value && <span> — {lead.label}</span>}
          <small>{lead.basis === 'exact_sender' ? 'From previous bookings' : 'Matches requested name'} · Search Infor</small>
          {lead.stock && <small>{lead.stock.status === 'available_each_night' ? 'Per-night stock available on each night'
            : lead.stock.status === 'sold_or_restricted' ? 'Some nights sold or restricted' : 'Per-night stock unresolved'}
            {' · '}read {new Date(lead.stock.observedAt).toLocaleString()} · whole-stay availability not confirmed</small>}
        </button>)}
      </div>}
      {allowNone && <button type="button" role="option" aria-selected={!query} onMouseDown={event => event.preventDefault()} onClick={() => {
        editVersion.current += 1; const before = editVersion.current;
        void editor.commands.edit(party ? path : inputPath, null, 'none').then(() => {
          if (editVersion.current === before) { setQuery(''); setDirty(false); setOpen(false); }
        }).catch(() => {});
      }}>None</button>}
      {shown.map((row, index) => <button id={`${id}-option-${index}`} key={`${row.ref}:${row.value}`} type="button" role="option" aria-selected={entity ? selectedRef === row.ref : saved === row.value}
        onMouseDown={event => event.preventDefault()} onClick={() => { void choose(row.ref, row.value, row.label); }}><strong>{choiceKind === 'reason_for_stay' ? row.label : row.value}</strong>{choiceKind !== 'reason_for_stay' && row.label !== row.value && <span> — {row.label}</span>}{row.detail && <small>{row.detail}</small>}</button>)}
      {selectedVerified && <small role="note">This row was checked; the earlier search may still be incomplete.</small>}
      {leads.length > 0 && <div role="note"><small><strong>Infor matches</strong> · {editor.commands.verifyNativeLead
        ? 'Verify a match before selecting. Search results may be incomplete.'
        : 'Search again or check the match in Infor. These cannot be selected yet.'}</small>
        {leads.map(lead => {
          const verified = verifiedLeads.get(lead.ref);
          return <div key={`${lead.ref}:${lead.label}`}><small>{lead.label} · {verified
            ? `${selectedRef === verified ? 'Selected' : 'Row checked; choose it above'}. Search may still be incomplete.` : lead.detail}</small>
            {!verified && lead.canVerify && editor.commands.verifyNativeLead && <button type="button" disabled={disabled || reviewing || editor.view.busy}
              onMouseDown={event => event.preventDefault()} onClick={() => { void editor.commands.verifyNativeLead?.(selectionPath, lead.ref).catch(() => {}); }}>Verify match</button>}</div>;
        })}</div>}
      {loading && <small role="status">Loading {label.toLocaleLowerCase()} from Infor…</small>}
      {lookupError && <small role="alert">{lookupError}</small>}
      {!choices.length && !loading && !lookupError && <small>{trackScopeChanged ? 'The stay selection changed. Refresh Infor choices.'
        : amendTrack && trackReady ? 'No common Track choices for the selected stays.'
        : entity ? 'Enter a name to find Infor matches.' : 'No Infor choices loaded yet.'}</small>}
      {!entity && ['room_type', 'room_type_for_charge', 'rate_plan'].includes(choiceKind ?? '') && <small>Hotel codes and meanings. The booking check verifies prices and availability for these dates and guests.</small>}
      <button type="button" disabled={loading} onMouseDown={event => event.preventDefault()} onClick={() => { void loadChoices(); }}>{lookupError ? 'Retry Infor' : entity ? 'Search Infor' : 'Refresh Infor choices'}</button>
    </div>}
  {open && catalogueSearch !== null && <small>Searching {catalogueSearch}. Select an Infor rate to apply it.</small>}
  {dirty ? amendTrack ? <small>Select an Infor match. <button type="button" disabled={editor.view.busy} onClick={() => {
      editVersion.current += 1; setQuery(saved); setDirty(false); setOpen(false); editor.commands.setUncommitted(path, false);
    }}>Cancel search</button></small> : <small>Unsaved search</small>
    : amendTrack && typeof savedValue === 'string' && saved ? <small>Select an Infor match for this requested Track.</small>
    : entity && !selectedRef && query ? <small>Select an Infor match</small> : null}{hint && <small>{hint}</small>}
    {autoTransfer && (!dirty || normalized(query) === normalized(saved)) && <small role="note" className={styles.memoryBadge}>History: Auto Transfer was recorded on {autoTransfer.support} of {autoTransfer.denominator} earlier stays for this {autoTransfer.partyKind === 'organization' ? 'organization' : 'A/R account'}. Check the current Infor setting.</small>}</div>
    {compact && <FieldReview editor={editor} path={path} label={label} disabled={amendTrack && dirty} onPendingChange={pending => { setReviewing(pending); if (pending) setOpen(false); }} />}</div>;
}
