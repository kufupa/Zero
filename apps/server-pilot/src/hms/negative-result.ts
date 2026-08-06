import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z
  .object({ evidenceId: z.string().uuid(), sha256: digest })
  .strict();

export const negativeResultCertificateV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    verifierVersion: z.string().min(1).max(64),
    candidateSource: evidence,
    surface: evidence,
    nativeRequestDifferential: evidence,
    response: evidence,
    parserConservation: evidence,
    scopeCompleteness: evidence,
    controlPair: evidence,
    candidateExhaustion: evidence,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type NegativeResultCertificateV1 = z.infer<
  typeof negativeResultCertificateV1Schema
>;

export type QuarantinedNegative = {
  status: 'UNVERIFIED_NEGATIVE';
  diagnostic:
    | 'CANDIDATE_EXTRACTION_UNVERIFIED'
    | 'UNVERIFIED_NEGATIVE'
    | 'REQUEST_DRIFT'
    | 'RESPONSE_SCHEMA_DRIFT'
    | 'PARSER_GAP'
    | 'CORRELATION_GAP'
    | 'WINDOW_OR_PAGINATION_MISS'
    | 'ROLE_OR_PROPERTY_SCOPE'
    | 'BLOCKED_NO_CANDIDATE_AFTER_VERIFIED_SOURCE_EXHAUSTION'
    | 'BLOCKED_NO_POSITIVE_CONTROL';
};

/**
 * Module-private brand. Only `validateNegativeResultCertificate` can attach it,
 * so a forged plain `{ status: 'BUSINESS_NOT_FOUND' }` can never be promoted.
 */
const validatedNegativeBrand: unique symbol = Symbol('hms.validatedNegative');

export type ValidatedBusinessNotFound = {
  status: 'BUSINESS_NOT_FOUND';
  certificateSha256: string;
  readonly [validatedNegativeBrand]: true;
};

function isValidatedBusinessNotFound(
  result: ValidatedBusinessNotFound | QuarantinedNegative,
): result is ValidatedBusinessNotFound {
  return (
    result.status === 'BUSINESS_NOT_FOUND' &&
    (result as ValidatedBusinessNotFound)[validatedNegativeBrand] === true
  );
}

/** Unbranded input fails closed to quarantine; it never reaches the model as not_found. */
export function toBusinessNotFoundToolStatus(
  result: ValidatedBusinessNotFound | QuarantinedNegative,
): 'not_found' | 'unverified_negative' {
  return isValidatedBusinessNotFound(result) ? 'not_found' : 'unverified_negative';
}

export async function validateNegativeResultCertificate(input: {
  certificate: unknown;
  certificateSha256: string;
  now?: Date;
  verifyEvidence: (
    gate: Exclude<
      keyof NegativeResultCertificateV1,
      'schemaVersion' | 'verifierVersion' | 'issuedAt' | 'expiresAt'
    >,
    ref: { evidenceId: string; sha256: string },
  ) => Promise<boolean>;
}): Promise<ValidatedBusinessNotFound | QuarantinedNegative> {
  const parsed = negativeResultCertificateV1Schema.safeParse(input.certificate);
  if (!parsed.success || !digest.safeParse(input.certificateSha256).success) {
    return { status: 'UNVERIFIED_NEGATIVE', diagnostic: 'UNVERIFIED_NEGATIVE' };
  }
  const cert = parsed.data;
  const now = (input.now ?? new Date()).getTime();
  if (Date.parse(cert.issuedAt) > now || Date.parse(cert.expiresAt) <= now) {
    return { status: 'UNVERIFIED_NEGATIVE', diagnostic: 'UNVERIFIED_NEGATIVE' };
  }
  const gates = [
    'candidateSource',
    'surface',
    'nativeRequestDifferential',
    'response',
    'parserConservation',
    'scopeCompleteness',
    'controlPair',
    'candidateExhaustion',
  ] as const;
  const diagnostics: QuarantinedNegative['diagnostic'][] = [
    'CANDIDATE_EXTRACTION_UNVERIFIED',
    'ROLE_OR_PROPERTY_SCOPE',
    'REQUEST_DRIFT',
    'RESPONSE_SCHEMA_DRIFT',
    'PARSER_GAP',
    'WINDOW_OR_PAGINATION_MISS',
    'BLOCKED_NO_POSITIVE_CONTROL',
    'BLOCKED_NO_CANDIDATE_AFTER_VERIFIED_SOURCE_EXHAUSTION',
  ];
  for (const [index, gate] of gates.entries()) {
    if (!(await input.verifyEvidence(gate, cert[gate]))) {
      return { status: 'UNVERIFIED_NEGATIVE', diagnostic: diagnostics[index]! };
    }
  }
  return {
    status: 'BUSINESS_NOT_FOUND',
    certificateSha256: input.certificateSha256,
    [validatedNegativeBrand]: true,
  };
}
