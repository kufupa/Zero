/**
 * Operator-only Rocketseed SMTP probe.
 *
 * Importing this module is network-free. Direct CLI execution verifies one
 * authenticated STARTTLS connection, then sends exactly one probe message.
 * Credentials are accepted only from SMTP_PASSWORD or SMTP_SECRET_ARN.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import nodemailer from 'nodemailer';
import { isCliEntry } from '../src/lib/is-cli-entry.js';

export const NAVA_ADDRESS = 'navaai@legacyhotels.co.za';
export const GMAIL_CANARY_ADDRESS = 'aroransh17@gmail.com';

export type RocketseedProbeInput = {
  host: string;
  port: number;
  tlsServername: string;
  authUser: string;
  headerFrom: string;
  envelopeFrom: string;
  recipient: string;
  outboundId: string;
  subjectToken: string;
  mode: 'autonomous-nava' | 'manual';
  includeSyntheticPdf: boolean;
};

type RocketseedProbeTransport = {
  host: string;
  port: number;
  secure: false;
  requireTLS: true;
  auth: {
    user: string;
    pass: string;
  };
  tls: {
    servername: string;
    rejectUnauthorized: true;
  };
};

type RocketseedProbeMessage = {
  from: string;
  to: string[];
  envelope: {
    from: string;
    to: string[];
  };
  subject: string;
  text: string;
  headers: {
    'X-Zero-Mailbox': string;
    'X-Zero-Outbound-Id': string;
  };
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType: 'application/pdf';
  }>;
};

export type RocketseedProbePlan = {
  transport: RocketseedProbeTransport;
  message: RocketseedProbeMessage;
};

export type RocketseedProbeResult = {
  response?: string;
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
};

type RocketseedProbeTransportClient = {
  verify(): Promise<unknown>;
  sendMail(message: RocketseedProbeMessage): Promise<RocketseedProbeResult>;
  close(): void;
};

type RocketseedProbeTransportFactory = (
  options: RocketseedProbeTransport,
) => RocketseedProbeTransportClient;

class ProbeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeConfigurationError';
  }
}

function required(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ProbeConfigurationError(`${label} required`);
  if (/[\r\n]/.test(trimmed)) {
    throw new ProbeConfigurationError(`${label} must not contain line breaks`);
  }
  return trimmed;
}

function generateSyntheticPdf(): Buffer {
  const stream =
    'BT\n/F1 12 Tf\n36 96 Td\n(Zero Rocketseed synthetic probe) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

export function buildRocketseedProbe(
  rawInput: RocketseedProbeInput,
  authSecret: string,
): RocketseedProbePlan {
  const input = {
    ...rawInput,
    host: required('SMTP host', rawInput.host),
    tlsServername: required('TLS server name', rawInput.tlsServername),
    authUser: required('SMTP auth user', rawInput.authUser),
    headerFrom: required('Header From', rawInput.headerFrom),
    envelopeFrom: required('envelope From', rawInput.envelopeFrom),
    recipient: required('recipient', rawInput.recipient),
    outboundId: required('outbound ID', rawInput.outboundId),
    subjectToken: required('subject token', rawInput.subjectToken),
  };
  const secret = authSecret;
  if (!secret.trim()) {
    throw new ProbeConfigurationError(
      'SMTP_PASSWORD or resolved SMTP_SECRET_ARN required',
    );
  }
  if (
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535
  ) {
    throw new ProbeConfigurationError(
      'SMTP port must be an integer from 1 to 65535',
    );
  }

  if (input.mode === 'autonomous-nava') {
    for (const field of [
      'authUser',
      'headerFrom',
      'envelopeFrom',
    ] as const) {
      if (input[field] !== NAVA_ADDRESS) {
        throw new ProbeConfigurationError(
          `autonomous-nava ${field} must be ${NAVA_ADDRESS}`,
        );
      }
    }
    if (
      input.recipient !== NAVA_ADDRESS &&
      input.recipient !== GMAIL_CANARY_ADDRESS
    ) {
      throw new ProbeConfigurationError(
        `autonomous-nava recipient must be ${NAVA_ADDRESS} or ${GMAIL_CANARY_ADDRESS}`,
      );
    }
    if (
      input.recipient === GMAIL_CANARY_ADDRESS &&
      input.includeSyntheticPdf
    ) {
      throw new ProbeConfigurationError(
        'autonomous Gmail canary forbids attachments',
      );
    }
  }

  if (
    input.includeSyntheticPdf &&
    (input.authUser !== NAVA_ADDRESS ||
      input.headerFrom !== NAVA_ADDRESS ||
      input.envelopeFrom !== NAVA_ADDRESS ||
      input.recipient !== NAVA_ADDRESS)
  ) {
    throw new ProbeConfigurationError(
      'synthetic PDF requires Nava auth user, Header From, envelope From, and recipient',
    );
  }

  return {
    transport: {
      host: input.host,
      port: input.port,
      secure: false,
      requireTLS: true,
      auth: {
        user: input.authUser,
        pass: secret,
      },
      tls: {
        servername: input.tlsServername,
        rejectUnauthorized: true,
      },
    },
    message: {
      from: input.headerFrom,
      to: [input.recipient],
      envelope: {
        from: input.envelopeFrom,
        to: [input.recipient],
      },
      subject: `Zero Rocketseed relay probe [${input.subjectToken}]`,
      text: `Synthetic Rocketseed relay probe. Correlation: ${input.outboundId}.`,
      headers: {
        'X-Zero-Mailbox': input.headerFrom,
        'X-Zero-Outbound-Id': input.outboundId,
      },
      attachments: input.includeSyntheticPdf
        ? [
            {
              filename: 'zero-rocketseed-probe.pdf',
              content: generateSyntheticPdf(),
              contentType: 'application/pdf',
            },
          ]
        : undefined,
    },
  };
}

function redactAddress(address: string): string {
  const separator = address.lastIndexOf('@');
  if (separator <= 0 || separator === address.length - 1) return '[redacted]';
  return `${address[0]}***@${address.slice(separator + 1)}`;
}

function redactText(value: string, secret: string): string {
  let redacted = value;
  if (secret) redacted = redacted.split(secret).join('[redacted-secret]');
  redacted = redacted.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    (address) => redactAddress(address),
  );
  return redacted.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function sanitizeMessageId(value: string, secret: string): string {
  const redacted = secret
    ? value.split(secret).join('[redacted-secret]')
    : value;
  return [...redacted]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join('');
}

export function buildRocketseedProbeSummary(
  plan: RocketseedProbePlan,
  result: RocketseedProbeResult,
) {
  const stringifyAddress = (value: unknown) =>
    redactAddress(typeof value === 'string' ? value : String(value));
  const secret = plan.transport.auth.pass;

  return {
    endpoint: {
      host: plan.transport.host,
      port: plan.transport.port,
    },
    tls: {
      mode: 'STARTTLS',
      servername: plan.transport.tls.servername,
      secure: plan.transport.secure,
      requireTLS: plan.transport.requireTLS,
      rejectUnauthorized: plan.transport.tls.rejectUnauthorized,
    },
    identities: {
      authUser: redactAddress(plan.transport.auth.user),
      headerFrom: redactAddress(plan.message.from),
      envelopeFrom: redactAddress(plan.message.envelope.from),
      recipient: redactAddress(plan.message.envelope.to[0] ?? ''),
    },
    response: redactText(result.response ?? '', secret),
    accepted: (result.accepted ?? []).map(stringifyAddress),
    rejected: (result.rejected ?? []).map(stringifyAddress),
    messageId: sanitizeMessageId(result.messageId ?? '', secret),
  };
}

export async function executeRocketseedProbe(
  plan: RocketseedProbePlan,
  createTransport: RocketseedProbeTransportFactory = (options) =>
    nodemailer.createTransport(options),
) {
  const transporter = createTransport(plan.transport);
  try {
    await transporter.verify();
    const result = await transporter.sendMail(plan.message);
    return buildRocketseedProbeSummary(plan, result);
  } finally {
    transporter.close();
  }
}

export function extractSmtpSecretValue(secretString: string): string {
  if (!secretString.trim()) {
    throw new ProbeConfigurationError('SMTP secret is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    return secretString;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return secretString;
  }
  const record = parsed as Record<string, unknown>;
  const candidate =
    typeof record.SMTP_PASSWORD === 'string'
      ? record.SMTP_PASSWORD
      : typeof record.password === 'string'
        ? record.password
        : undefined;
  if (candidate === undefined) return secretString;
  if (!candidate.trim()) {
    throw new ProbeConfigurationError('SMTP secret is empty');
  }
  return candidate;
}

async function resolveSmtpSecret(env: NodeJS.ProcessEnv): Promise<string> {
  const direct = env.SMTP_PASSWORD;
  if (direct?.trim()) return direct;

  const secretArn = env.SMTP_SECRET_ARN?.trim();
  if (!secretArn) {
    throw new ProbeConfigurationError(
      'SMTP_PASSWORD or SMTP_SECRET_ARN required',
    );
  }
  const { GetSecretValueCommand, SecretsManagerClient } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({
    region: env.AWS_REGION ?? 'af-south-1',
  });
  try {
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!response.SecretString) {
      throw new ProbeConfigurationError('SMTP secret is empty');
    }
    return extractSmtpSecretValue(response.SecretString);
  } finally {
    client.destroy();
  }
}

function readCliInput(argv: string[], env: NodeJS.ProcessEnv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'tls-servername': { type: 'string' },
      'auth-user': { type: 'string' },
      'header-from': { type: 'string' },
      'envelope-from': { type: 'string' },
      recipient: { type: 'string' },
      'outbound-id': { type: 'string' },
      'subject-token': { type: 'string' },
      mode: { type: 'string' },
      'include-synthetic-pdf': { type: 'boolean', default: false },
    },
  });
  const mode = values.mode ?? env.ROCKETSEED_PROBE_MODE ?? '';
  if (mode !== 'autonomous-nava' && mode !== 'manual') {
    throw new ProbeConfigurationError(
      'mode must be autonomous-nava or manual',
    );
  }

  return {
    host: values.host ?? env.SMTP_HOST ?? '',
    port: Number(values.port ?? env.SMTP_PORT ?? '587'),
    tlsServername:
      values['tls-servername'] ?? env.SMTP_TLS_SERVERNAME ?? '',
    authUser: values['auth-user'] ?? env.SMTP_USER ?? '',
    headerFrom:
      values['header-from'] ?? env.ROCKETSEED_HEADER_FROM ?? '',
    envelopeFrom:
      values['envelope-from'] ?? env.ROCKETSEED_ENVELOPE_FROM ?? '',
    recipient: values.recipient ?? env.ROCKETSEED_RECIPIENT ?? '',
    outboundId:
      values['outbound-id'] ?? env.ROCKETSEED_OUTBOUND_ID ?? randomUUID(),
    subjectToken:
      values['subject-token'] ?? env.ROCKETSEED_SUBJECT_TOKEN ?? '',
    mode,
    includeSyntheticPdf: values['include-synthetic-pdf'],
  } satisfies RocketseedProbeInput;
}

async function main(): Promise<void> {
  const input = readCliInput(process.argv.slice(2), process.env);
  const secret = await resolveSmtpSecret(process.env);
  const plan = buildRocketseedProbe(input, secret);
  const summary = await executeRocketseedProbe(plan);
  console.log(JSON.stringify(summary));
}

function safeFailure(error: unknown): string {
  if (error instanceof ProbeConfigurationError) return error.message;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    command?: unknown;
    responseCode?: unknown;
  };
  return JSON.stringify({
    error: 'Rocketseed probe failed',
    name:
      typeof candidate?.name === 'string'
        ? candidate.name.slice(0, 80)
        : 'Error',
    code:
      typeof candidate?.code === 'string' &&
      /^[A-Z0-9_-]{1,40}$/i.test(candidate.code)
        ? candidate.code
        : undefined,
    command:
      typeof candidate?.command === 'string' &&
      /^[A-Z0-9_-]{1,40}$/i.test(candidate.command)
        ? candidate.command
        : undefined,
    responseCode:
      typeof candidate?.responseCode === 'number'
        ? candidate.responseCode
        : undefined,
  });
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(safeFailure(error));
    process.exitCode = 1;
  });
}
