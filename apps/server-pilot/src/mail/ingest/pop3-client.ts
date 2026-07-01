/**
 * POP3 client + fake adapter for ingest.
 *
 * REAL mail server connection is OUT OF SCOPE for this pass. The interface
 * (`Pop3Client`) is what the worker depends on; the real implementation is a
 * minimal POP3-over-TCP client (UIDL/RETR/DELE/QUIT). Tests and the fixture
 * path use `FakePop3Client` which serves in-memory `.eml` content.
 *
 * Pop3Message:
 *   - uidl: server-unique id (from UIDL)
 *   - raw: full RFC822 message bytes (from RETR)
 *
 * Pop3Client contract:
 *   - connect(): open the session (USER/PASS or fake init)
 *   - listUidl(): string[] of pending message ids (UIDL)
 *   - retr(uidl): Promise<Pop3Message> — fetch raw MIME for one message
 *   - dele(uidl): Promise<void> — mark message for deletion; server commits
 *     the deletion on QUIT
 *   - quit(): Promise<void> — close session; server executes pending DELEs
 *   - close(): Promise<void> — emergency close without committing DELEs
 *
 * Safety order (enforced by the worker, not here):
 *   UIDL -> RETR -> raw MIME S3 PUT -> attachment S3 PUT -> PG tx -> DELE -> QUIT
 *
 * The client never deletes a message itself; the worker calls `dele` only
 * after S3 + Postgres commit, then `quit` to commit the deletion.
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';

export interface Pop3Message {
  uidl: string;
  raw: Buffer;
}

export interface Pop3Client {
  readonly kind: 'real' | 'fake';
  /** Open the session. Must be called before list/retr/dele. */
  connect(): Promise<void>;
  /** List pending message UIDLs (UIDL command). */
  listUidl(): Promise<string[]>;
  /** Fetch one message by UIDL (RETR command). */
  retr(uidl: string): Promise<Pop3Message>;
  /** Mark a message for deletion (DELE). Committed on quit(). */
  dele(uidl: string): Promise<void>;
  /** Commit pending DELEs and close the session (QUIT). */
  quit(): Promise<void>;
  /** Emergency close without committing DELEs. */
  close(): Promise<void>;
}

export interface Pop3ClientOptions {
  host: string;
  port: number;
  user: string;
  /** Password from env or Secrets Manager. */
  password?: string;
  /** Use TLS (STLS or implicit TLS). */
  tls?: boolean;
  /** Source ARN for password in Secrets Manager (resolved before connect). */
  secretArn?: string;
}

/* ----------------------------------------------------------------------- */
/* Real POP3 client (minimal)                                              */
/* ----------------------------------------------------------------------- */

/**
 * Minimal real POP3 client.
 *
 * Implements just the commands we need: USER, PASS, UIDL, RETR, DELE, QUIT.
 * Single connection, sequential commands (no pipelining). POP3 is a line
 * protocol with `+OK`/`-ERR` responses and dot-stuffed multi-line payloads
 * for RETR and UIDL.
 *
 * This code is NEVER exercised against the real mail server in this pass;
 * the worker only constructs it when `POP3_HOST`/`POP3_PORT`/`POP3_USER` are
 * set. Tests use `FakePop3Client`.
 */
export class RealPop3Client implements Pop3Client {
  readonly kind = 'real' as const;
  private readonly opts: Pop3ClientOptions;
  private sock: Socket | TLSSocket | null = null;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(opts: Pop3ClientOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const { host, port, tls } = this.opts;
    if (tls) {
      this.sock = await openTls({ host, port });
    } else {
      this.sock = await openCleartext({ host, port });
    }
    // greeting
    const greeting = await this.readLine();
    if (!greeting.startsWith('+OK')) {
      throw new Error(`pop3 greeting not OK: ${greeting}`);
    }
    // USER + PASS
    await this.command(`USER ${this.opts.user}`);
    if (this.opts.password) {
      await this.command(`PASS ${this.opts.password}`);
    }
  }

