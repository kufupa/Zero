const string = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object' as const, properties, required, additionalProperties: false,
});

export const schemas = {
  hms_search_reservations: object({
    property_code: string,
    criteria: object({
      reservation_id: string,
      guest_name: { ...string, description: 'Guest surname, or voucher name SURNAME/FIRST to search both name orders. Preserve the full compound surname when known.' },
      guest_first_name: { ...string, description: 'Given name, if available, used as an alternate surname when the first surname search is empty.' },
      guest_name_is_surname: { type: 'boolean', description: 'Required true for a surname containing spaces, and only when the source identifies the entire value as the surname (e.g. De Koker).' },
      arrival_date: string,
      departure_date: string,
    }, []),
  }, ['property_code', 'criteria']),
  hms_read_reservation: object({
    property_code: string,
    reservation_id: string,
    arrival_date: { ...string, format: 'date', description: 'Known arrival (YYYY-MM-DD); scopes the native lookup to this date.' },
    departure_date: { ...string, format: 'date', description: 'Known departure (YYYY-MM-DD); verify it against the native stay.' },
    last_name: { ...string, description: 'Exact guest surname only, including all words in a compound surname.' },
  }, ['property_code', 'reservation_id']),
  hms_read_catalogue: object({ property_code: string, arrival_date: { ...string, format: 'date' }, departure_date: { ...string, format: 'date' }, kinds: { type: 'array', minItems: 1,
    items: { type: 'string', enum: ['room_type', 'rate_plan', 'meal_plan', 'source_of_business', 'track', 'guarantee_type', 'organization', 'agency'] } } }, ['property_code', 'kinds']),
  hms_search_parties: object({ property_code: string,
    kind: { type: 'string', enum: ['guest', 'organization', 'agency', 'ar_account'] },
    field: { type: 'string', enum: ['last_name', 'first_name', 'email', 'phone', 'profile_id', 'name'] },
    query: string,
    sender_host: { ...string, description: 'From-domain host for party_sender_map lookup (optional).' },
  }, ['property_code', 'kind', 'field']),
};
