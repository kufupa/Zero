/**
 * Server-side repository boundary for the immutable mail baseline.
 *
 * Keeping this facade separate from the reducer makes it explicit that
 * dashboard reads can only consume bounded semantic rows; no message body or
 * model invocation belongs on this path.
 */
export {
  createMailBaselineProjectionRows,
  persistMailBaselineProjection,
  queryMailBaselineProjection,
  reduceProjectedMailBaseline,
  type MailBaselineProjectionQuery,
  type MailBaselineProjectionRow,
  type MailBaselineProjectionRowInput,
} from './mail-baseline-projection.js';
