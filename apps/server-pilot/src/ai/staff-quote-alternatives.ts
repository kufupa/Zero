export type StaffQuoteRoomAlternative = {
  groupId: string;
  roomCode: string;
  roomLabel: string;
  quantity: number;
};

/** True for markup brackets or C0 control characters, which never belong in an HMS label. */
function hasMarkupOrControl(value: string): boolean {
  return [...value].some((character) => character === '<' || character === '>' || character.codePointAt(0)! <= 0x1f);
}

/** Safe read of HMS alternatives; malformed, duplicate or untrusted labels never reach the pane. */
export function staffQuoteRoomAlternatives(value: unknown): StaffQuoteRoomAlternative[] {
  if (!Array.isArray(value)) return [];
  const result: StaffQuoteRoomAlternative[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const alternative = raw as Record<string, unknown>;
    const { groupId, roomCode, roomLabel, quantity } = alternative;
    if (
      typeof groupId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(groupId) ||
      typeof roomCode !== 'string' || !/^[A-Z0-9_-]{1,16}$/.test(roomCode) ||
      typeof roomLabel !== 'string' || !roomLabel.trim() || roomLabel.length > 120 || hasMarkupOrControl(roomLabel) ||
      !Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100
    ) continue;
    const key = `${groupId}|${roomCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ groupId, roomCode, roomLabel: roomLabel.trim(), quantity: quantity as number });
  }
  return result;
}
