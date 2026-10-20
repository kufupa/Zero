import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from '../src/db/client.js';
import {
  HMS_JOB_PRIORITY_DEV,
  evaluateQuoteReadyForMessage,
  prefetchQuoteReadyForExtraction,
} from '../src/ai/hms-jobs.js';

type Cli = { enqueue: boolean; messageIds: string[] };

export function parseQuoteReadyEvalArgs(argv: string[]): Cli {
  const enqueue = argv.includes('--enqueue');
  const messageIds = argv.filter((arg) => arg !== '--enqueue');
  if (messageIds.some((id) => id.startsWith('-'))) throw new Error('unknown_option');
  if (!messageIds.length) throw new Error('message_ids_required');
  return { enqueue, messageIds };
}

function summary(evaluation: Awaited<ReturnType<typeof evaluateQuoteReadyForMessage>>) {
  const stays = evaluation.plan?.stays.map((stay) => ({
    hasInput: stay.input ? 'y' : 'n',
    ...(stay.input
      ? {
          dates: stay.input.groups.map((group) => ({ arrival: group.arrivalDate, departure: group.departureDate })),
          rooms: stay.input.groups.map((group) => ({
            roomCodes: group.roomCodes ?? [],
            count: group.quantity,
            adultsPerRoom: group.adults,
            childCountPerRoom: group.childrenAges.length,
          })),
          board: stay.input.groups.map((group) => group.board),
        }
      : { reason: stay.reason ?? 'not_ready' }),
  })) ?? [];
  const hasInput = Boolean(evaluation.plan?.inputs.length);
  return {
    messageId: evaluation.messageId,
    hasInput: hasInput ? 'y' : 'n',
    ...(!hasInput ? { reason: evaluation.reason ?? 'not_ready' } : {}),
    dates: stays.flatMap((stay) => ('dates' in stay ? stay.dates : [])),
    rooms: stays.flatMap((stay) => ('rooms' in stay ? stay.rooms : [])),
    board: stays.flatMap((stay) => ('board' in stay ? stay.board : [])),
    partyBound: evaluation.plan?.partyBound ? 'y' : 'n',
    preparationEnabled: evaluation.preparationEnabled,
    stays,
  };
}

export async function main(argv: string[]): Promise<number> {
  let cli: Cli;
  try {
    cli = parseQuoteReadyEvalArgs(argv);
  } catch {
    console.error('Usage: pnpm --dir apps/server-pilot exec tsx scripts/quote-ready-eval.ts [--enqueue] <message-id> [...]');
    return 2;
  }

  const db = getDb();
  try {
    for (const messageId of cli.messageIds) {
      const evaluation = await evaluateQuoteReadyForMessage({ messageId }, db);
      const queued = cli.enqueue && evaluation.transportId
        ? await prefetchQuoteReadyForExtraction(
            {
              runKind: 'inbound_extraction',
              transportId: evaluation.transportId,
              triggerMessageId: messageId,
            },
            db,
            process.env,
            new Date(),
            HMS_JOB_PRIORITY_DEV,
          )
        : 0;
      console.log(JSON.stringify({ ...summary(evaluation), ...(cli.enqueue ? { queued } : {}) }));
    }
    return 0;
  } catch {
    console.error('Quote-ready evaluation could not complete.');
    return 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
