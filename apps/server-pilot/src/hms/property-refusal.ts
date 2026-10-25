import { TRPCError } from '@trpc/server';

export type PropertyRefusalCode =
  | 'property_unknown'
  | 'property_inactive'
  | 'collector_no_hotel'
  | 'property_required'
  | 'not_set_up';

export class PropertyRefusalCause extends Error {
  constructor(
    readonly code: PropertyRefusalCode,
    readonly transportId?: string,
  ) {
    super(code);
    this.name = 'PropertyRefusalCause';
  }
}

/** One safe, typed refusal for an unresolved, inactive, or non-hotel mailbox. */
export function refuseProperty(refusal: {
  code: PropertyRefusalCode;
  transportId?: string | null;
}): never {
  const cause = new PropertyRefusalCause(refusal.code, refusal.transportId || undefined);
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'This mailbox is not set up for this hotel',
    cause,
  });
}
