import { otaBookingChannel as sourceRegistryOtaBookingChannel } from '../../../server-pilot/src/ai/mail-source.js';

/** Read-only OTA attribution backed by the same domain registry as inbound source classification. */
export function otaBookingChannel(input: {
  senderEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
}): string | null {
  return sourceRegistryOtaBookingChannel({
    fromAddress: input.senderEmail,
    subject: input.subject,
    bodyText: input.bodyText,
  });
}
