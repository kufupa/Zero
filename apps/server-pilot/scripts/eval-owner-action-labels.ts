import { pathToFileURL } from 'node:url';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createDb, type DB } from '../src/db/client.js';
import { mailActionLabel, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { MAIL_ACTIONS, type MailAction } from '../src/mail/action-labels.js';

export const MONEY_ACTIONS = ['quote_availability', 'new_booking', 'amend', 'cancel'] as const;
export type MoneyAction = (typeof MONEY_ACTIONS)[number];
export const PRECISION_BAR = 0.95;
const HELDOUT_FRACTION = 0.2;

export type OwnerGoldCase = {
  id: string;
  messageId: string;
  ownerAction: MailAction;
  predictedAction: MailAction | null;
  updatedAt: Date;
};

export type OwnerGoldHeldOutRow = {
  messageId: string;
  owner: MailAction;
  predicted: MailAction | null;
  miss: boolean;
};

export type OwnerGoldEval = {
  ownerRows: number;
  heldOutRows: number;
  coverage: number;
  missingPredictions: number;
  moneyPrecision: Record<MoneyAction, number>;
  meetsBar: Record<MoneyAction, boolean>;
  bar: number;
  heldOut: OwnerGoldHeldOutRow[];
};

const ratio = (numerator: number, denominator: number) => (denominator ? numerator / denominator : 0);

function asMailAction(value: string | null | undefined): MailAction | null {
  return value && (MAIL_ACTIONS as readonly string[]).includes(value) ? (value as MailAction) : null;
}

export function parseOwnerGoldEvalArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { transportId?: string } {
  const values = new Map<string, string>();
  const invalid = () => new Error('Invalid eval options');
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key !== '--transport' || values.has(key)) throw invalid();
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw invalid();
    values.set(key, value);
  }
  const transportId = values.get('--transport') ?? env.HMS_MAILBOX_TRANSPORT_ID?.trim();
  return transportId ? { transportId } : {};
}

export function splitOwnerGoldHeldOut<T extends { id: string; updatedAt: Date }>(
  rows: readonly T[],
): { train: T[]; heldOut: T[] } {
  const sorted = [...rows].sort((left, right) => {
    const delta = left.updatedAt.getTime() - right.updatedAt.getTime();
    return delta !== 0 ? delta : left.id.localeCompare(right.id);
  });
  const heldOutCount = Math.floor(sorted.length * HELDOUT_FRACTION);
  const splitAt = sorted.length - heldOutCount;
  return { train: sorted.slice(0, splitAt), heldOut: sorted.slice(splitAt) };
}

export function computeOwnerGoldMetrics(rows: readonly OwnerGoldCase[]): OwnerGoldEval {
  const { heldOut } = splitOwnerGoldHeldOut(rows);
  const moneyPrecision = Object.fromEntries(
    MONEY_ACTIONS.map((action) => {
      const predicted = heldOut.filter((row) => row.predictedAction === action).length;
      const truePositive = heldOut.filter(
        (row) => row.ownerAction === action && row.predictedAction === action,
      ).length;
      return [action, ratio(truePositive, predicted)];
    }),
  ) as Record<MoneyAction, number>;

  return {
    ownerRows: rows.length,
    heldOutRows: heldOut.length,
    coverage: ratio(
      heldOut.filter((row) => row.predictedAction != null).length,
      heldOut.length,
    ),
    missingPredictions: heldOut.filter((row) => row.predictedAction == null).length,
    moneyPrecision,
    meetsBar: Object.fromEntries(
      MONEY_ACTIONS.map((action) => [action, moneyPrecision[action] >= PRECISION_BAR]),
    ) as Record<MoneyAction, boolean>,
    bar: PRECISION_BAR,
    heldOut: heldOut.map((row) => ({
      messageId: row.messageId,
      owner: row.ownerAction,
      predicted: row.predictedAction,
      miss: row.predictedAction !== row.ownerAction,
    })),
  };
}

/** Latest succeeded inbound payload.action per owner gold message. Ids and classes only. */
export async function selectOwnerGoldCases(
  db: DB,
  options: { transportId?: string } = {},
): Promise<OwnerGoldCase[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const ownerFilters = [eq(mailActionLabel.source, 'owner'), eq(mailActionLabel.version, 'owner')];
    if (options.transportId) ownerFilters.push(eq(mailActionLabel.transportId, options.transportId));

    const owners = await tx
      .select({
        id: mailActionLabel.id,
        messageId: mailActionLabel.messageId,
        ownerAction: mailActionLabel.action,
        updatedAt: mailActionLabel.updatedAt,
      })
      .from(mailActionLabel)
      .where(and(...ownerFilters));
    if (owners.length === 0) return [];

    const messageIds = owners.map((row) => row.messageId);
    const predictionFilters = [
      inArray(mailExtraction.messageId, messageIds),
      eq(mailExtraction.status, 'succeeded'),
      eq(message.direction, 'inbound'),
    ];
    if (options.transportId) predictionFilters.push(eq(message.transportId, options.transportId));

    const predictions = await tx
      .selectDistinctOn([mailExtraction.messageId], {
        messageId: mailExtraction.messageId,
        predictedAction: sql<string | null>`nullif(btrim(${mailExtraction.payload}->>'action'), '')`,
      })
      .from(mailExtraction)
      .innerJoin(message, eq(mailExtraction.messageId, message.id))
      .where(and(...predictionFilters))
      .orderBy(mailExtraction.messageId, desc(mailExtraction.createdAt), desc(mailExtraction.id));

    const predictedByMessage = new Map(
      predictions.map((row) => [row.messageId, asMailAction(row.predictedAction)] as const),
    );
    return owners.map((row) => ({
      ...row,
      predictedAction: predictedByMessage.get(row.messageId) ?? null,
    }));
  });
}

async function main(): Promise<number> {
  let options: { transportId?: string };
  try {
    options = parseOwnerGoldEvalArgs(process.argv.slice(2));
  } catch {
    console.error('Invalid eval options');
    return 2;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    return 2;
  }

  const connection = createDb(databaseUrl);
  try {
    const result = computeOwnerGoldMetrics(await selectOwnerGoldCases(connection.db, options));
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } finally {
    await connection.conn.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
