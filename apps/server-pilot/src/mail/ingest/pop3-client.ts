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
import { readdirSync, readFileSync } from 'node:fs';
import { fixtureLoopbackStore } from '../fixture-loopback.js';
import { join } from 'node:path';
import type { MailTransportMode } from '../../env.js';

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
  /** @internal Inject a connected socket (tests only). */
  testSocket?: Socket | TLSSocket;
  /** @internal Override secret resolution (tests only). */
  resolveSecret?: (arn: string) => Promise<string>;
}

const SOCKET_TIMEOUT_MS = 60_000;

type LineWaiter = {
  resolve: (line: Buffer) => void;
  reject: (err: Error) => void;
};

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
 */
export class RealPop3Client implements Pop3Client {
  readonly kind = 'real' as const;
  private readonly opts: Pop3ClientOptions;
  private sock: Socket | TLSSocket | null = null;
  private byteBuf = Buffer.alloc(0);
  private pendingLines: Buffer[] = [];
  private lineWaiters: LineWaiter[] = [];
  private uidlCache: Map<string, number> | null = null;
  private closed = false;
  private closeError: Error | null = null;

  constructor(opts: Pop3ClientOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const password = await this.resolvePassword();
    if (!password) {
      throw new Error('pop3 password required for real client (POP3_PASSWORD or POP3_SECRET_ARN)');
    }
    this.opts.password = password;

    // Worker poll loop reuses one client; quit()/close() must not poison next cycle.
    const reconnecting =
      Boolean(this.sock) || this.closed || Boolean(this.closeError);
    if (this.sock) {
      this.sock.removeAllListeners();
      try {
        this.sock.destroy();
      } catch {
        /* ignore */
      }
      this.sock = null;
    }
    this.closed = false;
    this.closeError = null;
    this.lineWaiters = [];
    this.uidlCache = null;
    // Keep pre-connect pushTestChunk buffers on first connect only.
    if (reconnecting) {
      this.byteBuf = Buffer.alloc(0);
      this.pendingLines = [];
    }

    if (this.opts.testSocket) {
      this.sock = this.opts.testSocket;
    } else {
      const { host, port, tls } = this.opts;
      if (tls) {
        this.sock = await openTls({ host, port });
      } else {
        this.sock = await openCleartext({ host, port });
      }
    }
    this.attachSocketHandlers(this.sock);

    const greeting = await this.readLine();
    if (!greeting.startsWith('+OK')) {
      throw new Error(`pop3 greeting not OK: ${greeting}`);
    }
    await this.command(`USER ${this.opts.user}`);
    await this.command(`PASS ${password}`);
  }

