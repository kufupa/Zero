/**
 * Wave A11 expected-vs-actual compare for mail_parse_channel_payload.
 * Oracle = sanitized fixture ground truth; never invent fields absent from mail bytes.
 */
import type {
  MailParseChannelPayloadActual,
  MailParseChannelPayloadOracle,
} from './channel-payload-contract.js';

export type MailChannelPayloadCompareField =
  | 'channel'
  | 'externalRef'
  | 'stayDates.arrival'
  | 'stayDates.departure'
  | 'guestLabel'
  | 'cardHandleAbsent';

export type MailChannelPayloadCompareRow = {
  field: MailChannelPayloadCompareField;
  expected: string | boolean;
  actual: string | boolean;
  required: boolean;
  pass: boolean;
};

export type MailChannelPayloadCompareV1 = {
  schemaVersion: 1;
  toolId: 'mail_parse_channel_payload';
  allRequiredPass: boolean;
  rows: MailChannelPayloadCompareRow[];
};

function eqString(a: string, b: string): boolean {
  return a === b;
}

export function compareMailChannelPayload(
  oracle: MailParseChannelPayloadOracle,
  actual: MailParseChannelPayloadActual,
): MailChannelPayloadCompareV1 {
  const rows: MailChannelPayloadCompareRow[] = [];

  const push = (
    field: MailChannelPayloadCompareField,
    expected: string | boolean,
    actualValue: string | boolean,
    required: boolean,
    pass: boolean,
  ) => {
    rows.push({ field, expected, actual: actualValue, required, pass });
  };

  push(
    'channel',
    oracle.channel,
    actual.channel,
    true,
    eqString(oracle.channel, actual.channel),
  );
  push(
    'externalRef',
    oracle.externalRef,
    actual.externalRef,
    true,
    eqString(oracle.externalRef, actual.externalRef),
  );
  push(
    'stayDates.arrival',
    oracle.stayDates.arrival,
    actual.stayDates.arrival,
    true,
    eqString(oracle.stayDates.arrival, actual.stayDates.arrival),
  );
  push(
    'stayDates.departure',
    oracle.stayDates.departure,
    actual.stayDates.departure,
    true,
    eqString(oracle.stayDates.departure, actual.stayDates.departure),
  );
  push(
    'guestLabel',
    oracle.guestLabel,
    actual.guestLabel,
    true,
    eqString(oracle.guestLabel, actual.guestLabel),
  );
  push(
    'cardHandleAbsent',
    oracle.cardHandleAbsent,
    actual.cardHandleAbsent,
    true,
    oracle.cardHandleAbsent === actual.cardHandleAbsent,
  );

  return {
    schemaVersion: 1,
    toolId: 'mail_parse_channel_payload',
    allRequiredPass: rows.every((r) => !r.required || r.pass),
    rows,
  };
}
