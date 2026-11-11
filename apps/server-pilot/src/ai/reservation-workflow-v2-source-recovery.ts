import { createHash } from 'node:crypto';
import { z } from 'zod';
import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Draft } from './reservation-workflow-v2-contract.js';

const roomCandidateSchema = z.object({ code: z.string().regex(/^[A-Z0-9]{1,12}$/), label: z.string().min(1) });

/** Recover source-backed suggestions; booking recovery never changes a native action. */
export function recoverReservationWorkflowV2SourceFields(input: ReservationWorkflowV2Draft): { draft: ReservationWorkflowV2Draft; paths: string[] } | null {
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
    if (request.kind === 'create' && !draft.operationResults.some(row => row.requestId === request.id)) {
      const root = `/proposal/content/requests/${encodeURIComponent(request.id)}/body`;
      const alias = `/proposal/content/requests/${requestIndex}/body`;
      const bookingSlots = [
        { target: request.body.shared, path: `${root}/shared`, alias: `${alias}/shared` },
        ...request.body.dateSections.map((section, index) => ({ target: section.defaults,
          path: `${root}/dateSections/${index}/defaults`, alias: `${alias}/dateSections/${index}/defaults` })),
        ...request.body.allocations.map((allocation, index) => ({ target: allocation.overrides,
          path: `${root}/allocations/${index}/overrides`, alias: `${alias}/allocations/${index}/overrides` })),
      ];
      // Scope checks walk each object and its leaves with one timestamp. A lone
      // field review is a staff decision; that recursive acknowledgement is not.
      const scopeReviewTimes = new Set(bookingSlots.flatMap(slot => {
        const review = draft.staffReviews[slot.path] ?? draft.staffReviews[slot.alias];
        return review?.status === 'accepted' && review.note === null && review.at &&
          Object.entries(draft.staffReviews).some(([path, child]) =>
            [slot.path, slot.alias].some(root => path.startsWith(`${root}/`)) &&
            child.status === 'accepted' && child.note === null && child.at === review.at) ? [review.at] : [];
      }));
      const overlaps = (key: string, path: string, alias: string) =>
        [path, alias].some(target => key === target || key.startsWith(`${target}/`) || target.startsWith(`${key}/`));
      const bookingCovered = (path: string, alias: string) =>
        Object.keys(draft.fieldOverrides).some(key => overlaps(key, path, alias)) ||
        Object.entries(draft.staffReviews).some(([key, review]) => overlaps(key, path, alias) &&
          !(review.status === 'accepted' && review.note === null && review.at && scopeReviewTimes.has(review.at)));
      const invalidateReviews = (path: string, alias: string) => {
        for (const key of Object.keys(draft.staffReviews)) if (overlaps(key, path, alias)) delete draft.staffReviews[key];
      };
      const agencyClaims = extracted.parties.filter(row => row.role === 'agency' && row.name.sourceRefs.includes(currentRef));
      const organizationClaims = extracted.parties.filter(row => row.role === 'organization' && row.name.sourceRefs.includes(currentRef));
      for (const slot of bookingSlots) {
        const organization = slot.target.organization;
        if (!organizationClaims.length && organization && organization.kind !== 'none' && organization.name &&
            !organization.suggestedRef && !organization.candidateRefs.length &&
            agencyClaims.some(row => normal(row.name.value) === normal(organization.name)) &&
            !bookingCovered(`${slot.path}/organization`, `${slot.alias}/organization`)) {
          slot.target.organization = null;
          invalidateReviews(`${slot.path}/organization`, `${slot.alias}/organization`);
          paths.push(`${slot.path}/organization`);
        }
      }
      const hints = extracted.roomTypeHints.filter((claim, index) => typeof claim.value === 'string' && claim.sourceRefs.includes(currentRef) &&
        draft.proposal.sourceClaims.some(row => row.path === `/extraction/requests/${extracted.id}/roomTypeHints/${index}` &&
          row.raw === claim.raw && row.sourceRefs.includes(currentRef)));
      const roomName = (value: unknown) => normal(value).replace(/\s+rooms?$/, '');
      const names = new Set(hints.map(hint => roomName(hint.value)).filter(Boolean));
      const section = request.body.dateSections.length === 1 ? request.body.dateSections[0] : undefined;
      const date = extracted.dates.length === 1 ? extracted.dates[0] : undefined;
      const quantity = extracted.roomCount;
      const sourceScopeMatches = section && date?.arrival?.sourceRefs.includes(currentRef) && date.departure?.sourceRefs.includes(currentRef) &&
        date.arrival.value === section.arrival && date.departure.value === section.departure &&
        quantity?.sourceRefs.includes(currentRef) && quantity.value === request.body.allocations.length &&
        request.body.allocations.length > 0 && request.body.allocations.every(row => row.dateSectionId === section.id);
      if (sourceScopeMatches && names.size === 1 && bookingSlots.every(slot => slot.target.roomType == null &&
          !bookingCovered(`${slot.path}/roomType`, `${slot.alias}/roomType`))) {
        const catalogues = draft.observations.filter(row => row.kind === 'rate_availability' &&
          row.generationId === draft.generationId && row.sourceMessageId === draft.source.messageId &&
          row.propertyCode === draft.propertyCode && row.criteria.workflow === 'create' && row.criteria.requestId === request.id &&
          row.criteria.catalogueKind === 'room_type' && request.body.allocations.some((allocation, index) =>
            row.criteria.allocationId === allocation.id && Array.isArray(row.criteria.fieldPaths) &&
            row.criteria.fieldPaths.includes(`${root}/allocations/${index}/overrides/roomType`)));
        const catalogue = catalogues.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
        const candidates = catalogue?.status === 'complete' && catalogue.coverage.complete && Array.isArray(catalogue.result.candidates) ? catalogue.result.candidates.flatMap(value => {
          const parsed = roomCandidateSchema.safeParse(value);
          return parsed.success && names.has(roomName(parsed.data.label)) ? [parsed.data] : [];
        }) : [];
        if (catalogue && candidates.length === 1 && draft.proposal.annotations.length < 2000 &&
            draft.proposal.sourceClaims.length < 1000) {
          const path = `${root}/shared/roomType`;
          request.body.shared.roomType = candidates[0]!.code;
          invalidateReviews(path, `${alias}/shared/roomType`);
          draft.proposal.annotations.push({ path, basis: 'native_read', evidenceRefs: [currentRef, catalogue.ref] });
          draft.proposal.sourceClaims.push({ path, raw: hints[0]!.raw, sourceRefs: [currentRef] });
          draft.fieldReviewRequirements[path] = { required: true, reasons: ['Matched the requested room to the Infor catalogue; review before continuing.'],
            evidenceRefs: [currentRef, catalogue.ref] };
          paths.push(path);
        }
      }
    }
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
