'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { autoTransferHistory, effectiveAt, hasCompleteNativeCatalogue, nativeChoices, nativeRecommendationLeads, partialNativeLeads, record, requestPath, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import styles from '../reservation-pane.module.css';
import { FieldReview, FieldSource } from './stay-fields';
import { AutopickPanel, autopickSuggestion } from './autopick-evidence';

const leadBlockReason: Record<string, string> = {
  support_below_min: 'Fewer than two prior stays', purity_below_threshold: 'History is inconsistent',
  purity_unknown: 'History is incomplete', multi_client_domain: 'Domain has multiple clients',
  webmail_domain: 'Personal email domain', refund_account_excluded: 'Refund account excluded',
  role_basis_not_auto: 'Requires staff selection',
};

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
export function NativePicker({ label, path, editor, kind, allowNone = false, compact = false, hint, disabled = false, partyRole = false, quoteName = false }: {
  label: string; path: string; editor: WorkbenchEditorProps; kind?: string; allowNone?: boolean; compact?: boolean; hint?: string; disabled?: boolean; partyRole?: boolean; quoteName?: boolean;
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
  const observedChoices = nativeChoices(editor.snapshot, entity ? selectionPath : path, choiceKind, editor.configuration);
  const rateCatalogueObserved = choiceKind === 'rate_plan' && editor.snapshot.session.draft.observations.some((observation) => {
    const criteria = record(observation.criteria);
    return observation.generationId === editor.snapshot.session.draft.generationId &&
      observation.propertyCode === editor.snapshot.session.draft.propertyCode &&
      observation.sourceMessageId === editor.snapshot.session.draft.source.messageId &&
      criteria.kind === 'native_catalogue' && criteria.catalogueKind === 'rate_plan' &&
      criteria.requestId === editor.request.id;
  });
  const rateCatalogueLoaded = choiceKind !== 'rate_plan' ||
    observedChoices.some((choice) => choice.ref.startsWith('catalogue:')) || rateCatalogueObserved;
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
  const [applyingName, setApplyingName] = useState(false);
  const applyingNameRef = useRef(false);
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
    if ((amendTrack && !open) || ((!rateCatalogueLoaded || !choices.length) && !lookupError &&
        (entity ? Boolean(query.trim()) : true))) void loadChoices();
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
  const recommendations = !quoteName && (!dirty || normalized(query) === normalized(saved))
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
    : ordered;
  const leads = entity && (!dirty || normalized(query) === normalized(saved))
    ? partialNativeLeads(editor.snapshot, selectionPath, choiceKind) : [];
  useEffect(() => { if (!dirty) setQuery(saved); }, [saved, dirty]);
  useEffect(() => () => { if (catalogueField || quoteName) editor.commands.setUncommitted(path, false); }, [path, catalogueField, quoteName]);
  const editValue = (value: string) => quoteName && !value.trim() ? null : party ? { name: value, candidateRefs: [], suggestedRef: null } : value;
  const editState = (value: string) => quoteName && !value.trim() ? 'none' as const : 'set' as const;
  const editPath = party ? path : inputPath;
  const choose = async (ref: string, value: string, label: string) => {
    if (quoteName && applyingNameRef.current) return;
    editVersion.current += 1;
    const before = editVersion.current;
    if (quoteName) { applyingNameRef.current = true; setApplyingName(true); editor.commands.setUncommitted(path, true); }
    try { if (entity) await editor.commands.selectNative(selectionPath, ref);
      else {
        await editor.commands.edit(path, amendTrack ? { lookupCode: value, display: label } : value);
        // Quote groups alone auto-fill mealPlan from known Centurion boards. Create
        // keeps mealPlan as a staff override — writing it here leaves a stale board
        // after switching to an unknown-board rate (e.g. BARRO → NCOR1B).
        const board = editor.request.kind === 'quote' && editor.configuration?.propertyCode === editor.snapshot.session.draft.propertyCode &&
          choiceKind === 'rate_plan' && path.endsWith('/ratePlan')
          ? editor.configuration.ratePlans.find(rate => rate.code === value)?.mealPlan : undefined;
        const mealPlan = board === 'bed_breakfast' ? 'bb' : board === 'dinner_bed_breakfast' ? 'dinner_bb' : board;
        if (mealPlan && mealPlan !== 'unknown')
          await editor.commands.edit(path.replace(/\/ratePlan$/u, '/mealPlan'), mealPlan);
      }
      if (editVersion.current === before) {
        if (catalogueField || quoteName) editor.commands.setUncommitted(path, false);
        setCatalogueSearch(null); setDirty(false); setOpen(false); setActiveIndex(-1);
      } }
    catch { if (quoteName && editVersion.current === before) { setDirty(false); editor.commands.setUncommitted(path, false); } }
    finally { if (quoteName) { applyingNameRef.current = false; setApplyingName(false); } }
  };
  const saveSearch = async () => {
    if (!dirty || amendTrack || applyingNameRef.current) return;
    const before = editVersion.current;
    try {
      await editor.commands.edit(editPath, editValue(query), editState(query));
      if (editVersion.current === before) { setDirty(false); if (catalogueField || quoteName) editor.commands.setUncommitted(path, false); }
    } catch (error) {
      if (quoteName && editVersion.current === before) { setDirty(false); editor.commands.setUncommitted(path, false); }
      throw error;
    }
  };
  const useTypedName = async () => {
    if (applyingNameRef.current) return;
    const before = ++editVersion.current;
    applyingNameRef.current = true; setApplyingName(true); editor.commands.setUncommitted(path, true);
    try {
      editor.commands.stageEdit(editPath, editValue(query), editState(query));
      editor.commands.stageEdit(selectionPath, null, 'none');
      await editor.commands.edit(selectionPath, null, 'none');
      if (editVersion.current === before) { setDirty(false); setOpen(false); editor.commands.setUncommitted(path, false); }
    } catch { if (editVersion.current === before) { setDirty(false); editor.commands.setUncommitted(path, false); } }
    finally { applyingNameRef.current = false; setApplyingName(false); }
  };
  const searchRecommendation = async (value: string) => {
    if (loadingRef.current) return;
    editVersion.current += 1;
    const before = editVersion.current;
    setActiveIndex(-1);
    if (catalogueField) setCatalogueSearch(value);
    else {
      setQuery(value); setDirty(true);
      if (quoteName) editor.commands.setUncommitted(path, true);
      editor.commands.stageEdit(editPath, editValue(value), editState(value));
    }
    loadingRef.current = true; setLoading(true); setLookupError(null);
    try {
      if (!catalogueField) {
        await editor.commands.edit(editPath, editValue(value), editState(value));
        if (editVersion.current !== before) return;
        setDirty(false);
        if (quoteName) editor.commands.setUncommitted(path, false);
      }
      if (catalogueField && editor.commands.lookupChoices) await editor.commands.lookupChoices(path);
      else await editor.commands.lookup();
    } catch { setLookupError('Infor choices could not load. Try again.'); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  const search = catalogueSearch ?? (dirty || entity ? query : '');
  const visible = choices.filter(row => !search || `${row.value} ${row.label} ${row.detail ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const shown = quoteName ? visible : visible.length ? visible : choices;
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
  // Host auto-pick (contract v1): evidence expander + Read tick replace the right-side confirm for this field.
  const picked = autopickSuggestion(editor.snapshot, editor.request.id, selectionPath);
  const staffSet = Object.entries(editor.snapshot.session.draft.fieldOverrides).some(([key, value]) => value.state !== 'inherit' &&
    [path, selectionPath].some(target => target === key || target.startsWith(`${key}/`) || (party && key.startsWith(`${path}/`))));
  const suggestionCurrent = entity ? typeof selectedRef === 'string' ? selectedRef : '' : saved;
  const suggestion = picked && suggestionCurrent === (entity ? picked.ref : picked.value) ? picked : null;
  const chooseSuggested = async (option: { ref: string; label: string }) => {
    if (!entity) { await choose(option.ref, option.ref, option.label); return; }
    if (party && editor.request.kind !== 'quote') {
      // Create/Amend require the lookup query before selectNative; Create/Quote then store the native display name.
      const observation = editor.snapshot.session.draft.observations.find(row => row.ref === option.ref);
      const result = record(observation?.result), criteria = record(observation?.criteria);
      const candidate = record(Array.isArray(result.candidates) && result.candidates.length === 1 ? result.candidates[0] : result);
      const query = [criteria.query, criteria.searchName, criteria.name, candidate.name, option.label]
        .find((value): value is string => typeof value === 'string' && Boolean(value.trim())) ?? option.label;
      if (text(valueAt(editor.snapshot, `${path}/name`)) !== query)
        await editor.commands.edit(`${path}/name`, query);
    }
    await choose(option.ref, option.ref, option.label);
  };
  const staleIdentity = Boolean(entity && selectedRef && !selectedChoice);
  const staleCode = Boolean(!entity && catalogueField && saved && !selectedChoice &&
    hasCompleteNativeCatalogue(editor.snapshot, path, choiceKind));
  const setCatalogueUncommitted = useRef(editor.commands.setUncommitted);
  setCatalogueUncommitted.current = editor.commands.setUncommitted;
  useEffect(() => {
    const key = `catalogue-selection:${path}`;
    setCatalogueUncommitted.current(key, staleCode);
    return () => setCatalogueUncommitted.current(key, false);
  }, [path, staleCode]);
  useEffect(() => {
    const key = `native-selection:${selectionPath}`;
    setCatalogueUncommitted.current(key, staleIdentity);
    return () => setCatalogueUncommitted.current(key, false);
  }, [selectionPath, staleIdentity]);
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
  return <div data-field-path={path} className={`${styles.field} ${compact ? styles.compactField : ''}`}><div className={styles.fieldLabel}><label htmlFor={id}>{label}</label>{!compact && !suggestion && <FieldSource editor={editor} path={path} label={label} />}</div><div ref={pickerRef} className={`${styles.picker} ${styles.controlSlot}`}>
    <div className={styles.pickerInput}><input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list"
      aria-activedescendant={activeId}
      value={display} disabled={disabled || reviewing || (quoteName && applyingName)} onFocus={quoteName ? undefined : openChoices} onClick={quoteName ? undefined : openChoices} placeholder={quoteName ? 'Name for quote (optional)' : guestPath ? 'Surname to find in Infor' : allowNone ? 'None / find in Infor' : 'Code or search'} onChange={event => {
        editVersion.current += 1;
        const value = event.target.value; setCatalogueSearch(null); setQuery(value); setDirty(true); if (!quoteName) setOpen(true); setActiveIndex(-1);
        if (catalogueField) {
          editor.commands.setUncommitted(path, true);
          if (!amendTrack) editor.commands.stageEdit(editPath, editValue(value), 'set', { notify: false });
        } else {
          if (quoteName) editor.commands.setUncommitted(path, true);
          editor.commands.stageEdit(editPath, editValue(value), editState(value));
        }
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
        if (event.key === 'Enter') { event.preventDefault(); const row = open && (shown[activeIndex] ?? (!quoteName && visible.length === 1 ? visible[0] : undefined));
          if (row) void choose(row.ref, row.value, row.label); else if (quoteName) void useTypedName(); else void saveSearch().catch(() => {}); }
      }} />
      <button type="button" aria-label={`Show ${label} choices`} disabled={disabled || reviewing || (quoteName && applyingName)} onMouseDown={event => event.preventDefault()} onClick={() => open ? setOpen(false) : quoteName ? (setOpen(true), void loadChoices()) : openChoices()}>⌄</button></div>
    {quoteName && <div>
      <button type="button" disabled={disabled || reviewing || applyingName || !query.trim()} onMouseDown={event => event.preventDefault()}
        onClick={() => { setOpen(true); void loadChoices(); }}>Find in Infor</button>{' '}
      <button type="button" disabled={disabled || reviewing || applyingName || !query.trim()} onMouseDown={event => event.preventDefault()}
        onClick={() => { void useTypedName(); }}>Use typed name on quote</button>
    </div>}
    {open && !disabled && <div id={`${id}-options`} role="listbox" className={styles.options} style={position}>
      {recommendations.length > 0 && <div role="group" aria-label="Suggested searches">
        <small><strong>Suggested searches</strong> · Check the Infor matches before selecting.</small>
        {recommendations.map(lead => <button key={`${lead.ref}:${lead.value}`} type="button" disabled={loading || reviewing || editor.view.busy}
          onMouseDown={event => event.preventDefault()} onClick={() => { void searchRecommendation(lead.value); }}>
          <strong>{lead.value}</strong>{lead.label !== lead.value && <span> — {lead.label}</span>}
          <small>{lead.basis === 'exact_sender' ? 'From previous bookings' : 'Matches requested name'} · Search Infor</small>
          {lead.denominator !== undefined && <small>{lead.support}/{lead.denominator}{typeof lead.purity === 'number' ? ` · ${Math.round(lead.purity * 100)}%` : ' · purity unknown'}</small>}
          {lead.blockedReason && <small>{leadBlockReason[lead.blockedReason] ?? lead.blockedReason.replaceAll('_', ' ')}</small>}
          {lead.stock && <small>{lead.stock.status === 'available_each_night' ? 'Per-night stock available on each night'
            : lead.stock.status === 'sold_or_restricted' ? 'Some nights sold or restricted' : 'Per-night stock unresolved'}
            {' · '}read {new Date(lead.stock.observedAt).toLocaleString()} · whole-stay availability not confirmed</small>}
        </button>)}
      </div>}
      {allowNone && <button type="button" role="option" aria-selected={!query} disabled={quoteName && applyingName} onMouseDown={event => event.preventDefault()} onClick={() => {
        editVersion.current += 1; const before = editVersion.current;
        if (quoteName) { applyingNameRef.current = true; setApplyingName(true); editor.commands.setUncommitted(path, true); }
        void editor.commands.edit(party ? path : inputPath, null, 'none').then(() => {
          if (editVersion.current === before) { setQuery(''); setDirty(false); setOpen(false); if (catalogueField || quoteName) editor.commands.setUncommitted(path, false); }
        }).catch(() => {
          if (quoteName && editVersion.current === before) { setDirty(false); editor.commands.setUncommitted(path, false); }
        }).finally(() => { if (quoteName) { applyingNameRef.current = false; setApplyingName(false); } });
      }}>None</button>}
      {shown.map((row, index) => <button id={`${id}-option-${index}`} key={`${row.ref}:${row.value}`} type="button" role="option" disabled={quoteName && applyingName} aria-selected={entity ? selectedRef === row.ref : saved === row.value}
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
      {quoteName && choices.length > 0 && !shown.length && !loading && <small>No matching Infor profiles. Use the typed name on the quote or search again.</small>}
      {!choices.length && !loading && !lookupError && <small>{trackScopeChanged ? 'The stay selection changed. Refresh Infor choices.'
        : amendTrack && trackReady ? 'No common Track choices for the selected stays.'
        : quoteName && query.trim() ? 'No Infor profiles returned. Use the typed name on the quote or search again.'
        : entity ? 'Enter a name to find Infor matches.' : 'No Infor choices loaded yet.'}</small>}
      {!entity && ['room_type', 'room_type_for_charge', 'rate_plan'].includes(choiceKind ?? '') && <small>Hotel codes and meanings. The booking check verifies prices and availability for these dates and guests.</small>}
      <button type="button" disabled={loading || (quoteName && applyingName)} onMouseDown={event => event.preventDefault()} onClick={() => { void loadChoices(); }}>{lookupError ? 'Retry Infor' : entity ? 'Search Infor' : 'Refresh Infor choices'}</button>
    </div>}
  {open && catalogueSearch !== null && <small>Searching {catalogueSearch}. Select an Infor rate to apply it.</small>}
  {party && !dirty && !open && selectedChoice && selectedChoice.label !== saved && <small>Selected: {selectedChoice.label}</small>}
  {dirty ? amendTrack ? <small>Select an Infor match. <button type="button" disabled={editor.view.busy} onClick={() => {
      editVersion.current += 1; setQuery(saved); setDirty(false); setOpen(false); editor.commands.setUncommitted(path, false);
    }}>Cancel search</button></small> : <small>{quoteName ? 'Unsaved name' : 'Unsaved search'}</small>
    : amendTrack && typeof savedValue === 'string' && saved ? <small>Select an Infor match for this requested Track.</small>
    : entity && !selectedRef && query && !quoteName ? <small>Select an Infor match</small> : null}
    {quoteName && !dirty && query.trim() && <small>{selectedChoice ? `Infor profile selected: ${selectedChoice.label}.`
      : selectedRef ? 'The selected Infor profile needs checking.' : 'Quote name only. Public rates apply unless another verified profile is selected.'}</small>}
    {staleIdentity && <small role="alert">The selected Infor match changed. Choose a current match or search again.</small>}
    {staleCode && <small role="alert">This code was not returned by the latest Infor choices. Choose a current code or refresh.</small>}{hint && <small>{hint}</small>}
    {autoTransfer && (!dirty || normalized(query) === normalized(saved)) && <small role="note" className={styles.memoryBadge}>History: Auto Transfer was recorded on {autoTransfer.support} of {autoTransfer.denominator} earlier stays for this {autoTransfer.partyKind === 'organization' ? 'organization' : 'A/R account'}. Check the current Infor setting.</small>}</div>
    {suggestion ? <AutopickPanel editor={editor} suggestion={suggestion} selectionPath={selectionPath} label={label}
      changed={staffSet}
      onChoose={chooseSuggested} disabled={disabled || dirty} onPendingChange={pending => { setReviewing(pending); if (pending) setOpen(false); }} />
      : compact && <FieldReview editor={editor} path={path} label={label} disabled={amendTrack && dirty} onPendingChange={pending => { setReviewing(pending); if (pending) setOpen(false); }} />}</div>;
}
