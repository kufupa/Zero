import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { RealPop3Client } from '../src/mail/ingest/pop3-client';

type WritableSocket = EventEmitter & {
  write(
    data: string | Buffer,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean;
  setTimeout(ms: number): void;
  destroy(): void;
};

function createFakeSocket(): WritableSocket {
  const sock = new EventEmitter() as WritableSocket;
  sock.setTimeout = () => sock;
  sock.destroy = () => {
    // Match real net.Socket: 'close' is not sync with destroy().
    setImmediate(() => sock.emit('close'));
  };
  sock.write = (
    _data: string | Buffer,
    _encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ) => {
    cb?.(null);
    return true;
  };
  return sock;
}

function wirePop3Script(
  sock: WritableSocket,
  handlers: Record<string, (written: string) => void>,
): void {
  const originalWrite = sock.write.bind(sock);
  sock.write = (data, encoding, cb) => {
    const written = typeof data === 'string' ? data : data.toString('utf-8');
    const cmd = written.trim().split(/\s+/)[0] ?? '';
    const handler = handlers[cmd];
    if (handler) {
      handler(written);
    }
    return originalWrite(data, encoding as BufferEncoding, cb);
  };
}

describe('RealPop3Client socket framing', () => {
  it('multiline UIDL survives split chunks', async () => {
    const sock = createFakeSocket();
    const client = new RealPop3Client({
      host: 'mail.test',
      port: 110,
      user: 'ingest',
      password: 'secret',
      testSocket: sock,
    });

    wirePop3Script(sock, {
      USER: () => sock.emit('data', Buffer.from('+OK user accepted\r\n')),
      PASS: () => sock.emit('data', Buffer.from('+OK pass accepted\r\n')),
      UIDL: () => {
        setImmediate(() => {
          client.pushTestChunk(Buffer.from('+OK\r\n'));
          client.pushTestChunk(Buffer.from('1 uidl-a\r\n2 uid'));
          client.pushTestChunk(Buffer.from('l-b\r\n.\r\n'));
        });
      },
    });

    client.pushTestChunk(Buffer.from('+OK server ready\r\n'));
    await client.connect();
    const uidls = await client.listUidl();
    expect(uidls).toEqual(['uidl-a', 'uidl-b']);
  });

  it('RETR raw body is byte-identical (latin-1 fixture)', async () => {
    const sock = createFakeSocket();
    const client = new RealPop3Client({
      host: 'mail.test',
      port: 110,
      user: 'ingest',
      password: 'secret',
      testSocket: sock,
    });

    const expectedRaw = Buffer.from(
      'Subject: latin-1\r\n\r\nFr\xFCh und Gr\xFC\xDFe',
      'latin1',
    );

    wirePop3Script(sock, {
      USER: () => sock.emit('data', Buffer.from('+OK\r\n')),
      PASS: () => sock.emit('data', Buffer.from('+OK\r\n')),
      UIDL: () => {
        setImmediate(() => {
          client.pushTestChunk(Buffer.from('+OK\r\n1 uid-latin\r\n.\r\n'));
        });
      },
      RETR: () => {
        setImmediate(() => {
          client.pushTestChunk(Buffer.from('+OK\r\n'));
          client.pushTestChunk(Buffer.concat([expectedRaw, Buffer.from('\r\n.\r\n')]));
        });
      },
    });

    client.pushTestChunk(Buffer.from('+OK\r\n'));
    await client.connect();
    await client.listUidl();
    const msg = await client.retr('uid-latin');
    expect(msg.raw.equals(Buffer.concat([expectedRaw, Buffer.from('\r\n')]))).toBe(true);
    expect(msg.raw.toString('latin1')).toContain('Früh');
  });

  it('bytes dropped between readLine calls do not hang', async () => {
    const sock = createFakeSocket();
    const client = new RealPop3Client({
      host: 'mail.test',
      port: 110,
      user: 'ingest',
      password: 'secret',
      testSocket: sock,
    });

    wirePop3Script(sock, {
      USER: () => {
        setImmediate(() => client.pushTestChunk(Buffer.from('+OK user\r\n')));
      },
      PASS: () => {
        setImmediate(() => client.pushTestChunk(Buffer.from('+OK pass\r\n')));
      },
      UIDL: () => {
        setImmediate(() => {
          client.pushTestChunk(Buffer.from('+OK\r\n1 slow-uidl\r\n.\r\n'));
        });
      },
    });

    client.pushTestChunk(Buffer.from('+OK greeting\r\n'));
    await client.connect();

    const uidls = await Promise.race([
      client.listUidl(),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error('listUidl hung')), 2000),
      ),
    ]);
    expect(uidls).toEqual(['slow-uidl']);
  });

  it('retr/dele use UIDL cache instead of re-listing', async () => {
    const sock = createFakeSocket();
    const client = new RealPop3Client({
      host: 'mail.test',
      port: 110,
      user: 'ingest',
      password: 'secret',
      testSocket: sock,
    });

    let uidlCalls = 0;
    const raw = Buffer.from('Subject: cache\r\n\r\nbody', 'utf-8');

    wirePop3Script(sock, {
      USER: () => sock.emit('data', Buffer.from('+OK\r\n')),
      PASS: () => sock.emit('data', Buffer.from('+OK\r\n')),
      UIDL: () => {
        uidlCalls += 1;
        setImmediate(() => {
          client.pushTestChunk(Buffer.from('+OK\r\n2 cached-uidl\r\n.\r\n'));
        });
      },
      RETR: () => {
        setImmediate(() => {
          client.pushTestChunk(Buffer.from('+OK\r\n'));
          client.pushTestChunk(Buffer.concat([raw, Buffer.from('\r\n.\r\n')]));
        });
      },
      DELE: () => {
        setImmediate(() => client.pushTestChunk(Buffer.from('+OK deleted\r\n')));
      },
    });

    client.pushTestChunk(Buffer.from('+OK\r\n'));
    await client.connect();
    await client.listUidl();
    expect(uidlCalls).toBe(1);

    await client.retr('cached-uidl');
    await client.dele('cached-uidl');
    expect(uidlCalls).toBe(1);
  });

  it('connect fails fast without password when kind is real', async () => {
    const client = new RealPop3Client({
      host: 'mail.test',
      port: 110,
      user: 'ingest',
      testSocket: createFakeSocket(),
    });
    const prev = process.env.POP3_PASSWORD;
    delete process.env.POP3_PASSWORD;
    try {
      await expect(client.connect()).rejects.toThrow(/password required/i);
    } finally {
      if (prev === undefined) delete process.env.POP3_PASSWORD;
      else process.env.POP3_PASSWORD = prev;
    }
  });

  it('reconnects after quit without sticky pop3 socket closed', async () => {
    const sock1 = createFakeSocket();
    const sock2 = createFakeSocket();
    const client = new RealPop3Client({
      host: 'mail.test',
      port: 110,
      user: 'ingest',
      password: 'secret',
      testSocket: sock1,
    });

    const scriptSession = (sock: WritableSocket) => {
      wirePop3Script(sock, {
        USER: () => {
          setImmediate(() => sock.emit('data', Buffer.from('+OK\r\n')));
        },
        PASS: () => {
          setImmediate(() => sock.emit('data', Buffer.from('+OK\r\n')));
        },
        UIDL: () => {
          setImmediate(() =>
            sock.emit('data', Buffer.from('+OK\r\n1 a\r\n.\r\n')),
          );
        },
        QUIT: () => {
          setImmediate(() => sock.emit('data', Buffer.from('+OK bye\r\n')));
        },
      });
    };

    scriptSession(sock1);
    setImmediate(() => sock1.emit('data', Buffer.from('+OK ready\r\n')));
    await client.connect();
    await expect(client.listUidl()).resolves.toEqual(['a']);
    await client.quit();
    // Allow fake socket 'close' to set sticky closeError (real POP3 poll loop hits this).
    await new Promise<void>((r) => setImmediate(r));

    (client as unknown as { opts: { testSocket: WritableSocket } }).opts.testSocket =
      sock2;
    scriptSession(sock2);
    setImmediate(() => sock2.emit('data', Buffer.from('+OK ready\r\n')));
    await client.connect();
    // Stale close from the previous socket must not poison the new session.
    sock1.emit('close');
    await expect(client.listUidl()).resolves.toEqual(['a']);
    await client.quit();
  });
});
