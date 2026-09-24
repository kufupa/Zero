export const getBrowserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const isValidTimezone = (timezone: string): boolean => {
  if (!timezone) return false;
  if (timezone === 'UTC' || timezone === 'Etc/UTC' || timezone === 'GMT') return true;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};
