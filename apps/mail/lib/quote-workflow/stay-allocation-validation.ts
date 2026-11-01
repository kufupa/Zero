import type { StayGroupRequirement } from './types';

export type StayTotalMismatch = 'rooms' | 'children' | 'adults';

/** Check explicit stay totals against the per-row allocation before HMS availability or quote calls. */
export function stayTotalMismatch(groups: readonly StayGroupRequirement[]): StayTotalMismatch | null {
  const stays = new Map<string, {
    rooms: Set<number>;
    children: Set<number>;
    adults: Set<number>;
    describedRooms: number;
    describedChildren: number;
    describedAdults: number;
  }>();
  for (const group of groups) {
    const key = group.stayId ?? `${group.arrivalDate}/${group.departureDate}`;
    const counts = stays.get(key) ?? {
      rooms: new Set<number>(), children: new Set<number>(), adults: new Set<number>(),
      describedRooms: 0, describedChildren: 0, describedAdults: 0,
    };
    if (typeof group.roomsTotal === 'number') counts.rooms.add(group.roomsTotal);
    if (typeof group.childrenTotal === 'number') counts.children.add(group.childrenTotal);
    if (typeof group.adultsTotal === 'number') counts.adults.add(group.adultsTotal);
    counts.describedRooms += group.quantity ?? 0;
    counts.describedChildren += (group.quantity ?? 0) * group.childrenAges.length;
    counts.describedAdults += (group.quantity ?? 0) * (group.adults ?? 0);
    stays.set(key, counts);
  }
  for (const counts of stays.values()) {
    if (counts.rooms.size > 1 || (counts.rooms.size === 1 && counts.describedRooms !== [...counts.rooms][0])) return 'rooms';
    if (counts.children.size > 1 || (counts.children.size === 1 && counts.describedChildren !== [...counts.children][0])) return 'children';
    if (counts.adults.size > 1 || (counts.adults.size === 1 && counts.describedAdults !== [...counts.adults][0])) return 'adults';
  }
  return null;
}
