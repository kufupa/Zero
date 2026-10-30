// Add a requested room count to the bounded, private availability view.
import { getAvailabilityView } from './availability-view.mjs';

/** Compare each observed night with the explicit quantity for this room scenario. */
export function getQuoteView(snapshot, { roomQuantity, ...filters } = {}) {
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
      return { ...option, roomQuantity: { requested: quantity, status, allNightsShown }, nights };
    }),
  };
}
