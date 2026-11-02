'use client';

import { useRef, useState } from 'react';
import { PrimaryButton, SecondaryButton } from '@/components/nava-pane/pane-ui';
import { rowRoomLabel } from '@/lib/quote-workflow/room-types';
import type { BatchReview, BatchReviewInput, BatchReviewedRoom, BatchRoomResult, PaneBatchClient } from '@/lib/quote-workflow/pane-batch-booking';
import { BatchBookingEvidence, type ReviewAttempt } from './batch-booking-evidence';
import { BatchRoomInclusion } from './batch-room-inclusion';

function pricedAmountMissing(amount: BatchReviewedRoom['amount']): boolean {
  return (amount.status === 'estimate' || amount.status === 'confirmed') &&
    (!Number.isSafeInteger(amount.minor) || (amount.minor ?? -1) < 0 || !/^[A-Z]{3}$/.test(amount.currency ?? '') ||
      !['room_night', 'room_stay'].includes(amount.basis ?? '') || !['included', 'excluded', 'unknown'].includes(amount.tax ?? ''));
}

function amountLabel(amount: BatchReviewedRoom['amount']): string {
  if (amount.status === 'unknown' || amount.status === 'unavailable' || pricedAmountMissing(amount)) {
    const quoted = Number.isSafeInteger(amount.minor) && (amount.minor ?? -1) >= 0
      ? ` (quoted ${amount.currency ?? 'currency unknown'} ${(amount.minor! / 100).toFixed(2)})` : '';
    return `Amount unavailable${quoted}`;
  }
  return `${amount.status === 'estimate' ? 'Estimate' : 'Amount'} ${amount.currency} ${(amount.minor! / 100).toFixed(2)} · ${amount.basis} · tax ${amount.tax}`;
}

