import { createHash } from 'node:crypto';
import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Draft } from './reservation-workflow-v2-contract.js';

/** Recover omitted source contacts when reopening an old draft, without replacing staff work. */
export function recoverReservationWorkflowV2Contacts(input: ReservationWorkflowV2Draft): { draft: ReservationWorkflowV2Draft; paths: string[] } | null {
  if (!input.extraction || input.extractionGenerationId !== input.generationId ||
      !['complete', 'superseded'].includes(input.prefill?.status ?? '')) return null;
  const currentRef = `src_${createHash('sha256').update(`${input.source.messageId}\u001fmessage\u001f${input.source.messageId}`).digest('hex').slice(0, 12)}`;
  if (!input.observations.some(row => row.kind === 'source' && row.generationId === input.generationId &&
      row.sourceMessageId === input.source.messageId && row.propertyCode === input.propertyCode &&
      ['complete', 'partial'].includes(row.status) && row.sourceRefs.includes(currentRef))) return null;
  const draft = structuredClone(input), paths: string[] = [];
  const normal = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : '';
  const covered = (path: string, alias: string) => [...Object.keys(draft.fieldOverrides), ...Object.keys(draft.staffReviews)]
    .some(key => [path, alias].some(target => key === target || key.startsWith(`${target}/`) || target.startsWith(`${key}/`)));
  for (const [requestIndex, request] of draft.proposal.content.requests.entries()) {
    if (request.kind !== 'create' && request.kind !== 'quote' || draft.operationResults.some(row => row.requestId === request.id &&
        (row.status !== 'prepared' || row.workflow !== request.kind))) continue;
    const candidates = input.extraction.requests.filter(row => row.kind === request.kind && row.requestText.sourceRefs.includes(currentRef));
    const exact = candidates.filter(row => row.id === request.id);
    const text = candidates.filter(row => normal(row.requestText.raw) === normal(request.requestText));
    const linked = exact.length ? exact : text.length ? text : candidates.filter(row => row.requestText.sourceRefs.some(ref => request.sourceRefs.includes(ref)));
    if (linked.length !== 1) continue;
    const extracted = linked[0]!;
    const facts = (field: 'name' | 'email' | 'mobile') => extracted.guests.flatMap((guest, index) => {
      const claim = guest[field];
      const claimPath = `/extraction/requests/${extracted.id}/guests/${index}/${field}`;
      return guest.role === 'booker' && claim && typeof claim.value === 'string' && claim.value.trim() &&
        claim.sourceRefs.includes(currentRef) && draft.proposal.sourceClaims.some(row => row.path === claimPath &&
          row.raw === claim.raw && row.sourceRefs.includes(currentRef)) ? [claim] : [];
    });
    const name = facts('name'), email = facts('email'), mobile = facts('mobile');
    const unique = (claims: typeof name) => new Set(claims.map(claim => normal(claim.value))).size;
    if (unique(name) > 1) continue;
    const target: Record<string, unknown> = request.kind === 'create' ? request.body.shared : request.body.client;
    const suffix = request.kind === 'create' ? 'shared' : 'client';
    const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body/${suffix}`;
    const aliasRoot = `/proposal/content/requests/${requestIndex}/body/${suffix}`;
    const fill = (field: string, claims: typeof name, max: number) => {
      const path = `${root}/${field}`;
      if (unique(claims) !== 1 || covered(path, `${aliasRoot}/${field}`) ||
          target[field] !== undefined && target[field] !== null && target[field] !== '' ||
          draft.proposal.annotations.length >= 2000 || draft.proposal.sourceClaims.length >= 1000) return;
      const claim = claims[0]!;
      if (typeof claim.value !== 'string' || claim.value.length > max) return;
      target[field] = claim.value;
      draft.proposal.annotations.push({ path, basis: 'source', evidenceRefs: [currentRef] });
      draft.proposal.sourceClaims.push({ path, raw: claim.raw, sourceRefs: [currentRef] });
      draft.fieldReviewRequirements[path] = { required: true, reasons: ['Recovered from this email; review before continuing.'], evidenceRefs: [currentRef] };
      paths.push(path);
    };
    if (request.kind === 'quote') { fill('attention', name, 300); fill('email', email, 320); fill('telephone', mobile, 120); }
    else { fill('bookerName', name, 50); fill('bookerContact', mobile.length ? mobile : email, 80); fill('cmsRecipient', email, 255); }
  }
  if (!paths.length) return null;
  const parsed = reservationWorkflowV2DraftSchema.safeParse(draft);
  return parsed.success ? { draft: parsed.data, paths } : null;
}