  async listUidl(): Promise<string[]> {
    const body = await this.multiline('UIDL');
    // body lines: "<n> <uidl>"
    const uidls: string[] = [];
    for (const line of body) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      // drop the leading message number
      uidls.push(parts.length > 1 ? parts.slice(1).join(' ') : parts[0]!);
    }
    return uidls;
  }

  async retr(uidl: string): Promise<Pop3Message> {
    const num = await this.lookupMessageNumber(uidl);
    const body = await this.multiline(`RETR ${num}`);
    // body lines are dot-unstuffed already; join with CRLF
    const raw = Buffer.from(body.join('\r\n') + '\r\n', 'utf-8');
    return { uidl, raw };
  }

  async dele(uidl: string): Promise<void> {
    const num = await this.lookupMessageNumber(uidl);
    await this.command(`DELE ${num}`);
  }

  async quit(): Promise<void> {
    try {
      await this.command('QUIT');
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  private async lookupMessageNumber(uidl: string): Promise<number> {
    const body = await this.multiline('UIDL');
    for (const line of body) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const [num, u] = parts as [string, string];
      if (u === uidl) return Number(num);
    }
    throw new Error(`pop3 uidl not found: ${uidl}`);
  }

  private async command(cmd: string): Promise<string> {
    await this.writeLine(cmd);
    const line = await this.readLine();
    if (!line.startsWith('+OK')) {
      throw new Error(`pop3 ${cmd.split(' ')[0]} failed: ${line}`);
    }
    return line;
  }

  private async multiline(cmd: string): Promise<string[]> {
    await this.writeLine(cmd);
    const first = await this.readLine();
    if (!first.startsWith('+OK')) {
      throw new Error(`pop3 ${cmd} failed: ${first}`);
    }
    const lines: string[] = [];
    // read until a line with only `.`
    while (true) {
      const line = await this.readLine();
      if (line === '.') break;
      // de-stuff: lines starting with `..` are escaped `.`
      lines.push(line.startsWith('..') ? line.slice(1) : line);
    }
    return lines;
  }

  private async writeLine(line: string): Promise<void> {
    if (!this.sock) throw new Error('pop3 not connected');
    return new Promise((resolve, reject) => {
      this.sock!.write(line + '\r\n', 'utf-8', (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private async readLine(): Promise<string> {
    if (!this.sock) throw new Error('pop3 not connected');
    // accumulate until CRLF
    const sock = this.sock;
    return new Promise((resolve, reject) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += this.decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          sock.off('data', onData);
          sock.off('error', onErr);
          resolve(line);
          return;
        }
      };
      const onErr = (err: Error) => {
        sock.off('data', onData);
        sock.off('error', onErr);
        reject(err);
      };
      sock.on('data', onData);
      sock.on('error', onErr);
    });
  }
}

function openCleartext(opts: { host: string; port: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: opts.host, port: opts.port });
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

function openTls(opts: { host: string; port: number }): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host: opts.host, port: opts.port });
    sock.once('secureConnect', () => resolve(sock));
    sock.once('error', reject);
  });
}

/* ----------------------------------------------------------------------- */
/* Fake POP3 client (fixtures)                                             */
/* ----------------------------------------------------------------------- */

export interface FakePop3Message {
  uidl: string;
  raw: Buffer;
}

export interface FakePop3ClientOptions {
  /** Pre-loaded messages (UIDL -> raw bytes). */
  messages?: FakePop3Message[];
}

/**
 * In-memory POP3 client. Drives the same contract as `RealPop3Client` but
 * never opens a socket. `dele` records the deletion in `deleLog` (so tests
 * can assert order); `quit` commits the deletions (removes from `remaining`).
 */
export class FakePop3Client implements Pop3Client {
  readonly kind = 'fake' as const;
  private readonly initial: FakePop3Message[];
  private remaining: Map<string, FakePop3Message>;
  private pendingDele = new Set<string>();
  private connected = false;
  readonly callLog: { op: string; uidl?: string }[] = [];
  readonly deleLog: string[] = [];

  constructor(opts: FakePop3ClientOptions = {}) {
    this.initial = opts.messages ?? [];
    this.remaining = new Map(this.initial.map((m) => [m.uidl, m]));
  }

  async connect(): Promise<void> {
    this.callLog.push({ op: 'connect' });
    this.connected = true;
  }

  async listUidl(): Promise<string[]> {
    this.requireConnected();
    this.callLog.push({ op: 'uidl' });
    return [...this.remaining.keys()];
  }

  async retr(uidl: string): Promise<Pop3Message> {
    this.requireConnected();
    this.callLog.push({ op: 'retr', uidl });
    const msg = this.remaining.get(uidl);
    if (!msg) throw new Error(`fake pop3: no message with uidl ${uidl}`);
    return { uidl, raw: msg.raw };
  }

  async dele(uidl: string): Promise<void> {
    this.requireConnected();
    this.callLog.push({ op: 'dele', uidl });
    this.pendingDele.add(uidl);
    this.deleLog.push(uidl);
  }

  async quit(): Promise<void> {
    this.callLog.push({ op: 'quit' });
    for (const uidl of this.pendingDele) {
      this.remaining.delete(uidl);
    }
    this.pendingDele.clear();
    this.connected = false;
  }

  async close(): Promise<void> {
    this.callLog.push({ op: 'close' });
    this.pendingDele.clear();
    this.connected = false;
  }

  /** Test helper: messages still present (not yet committed via quit). */
  remainingUidls(): string[] {
    return [...this.remaining.keys()];
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error('fake pop3: not connected');
  }
}

/**
 * Load `.eml` fixtures from a directory into `FakePop3Message[]`.
 * Used by tests and by the worker when running the fixture/fake path.
 */
export function loadFixtureMessages(
  files: { uidl: string; path: string }[],
): FakePop3Message[] {
  return files.map(({ uidl, path }) => ({
    uidl,
    raw: readFileSync(path),
  }));
}

/* ----------------------------------------------------------------------- */
/* Factory                                                                 */
/* ----------------------------------------------------------------------- */

/**
 * Build a Pop3Client from env. Returns null when no real POP3 is configured
 * — the worker then falls back to the fake/fixture path.
 */
export function createPop3Client(env: {
  POP3_HOST?: string;
  POP3_PORT?: number;
  POP3_USER?: string;
  POP3_SECRET_ARN?: string;
  POP3_TLS?: boolean;
}): RealPop3Client | null {
  if (!env.POP3_HOST || !env.POP3_PORT || !env.POP3_USER) {
    return null;
  }
  return new RealPop3Client({
    host: env.POP3_HOST,
    port: env.POP3_PORT,
    user: env.POP3_USER,
    tls: env.POP3_TLS ?? true,
    secretArn: env.POP3_SECRET_ARN,
  });
}
