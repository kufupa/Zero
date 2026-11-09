import type { DB } from '../db/client.js';
import type { ReservationNativeCheckBatch } from './reservation-workflow-v2-state.js';

/** Trusted arrival reads use the claimed batch; they have no staff identity. */
export type ReservationWorkflowV2SystemReadContext = {
  system: true;
  db: DB;
  transport: { id: string };
  property: { propertyCode: string };
  nativeBatch: ReservationNativeCheckBatch;
  user?: never;
  recovery?: never;
};
