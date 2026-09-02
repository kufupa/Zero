import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type HermesAskResult = {
  ok: boolean;
  sessionId: string;
  text: string;
  stderr: string;
  error?: string;
};

export type HermesBridgeOptions = {
  hermesHome: string;
  hermesBin?: string;
  cwd?: string;
  timeoutMs?: number;
};

export const NAVA_HERMES_ASK_TIMEOUT_MS = 600_000;

function parseSessionId(stderr: string, stdout: string): string {
  const fromErr = stderr.match(/session_id:\s*(\S+)/);
  if (fromErr?.[1]) return fromErr[1];
  const fromOut = stdout.match(/session_id:\s*(\S+)/);
  return fromOut?.[1] ?? '';
}

export function extractHermesSessionId(stderr: string, stdout = ''): string {
  return parseSessionId(stderr, stdout);
}

function isMetaScratchLine(line: string): boolean {
  return (
    line.startsWith('┌') ||
    line.startsWith('└') ||
    line.startsWith('│') ||
    line.startsWith('┃') ||
    /^\*\*/.test(line) ||
    /^I need to provide/i.test(line) ||
    /make sure to keep it/i.test(line) ||
    /^on the /i.test(line) ||
    /^from spam/i.test(line) ||
    /^while waiting/i.test(line) ||
    /^Therefore,/i.test(line) ||
    /^Tool (call|result|preview)/i.test(line) ||
    /^⚙/.test(line) ||
    /^✅ Tool/i.test(line)
  );
}

/** Keep only operator-facing reply text from Hermes -Q stdout. */
export function cleanHermesReply(text: string): string {
  let cleaned = text
    .split('\n')
    .filter((line) => !/^session_id:/i.test(line.trim()))
    .filter((line) => !/^↻ Resumed session/i.test(line.trim()))
    .filter((line) => !/^Resumed session/i.test(line.trim()))
    .join('\n')
    .replace(/\r/g, '')
    .trim();

  const hasScratch =
    /┌─\s*Reasoning/i.test(cleaned) ||
    /\*\*Clarifying/i.test(cleaned) ||
    /Tool (call|result|preview)/i.test(cleaned);

  if (hasScratch) {
    // Prefer trailing non-meta paragraphs (multi-line answers OK).
    const paragraphs = cleaned
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    const kept: string[] = [];
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const para = paragraphs[i]!;
      const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) continue;
      if (lines.every(isMetaScratchLine)) continue;
      if (isMetaScratchLine(lines[0]!)) continue;
      kept.unshift(
        lines
          .filter((l) => !isMetaScratchLine(l))
          .join('\n')
          .trim(),
      );
      // Keep collecting until we hit clear scratch at the top of the dump.
      if (/┌─\s*Reasoning/i.test(para) || /^\*\*Clarifying/i.test(para)) break;
      // Usually one final answer block after scratch is enough.
      if (kept.length >= 1 && i < paragraphs.length - 1) break;
    }
    const joined = kept.filter(Boolean).join('\n\n').trim();
    if (joined) cleaned = joined;
    else {
      // Fallback: last non-meta line.
      const lines = cleaned
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (isMetaScratchLine(line)) continue;
        cleaned = line;
        break;
      }
    }
  }

  cleaned = cleaned
    .replace(/\bAsk one investor question\b/gi, 'Ask the next question')
    .replace(/\bAsk an investor question\b/gi, 'Ask the next question')
    .replace(/\binvestor questions?\b/gi, 'questions')
    .replace(/\binvestor\b/gi, 'operator');

  return cleaned.trim();
}

function stripBannerNoise(text: string): string {
  return cleanHermesReply(text);
}

