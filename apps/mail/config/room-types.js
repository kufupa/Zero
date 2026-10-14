export const ROOM_TYPE_NAMES = {
  STWN: 'Standard Twin',
  STQN: 'Standard Queen',
  SKNG: 'Standard King',
  EXKNG: 'Executive King',
  DLXTWN: 'Deluxe Twin',
  DLXQN: 'Deluxe Queen',
  DLXKNG: 'Deluxe King',
  LUXKNG: 'Luxury King',
  SUITE: 'Suite',
};

export const ROOM_WORD_ALIASES = {
  // Low-information bed/occupancy words rank suggestions; they never select by themselves.
  double: ['STQN', 'SKNG', 'EXKNG'],
  single: ['STWN', 'SKNG'],
};
