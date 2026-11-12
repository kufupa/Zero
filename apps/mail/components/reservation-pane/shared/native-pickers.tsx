'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { nativeChoices, nativeRecommendationLeads, partialNativeLeads, record, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
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
export function NativePicker({ label, path, editor, kind, allowNone = false, compact = false, hint, disabled = false }: {
  label: string; path: string; editor: WorkbenchEditorProps; kind?: string; allowNone?: boolean; compact?: boolean; hint?: string; disabled?: boolean;
}) {
  const id = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const party = /\/(bookingAgency|organization|arAccount|agency|company)$/.test(path);
  const entity = party || path.endsWith('/nativeSelectionRef');
  const selectionPath = party ? `${path}/nativeSelectionRef` : path;
  const guestPath = !party && entity ? path.replace(/\/nativeSelectionRef$/, '') : null;
  const inputPath = party ? `${path}/name` : guestPath ? `${guestPath}/lastName` : path;
  // HMS guest search is by surname. Keep first name separate; a name's last
  // token is not necessarily its surname (for example, "van der Merwe").
  const saved = party ? text(valueAt(editor.snapshot, `${path}/name`)) : text(valueAt(editor.snapshot, inputPath));
  const choiceKind = kind ?? (party ? 'party_candidate' : undefined);
  const catalogueField = ['create', 'quote', 'amend'].includes(editor.request.kind) &&
    ['room_type', 'room_type_for_charge', 'rate_plan', 'reason_for_stay', 'guarantee', 'cms_message', 'source_of_business'].includes(choiceKind ?? '');
  const observedChoices = nativeChoices(editor.snapshot, entity ? selectionPath : path, choiceKind);
  const availableChoices = choiceKind === 'reason_for_stay' ? observedChoices
    .filter(row => /^(business|leisure(?: guest)?)$/i.test(row.label))
    .map(row => ({ ...row, label: /^leisure/i.test(row.label) ? 'Leisure' : 'Business' })) : observedChoices;
  const [query, setQuery] = useState(saved);
  const [open, setOpen] = useState(false);
  const position = usePickerPosition(open, pickerRef);
  const [dirty, setDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const editVersion = useRef(0);
  const loadChoices = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true; setLoading(true); setLookupError(null);
    try {
      await saveSearch();
      if (catalogueField && editor.commands.lookupChoices) await editor.commands.lookupChoices(path);
      else await editor.commands.lookup();
    } catch (error) { setLookupError(error instanceof Error ? error.message : 'Infor choices could not load. Try again.'); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  const openChoices = () => {
    setOpen(true); setActiveIndex(-1);
    if (!choices.length && !lookupError && (entity ? Boolean(query.trim()) : choiceKind !== 'track')) void loadChoices();
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
  const choices = [...availableChoices].sort((left, right) => recommendationRank(left.value) - recommendationRank(right.value));
  const leads = entity && (!dirty || normalized(query) === normalized(saved))
    ? partialNativeLeads(editor.snapshot, selectionPath, choiceKind) : [];
  useEffect(() => { if (!dirty) setQuery(saved); }, [saved, dirty]);
  const editValue = (value: string) => party ? { name: value, candidateRefs: [], suggestedRef: null } : value;
  const editPath = party ? path : inputPath;
  const choose = async (ref: string, value: string) => {
    editVersion.current += 1;
    const before = editVersion.current;
    try { if (entity) await editor.commands.selectNative(selectionPath, ref); else await editor.commands.edit(path, value);
      if (editVersion.current === before) { setDirty(false); setOpen(false); setActiveIndex(-1); } }
    catch { /* controller retains failure */ }
  };
  const saveSearch = async () => {
    if (!dirty) return;
    const before = editVersion.current;
    await editor.commands.edit(editPath, editValue(query));
    if (editVersion.current === before) setDirty(false);
  };
  const searchRecommendation = async (value: string) => {
    if (loadingRef.current) return;
    editVersion.current += 1;
    const before = editVersion.current;
    setQuery(value); setDirty(true); setActiveIndex(-1);
    editor.commands.stageEdit(editPath, editValue(value));
    loadingRef.current = true; setLoading(true); setLookupError(null);
    try {
      await editor.commands.edit(editPath, editValue(value));
      if (editVersion.current !== before) return;
      setDirty(false);
      if (catalogueField && editor.commands.lookupChoices) await editor.commands.lookupChoices(path);
      else await editor.commands.lookup();
    } catch (error) { setLookupError(error instanceof Error ? error.message : 'Infor choices could not load. Try again.'); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  const search = dirty || entity ? query : '';
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
  const display = dirty || open ? query : guestPath
    ? selectedChoice?.label || [text(valueAt(editor.snapshot, `${guestPath}/firstName`)), saved].filter(Boolean).join(' ')
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
        const value = event.target.value; setQuery(value); setDirty(true); setOpen(true); setActiveIndex(-1);
        editor.commands.stageEdit(editPath, editValue(value));
      }}
      onBlur={() => { void saveSearch().catch(() => {}); }} onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); setActiveIndex(-1); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); if (!open) openChoices();
          setActiveIndex(index => shown.length ? (event.key === 'ArrowDown' ? Math.min(index + 1, shown.length - 1) : index < 0 ? shown.length - 1 : Math.max(0, index - 1)) : -1);
        }
        if (event.key === 'Enter') { event.preventDefault(); const row = open && (shown[activeIndex] ?? (visible.length === 1 ? visible[0] : undefined));
          if (row) void choose(row.ref, row.value); else void saveSearch().catch(() => {}); }
      }} />
      <button type="button" aria-label={`Show ${label} choices`} disabled={disabled || reviewing} onMouseDown={event => event.preventDefault()} onClick={() => open ? setOpen(false) : openChoices()}>⌄</button></div>
    {open && !disabled && <div id={`${id}-options`} role="listbox" className={styles.options} style={position}>
      {recommendations.length > 0 && <div role="group" aria-label="Suggested searches">
        <small><strong>Suggested searches</strong> · Check the Infor matches before selecting.</small>
        {recommendations.map(lead => <button key={`${lead.ref}:${lead.value}`} type="button" disabled={loading || reviewing || editor.view.busy}
          onMouseDown={event => event.preventDefault()} onClick={() => { void searchRecommendation(lead.value); }}>
          <strong>{lead.value}</strong>{lead.label !== lead.value && <span> — {lead.label}</span>}
          <small>{lead.basis === 'exact_sender' ? 'From previous bookings' : 'Matches requested name'} · Search Infor</small>
        </button>)}
      </div>}
      {allowNone && <button type="button" role="option" aria-selected={!query} onMouseDown={event => event.preventDefault()} onClick={() => {
        editVersion.current += 1; const before = editVersion.current;
        void editor.commands.edit(party ? path : inputPath, null, 'none').then(() => {
          if (editVersion.current === before) { setQuery(''); setDirty(false); setOpen(false); }
        }).catch(() => {});
      }}>None</button>}
      {shown.map((row, index) => <button id={`${id}-option-${index}`} key={`${row.ref}:${row.value}`} type="button" role="option" aria-selected={entity ? selectedRef === row.ref : saved === row.value}
        onMouseDown={event => event.preventDefault()} onClick={() => { void choose(row.ref, row.value); }}><strong>{choiceKind === 'reason_for_stay' ? row.label : row.value}</strong>{choiceKind !== 'reason_for_stay' && row.label !== row.value && <span> — {row.label}</span>}{row.detail && <small>{row.detail}</small>}</button>)}
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
      {!choices.length && !loading && !lookupError && <small>{entity ? 'Enter a name to find Infor matches.' : 'No Infor choices loaded yet.'}</small>}
      {!entity && ['room_type', 'room_type_for_charge', 'rate_plan'].includes(choiceKind ?? '') && <small>Hotel codes and meanings. The booking check verifies prices and availability for these dates and guests.</small>}
      <button type="button" disabled={loading} onMouseDown={event => event.preventDefault()} onClick={() => { void loadChoices(); }}>{lookupError ? 'Retry Infor' : entity ? 'Search Infor' : 'Refresh Infor choices'}</button>
    </div>}
  {dirty ? <small>Unsaved search</small> : entity && !selectedRef && query ? <small>Select an Infor match</small> : null}{hint && <small>{hint}</small>}</div>
    {compact && <FieldReview editor={editor} path={path} label={label} onPendingChange={pending => { setReviewing(pending); if (pending) setOpen(false); }} />}</div>;
}
