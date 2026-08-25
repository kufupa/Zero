export const PITCH_DEMO_SENDER_EMAIL = 'oreratile.naledilm@gmail.com';

export const PITCH_DEMO_DRAFT_SUBJECT =
  'Re: Quotation — Dinner, Bed and Breakfast (26–27 August 2026)';

export const PITCH_DEMO_DRAFT_BODY = `Good day Ms Maruping,

Thank you for your enquiry regarding dinner, bed and breakfast for one (1) guest, check-in 26 August and check-out 27 August 2026.

We are pleased to advise provisional availability for one (1) guest room, subject to final release within forty-eight (48) hours of your written confirmation.

Indicative rate (DBB, single occupancy): ZAR 2,265.00 per night (excl. VAT)
One (1) night: ZAR 2,265.00
VAT (15%): ZAR 339.75
Indicative total: ZAR 2,604.75

Please advise the billing name and address for the formal quotation, as your request noted "Please address it to" without full details.

Amounts are indicative, subject to availability, and this quotation remains valid for 48 hours.

Kind regards,
Reservations
The Centurion — A Legacy Hotel`;

export const PITCH_DEMO_VIDEO_URL = '/demo/hms-rpa-booking.webm';

export const PITCH_DEMO_LOADING_MS = 3000;

type PitchDemoEnv = {
  VITE_PITCH_DEMO?: string;
  PITCH_DEMO?: string;
  VITE_PITCH_DEMO_THREAD_ID?: string;
};

export type { PitchDemoEnv };

export function isPitchDemoEnabled(
  env: PitchDemoEnv = import.meta.env as unknown as PitchDemoEnv,
): boolean {
  const flag = env.VITE_PITCH_DEMO ?? env.PITCH_DEMO;
  return flag === '1' || flag === 'true';
}

export function pitchDemoThreadIdOverride(
  env: PitchDemoEnv = import.meta.env as unknown as PitchDemoEnv,
): string | null {
  const id = env.VITE_PITCH_DEMO_THREAD_ID?.trim();
  return id ? id : null;
}
