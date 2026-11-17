export const prepareSchema = {
  type: 'object',
  properties: {
    workflow: { type: 'string', enum: ['cancel'] },
    booking: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        property_code: { type: ['string', 'null'] },
        reservation_id: { type: ['string', 'null'] },
        current_state: { type: ['object', 'null'] },
        fields: { type: 'object' },
      },
      required: ['id', 'property_code', 'reservation_id', 'current_state', 'fields'],
      additionalProperties: false,
    },
    action: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { type: 'string', enum: ['cancel'] },
        booking_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        details: {},
      },
      required: ['id', 'type', 'booking_ids', 'details'],
      additionalProperties: false,
    },
  },
  required: ['workflow', 'booking', 'action'],
  additionalProperties: false,
} satisfies { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };

export const toolName = 'hms_cancel_preflight';