/** The client is supplied only by the authenticated batch-capability route, on both pane hosts. */
export function BatchBookingReview({ client, input, missing, onLock }: {
  client?: PaneBatchClient; input: BatchReviewInput | null; missing: string[]; onLock: (locked: boolean) => void;
}) {
  const [review, setReview] = useState<BatchReview | null>(null);
  const [reviewKey, setReviewKey] = useState('');
  const [reviewGeneration, setReviewGeneration] = useState(-1);
  const [runId, setRunId] = useState<string | null>(null);
  const [results, setResults] = useState<BatchRoomResult[] | null>(null);
  const [reviewAttempts, setReviewAttempts] = useState<Record<string, ReviewAttempt>>({});
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const readSequence = useRef(0);
  const approvedRoomIds = useRef<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [approvalStarted, setApprovalStarted] = useState(false);
  const [error, setError] = useState('');
  const [excluded, setExcluded] = useState<{ source: string; ids: string[] }>({ source: '', ids: [] });
  const sourceKey = JSON.stringify(input?.source ?? null);
  const excludedIds = new Set(excluded.source === sourceKey ? excluded.ids : []);
  const selectedInput = input ? { ...input, rooms: input.rooms.filter((room) => !excludedIds.has(room.allocationId)) } : null;
  const inputIds = input?.rooms.map((room) => room.allocationId) ?? [];
  const sourceIds = selectedInput?.rooms.map(({ identity }) => JSON.stringify([identity?.stayId, identity?.rowId, identity?.roomIndex])) ?? [];
  const identitiesValid = inputIds.every((id) => typeof id === 'string' && Boolean(id.trim())) && new Set(inputIds).size === inputIds.length &&
    (selectedInput?.rooms.every(({ identity }) => /^[A-Za-z0-9_-]{1,40}$/.test(identity?.stayId ?? '') &&
      /^[A-Za-z0-9_-]{1,40}$/.test(identity?.rowId ?? '') && Number.isInteger(identity?.roomIndex) &&
      identity.roomIndex >= 1 && identity.roomIndex <= 999) ?? false) && new Set(sourceIds).size === sourceIds.length;
  const countValid = !!selectedInput && selectedInput.rooms.length >= 2 && selectedInput.rooms.length <= 8;
  const currentKey = JSON.stringify({ input, missing, selectedIds: selectedInput?.rooms.map((room) => room.allocationId) ?? [] });
  const keyRef = useRef(currentKey);
  const editGeneration = useRef(0);
  if (keyRef.current !== currentKey) editGeneration.current += 1;
  keyRef.current = currentKey;
  // Editing and then restoring the old values still requires a new server review.
  const fresh = review && reviewKey === currentKey && reviewGeneration === editGeneration.current ? review : null;
  const labEligible = selectedInput?.propertyCode === 'HRCEN' && selectedInput.rooms.every(({ stay }) =>
    stay.firstName === 'Proof' && stay.lastName === 'Labtest' && stay.arrival >= '2027-01-01' && stay.confirmationSendMail === false);
  const eligible = labEligible && identitiesValid && countValid;
  const missingPricedAmount = fresh?.rooms.some((room) => pricedAmountMissing(room.amount)) ?? false;
  const safeResults = (rooms: BatchRoomResult[]) => rooms.map((room) => room.status === 'confirmed' &&
    (!room.confirmation || room.screenshotRecorded !== true || room.readbackRecorded !== true || !room.attempt?.runId ||
      !/^[a-f0-9]{64}$/.test(room.attempt?.childId ?? '') || rooms.filter((item) => item.allocationId === room.allocationId).length !== 1 ||
      rooms.filter((item) => item.status === 'confirmed' && item.attempt?.childId === room.attempt?.childId).length !== 1 ||
      rooms.filter((item) => item.status === 'confirmed' && item.confirmation === room.confirmation).length !== 1)
      ? { ...room, status: 'uncertain' as const } : room);
  const acceptResults = (result: Awaited<ReturnType<PaneBatchClient['read']>>, workItemId: string, expectedRunId: string, sequence: number) => {
    if (result.workItemId !== workItemId || result.runId !== expectedRunId || !Array.isArray(result.rooms) || !approvedRoomIds.current.length) throw new Error('batch_result_mismatch');
    const expected = approvedRoomIds.current;
    const safe = safeResults(result.rooms);
    const incomplete = result.complete !== true || safe.some((room) => !expected.includes(room.allocationId)) ||
      expected.some((id) => safe.filter((room) => room.allocationId === id).length !== 1);
    setResults(expected.map((id) => {
      const matches = safe.filter((room) => room.allocationId === id);
      if (matches.length !== 1 || (result.complete !== true && matches[0]!.status !== 'confirmed')) {
        return { allocationId: id, status: 'uncertain' as const };
      }
      return matches[0]!;
    }));
    if (incomplete) setError('Some booking results are incomplete. Check HMS before trying again.');
    setRefreshEpoch(sequence);
  };

  async function prepare() {
    if (!client || !selectedInput || !eligible || busy) return;
    const selected = selectedInput;
    const key = currentKey;
    const generation = editGeneration.current;
    setBusy(true); setError(''); setReview(null);
    try {
      const next = await client.prepare(selected);
      if (keyRef.current !== key || editGeneration.current !== generation) return;
      const sameSource = JSON.stringify(next.source) === JSON.stringify(selected.source);
      const ids = selected.rooms.map((room) => room.allocationId);
      if (!sameSource || !Array.isArray(next.blockers) || next.propertyCode !== selected.propertyCode || next.rooms.length !== ids.length ||
          next.rooms.some((room, index) => room.allocationId !== ids[index] || room.cmsSend !== false ||
            room.identity?.stayId !== selected.rooms[index]?.identity.stayId || room.identity?.rowId !== selected.rooms[index]?.identity.rowId ||
            room.identity?.roomIndex !== selected.rooms[index]?.identity.roomIndex ||
            room.guest.firstName !== 'Proof' || room.guest.lastName !== 'Labtest')) throw new Error('invalid_review');
      setReview(next); setReviewKey(key); setReviewGeneration(generation);
    } catch { setError('Nava could not prepare these rooms. Nothing was saved.'); }
    finally { setBusy(false); }
  }

  async function approve() {
    if (!client || !fresh || !selectedInput || !eligible || busy || missing.length > 0 || missingPricedAmount || fresh.blockers.length > 0 || fresh.batchLimit === null || fresh.batchLimit < selectedInput.rooms.length ||
        !Number.isFinite(Date.parse(fresh.expiresAt)) || Date.parse(fresh.expiresAt) <= Date.now()) return;
    approvedRoomIds.current = fresh.rooms.map((room) => room.allocationId);
    setBusy(true); setApprovalStarted(true); onLock(true); setError('');
    try {
      const queued = await client.approve({ workItemId: selectedInput.source.workItemId, reviewId: fresh.reviewId, manifestDigest: fresh.manifestDigest });
      if (!queued.runId) throw new Error('batch_run_missing');
      setRunId(queued.runId);
      const sequence = ++readSequence.current;
      const result = await client.read({ workItemId: selectedInput.source.workItemId, runId: queued.runId });
      acceptResults(result, selectedInput.source.workItemId, queued.runId, sequence);
    } catch {
      // Approval or dispatch may have reached the server. Do not offer another approval.
      setError('The booking outcome needs checking. Check HMS before trying again.');
    } finally { setBusy(false); }
  }

  async function refresh() {
    if (!client || !input || !runId || busy) return;
    setBusy(true); setError('');
    const sequence = ++readSequence.current;
    try { acceptResults(await client.read({ workItemId: input.source.workItemId, runId }), input.source.workItemId, runId, sequence); }
    catch { setError('Could not read the booking result. Check HMS before trying again.'); }
    finally { setBusy(false); }
  }

  return <div className="flex flex-col gap-2 rounded-xs border border-[#e2e8f0] bg-white p-3">
    <p className="text-xs font-semibold">Multiple rooms</p>
    <p className="text-[11.5px] text-[#475569]">Rooms are booked separately and are not linked in HMS. If one booking needs checking, later rooms will not be attempted.</p>
    {!client ? <p className="text-[11.5px] text-[#475569]">Multi-room booking is not available in Nava yet. Book these rooms in HMS.</p> : null}
    {client && input ? <BatchRoomInclusion
      rooms={input.rooms.map(({ allocationId, stay }, index) => ({ id: allocationId,
        label: `Room ${index + 1} · ${rowRoomLabel({ roomPreference: stay.roomType, quantity: 1 })} · ${stay.firstName} ${stay.lastName}` }))}
      included={selectedInput?.rooms.map((room) => room.allocationId) ?? []} disabled={busy || approvalStarted}
      onChange={(ids) => { const included = new Set(ids); setExcluded({ source: sourceKey, ids: inputIds.filter((id) => !included.has(id)) }); }} /> : null}
    {client && input && !identitiesValid ? <p role="alert">Room details need checking before review.</p> : null}
    {client && input && !countValid ? <p className="text-[11.5px] text-[#475569]">Select between 2 and 8 rooms to review.</p> : null}
    {client && selectedInput && countValid && !labEligible ? <p className="text-[11.5px] text-[#475569]">Multi-room booking is available for test bookings only.</p> : null}
    {missing.length ? <p className="text-[11.5px] text-[#475569]">Needed before review: {missing.join(', ')}.</p> : null}
    {review && !fresh && !runId ? <p role="status" className="text-[11.5px] text-amber-900">Booking details changed. Review again.</p> : null}
    {fresh ? <div data-pii className="flex flex-col gap-2 text-[11.5px] text-[#334155]">
      <p>Hotel {fresh.propertyCode}. HMS confirmation email is off for every test booking.</p>
      {fresh.rooms.map((room) => <div key={room.allocationId} className="border-t border-[#e2e8f0] pt-2">
        <p className="font-semibold">{rowRoomLabel({ roomPreference: room.roomType, quantity: 1 })} · {room.guest.firstName} {room.guest.lastName}</p>
        <p>{room.stay.arrival} – {room.stay.departure} · {room.stay.adults} adults · {room.stay.childAges.length} children{room.stay.childAges.length ? ` (ages ${room.stay.childAges.join(', ')})` : ''}</p>
        <p>Rate {room.ratePlan} · {amountLabel(room.amount)}</p>
        <p>Agency {room.agency?.name ?? 'none'} · Company {room.organization?.name ?? 'none'} · Guarantee {room.guaranteeType}</p>
        {room.sourceOfBusiness ? <p>Source {room.sourceOfBusiness}</p> : null}
        {room.track || room.marketSegment ? <p>Track {room.track ?? 'not set'} · Market segment {room.marketSegment ?? 'not set'}</p> : null}
        <p>Guest opt-in {room.guestOptIn ? 'yes' : 'no'}{room.booker ? ` · Booker ${room.booker.name ?? 'not set'}${room.booker.email ? ` (${room.booker.email})` : ''}` : ''}</p>
        {room.note ? <p>Reservation note: {room.note}</p> : null}
        {results?.filter((item) => item.allocationId === room.allocationId).map((item, index) => <div key={`${item.allocationId}:${index}`}>
          <p>{item.status === 'confirmed' ? `Booked · confirmation ${item.confirmation}` : item.status === 'uncertain' ? 'Outcome needs checking in HMS' : item.status === 'unattempted' ? 'Not attempted' : item.status === 'not_dispatched' ? 'Not sent to HMS' : item.status === 'reconciled_not_booked' ? 'Checked in HMS · not booked' : 'Could not book'}</p>
          {item.status === 'confirmed' && item.attempt && client && input ? <BatchBookingEvidence
            key={`${input.source.workItemId}:${item.attempt.runId}:${item.attempt.childId}`}
            client={client} batchRunId={runId!} allocationId={item.allocationId}
            scope={{ workItemId: input.source.workItemId, runId: item.attempt.runId, childId: item.attempt.childId }}
            reviewed={item.reviewed} refreshEpoch={refreshEpoch} currentReadSequence={() => readSequence.current}
            pending={reviewAttempts[JSON.stringify([input.source.workItemId, item.attempt.runId, item.attempt.childId])]}
            onPending={(attempt) => { const key = JSON.stringify([input.source.workItemId, item.attempt!.runId, item.attempt!.childId]); setReviewAttempts((previous) => ({ ...previous, [key]: attempt })); }}
            onVerified={(verified) => { const key = JSON.stringify([input.source.workItemId, item.attempt!.runId, item.attempt!.childId]); setReviewAttempts((previous) => previous[key] ? ({ ...previous, [key]: { ...previous[key]!, verified } }) : previous); }} /> : null}
        </div>)}
      </div>)}
      {fresh.blockers.length ? <p>Some booking details are not yet supported. Check HMS before approving.</p> : null}
      {missingPricedAmount ? <p>Amount unavailable. Check the price before approving.</p> : null}
      {fresh.batchLimit === null ? <p>Booking time is not yet known. Approval is unavailable.</p> :
        fresh.batchLimit < fresh.rooms.length ? <p>Approval would expire before all rooms could be booked. Review fewer rooms.</p> : null}
    </div> : null}
    {error ? <p role="alert" className="text-[11.5px] text-amber-900">{error}</p> : null}
    {busy ? <p role="status" className="text-[11.5px] text-[#475569]">Nava is checking HMS. This can take more than 30 seconds.</p> : null}
    {client && eligible && input && !approvalStarted && !fresh ? <PrimaryButton disabled={busy || missing.length > 0} onClick={() => void prepare()}>Review these rooms</PrimaryButton> : null}
    {client && eligible && input && !approvalStarted && fresh ? <PrimaryButton disabled={busy || missing.length > 0 || missingPricedAmount || fresh.blockers.length > 0 || fresh.batchLimit === null || fresh.batchLimit < fresh.rooms.length} onClick={() => void approve()}>Approve and book these rooms</PrimaryButton> : null}
    {runId ? <SecondaryButton disabled={busy} onClick={() => void refresh()}>Refresh booking results</SecondaryButton> : null}
  </div>;
}
