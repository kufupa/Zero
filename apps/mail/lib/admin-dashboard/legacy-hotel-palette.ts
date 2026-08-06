/**
 * Stable Legacy hotel colour palette — names + colours only, no metrics.
 * Reserved so multi-hotel LIVE wiring later keeps the same swatches.
 */

export const TREND_LINE_COLORS = [
  '#0ea5e9',
  '#16a34a',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#ef4444',
  '#0f766e',
] as const;

export type LegacyHotelPaletteEntry = {
  hotelId: string;
  name: string;
  color: string;
};

/** Demo order from admin-dashboard demo-data — colour index is stable. */
export const LEGACY_HOTEL_PALETTE: readonly LegacyHotelPaletteEntry[] = [
  { hotelId: 'the-leonardo', name: 'The Leonardo', color: TREND_LINE_COLORS[0] },
  {
    hotelId: 'legacy-central-reservations',
    name: 'Legacy Central Reservations',
    color: TREND_LINE_COLORS[1],
  },
  { hotelId: 'davinci-hotel', name: 'Davinci Hotel & Suites', color: TREND_LINE_COLORS[2] },
  { hotelId: 'the-commodore', name: 'The Commodore Hotel', color: TREND_LINE_COLORS[3] },
  { hotelId: 'castleburn', name: 'Castleburn', color: TREND_LINE_COLORS[4] },
  { hotelId: 'bakubung', name: 'Bakubung Bush Lodge', color: TREND_LINE_COLORS[5] },
  { hotelId: 'kwa-maritane', name: 'Kwa Maritane Bush Lodge', color: TREND_LINE_COLORS[6] },
  { hotelId: 'tshukudu', name: 'Tshukudu Bush Lodge', color: TREND_LINE_COLORS[7] },
] as const;

export const SPLIT_THEME = {
  individual: {
    border: 'border-sky-300 dark:border-sky-400/50',
    label: 'text-sky-700 dark:text-sky-200',
    value: 'text-sky-800 dark:text-sky-100',
    bar: 'bg-sky-500',
  },
  group: {
    border: 'border-amber-300 dark:border-amber-400/50',
    label: 'text-amber-700 dark:text-amber-200',
    value: 'text-amber-800 dark:text-amber-100',
    bar: 'bg-amber-500',
  },
  travelAgents: {
    border: 'border-violet-300 dark:border-violet-400/50',
    label: 'text-violet-700 dark:text-violet-200',
    value: 'text-violet-800 dark:text-violet-100',
    bar: 'bg-violet-500',
  },
} as const;
