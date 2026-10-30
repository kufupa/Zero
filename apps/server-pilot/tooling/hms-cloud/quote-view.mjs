// Add a requested room count to the bounded, private availability view.
import { getAvailabilityView } from './availability-view.mjs';

function sumNightlyValues(nights, verified) {
  const basis = { source: 'hotel_availability_nightly_values', quantityApplied: false,
    quantityBasis: 'unknown', priceBasis: 'unknown', tax: 'unknown', finalTotal: 'unknown' };
  if (!verified || !nights.length) return { outcome: 'unavailable', issue: 'NIGHTS_INCOMPLETE_OR_UNVERIFIED', ...basis };
  const currency = nights[0].price.currency;
  if (typeof currency !== 'string' || !currency.trim() || nights.some((night) => night.price.currency !== currency)) {
    return { outcome: 'unavailable', issue: 'NIGHTLY_CURRENCY_UNVERIFIED', ...basis };
  }
  let hundredths = 0n;
  for (const night of nights) {
    const value = night.price.responseValue;
    if ((typeof value !== 'string' && typeof value !== 'number') ||
        (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100))) {
      return { outcome: 'unavailable', issue: 'NIGHTLY_VALUE_UNSUPPORTED', ...basis };
    }
    const parts = /^(-?)(\d{1,15})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
    if (!parts) return { outcome: 'unavailable', issue: 'NIGHTLY_VALUE_UNSUPPORTED', ...basis };
    const units = BigInt(parts[2]) * 100n + BigInt((parts[3] || '').padEnd(2, '0'));
    hundredths += parts[1] ? -units : units;
  }
  const digits = (hundredths < 0n ? -hundredths : hundredths).toString().padStart(3, '0');
  return { outcome: 'calculated', value: `${hundredths < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`,
    currency, nights: nights.length, ...basis };
}

/** Compare each observed night with the explicit quantity for this room scenario. */
export function getQuoteView(snapshot, { roomQuantity, includeNightlyValueSum = false, ...filters } = {}) {
  if (typeof includeNightlyValueSum !== 'boolean') throw new TypeError('NIGHTLY_SUM_FLAG_INVALID');
  const recorded = snapshot?.requestedCriteria?.roomQuantity;
  if ((roomQuantity != null && (!Number.isSafeInteger(roomQuantity) || roomQuantity < 1)) ||
      (recorded != null && (!Number.isSafeInteger(recorded) || recorded < 1))) {
    throw new RangeError('ROOM_QUANTITY_INVALID');
  }
  if (roomQuantity != null && recorded != null && roomQuantity !== recorded) {
    throw new Error('ROOM_QUANTITY_MISMATCH');
  }
  const quantity = roomQuantity ?? recorded ?? null;
  const view = getAvailabilityView(snapshot, filters);
  const allNightsShown = view.coverage.nights != null && view.scope.nightOffset === 0 &&
    view.coverage.nights.returned === view.coverage.nights.total;
  const criteria = Object.values(view.coverage.checkedCriteriaMatch || {});
  const nightsVerified = allNightsShown && view.coverage.nights?.matchesAppliedCriteria === true &&
    criteria.length > 0 && criteria.every((match) => match === true) &&
    view.coverage.unprojectedRequestedFields === 0 && view.coverage.unprojectedPartyFields === 0 &&
    view.coverage.unprojectedAppliedFields === 0 && view.coverage.observationTimeKnown === true &&
    view.coverage.propertyRows === 1 && view.coverage.unexpectedPropertyRows === 0 &&
    view.coverage.duplicateRateRows === 0 && view.coverage.unexpectedRateRows === 0;
  return {
    ...view,
    roomQuantity: { requested: quantity, gap: quantity == null ? 'ROOM_QUANTITY_UNKNOWN' : null,
      basis: 'one_room_type_per_night', combinedAvailability: 'unknown' },
    options: view.options.map((option) => {
      const nights = option.nights.map((night) => {
        const count = Number.isSafeInteger(night.roomsAvailable) && night.roomsAvailable >= 0 ? night.roomsAvailable : null;
        const observedShortfall = quantity != null && count != null ? Math.max(0, quantity - count) : null;
        const status = quantity == null ? 'quantity_unknown' : observedShortfall == null ? 'inventory_unknown'
          : observedShortfall > 0 ? (night.reasons.includes('unknown') ? 'shortfall_unverified' : 'shortfall')
            : night.reasons.includes('unknown') ? 'evidence_unverified' : 'count_sufficient';
        return { ...night, roomQuantity: { requested: quantity, observedShortfall, status } };
      });
      const status = quantity == null ? 'quantity_unknown' : nights.some((night) => night.roomQuantity.status === 'shortfall')
        ? 'shortfall' : nights.some((night) => night.roomQuantity.status === 'shortfall_unverified')
          ? 'shortfall_unverified' : !nights.length || nights.some((night) => night.roomQuantity.status !== 'count_sufficient')
            ? 'unknown' : !allNightsShown ? 'partial' : 'count_sufficient';
      return { ...option, roomQuantity: { requested: quantity, status, allNightsShown }, nights,
        ...(includeNightlyValueSum ? { nightlyValueSum: sumNightlyValues(nights, nightsVerified) } : {}) };
    }),
  };
}
