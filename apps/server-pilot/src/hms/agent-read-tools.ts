/** Model-facing read-tool facade.
 *
 * Inputs are closed and opaque.  The implementation delegates to the trusted
 * executor; it never accepts URLs, selectors, scripts, or PMS record IDs.
 */
import { z } from 'zod';
import {
  reservationContextRequestSchema,
} from './reservation-context-contract.js';
import { executeRead, type ReadExecutionContext } from './read-service.js';
import { readRefSchema } from './read-service-contracts.js';

/** Public tool inputs intentionally omit the dispatcher discriminator. */
export const hmsFindReservationInputSchema = z.object({ candidateId: readRefSchema }).strict();
export const hmsReadReservationInputSchema = reservationContextRequestSchema
  .omit({ toolId: true })
  .strict();
export const agentReadRequestSchema = z.union([hmsFindReservationInputSchema, hmsReadReservationInputSchema]);

export type AgentReadRequest =
  | z.infer<typeof hmsFindReservationInputSchema>
  | z.infer<typeof hmsReadReservationInputSchema>;

export type AgentReadTool = {
  id: 'hms_find_reservation' | 'hms_read_reservation';
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: AgentReadRequest) => ReturnType<typeof executeRead>;
};

export function createAgentReadTools(context: ReadExecutionContext): Readonly<Record<string, AgentReadTool>> {
  return {
    hms_find_reservation: {
      id: 'hms_find_reservation',
      description: 'Find a reservation from a trusted opaque candidate reference.',
      inputSchema: hmsFindReservationInputSchema,
      execute: (input) => hmsFindReservation(context, hmsFindReservationInputSchema.parse(input)),
    },
    hms_read_reservation: {
      id: 'hms_read_reservation',
      description: 'Read entitled reservation sections from a trusted scoped reservation reference.',
      inputSchema: hmsReadReservationInputSchema,
      execute: (input) => hmsReadReservation(context, hmsReadReservationInputSchema.parse(input)),
    },
  };
}

export async function hmsFindReservation(
  context: ReadExecutionContext,
  input: z.input<typeof hmsFindReservationInputSchema>,
) {
  const parsed = hmsFindReservationInputSchema.parse(input);
  return executeRead(context, { toolId: 'hms_find_reservation', candidateId: parsed.candidateId });
}

export async function hmsReadReservation(
  context: ReadExecutionContext,
  input: z.input<typeof hmsReadReservationInputSchema>,
) {
  const parsed = hmsReadReservationInputSchema.parse(input);
  return executeRead(context, { toolId: 'hms_read_reservation', ...parsed });
}
