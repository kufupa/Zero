const string = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object' as const, properties, required, additionalProperties: false,
});

export const schemas = {
  hms_search_reservations: object({
    property_code: string,
    criteria: object({ reservation_id: string, guest_name: string, arrival_date: string, departure_date: string }, []),
  }, ['property_code', 'criteria']),
  hms_read_reservation: object({ property_code: string, reservation_id: string }, ['property_code', 'reservation_id']),
  hms_read_catalogue: object({ property_code: string, kinds: { type: 'array', minItems: 1,
    items: { type: 'string', enum: ['room_type', 'rate_plan', 'meal_plan', 'source_of_business', 'track', 'guarantee_type', 'organization', 'agency'] } } }, ['property_code', 'kinds']),
  hms_search_parties: object({ property_code: string,
    kind: { type: 'string', enum: ['guest', 'organization', 'agency', 'ar_account'] },
    field: { type: 'string', enum: ['last_name', 'first_name', 'email', 'phone', 'profile_id', 'name'] },
    query: string,
  }, ['property_code', 'kind', 'field', 'query']),
};
