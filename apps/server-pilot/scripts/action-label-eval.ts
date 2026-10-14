import {
  MAIL_ACTIONS,
  type MailAction,
  type MailActionLabelSource,
} from '../src/mail/action-labels.js';
import type { DB } from '../src/db/client.js';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

type Label = { action: MailAction; needsAction: boolean };
export type EvalLabelRow = Label & {
  id: string;
  messageId: string;
  transportId: string;
  source: MailActionLabelSource;
  version: string;
  updatedAt: Date;
};
type EvalOptions = { transportId: string; version: string };
const ratio = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : 0;
const label = (row: EvalLabelRow): Label => ({ action: row.action, needsAction: row.needsAction });
const actionRecord = <T>(create: () => T): Record<MailAction, T> =>
  Object.fromEntries(MAIL_ACTIONS.map((action) => [action, create()])) as Record<MailAction, T>;

/** Pure selection and metrics. Owner marks span versions; updatedAt then id breaks ties. */
export function computeActionLabelEval(rows: readonly EvalLabelRow[], options: EvalOptions) {
  const selected = {
    model: new Map<string, EvalLabelRow>(),
    agent: new Map<string, EvalLabelRow>(),
    owner: new Map<string, EvalLabelRow>(),
  };
  for (const row of rows) {
    if (
      row.transportId !== options.transportId ||
      (row.source !== 'owner' && row.version !== options.version)
    )
      continue;
    const previous = selected[row.source].get(row.messageId);
    if (
      !previous ||
      row.updatedAt.getTime() > previous.updatedAt.getTime() ||
      (row.updatedAt.getTime() === previous.updatedAt.getTime() && row.id > previous.id)
    ) {
      selected[row.source].set(row.messageId, row);
    }
  }
  const counts = { modelLabelled: selected.model.size, ownerMarked: 0, agentCompared: 0 };
  const confusion = actionRecord(() => actionRecord(() => 0));
  let actionCorrect = 0,
    needsActionCorrect = 0,
    agentCorrect = 0;
  const labels = [...selected.model.values()]
    .sort((a, b) => a.messageId.localeCompare(b.messageId))
    .map((model) => {
      const owner = selected.owner.get(model.messageId);
      const agent = selected.agent.get(model.messageId);
      if (owner) {
        counts.ownerMarked++;
        actionCorrect += Number(model.action === owner.action);
        needsActionCorrect += Number(model.needsAction === owner.needsAction);
        confusion[owner.action][model.action]++;
        if (agent) {
          counts.agentCompared++;
          agentCorrect += Number(agent.action === owner.action);
        }
      }
      return {
        messageId: model.messageId,
        model: label(model),
        owner: owner ? label(owner) : null,
        agent: agent ? label(agent) : null,
      };
    });
  const perClass = actionRecord(() => ({ precision: 0, recall: 0 }));
  for (const action of MAIL_ACTIONS) {
    perClass[action] = {
      precision: ratio(
        confusion[action][action],
        MAIL_ACTIONS.reduce((n, actual) => n + confusion[actual][action], 0),
      ),
      recall: ratio(
        confusion[action][action],
        MAIL_ACTIONS.reduce((n, predicted) => n + confusion[action][predicted], 0),
      ),
    };
  }
  return {
    counts,
    metrics: {
      modelActionAccuracy: ratio(actionCorrect, counts.ownerMarked),
      modelNeedsActionAccuracy: ratio(needsActionCorrect, counts.ownerMarked),
      agentOwnerActionAgreement: ratio(agentCorrect, counts.agentCompared),
      coverage: ratio(counts.ownerMarked, counts.modelLabelled),
    },
    perClass,
    confusionMatrix: {
      axes: { rows: 'owner_actual', columns: 'model_predicted' },
      counts: confusion,
    },
    labels,
  };
}

export function parseEvalArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): EvalOptions & { out: string } {
  const values = new Map<string, string>();
  const invalid = () => new Error('Invalid eval options');
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!['--out', '--version', '--transport'].includes(key) || values.has(key)) throw invalid();
    const value = args[++i];
    if (!value?.trim() || value.startsWith('--')) throw invalid();
    values.set(key, value);
  }
  const out = values.get('--out');
  const version = values.get('--version');
  const transportId = values.get('--transport') ?? env.HMS_MAILBOX_TRANSPORT_ID?.trim();
  if (!out || !version || !transportId) throw invalid();
  return { out, version, transportId };
}

/** Read only label columns; never fetch message content or provider/model metadata. */
export async function readActionLabelEvalRows(
  db: DB,
  options: EvalOptions,
): Promise<EvalLabelRow[]> {
  const { mailActionLabel: t } = await import('../src/db/schema/mail.js');
  const { and, eq, or, inArray } = await import('drizzle-orm');
  return db
    .select({
      id: t.id,
      messageId: t.messageId,
      transportId: t.transportId,
      source: t.source,
      action: t.action,
      needsAction: t.needsAction,
      version: t.version,
      updatedAt: t.updatedAt,
    })
    .from(t)
    .where(
      and(
        eq(t.transportId, options.transportId),
        or(
          eq(t.source, 'owner'),
          and(inArray(t.source, ['model', 'agent']), eq(t.version, options.version)),
        ),
      ),
    );
}

async function main(): Promise<void> {
  const options = parseEvalArgs(process.argv.slice(2));
  const { getDb, closeDb } = await import('../src/db/client.js');
  try {
    const result = computeActionLabelEval(await readActionLabelEvalRows(getDb(), options), options);
    await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.table(result.metrics);
    console.table(result.counts);
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error('Action label evaluation failed');
    process.exitCode = 1;
  });
}
