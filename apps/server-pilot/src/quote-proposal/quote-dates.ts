export function occupiedDates(arrival: string, departure: string): string[] {
  const parse = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('invalid_calendar');
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== s)
      throw new Error('invalid_calendar');
    return d.valueOf();
  };
  const a = parse(arrival),
    b = parse(departure);
  if (b <= a || b - a > 366 * 86400000) throw new Error('invalid_calendar_order');
  return Array.from({ length: (b - a) / 86400000 }, (_, i) =>
    new Date(a + i * 86400000).toISOString().slice(0, 10),
  );
}
