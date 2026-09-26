/**
 * Server-side repository boundary for the immutable mail baseline.
 *
 * Keeping this facade separate from the reducer makes it explicit that
 * dashboard reads can only consume bounded semantic rows; no message body or
 * model invocation belongs on this path.
 */
export {
  MAIL_BASELINE_PROJECTION_QUERY_CAP,
  createMailBaselineProjectionRows,
  persistMailBaselineProjection,
  queryMailBaselineProjection,
  queryMailBaselineProjectionPage,
  reduceProjectedMailBaseline,
  selectMailBaselineGeneration,
  type MailBaselineProjectionQuery,
  type MailBaselineProjectionPage,
  type MailBaselineProjectionRow,
  type MailBaselineProjectionRowInput,
} from './mail-baseline-projection.js';
