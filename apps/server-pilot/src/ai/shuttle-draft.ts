export type ShuttleProviderConfig = {
  provider: string;
  to: string[];
};

export type ShuttleTransferDetails = {
  serviceDate: string;
  pickupLocation: string;
  dropoffLocation: string;
  pickupTime: string;
  flight: string;
  passengers: string;
  bookingReference: string;
};

export function readShuttleProviderConfig(_raw: unknown): ShuttleProviderConfig | null {
  return null;
}

export function buildShuttleDraftTemplate(
  _config: ShuttleProviderConfig,
  _details: ShuttleTransferDetails,
): { subject: string; html: string; noteText: string } {
  return { subject: '', html: '', noteText: '' };
}
