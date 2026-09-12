/**
 * Pure projection from a live Guest Stay detail dump (form/network key inventory)
 * into reservation-context section payloads. Never invent keys absent from dump.
 */
export type ReservationDetailDumpV1 = {
  schemaVersion: 1;
  surface: 'guest_stay_detail';
  /** Lowercased field / body / grid keys observed on the detail surface. */
  keys: string[];
  /** Optional known values keyed by dump key (tests/fixtures; live oracle private). */
  values?: Record<string, string | number | null>;
};

const ROOM_TYPE_KEYS = ['roomtype', 'room_type', 'roomtypedisplay', 'rmtype'] as const;
const RATE_PLAN_KEYS = ['rateplan', 'rate_plan', 'rateplandisplay', 'rate'] as const;
const ADULTS_KEYS = ['adults', 'adultcount', 'numberofadults'] as const;
const ROOM_QTY_KEYS = ['roomquantity', 'rooms', 'numberofrooms', 'roomcount'] as const;
const ARRIVAL_KEYS = ['arrivaldate', 'arrival', 'startdate'] as const;
const DEPARTURE_KEYS = ['departuredate', 'departure', 'enddate'] as const;
const STATUS_KEYS = ['status', 'reservationstatus', 'resstatus'] as const;
const CONF_KEYS = ['confirmationnumber', 'confirmation', 'confnumber'] as const;
const EXT_KEYS = ['externalconfirmation', 'externalreference', 'extconfirmation'] as const;

function keySet(dump: ReservationDetailDumpV1): Set<string> {
  return new Set(dump.keys.map((k) => k.toLowerCase()));
}

function firstPresent(
  present: Set<string>,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    if (present.has(alias)) return alias;
  }
  return null;
}

function valueFor(
  dump: ReservationDetailDumpV1,
  aliases: readonly string[],
): string | number | null | undefined {
  const values = dump.values;
  if (!values) return undefined;
  for (const alias of aliases) {
    for (const [k, v] of Object.entries(values)) {
      if (k.toLowerCase() === alias) return v;
    }
  }
  return undefined;
}

export type ProjectedReservationDetailSections = {
  core: {
    status: 'available' | 'partial';
    confirmation?: string | null;
    externalReference?: string | null;
    reservationStatus?: string | null;
  };
  stay: {
    status: 'available' | 'partial';
    arrival?: string | null;
    departure?: string | null;
    roomType?: string | null;
    roomQuantity?: number | null;
    adults?: number | null;
  };
  rates: { status: 'unavailable'; reasonCode: 'SURFACE_UNPROVEN' | 'SOURCE_UNAVAILABLE' };
  policies: { status: 'unavailable'; reasonCode: 'SURFACE_UNPROVEN' | 'SOURCE_UNAVAILABLE' };
  operations: { status: 'unavailable'; reasonCode: 'SURFACE_UNPROVEN' | 'SOURCE_UNAVAILABLE' };
  /** Dump keys used for claims; empty ⇒ do not claim. */
  claimKeys: string[];
};

/**
 * Project dump → section stubs. Rates/policies/operations stay unavailable until
 * a dump proves a dedicated rate/policy surface key family (not invent from find GRID).
 */
export function projectReservationDetailDump(
  dump: ReservationDetailDumpV1,
): ProjectedReservationDetailSections {
  const present = keySet(dump);
  const claimKeys: string[] = [];

  const confKey = firstPresent(present, CONF_KEYS);
  const extKey = firstPresent(present, EXT_KEYS);
  const statusKey = firstPresent(present, STATUS_KEYS);
  const arrivalKey = firstPresent(present, ARRIVAL_KEYS);
  const departureKey = firstPresent(present, DEPARTURE_KEYS);
  const roomTypeKey = firstPresent(present, ROOM_TYPE_KEYS);
  const roomQtyKey = firstPresent(present, ROOM_QTY_KEYS);
  const adultsKey = firstPresent(present, ADULTS_KEYS);
  const ratePlanKey = firstPresent(present, RATE_PLAN_KEYS);

  const confirmation = confKey ? valueFor(dump, CONF_KEYS) : undefined;
  const externalReference = extKey ? valueFor(dump, EXT_KEYS) : undefined;
  const reservationStatus = statusKey ? valueFor(dump, STATUS_KEYS) : undefined;
  const arrival = arrivalKey ? valueFor(dump, ARRIVAL_KEYS) : undefined;
  const departure = departureKey ? valueFor(dump, DEPARTURE_KEYS) : undefined;
  const roomType = roomTypeKey ? valueFor(dump, ROOM_TYPE_KEYS) : undefined;
  const roomQuantityRaw = roomQtyKey ? valueFor(dump, ROOM_QTY_KEYS) : undefined;
  const adultsRaw = adultsKey ? valueFor(dump, ADULTS_KEYS) : undefined;

  if (confKey && confirmation != null && confirmation !== '') claimKeys.push('core.confirmation');
  if (extKey && externalReference != null && externalReference !== '') {
    claimKeys.push('core.externalReference');
  }
  if (statusKey && reservationStatus != null && reservationStatus !== '') {
    claimKeys.push('core.status');
  }
  if (arrivalKey && arrival != null && arrival !== '') claimKeys.push('stay.arrival');
  if (departureKey && departure != null && departure !== '') claimKeys.push('stay.departure');
  if (roomTypeKey && roomType != null && roomType !== '') claimKeys.push('stay.roomType');
  if (roomQtyKey && roomQuantityRaw != null && roomQuantityRaw !== '') {
    claimKeys.push('stay.roomQuantity');
  }
  if (adultsKey && adultsRaw != null && adultsRaw !== '') claimKeys.push('stay.adults');

  // Rate plan on detail may exist as a key; rates *section* still unavailable until
  // nightly rate surface dump proves NightlyRate items (DoD A1 rates).
  void ratePlanKey;

  const corePartial = !confKey || !statusKey;
  const stayPartial = !arrivalKey || !departureKey;

  return {
    core: {
      status: corePartial ? 'partial' : 'available',
      confirmation: confirmation === undefined ? undefined : (confirmation as string | null),
      externalReference:
        externalReference === undefined ? undefined : (externalReference as string | null),
      reservationStatus:
        reservationStatus === undefined ? undefined : (reservationStatus as string | null),
    },
    stay: {
      status: stayPartial ? 'partial' : 'available',
      arrival: arrival === undefined ? undefined : (arrival as string | null),
      departure: departure === undefined ? undefined : (departure as string | null),
      roomType: roomType === undefined ? undefined : (roomType as string | null),
      roomQuantity:
        roomQuantityRaw === undefined || roomQuantityRaw === null || roomQuantityRaw === ''
          ? roomQuantityRaw === null
            ? null
            : undefined
          : Number(roomQuantityRaw),
      adults:
        adultsRaw === undefined || adultsRaw === null || adultsRaw === ''
          ? adultsRaw === null
            ? null
            : undefined
          : Number(adultsRaw),
    },
    rates: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
    policies: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
    operations: { status: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
    claimKeys,
  };
}
