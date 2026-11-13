'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { inMailbox } from '@/lib/mail/mail-cache-scope';
import { workItemsFromTrpc, type RecordFieldEventInput } from '@/lib/quote-workflow/backend-bind';
import { rateMoney, rateReason, type RateReply } from '@/lib/quote-workflow/use-amend-rate-candidates';
import type { WorkItemPaneControls } from '@/lib/quote-workflow/use-work-item';
import type { QuoteSession, RatePlanCatalogueEntry, StayGroupRequirement } from '@/lib/quote-workflow/types';
import type { RatePartyEvidence } from './party-picker';
import { HmsAsOf } from './hms-queue-status';

export type PartyEvidence = { organization: RatePartyEvidence | null; bookingAgency: RatePartyEvidence | null };
type CreateContext = { roomIndex: number; rateCode: string; bookingAgency: 'none' | 'selected' | 'unknown';
  organization: 'none' | 'selected' | 'unknown'; contextKey: string; locked: boolean; prepare: () => boolean;
  onContextChange?: () => void };
type Binding = { workItemId: string; source: { threadId: string; messageId: string; sourceHash: string };
  request: { requestId: string; stayId: string; rowId: string; roomIndex: number | null }; expectedSeq: number; expectedExtractionId: string };
type Selection = { kind: 'none'; ratePlan: string | null } | { kind: 'selected';
  bookingAgency: { nativeId: string; name: string; jobId: string } | null;
  organization: { nativeId: string; name: string; jobId: string } | null; ratePlan: string | null };
type SelectionReply = { status: string; requestId: string; previousSeq?: number; seq?: number; revision?: number;
  revisionHead?: number; workItemExtractionId?: string };
type ContextRoute = { mutate: (input: { kind: 'select'; binding: Binding; selection: Selection },
  options: { context: { activeTransportId: string } }) => Promise<SelectionReply> };
type RatesRoute = { mutate: (input: { kind: 'start'; binding: Binding; typedRatePlan?: string; forceRefresh?: boolean } |
  { kind: 'read'; binding: Binding; jobId: string }, options: { context: { activeTransportId: string } }) => Promise<RateReply> };
type View = { key: string; status: 'checking' | 'saving' | 'ready' | 'blocked'; reply?: RateReply; message?: string };

