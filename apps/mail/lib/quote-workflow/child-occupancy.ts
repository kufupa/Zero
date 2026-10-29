/** An absent count is not evidence that the room has no children. */
export function childOccupancyReady(group: {
  childrenPerRoom?: number | null;
  childrenAges: number[];
}): group is { childrenPerRoom: number; childrenAges: number[] } {
  return typeof group.childrenPerRoom === 'number' && Number.isInteger(group.childrenPerRoom) &&
    group.childrenPerRoom >= 0 && group.childrenPerRoom <= 6 &&
    Array.isArray(group.childrenAges) && group.childrenAges.length === group.childrenPerRoom &&
    group.childrenAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17);
}