  async listUidl(): Promise<string[]> {
    const body = await this.multilineText('UIDL');
    const uidls: string[] = [];
    const cache = new Map<string, number>();
    for (const line of body) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length > 1) {
        const num = Number(parts[0]);
        const uidl = parts.slice(1).join(' ');
        uidls.push(uidl);
        cache.set(uidl, num);
      } else {
        uidls.push(parts[0]!);
      }
    }
    this.uidlCache = cache;
    return uidls;
  }

  async retr(uidl: string): Promise<Pop3Message> {
    const num = await this.lookupMessageNumber(uidl);
    await this.writeLine(`RETR ${num}`);
    const first = await this.readLine();
    if (!first.startsWith('+OK')) {
      throw new Error(`pop3 RETR ${num} failed: ${first}`);
    }
    const raw = await this.readRetrBody();
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
    this.rejectWaiters(new Error('pop3 connection closed'));
    this.closed = true;
  }

  /** @internal Test hook: push bytes as if they arrived on the socket. */
  pushTestChunk(chunk: Buffer): void {
    this.onData(chunk);
  }

  private async lookupMessageNumber(uidl: string): Promise<number> {
    if (!this.uidlCache) {
      await this.listUidl();
    }
    const num = this.uidlCache?.get(uidl);
    if (num === undefined) {
      throw new Error(`pop3 uidl not found: ${uidl}`);
    }
    return num;
  }

  private async resolvePassword(): Promise<string | undefined> {
    if (this.opts.password) return this.opts.password;
    const envPass = process.env.POP3_PASSWORD;
    if (envPass) return envPass;
    if (this.opts.secretArn) {
      if (this.opts.resolveSecret) {
        return this.opts.resolveSecret(this.opts.secretArn);
      }
      return fetchPop3Secret(this.opts.secretArn);
    }
    return undefined;
  }

  private attachSocketHandlers(sock: Socket | TLSSocket): void {
    sock.setTimeout(SOCKET_TIMEOUT_MS);
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('error', (err: Error) => {
      this.closeError = err;
      this.rejectWaiters(err);
    });
    sock.on('close', () => {
      if (!this.closeError) {
        this.closeError = new Error('pop3 socket closed');
      }
      this.rejectWaiters(this.closeError);
      this.closed = true;
    });
    sock.on('timeout', () => {
      const err = new Error('pop3 socket timeout');
      this.closeError = err;
      sock.destroy(err);
    });
  }

  private onData(chunk: Buffer): void {
    this.byteBuf = Buffer.concat([this.byteBuf, chunk]);
    this.flushLines();
  }

  private flushLines(): void {
    while (true) {
      const idx = this.byteBuf.indexOf('\r\n');
      if (idx < 0) break;
      const line = this.byteBuf.subarray(0, idx);
      this.byteBuf = this.byteBuf.subarray(idx + 2);
      if (this.lineWaiters.length > 0) {
        const waiter = this.lineWaiters.shift()!;
        waiter.resolve(line);
      } else {
        this.pendingLines.push(line);
      }
    }
  }

  private rejectWaiters(err: Error): void {
    for (const waiter of this.lineWaiters) {
      waiter.reject(err);
    }
    this.lineWaiters = [];
  }

  private async readLineBytes(): Promise<Buffer> {
    if (this.closeError) {
      throw this.closeError;
    }
    if (this.pendingLines.length > 0) {
      return this.pendingLines.shift()!;
    }
    return new Promise((resolve, reject) => {
      this.lineWaiters.push({ resolve, reject });
    });
  }

  private async readLine(): Promise<string> {
    const bytes = await this.readLineBytes();
    return bytes.toString('utf-8');
  }

  private async readRetrBody(): Promise<Buffer> {
    const parts: Buffer[] = [];
    while (true) {
      const line = await this.readLineBytes();
      if (line.length === 1 && line[0] === 0x2e) {
        break;
      }
      let bodyLine = line;
      if (line.length >= 2 && line[0] === 0x2e && line[1] === 0x2e) {
        bodyLine = line.subarray(1);
      }
      parts.push(bodyLine, Buffer.from('\r\n'));
    }
    return Buffer.concat(parts);
  }

  private async command(cmd: string): Promise<string> {
    await this.writeLine(cmd);
    const line = await this.readLine();
    if (!line.startsWith('+OK')) {
      throw new Error(`pop3 ${cmd.split(' ')[0]} failed: ${line}`);
    }
    return line;
  }

  private async multilineText(cmd: string): Promise<string[]> {
    await this.writeLine(cmd);
    const first = await this.readLine();
    if (!first.startsWith('+OK')) {
      throw new Error(`pop3 ${cmd} failed: ${first}`);
    }
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      if (line === '.') break;
      lines.push(line.startsWith('..') ? line.slice(1) : line);
    }
    return lines;
  }

  private async writeLine(line: string): Promise<void> {
    if (!this.sock) throw new Error('pop3 not connected');
    if (this.closed) throw new Error('pop3 connection closed');
    return new Promise((resolve, reject) => {
      this.sock!.write(line + '\r\n', 'utf-8', (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}

async function fetchPop3Secret(secretArn: string): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const region = process.env.AWS_REGION ?? 'af-south-1';
  const client = new SecretsManagerClient({ region });
  const out = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const raw = out.SecretString;
  if (!raw) {
    throw new Error(`pop3 secret empty: ${secretArn}`);
  }
  try {
    const parsed = JSON.parse(raw) as { POP3_PASSWORD?: string; password?: string };
    return parsed.POP3_PASSWORD ?? parsed.password ?? raw;
  } catch {
    return raw;
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
  // Hotel Zimbra may present expired/self-signed certs over VPN.
  // Set MAIL_TLS_REJECT_UNAUTHORIZED=false on pilot to proceed; default verify.
  const rejectUnauthorized =
    process.env.MAIL_TLS_REJECT_UNAUTHORIZED !== 'false';
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({
      host: opts.host,
      port: opts.port,
      rejectUnauthorized,
    });
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
    this.remaining = new Map(this.initial.map((m) => [m.uidl, m]));
    for (const m of fixtureLoopbackStore.drain()) {
      this.remaining.set(m.uidl, m);
    }
    this.pendingDele.clear();
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

/** Load `.eml` fixtures from a directory; uidl = filename without extension. */
export function loadFixtureMessagesFromDir(dir?: string): FakePop3Message[] {
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.eml'))
      .map((name) => ({
        uidl: name.replace(/\.eml$/, ''),
        raw: readFileSync(join(dir, name)),
      }));
  } catch {
    return [];
  }
}

function usesRealPop3(mode: MailTransportMode | undefined): boolean {
  return mode === 'real' || mode === 'wire';
}

/**
 * Build a Pop3Client from env.
 *
 * - `fixture` (default): always `FakePop3Client` — never opens TCP even when
 *   `POP3_HOST` is set (prevents accidental real connect during deploy gates).
 * - `wire`: `RealPop3Client` against Mailpit (plain POP3, password optional).
 * - `real`: `RealPop3Client` when host/port/user and password/secret are set;
 *   otherwise `null`.
 */
export function createPop3Client(env: {
  MAIL_TRANSPORT_MODE?: MailTransportMode;
  POP3_HOST?: string;
  POP3_PORT?: number;
  POP3_USER?: string;
  POP3_PASSWORD?: string;
  POP3_SECRET_ARN?: string;
  POP3_TLS?: boolean;
  INGEST_FIXTURE_DIR?: string;
}): Pop3Client | null {
  const mode = env.MAIL_TRANSPORT_MODE ?? 'fixture';

  if (!usesRealPop3(mode)) {
    const messages = loadFixtureMessagesFromDir(env.INGEST_FIXTURE_DIR);
    return new FakePop3Client({ messages });
  }

  if (!env.POP3_HOST || !env.POP3_PORT || !env.POP3_USER) {
    return null;
  }
  if (mode === 'real' && !env.POP3_PASSWORD && !env.POP3_SECRET_ARN) {
    return null;
  }
  return new RealPop3Client({
    host: env.POP3_HOST,
    port: env.POP3_PORT,
    user: env.POP3_USER,
    password: env.POP3_PASSWORD,
    tls: env.POP3_TLS ?? mode === 'real',
    secretArn: env.POP3_SECRET_ARN,
  });
}
