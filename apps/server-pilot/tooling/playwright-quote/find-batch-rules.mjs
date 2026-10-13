// Pure argument, resume and route-guard rules for the sequential read-only find batch.

const VALUE_FLAGS = new Set(['--input', '--out', '--cap', '--pause-ms']);
const SWITCH_FLAGS = new Set(['--include-history']);

function refuse(error) {
  return { ok: false, error };
}

export function parseFindBatchArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (SWITCH_FLAGS.has(flag)) {
      if (values.has(flag)) return refuse(`Repeated argument: ${flag}`);
      values.set(flag, true);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return refuse(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || VALUE_FLAGS.has(value) || SWITCH_FLAGS.has(value)) {
      return refuse(`Missing value for ${flag}`);
    }
    if (values.has(flag)) return refuse(`Repeated argument: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  if (!values.has('--input')) return refuse('Required: --input <json array of confirmations>');
  if (!values.has('--out')) return refuse('Required: --out <jsonl>');

  let cap = null;
  if (values.has('--cap')) {
    cap = Number(values.get('--cap'));
    if (!Number.isSafeInteger(cap) || cap < 1) return refuse('--cap must be a positive integer');
  }
  const pauseMs = values.has('--pause-ms') ? Number(values.get('--pause-ms')) : 1500;
  if (!Number.isSafeInteger(pauseMs) || pauseMs < 0) return refuse('--pause-ms must be a non-negative integer');
  return {
    ok: true,
    args: {
      input: values.get('--input'),
      out: values.get('--out'),
      cap,
      pauseMs,
      includeHistory: values.has('--include-history'),
    },
  };
}

export function parseFindBatchInput(json, cap = null) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error('Input must be valid JSON', { cause: error });
  }
  if (!Array.isArray(raw)) throw new Error('Input must be a JSON array of confirmation numbers');
  const confirmations = [];
  const seen = new Set();
  for (const [index, item] of raw.entries()) {
    const conf = typeof item === 'string' ? item.trim() : '';
    if (!/^\d{6,10}-\d{1,2}$/.test(conf)) {
      throw new Error(`Invalid confirmation at input index ${index}`);
    }
    if (seen.has(conf)) continue;
    seen.add(conf);
    confirmations.push(conf);
  }
  return cap === null ? confirmations : confirmations.slice(0, cap);
}

export function completedConfirmations(jsonl) {
  const completed = new Set();
  for (const line of String(jsonl ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row?.conf === 'string' && row.conf) completed.add(row.conf);
    } catch {
      // A torn last line does not count as completed and is safely ignored on resume.
    }
  }
  return completed;
}

export function remainingConfirmations(confirmations, jsonl) {
  const completed = completedConfirmations(jsonl);
  return confirmations.filter((conf) => !completed.has(conf));
}

function addDays(iso, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!match) throw new Error('History sweep requires an ISO day');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== iso) throw new Error('History sweep requires a real ISO day');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Past 60-day search-window starts, bounded to five years before the current panel window.
export function historySweepStarts(currentFrom, lookbackDays = 365 * 5, windowDays = 60) {
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 1 || !Number.isSafeInteger(windowDays) || windowDays < 1) {
    throw new Error('History sweep bounds must be positive integers');
  }
  const cutoff = addDays(currentFrom, -lookbackDays);
  const starts = [];
  for (let start = addDays(currentFrom, -windowDays); start >= cutoff; start = addDays(start, -windowDays)) {
    starts.push(start);
  }
  if (starts.at(-1) !== cutoff) starts.push(cutoff);
  return starts;
}

