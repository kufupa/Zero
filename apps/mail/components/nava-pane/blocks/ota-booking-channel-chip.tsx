export function OtaBookingChannelChip({ source }: { source: string }) {
  return (
    <p
      data-testid="ota-booking-channel"
      className="inline-flex w-fit items-center rounded-full border border-[#bfdbfe] bg-[#eff6ff] px-2 py-1 text-[10.5px] font-medium text-[#1d4ed8]"
    >
      {`Booked via ${source}`}
    </p>
  );
}