/** A rate read is tied to the selected mail, saved row, party job and revision. */
export function ContextualRateCheck({ group, session, pane, evidence, plans, onChoose, create }: {
  group: StayGroupRequirement; session: QuoteSession; pane: WorkItemPaneControls | null;
  evidence: PartyEvidence; plans: RatePlanCatalogueEntry[]; onChoose?: (code: string) => void;
  create?: CreateContext;
}) {
  const inputId = useId();
  const draft = pane?.rateDraft;
  const queue = pane?.requestDraft;
  const storedRef = pane?.refs[group.id] ?? (group.stayId ? { stayId: group.stayId, rowId: group.id } : undefined);
  const ref = storedRef ? { stayId: storedRef.stayId, rowId: storedRef.rowId ?? `${storedRef.stayId}_row` } : undefined;
  const matches = draft?.snapshot.requests.filter((request) => request.stayId === ref?.stayId &&
    request.action === (create ? 'new_booking' : 'quote_availability') && request.workflow === (create ? 'create' : 'quote') &&
    request.status === 'pending' && request.fields?.kind === (create ? 'create' : 'quote')) ?? [];
  const request = matches.length === 1 ? matches[0] : null;
  const projected = request?.fields?.value as { rows?: Array<{ rowId?: string; ratePlan?: string | null }> } | null;
  const createRooms = create && Array.isArray(request?.fields?.value)
    ? request.fields.value as Array<{ rowId?: string; roomIndex?: number; ratePlan?: string | null }> : [];
  const rows = create ? createRooms.filter((room) => room.rowId === ref?.rowId && room.roomIndex === create.roomIndex)
    : projected?.rows?.filter((row) => row.rowId === ref?.rowId) ?? [];
  const projectedRow = rows.length === 1 ? rows[0] : undefined;
  const source = draft?.snapshot.source;
  const sourceMatches = source && session.staffSource && source.threadId === session.staffSource.threadId &&
    source.messageId === session.staffSource.messageId && source.sourceHash === session.staffSource.sourceHash;
  const client = draft?.trpc as { quoteWorkflow?: { rateContextSelection?: ContextRoute; rateCandidates?: RatesRoute } } | null;
  const usable = Boolean(draft && sourceMatches && request && ref?.rowId && projectedRow &&
    client?.quoteWorkflow?.rateContextSelection?.mutate && client.quoteWorkflow.rateCandidates?.mutate);
  const header = session.staffHeader;
  const key = JSON.stringify([draft?.transportId, draft?.snapshot.workItemId, source, request?.requestId, ref,
    session.binding?.selectionEpoch, request?.fields?.value, session.groups, header.bookingAgency, header.organization, header.parties, evidence,
    create && [create.roomIndex, create.rateCode, create.bookingAgency, create.organization, create.contextKey, create.locked], pane?.historyBusy]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRate = useRef<{ key: string; value: string | null } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const latestCheck = useRef<((forceRefresh: boolean) => Promise<void>) | null>(null);
  latestCheck.current = null;
  useEffect(() => {
    if (!usable) return;
    const scheduled = setTimeout(() => void latestCheck.current?.(false), 500);
    timer.current = scheduled;
    return () => clearTimeout(scheduled);
  }, [key, usable]);
  useEffect(() => () => { generation.current += 1; if (timer.current) clearTimeout(timer.current); }, [key]);
  if (!usable || !draft || !request || !ref?.rowId || !source || !projectedRow) return null;
  const suffix = create ? `rows[${ref.rowId}].rooms[${create.roomIndex}].ratePlan` : `rows[${ref.rowId}].ratePlan`;

  const picked = (kind: 'organization' | 'bookingAgency') => {
    const party = header.parties?.[kind];
    const state = create?.[kind];
    if (state === 'unknown') return { pick: null, error: true };
    if (state === 'none') return { pick: null, error: false };
    if (state === 'selected' && !party) return { pick: null, error: true };
    const name = create ? party?.name ?? '' : (kind === 'organization' ? header.organization : header.bookingAgency).trim();
    if (!party && !name) return { pick: null, error: false };
    const proof = evidence[kind];
    const time = proof ? Date.parse(proof.asOf) : NaN;
    if (!party || !proof || party.nativeId !== proof.nativeId || party.name !== proof.name || name !== party.name ||
        !Number.isFinite(time) || time > Date.now() || Date.now() - time >= 5 * 60_000) return { pick: null, error: true };
    return { pick: { nativeId: proof.nativeId, name: proof.name, jobId: proof.jobId }, error: false };
  };
  const agency = picked('bookingAgency');
  const company = picked('organization');
  const partyMissing = agency.error || company.error;
  const rate = (create?.rateCode ?? group.rateCode ?? projectedRow.ratePlan ?? group.quotedRateCode ?? '').trim().toUpperCase();
  const validRate = !rate || /^[A-Z0-9]{1,12}$/.test(rate);
  const mailbox = inMailbox(draft.transportId);
  const savedRateKey = JSON.stringify([draft.transportId, draft.snapshot.workItemId, source,
    draft.snapshot.revisionSeq, request.requestId, ref.rowId]);

  const persistRate = async (code: string | null, cursor: { seq: number; revision: number; revisionHead: number }, isCurrent: () => boolean) => {
    const known = savedRate.current?.key === savedRateKey
      ? savedRate.current.value : projectedRow.ratePlan ?? null;
    if (known === code) return cursor;
    const mutate = workItemsFromTrpc(draft.trpc).recordEvent?.mutate;
    if (!mutate || !mailbox) return null;
    const input: RecordFieldEventInput = { workItemId: draft.snapshot.workItemId, type: 'field.edit',
      fieldPath: `requests[${request.requestId}].${suffix}`, value: code,
      source: { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash }, expectedSeq: cursor.seq,
      expectedExtractionId: source.extractionId };
    const result = await mutate(input, mailbox) as { seq?: number; revision?: number; revisionHead?: number; workItemExtractionId?: string };
    if (result?.seq !== cursor.seq + 1 || !Number.isSafeInteger(result.revision) || !Number.isSafeInteger(result.revisionHead) ||
        result.workItemExtractionId !== source.extractionId) return null;
    const next = { seq: result.seq, revision: result.revision!, revisionHead: result.revisionHead! };
    draft.onSave(next, cursor.seq, draft.snapshot);
    if (isCurrent()) {
      savedRate.current = { key: savedRateKey, value: code };
    }
    return next;
  };

  const check = async (forceRefresh = true) => {
    if (!rate || partyMissing || !validRate || !mailbox || pane?.historyBusy || create?.locked) return;
    if (timer.current) clearTimeout(timer.current);
    const mine = ++generation.current, startedKey = currentKey.current;
    const active = () => generation.current === mine && currentKey.current === startedKey;
    const fail = (message: string) => { if (active()) setView({ key: startedKey, status: 'blocked', message }); };
    setView({ key: startedKey, status: 'checking' });
    try {
      if (create && !create.prepare()) return fail('Finish the room, guest counts and ages before checking rates.');
      if (queue && projectedRow.ratePlan !== (rate || null) &&
          !queue.record(request.requestId, suffix, rate || null)) {
        return fail('Could not save this rate. Check the draft and try again.');
      }
      let cursor = queue ? await queue.flush() : await draft.flush();
      if (!active()) return;
      if (!cursor) return fail('Save the stay and contact changes before checking rates.');
      if (!queue) cursor = await persistRate(rate || null, cursor, active);
      if (!active()) return;
      if (!cursor) return fail('Could not save this rate. Check the draft and try again.');
      const binding: Binding = { workItemId: draft.snapshot.workItemId,
        source: { threadId: source.threadId, messageId: source.messageId, sourceHash: source.sourceHash },
        request: { requestId: request.requestId, stayId: request.stayId, rowId: ref.rowId!, roomIndex: create?.roomIndex ?? null }, expectedSeq: cursor.seq,
        expectedExtractionId: source.extractionId };
      const selection: Selection = agency.pick || company.pick
        ? { kind: 'selected', bookingAgency: agency.pick, organization: company.pick, ratePlan: rate || null }
        : { kind: 'none', ratePlan: rate || null };
      create?.onContextChange?.();
      const selected = await client!.quoteWorkflow!.rateContextSelection!.mutate({ kind: 'select', binding, selection }, mailbox);
      if (selected.status !== 'recorded' || selected.requestId !== request.requestId || selected.previousSeq !== cursor.seq ||
          typeof selected.seq !== 'number' || (selected.seq !== cursor.seq && selected.seq !== cursor.seq + 1) ||
          selected.workItemExtractionId !== source.extractionId ||
          !Number.isSafeInteger(selected.revision) || !Number.isSafeInteger(selected.revisionHead)) {
        return fail('The stay or company details changed. Check the draft and try again.');
      }
      // An unchanged reply performed no write; it may arrive after another local save.
      if (selected.seq === cursor.seq + 1) {
        draft.onSave({ seq: selected.seq, revision: selected.revision!, revisionHead: selected.revisionHead! }, cursor.seq, draft.snapshot);
      }
      if (!active()) return;
      const rateBinding = { ...binding, expectedSeq: selected.seq };
      let context: string | null = null, polls = 0;
      const receive = async (reply: RateReply): Promise<void> => {
        if (!active()) return;
        if (reply.requestId !== request.requestId || (context && reply.contextKey !== context)) return fail('The rate context changed. Check again.');
        if (reply.status === 'queued' || reply.status === 'running') {
          if (!reply.jobId || !reply.contextKey || ++polls >= 45) return fail('Rates are still being checked. Try again.');
          context = reply.contextKey;
          if (polls >= 8) setView({ key: startedKey, status: 'checking', message: 'HMS is still checking this rate. You can keep editing the stay.' });
          const jobId = reply.jobId;
          timer.current = setTimeout(() => { void client!.quoteWorkflow!.rateCandidates!.mutate({ kind: 'read', binding: rateBinding, jobId }, mailbox)
            .then(receive).catch(() => fail('Rates could not be checked. Try again.')); }, 4000);
          return;
        }
        if (reply.status !== 'ready' || !reply.contextKey || !reply.observedAt || !reply.expiresAt ||
            !Number.isFinite(Date.parse(reply.expiresAt)) || Date.parse(reply.expiresAt) <= Date.now()) {
          return fail(reply.issues[0]?.message ?? 'Rates could not be checked. Try again.');
        }
        setView({ key: startedKey, status: 'ready', reply });
        timer.current = setTimeout(() => fail('These rates have expired. Check again.'), Math.max(0, Date.parse(reply.expiresAt) - Date.now()));
      };
      await receive(await client!.quoteWorkflow!.rateCandidates!.mutate({ kind: 'start', binding: rateBinding,
        typedRatePlan: rate, ...(forceRefresh ? { forceRefresh: true } : {}) }, mailbox));
    } catch { fail('The stay or rate changed. Check the draft and try again.'); }
  };
  latestCheck.current = check;
  const choose = async (code: string) => {
    if (!onChoose || !/^[A-Z0-9]{1,12}$/.test(code)) return;
    const mine = ++generation.current, startedKey = currentKey.current;
    setView({ key: startedKey, status: 'saving' });
    try {
      if (queue && !queue.record(request.requestId, suffix, code)) {
        return setView({ key: startedKey, status: 'blocked', message: 'Could not save this rate. Check the draft and try again.' });
      }
      const cursor = queue ? await queue.flush() : await draft.flush();
      if (generation.current !== mine || currentKey.current !== startedKey) return;
      const saved = queue ? cursor : cursor && await persistRate(code, cursor, () => generation.current === mine && currentKey.current === startedKey);
      if (generation.current !== mine || currentKey.current !== startedKey) return;
      if (!saved) return setView({ key: startedKey, status: 'blocked', message: 'Could not save this rate. Check the draft and try again.' });
      onChoose(code);
      setView(null);
    } catch { if (generation.current === mine && currentKey.current === startedKey)
      setView({ key: startedKey, status: 'blocked', message: 'Could not save this rate. Check the draft and try again.' }); }
  };
  const shown = view?.key === key ? view : null;
  const selected = shown?.reply?.options.find((option) => option.rateCode === rate);
  const catalogueLabel = plans.find((plan) => plan.code === rate)?.name;
  const contextText = [agency.pick ? `Agency: ${agency.pick.name}` : 'No agency',
    company.pick ? `Company: ${company.pick.name}` : 'No company'].join(' · ');
  return <div className="flex flex-col gap-2 rounded-sm border border-[#cbd5e1] bg-white p-2.5">
    <div className="flex flex-wrap items-baseline justify-between gap-1">
      <p className="text-xs font-semibold text-[#334155]">{group.roomPreference || 'Room'} · HMS rate</p>
      {rate ? <span className="text-xs font-semibold text-[#334155]">{rate}</span> : null}
    </div>
    {!create ? <><label htmlFor={inputId} className="text-[11px] font-semibold text-[#475569]">Rate code or name</label>
    <input id={inputId} list={`${inputId}-plans`} className="rounded-sm border border-[#cbd5e1] px-2 py-1 text-xs"
      value={group.rateCode ?? projectedRow.ratePlan ?? group.quotedRateCode ?? ''} disabled={!onChoose || pane?.historyBusy} placeholder="Search code or name"
      onChange={(event) => {
        const value = event.target.value;
        queue?.record(request.requestId, suffix, value.trim() || null, false);
        onChoose?.(value);
      }} onBlur={(event) => {
        const input = event.currentTarget.value.trim();
        const code = plans.find((plan) => plan.code.toUpperCase() === input.toUpperCase());
        const names = plans.filter((plan) => plan.name.toLocaleLowerCase() === input.toLocaleLowerCase());
        const resolved = code?.code ?? (names.length === 1 ? names[0]!.code : input.toUpperCase());
        const valid = !resolved || /^[A-Z0-9]{1,12}$/.test(resolved);
        queue?.record(request.requestId, suffix, resolved || null, valid);
        if (resolved !== input) onChoose?.(resolved);
      }} />
    <datalist id={`${inputId}-plans`}>{plans.map((plan) => <option key={plan.code} value={plan.code} label={`${plan.name} · catalogue label`} />)}</datalist></> : null}
    {rate ? <p className="text-[11px] text-[#64748b]">{selected?.rateLabel ? `${selected.rateLabel} · HMS label`
      : catalogueLabel && catalogueLabel !== rate ? `${catalogueLabel} · catalogue label, meaning not verified in HMS`
      : 'Meaning not yet read from HMS.'}</p> : <p className="text-[11px] text-[#64748b]">Choose or type a rate code to check its current price.</p>}
    {!partyMissing ? <p className="text-[11px] text-[#64748b]">{contextText}</p> : null}
    {partyMissing ? <p className="text-[11px] text-amber-900">Choose the company or agency from a fresh HMS search before checking rates.</p> : null}
    {!validRate ? <p className="text-[11px] text-amber-900">Enter a valid rate code first.</p> : null}
    <button type="button" className="w-fit rounded-sm border border-[#94a3b8] px-2 py-1 text-xs font-semibold disabled:opacity-50"
      disabled={!rate || partyMissing || !validRate || pane?.historyBusy || create?.locked || shown?.status === 'checking' || shown?.status === 'saving'} onClick={() => void check()}>
      {shown?.status === 'checking' ? `Checking ${rate}…` : `Recheck ${rate || 'rate'} in HMS`}
    </button>
    {shown?.status === 'checking' ? <p role="status" className="text-[11px] text-[#64748b]">{shown.message ?? 'Reading the selected rate for this stay…'}</p> : null}
    {shown?.status === 'blocked' ? <p role="status" className="text-[11px] text-amber-900">{shown.message}</p> : null}
    {shown?.status === 'ready' && shown.reply ? <>
      <HmsAsOf asOf={shown.reply.observedAt} />
      <p className="text-[11px] text-[#64748b]">Selected-rate read: {shown.reply.coverage.candidateList}.{shown.reply.coverage.reason ? ` ${shown.reply.coverage.reason}` : ''}</p>
      {shown.reply.recommendation ? <p className="text-[11px] text-[#64748b]">{shown.reply.recommendation.explanation}</p> : null}
      {shown.reply.options.length ? <ul aria-label="Rates from HMS" className="max-h-48 overflow-y-auto">
        {shown.reply.options.map((option) => {
          const nightly = option.price ? rateMoney(option.price.currency, option.price.averagePerNightMinor) : null;
          const total = option.price?.totalBasis === 'native' ? rateMoney(option.price.currency, option.price.totalMinor) : null;
          return <li key={option.id} className="border-t border-[#e2e8f0]">
            <button type="button" className="w-full py-1.5 text-left disabled:opacity-60" disabled={!onChoose || ['unavailable', 'restricted', 'failed'].includes(option.state)}
              onClick={() => void choose(option.rateCode)}>
              <span className="block text-xs font-semibold">{option.rateCode}{option.rateLabel ? ` · ${option.rateLabel}` : ''}</span>
              <span className="block text-[11px] text-[#64748b]">{[option.roomLabel ?? option.roomCode, option.mealPlanLabel,
                option.state === 'unchecked' ? 'Availability needs Prepare' : option.state, nightly ? `${nightly} nightly estimate from HMS` : null,
                total ? `${total} native total` : null].filter(Boolean).join(' · ')}</span>
              <span className="block text-[11px] text-[#64748b]">{option.coverage.nightsObserved}/{option.coverage.nightsExpected} nights checked
                {!option.coverage.eligibilityVerified ? ' · eligibility not verified' : ''}
                {!option.coverage.nativePartyIdsMatched ? ' · company/agency not verified' : ''}
                {option.reasons.length ? ` · ${option.reasons.map(rateReason).join('; ')}` : ''}</span>
            </button>
          </li>;
        })}
      </ul> : <p className="text-[11px] text-[#64748b]">HMS returned no rate options for this check.</p>}
      {create ? <p className="text-[11px] text-[#64748b]">Prepare checks the booking in HMS and shows its final price before Go.</p> : <p className="text-[11px] text-[#64748b]">Nightly estimates do not confirm taxes, totals or rate eligibility. Prepare checks the chosen offer.</p>}
      {shown.reply.issues.map((issue, index) => <p key={`${issue.message}:${index}`} className="text-[11px] text-[#64748b]">{issue.message}</p>)}
    </> : null}
  </div>;
}
