'use client';

/** Selection changes are surfaced to the parent so any prepared review can be invalidated. */
export function BatchRoomInclusion({ rooms, included, disabled, onChange }: {
  rooms: ReadonlyArray<{ id: string; label: string }>;
  included: readonly string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const ids = rooms.map((room) => room.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return <p role="alert">Room details need checking before review.</p>;
  }
  const selected = new Set(included);
  return <fieldset disabled={disabled} className="flex flex-col gap-1">
    <legend className="text-xs font-semibold">Rooms to review</legend>
    {rooms.map((room) => <label key={room.id} className="flex items-center gap-2 text-xs">
      <input type="checkbox" disabled={disabled} checked={selected.has(room.id)} onChange={(event) => {
        const next = new Set(selected);
        if (event.target.checked) next.add(room.id); else next.delete(room.id);
        // Preserve manifest order and drop identities that no longer exist.
        onChange(ids.filter((id) => next.has(id)));
      }} />
      <span data-pii>{room.label}</span>
    </label>)}
  </fieldset>;
}
