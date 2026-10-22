/**
 * Builds the party index the staff typeahead searches: the HMS company and agency list. Run it on the EC2 host that owns
 * the HMS slot, with the server's environment (DATABASE_URL for the property lock, and the installed staff quote
 * configuration for the borrowed browser):
 *
 *   pnpm -C apps/server-pilot exec tsx scripts/party-index-sweep.ts --delay-ms 20000 --max-runs 150
 *
 * Run the same command again to resume. Exit codes: 0 index written. 3 paused at --max-runs; resume later. 4 stopped on a
 * run that was not a clean answer (see the log); fix the cause, then resume. 2 configuration error.
 *
 * The sweep reads HMS only, one property-locked runner run at a time, and writes two private files (mode 600) under
 * .private/pms-pipeline/party-index/: HRCEN keeps party-index.json; HRDAV is party-index-HRDAV.json (`--property`).
 * PARTY_INDEX_PATH / PARTY_INDEX_PATH_HRDAV choose another file. No Centurion fallback.
 */
import { readFile, rm } from 'node:fs/promises';
import { panePartyFindResultFromCli, spawnPartyLookup, type PanePartyKind } from '../src/ai/pane-party-lookup.js';
import {
  parsePartyIndexProperty,
  partyIndexPath,
  partyIndexProgressPath,
  writePrivateFile,
  type PartyIndexFile,
  type PartyIndexProperty,
} from '../src/ai/party-index.js';
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import {
  runPartyIndexSweep,
  SweepStopped,
  type SweepProgress,
} from '../src/ai/party-index-sweep.js';
import { paneStayPropertyLock } from '../src/ai/pane-stay-save.js';
import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../src/hms/property-read-lock.js';

const USAGE = `usage: party-index-sweep.ts [--property HRCEN|HRDAV] [--kinds company,agency] [--delay-ms 15000]
                          [--max-runs 150] [--lock-retries 5] [--lock-retry-ms 60000] [--fresh]`;

type Args = {
  property: PartyIndexProperty;
  kinds: PanePartyKind[];
  delayMs: number;
  maxRuns: number;
  lockRetries: number;
  lockRetryMs: number;
  fresh: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    property: 'HRCEN',
    kinds: ['company', 'agency'],
    delayMs: 15_000,
    maxRuns: 150,
    lockRetries: 5,
    lockRetryMs: 60_000,
    fresh: false,
    help: false,
  };
  const whole = (name: string, value: string | undefined): number => {
    const parsed = Number(value);
    if (!value || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} needs a whole number`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--help') args.help = true;
    else if (flag === '--fresh') args.fresh = true;
    else if (flag === '--property') {
      const property = parsePartyIndexProperty(value);
      if (!property) throw new Error('--property takes HRCEN or HRDAV');
      args.property = property;
      i += 1;
    } else if (flag === '--kinds') {
      const kinds = (value ?? '').split(',').map((kind) => kind.trim());
      if (!kinds.every((kind) => kind === 'company' || kind === 'agency') || kinds.length === 0) {
        throw new Error('--kinds takes company, agency, or both');
      }
      args.kinds = kinds as PanePartyKind[];
      i += 1;
    } else if (flag === '--delay-ms') {
      args.delayMs = whole(flag, value);
      i += 1;
    } else if (flag === '--max-runs') {
      args.maxRuns = whole(flag, value);
      i += 1;
    } else if (flag === '--lock-retries') {
      args.lockRetries = whole(flag, value);
      i += 1;
    } else if (flag === '--lock-retry-ms') {
      args.lockRetryMs = whole(flag, value);
      i += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const target = args.property === 'HRDAV' ? DAVINCI_HMS_READ_TARGET : CENTURION_HMS_READ_TARGET;
  const lock = paneStayPropertyLock(args.property);
  if (!lock) {
    console.error('DATABASE_URL is required: every sweep run takes the property lock.');
    return 2;
  }

  const indexPath = partyIndexPath(process.env, args.property);
  const progressPath = partyIndexProgressPath(indexPath, args.property);

  let runNumber = 0;
  const seams = {
    lookup: async (input: { kind: PanePartyKind; name: string }) => {
      const raw = await spawnPartyLookup({ ...input, target });
      runNumber += 1;
      const result = panePartyFindResultFromCli(input.kind, raw);
      const shape = result.truncated ? ' truncated' : '';
      // The log names the kind and the prefix only. Company and agency names stay out of it.
      console.log(`run ${runNumber}: ${input.kind} "${input.name}" ${result.outcome} ${result.results.length}${shape}`);
      return raw;
    },
    underLock: <T,>(run: () => Promise<T>) => lock.withLock(run, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS)),
    isLockBusy: (error: unknown) => isPropertyReadLockDeadline(error),
    loadProgress: async (): Promise<SweepProgress | null> => {
      try {
        const parsed = JSON.parse(await readFile(progressPath, 'utf8')) as SweepProgress;
        return parsed?.version === 1 && Array.isArray(parsed.queue) ? parsed : null;
      } catch {
        return null;
      }
    },
    saveProgress: (progress: SweepProgress) => writePrivateFile(progressPath, JSON.stringify(progress)),
    clearProgress: () => rm(progressPath, { force: true }),
    writeIndex: (index: PartyIndexFile) => writePrivateFile(indexPath, `${JSON.stringify(index, null, 2)}\n`),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };

  try {
    const result = await runPartyIndexSweep({ ...args }, seams);
    if (result.status === 'complete') {
      console.log(
        `index written: ${result.entries} entries from ${result.runs} runs; ${result.incomplete} two-letter prefixes still truncated`,
      );
      return 0;
    }
    console.log(`paused after ${result.runs} runs with ${result.pending} prefixes pending. Run again to resume.`);
    return 3;
  } catch (error) {
    if (error instanceof SweepStopped) {
      console.error(`${error.message}. Progress saved; run again to resume once fixed.`);
      return 4;
    }
    console.error('party index sweep failed; progress saved where it could be. Run again to resume.');
    return 4;
  }
}

main().then((code) => process.exit(code));