export async function runHermesChat(
  opts: HermesBridgeOptions & {
    query: string;
    resumeSessionId?: string;
  },
): Promise<HermesAskResult> {
  const bin = opts.hermesBin ?? 'hermes';
  const timeoutMs = opts.timeoutMs ?? NAVA_HERMES_ASK_TIMEOUT_MS;
  const args = ['chat', '-Q', '-q', opts.query];
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        HERMES_HOME: opts.hermesHome,
        HERMES_ACCEPT_HOOKS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        ok: false,
        sessionId: parseSessionId(stderr, stdout) || opts.resumeSessionId || '',
        text: stripBannerNoise(stdout),
        stderr,
        error: `hermes timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        sessionId: '',
        text: '',
        stderr,
        error: err.message,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const sessionId =
        parseSessionId(stderr, stdout) || opts.resumeSessionId || '';
      const text = stripBannerNoise(stdout);
      resolve({
        ok: code === 0 && Boolean(text),
        sessionId,
        text,
        stderr,
        error: code === 0 ? undefined : `hermes exit ${String(code)}`,
      });
    });
  });
}

export async function seedNavaHermesSession(opts: {
  hermesHome: string;
  cwd: string;
  seedPrompt: string;
  sessionFile: string;
  timeoutMs?: number;
}): Promise<HermesAskResult> {
  const result = await runHermesChat({
    hermesHome: opts.hermesHome,
    cwd: opts.cwd,
    query: opts.seedPrompt,
    timeoutMs: opts.timeoutMs,
  });
  if (result.sessionId) {
    await mkdir(path.dirname(opts.sessionFile), { recursive: true });
    await writeFile(opts.sessionFile, `${result.sessionId}\n`, 'utf8');
  }
  return result;
}

export async function askNavaHermes(opts: {
  hermesHome: string;
  cwd: string;
  sessionId: string;
  question: string;
  timeoutMs?: number;
}): Promise<HermesAskResult> {
  return runHermesChat({
    hermesHome: opts.hermesHome,
    cwd: opts.cwd,
    resumeSessionId: opts.sessionId,
    query: opts.question,
    timeoutMs: opts.timeoutMs ?? NAVA_HERMES_ASK_TIMEOUT_MS,
  });
}

/**
 * Soft-fork onto corpus session: resume corpus SID, posture seed once,
 * persist working SID (usually same corpus id).
 */
export async function ensureNavaCorpusChat(opts: {
  hermesHome: string;
  cwd: string;
  corpusSessionId: string;
  posturePrompt: string;
  sessionFile: string;
  timeoutMs?: number;
  alreadySeeded?: boolean;
}): Promise<HermesAskResult & { seeded: boolean }> {
  // Always resume the corpus lineage — ignore stale thin-seed SIDs.
  const workingId = opts.corpusSessionId;

  if (opts.alreadySeeded) {
    return {
      ok: true,
      sessionId: workingId,
      text: '',
      stderr: '',
      seeded: false,
    };
  }

  let postureDone = false;
  try {
    const marker = await readFile(`${opts.sessionFile}.posture`, 'utf8');
    postureDone = marker.trim() === workingId;
  } catch {
    postureDone = false;
  }

  if (postureDone) {
    await mkdir(path.dirname(opts.sessionFile), { recursive: true });
    await writeFile(opts.sessionFile, `${workingId}\n`, 'utf8');
    return {
      ok: true,
      sessionId: workingId,
      text: '',
      stderr: '',
      seeded: false,
    };
  }

  const result = await runHermesChat({
    hermesHome: opts.hermesHome,
    cwd: opts.cwd,
    resumeSessionId: workingId,
    query: opts.posturePrompt,
    timeoutMs: opts.timeoutMs ?? NAVA_HERMES_ASK_TIMEOUT_MS,
  });
  const sid = result.sessionId || workingId;
  await mkdir(path.dirname(opts.sessionFile), { recursive: true });
  await writeFile(opts.sessionFile, `${sid}\n`, 'utf8');
  await writeFile(`${opts.sessionFile}.posture`, `${sid}\n`, 'utf8');
  return { ...result, sessionId: sid, seeded: true };
}
