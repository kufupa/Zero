import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import {
  HmsTracePrivacyError,
  collectHmsStorageStateSecretValues,
  sanitizePlaywrightTraceFile,
  type HmsTraceSanitizationResult,
} from '../src/hms/trace-privacy.js';

type PrivacyOptions = {
  signal?: AbortSignal;
};

const sanitize = sanitizePlaywrightTraceFile as unknown as (
  rawPath: string,
  reviewPath: string,
  secretValues: readonly string[],
  options?: PrivacyOptions,
) => Promise<HmsTraceSanitizationResult>;

const crc32 = (input: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

function nativeZip(entries: Record<string, string | Uint8Array>): Buffer {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(entries).map(([name, value]) => [
          name,
          typeof value === 'string' ? Buffer.from(value) : Buffer.from(value),
        ]),
      ),
      { level: 0, mtime: new Date('1980-01-01T00:00:00.000Z') },
    ),
  );
}

function descriptorZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = Buffer.from(text, 'utf8');
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(body.length, 12);
    locals.push(descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0008, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length + descriptor.length;
  }
  const centralBody = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBody.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBody, end]);
}

function utf16leJson(value: unknown): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(value), 'utf16le')]);
}

function utf16beJson(value: unknown): Buffer {
  const littleEndian = Buffer.from(JSON.stringify(value), 'utf16le');
  const bigEndian = Buffer.alloc(littleEndian.length);
  for (let offset = 0; offset < littleEndian.length; offset += 2) {
    bigEndian[offset] = littleEndian[offset + 1]!;
    bigEndian[offset + 1] = littleEndian[offset]!;
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]);
}

function decodeUtf16be(bytes: Uint8Array): string {
  const littleEndian = Buffer.alloc(bytes.length);
  for (let offset = 0; offset < bytes.length; offset += 2) {
    littleEndian[offset] = bytes[offset + 1]!;
    littleEndian[offset + 1] = bytes[offset]!;
  }
  return littleEndian.toString('utf16le');
}

async function fixture(entries: Record<string, string | Uint8Array>): Promise<{
  root: string;
  rawPath: string;
  reviewPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `hms-trace-privacy-${randomUUID()}-`));
  const rawPath = join(root, 'raw.trace.zip');
  const reviewPath = join(root, 'review.trace.zip');
  await writeFile(rawPath, nativeZip(entries));
  return { root, rawPath, reviewPath };
}

describe('bounded native trace privacy', () => {
  it('does not mistake the HMS iscallerlogin=no flag for a credential inside response schema keys', async () => {
    const values = collectHmsStorageStateSecretValues({ cookies: [
      { name: 'iscallerlogin', value: 'no' },
      { name: 'JSESSIONID', value: 'private-session-value' },
    ] });
    expect(values).toEqual(['private-session-value']);
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': '{}\n',
      'trace.network': JSON.stringify({ request: {
        headers: [{ name: 'Cookie', value: 'iscallerlogin=no; JSESSIONID=private-session-value' }],
        cookies: [{ name: 'iscallerlogin', value: 'no' }, { name: 'JSESSIONID', value: 'private-session-value' }],
      } }) + '\n',
      'resources/response.json': JSON.stringify({ nonroombundleslist: [], noguestpreferences: true, duplicate: 'private-session-value' }),
    });
    try {
      await sanitize(rawPath, reviewPath, values);
      const output = unzipSync(await readFile(reviewPath));
      const body = JSON.parse(Buffer.from(output['resources/response.json']!).toString());
      expect(body.nonroombundleslist).toEqual([]);
      expect(body.noguestpreferences).toBe(true);
      for (const bytes of Object.values(output)) expect(Buffer.from(bytes).toString()).not.toContain('private-session-value');
      // Arbitrary values in that cookie are not automatically trusted.
      expect(collectHmsStorageStateSecretValues({ cookies: [{ name: 'iscallerlogin', value: 'opaque-secret' }] })).toEqual(['opaque-secret']);
      expect(collectHmsStorageStateSecretValues({ cookies: [{ name: 'JSESSIONID', value: 'no' }] })).toEqual(['no']);
      await expect(sanitize(rawPath, reviewPath, ['no'])).rejects.toMatchObject({ code: 'TRACE_PRIVACY_FAILED' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps native resource hash references distinct without exempting credential-shaped hashes', async () => {
    const first = 'a'.repeat(39) + '1';
    const second = 'b'.repeat(39) + '2';
    const token = 'c'.repeat(39) + '3';
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': JSON.stringify({ sha1: first, token, duplicate: token }) + '\n',
      'trace.network': JSON.stringify({ content: { _sha1: first } }) + '\n' + JSON.stringify({ content: { _sha1: second } }) + '\n',
      [`resources/${first}`]: 'first native body',
      [`resources/${second}`]: 'second native body',
    });
    try {
      await sanitize(rawPath, reviewPath, []);
      const output = unzipSync(await readFile(reviewPath));
      expect(Buffer.from(output[`resources/${first}`]!).toString()).toBe('first native body');
      expect(Buffer.from(output[`resources/${second}`]!).toString()).toBe('second native body');
      expect(Buffer.from(output['trace.network']!).toString()).toContain(first);
      expect(Buffer.from(output['trace.network']!).toString()).toContain(second);
      expect(Buffer.from(output['trace.trace']!).toString()).not.toContain(token);
      for (const source of ['auth-field', 'caller-secret']) {
        await writeFile(rawPath, nativeZip({
          'trace.trace': JSON.stringify({ sha1: first, ...(source === 'auth-field' ? { authorization: first } : {}) }) + '\n',
          'trace.network': JSON.stringify({ content: { _sha1: first } }) + '\n',
          [`resources/${first}`]: 'native body',
        }));
        await sanitize(rawPath, reviewPath, source === 'caller-secret' ? [first] : []);
        const redacted = unzipSync(await readFile(reviewPath));
        expect(Object.keys(redacted).join('\n')).not.toContain(first);
        for (const bytes of Object.values(redacted)) expect(Buffer.from(bytes).toString()).not.toContain(first);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves Playwright 1.63 screencast frames while rejecting unsafe sibling entries', async () => {
    const frameName = 'screencast/page@375948314ea928e64075ea93f74cdd9a-1789688535557.jpeg';
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': JSON.stringify({ type: 'screencast-frame', sha1: frameName }) + '\n',
      'trace.network': '',
      [frameName]: frame,
    });
    try {
      await sanitize(rawPath, reviewPath, []);
      expect(Buffer.from(unzipSync(await readFile(reviewPath))[frameName]!)).toEqual(frame);
      for (const name of ['screencast/../escape.jpeg', 'screencast/nested/frame.jpeg', 'screencast/script.js']) {
        await writeFile(rawPath, nativeZip({ 'trace.trace': '{}\n', 'trace.network': '', [name]: frame }));
        await expect(sanitize(rawPath, reviewPath, [])).rejects.toMatchObject({ code: 'TRACE_PRIVACY_FAILED' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts supported encodings and every native textual stream without losing provenance', async () => {
    const rotated = 'rotated-stream-token-123';
    const rotatedUrl = 'rotated-url-token-456';
    const secret = 'Bearer/short';
    const encodedForm = 'Bearer%2fshort+value';
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': `${JSON.stringify({
        type: 'action',
        apiName: 'page.goto',
        url: 'https://example.test/reservation',
        authorization: secret,
      })}\n`,
      'trace.network': `${JSON.stringify({
        type: 'request',
        url: `https://example.test/reservation?access_token=${rotatedUrl}`,
        headers: { 'X-Useful': 'kept' },
        body: encodedForm,
      })}\n`,
      'trace.stacks': JSON.stringify({ stack: 'native provenance', value: rotated }),
      'resources/utf16le': utf16leJson({ token: secret, locale: 'en-ZA' }),
      'resources/utf16be': utf16beJson({ token: secret, property: 'response-body' }),
      'resources/token-name-secret': JSON.stringify({ image: 'screenshot', safe: true }),
      'resources/screenshot': Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x11]),
    });

    try {
      await sanitize(rawPath, reviewPath, [secret, 'Bearer/short value']);
      const output = unzipSync(await readFile(reviewPath));
      const names = Object.keys(output);
      const allText = names
        .filter((name) => !name.startsWith('resources/utf16') && name !== 'resources/screenshot')
        .map((name) => Buffer.from(output[name]!).toString('utf8'))
        .join('\n');
      const utf16Text = [
        Buffer.from(output['resources/utf16le']!).subarray(2).toString('utf16le'),
        decodeUtf16be(Buffer.from(output['resources/utf16be']!).subarray(2)),
      ].join('\n');
      expect(allText).not.toContain(secret);
      expect(allText).not.toContain(rotated);
      expect(allText).not.toContain(rotatedUrl);
      expect(allText).not.toContain(encodedForm);
      expect(utf16Text).not.toContain(secret);
      expect(names.some((name) => name.includes(secret))).toBe(false);
      expect(Buffer.from(output['resources/screenshot']!)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x11]),
      );
      expect(allText).toContain('page.goto');
      expect(allText).toContain('https://example.test/reservation');
      expect(utf16Text).toContain('en-ZA');
      expect(utf16Text).toContain('response-body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps ExtJS generated DOM ids while redacting opaque and percent-encoded values', async () => {
    const extIds = ['container-1234-innerCt', 'treeview-1045-record-567', 'x-grid-cell-gridcolumn-1045', 'ext-element-12345'];
    const opaque = 'Q9xk2LmP7vR4tZ8wYb3N';
    const extShapedCredential = 'accesskey-482910-rotation';
    const secret = 'Pilot/Session=Value';
    const encoded = encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
    const keywordId = 'session-1234-panel';
    const apiShapedCredential = 'grant-739201-rotation';
    const snapshot = ['DIV', { id: extIds[0], class: `x-grid-cell ${extIds[2]}` }, ['TR', { id: extIds[1] }], ['SPAN', { id: extIds[3] }],
      ['DIV', { id: keywordId }], ['DIV', { id: apiShapedCredential }], ['LABEL', { for: extIds[2] }], ['COL', { class: extIds[2] }]];
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': [
        JSON.stringify({ type: 'frame-snapshot', snapshot: { html: snapshot }, note: opaque, grant: extShapedCredential }),
        JSON.stringify({ type: 'action', first: `a=${encoded}`, second: `b=${encoded}`, third: `c=${encoded}` }),
      ].join('\n'),
      'trace.network': '{"type":"resource-snapshot"}\n',
      'resources/api.json': JSON.stringify({ id: apiShapedCredential, class: `${apiShapedCredential}-2` }),
    });
    try {
      await sanitize(rawPath, reviewPath, [secret]);
      const output = unzipSync(await readFile(reviewPath));
      const text = Buffer.from(output['trace.trace']!).toString('utf8');
      const api = Buffer.from(output['resources/api.json']!).toString('utf8');
      expect(api).toBe(JSON.stringify({ id: '[REDACTED]', class: '[REDACTED]' }));
      expect(text).toContain(`{"class":"${extIds[2]}"}`);
      for (const id of extIds) expect(text).toContain(id);
      expect(text).not.toContain(opaque);
      expect(text).not.toContain(extShapedCredential);
      expect(text).not.toContain(keywordId);
      expect(text).not.toContain(apiShapedCredential);
      expect(text).not.toContain(encoded);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts explicit short secrets without treating metadata as secret', async () => {
    const shortSecret = 'q7';
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': `${JSON.stringify({
        type: 'action',
        note: `opaque=${shortSecret}`,
        locale: 'en-ZA',
        property: 'Centurion',
      })}\n`,
      'trace.network': '{"type":"resource-snapshot"}\n',
    });
    try {
      await sanitize(rawPath, reviewPath, [shortSecret]);
      const output = unzipSync(await readFile(reviewPath));
      const text = Buffer.from(output['trace.trace']!).toString('utf8');
      expect(text).not.toContain(shortSecret);
      expect(text).toContain('en-ZA');
      expect(text).toContain('Centurion');
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('redacts explicit short credentials in text and queries while preserving native image bytes', async () => {
    const secret = 'q7';
    const image = Buffer.from([0xff, 0xd8, 0xff, 0x71, 0x37, 0x00]);
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': JSON.stringify({ type: 'action', note: `copy=${secret}`, locale: 'en-ZA', property: 'Centurion' }),
      'trace.network': JSON.stringify({ type: 'request', url: `https://example.test/reservation?copy=${secret}&locale=en-ZA` }),
      'trace.stacks': JSON.stringify({ files: [`copy-${secret}.ts`] }),
      'resources/screenshot': image,
    });
    try {
      await sanitize(rawPath, reviewPath, [secret]);
      const output = unzipSync(await readFile(reviewPath));
      for (const name of ['trace.trace', 'trace.network', 'trace.stacks']) {
        expect(Buffer.from(output[name]!).toString()).not.toContain(secret);
      }
      expect(Buffer.from(output['trace.trace']!).toString()).toContain('Centurion');
      expect(Buffer.from(output['trace.network']!).toString()).toContain('locale=en-ZA');
      expect(Buffer.from(output['resources/screenshot']!)).toEqual(image);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redacts opaque sensitive header values when duplicated in retained fields', async () => {
    const rotated = 'abcdefghijklmnop';
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': '{"type":"context-options"}\n',
      'trace.network': `${JSON.stringify({
        type: 'request',
        headers: [{ name: 'Authorization', value: rotated }],
        url: `https://example.test/reservation?copy=${rotated}`,
      })}\n`,
    });
    try {
      await sanitize(rawPath, reviewPath, []);
      const output = unzipSync(await readFile(reviewPath));
      const text = Buffer.from(output['trace.network']!).toString('utf8');
      expect(text).not.toContain(rotated);
      expect(text).toContain('https://example.test/reservation');
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it.each(['headers', 'cookies'] as const)(
    'discovers opaque %s array values before filtering and redacts duplicates across all retained streams',
    async (field) => {
      const opaque = 'abcdefghijklmnop';
      const { root, rawPath, reviewPath } = await fixture({
        'trace.trace': JSON.stringify({ type: 'action', note: `copy=${opaque}`, locale: 'en-ZA' }),
        'trace.network': JSON.stringify({
          type: 'resource-snapshot',
          request: {
            [field]: [{ name: field === 'headers' ? 'Authorization' : 'session', value: opaque }],
            url: `https://example.test/${opaque}?copy=${opaque}`,
          },
        }),
        'trace.stacks': JSON.stringify({ files: [`copy-${opaque}.ts`] }),
        'resources/body': JSON.stringify({ label: `copy=${opaque}`, property: 'Centurion' }),
      });
      try {
        await sanitize(rawPath, reviewPath, []);
        const output = unzipSync(await readFile(reviewPath));
        for (const bytes of Object.values(output)) expect(Buffer.from(bytes).toString()).not.toContain(opaque);
        expect(Buffer.from(output['trace.trace']!).toString()).toContain('en-ZA');
        expect(Buffer.from(output['resources/body']!).toString()).toContain('Centurion');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('joins termination of an active privacy worker before cancellation settles', async () => {
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': '{"type":"context-options"}\n',
      'trace.network': '{"type":"resource-snapshot"}\n',
    });
    const controller = new AbortController();
    let releaseJoin!: () => void;
    const joinRelease = new Promise<void>((resolve) => { releaseJoin = resolve; });
    let markTerminated!: () => void;
    const terminated = new Promise<void>((resolve) => { markTerminated = resolve; });
    let worker: Worker | undefined;
    const emit = Worker.prototype.emit;
    const emitSpy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (event, ...args) {
      const result = emit.call(this, event, ...args);
      if (event === 'online') {
        worker = this;
        controller.abort();
      }
      return result;
    });
    const terminate = Worker.prototype.terminate;
    const terminateSpy = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(async function () {
      const code = await terminate.call(this);
      markTerminated();
      await joinRelease;
      return code;
    });
    let settled = false;
    const pending = sanitize(rawPath, reviewPath, [], { signal: controller.signal }).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await terminated;
      expect(worker?.threadId).toBe(-1);
      expect(settled).toBe(false);
      releaseJoin();
      expect(await pending).toMatchObject({ code: 'TRACE_PRIVACY_FAILED' });
      await expect(readFile(reviewPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseJoin();
      controller.abort();
      await pending;
      emitSpy.mockRestore();
      terminateSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a worker exit without a result instead of waiting forever', async () => {
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': '{"type":"context-options"}\n',
      'trace.network': '{"type":"resource-snapshot"}\n',
    });
    const controller = new AbortController();
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    const emit = Worker.prototype.emit;
    const emitSpy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (event, ...args) {
      if (event === 'message') return false;
      const result = emit.call(this, event, ...args);
      if (event === 'exit') markExited();
      return result;
    });
    let settled = false;
    const pending = sanitize(rawPath, reviewPath, [], { signal: controller.signal }).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await exited;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ code: 'TRACE_PRIVACY_FAILED' });
      await expect(readFile(reviewPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      controller.abort();
      await pending;
      emitSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts Playwright data descriptors but rejects CRC and local metadata mismatches', async () => {
    const entries = {
      'trace.trace': `${JSON.stringify({ type: 'context-options' })}\n`,
      'trace.network': `${JSON.stringify({ type: 'resource-snapshot' })}\n`,
    };
    const descriptor = descriptorZip(entries);
    const { root, rawPath, reviewPath } = await fixture(entries);
    try {
      await writeFile(rawPath, descriptor);
      await expect(sanitize(rawPath, reviewPath, [])).resolves.toMatchObject({
        sanitizerVersion: 'hms-trace-sanitizer-v1',
      });

      const corrupt = Buffer.from(nativeZip(entries));
      const central = corrupt.indexOf(Buffer.from('PK\x01\x02', 'binary'));
      corrupt.writeUInt32LE((corrupt.readUInt32LE(central + 16) + 1) >>> 0, central + 16);
      await writeFile(rawPath, corrupt);
      await expect(sanitize(rawPath, reviewPath, [])).rejects.toBeInstanceOf(
        HmsTracePrivacyError,
      );

      const localMismatch = Buffer.from(nativeZip(entries));
      localMismatch.writeUInt32LE((localMismatch.readUInt32LE(14) ^ 1) >>> 0, 14);
      await writeFile(rawPath, localMismatch);
      await expect(sanitize(rawPath, reviewPath, [])).rejects.toBeInstanceOf(
        HmsTracePrivacyError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unrecognized trace stream instead of treating it as arbitrary text', async () => {
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': '{"type":"context-options"}\n',
      'trace.network': '{"type":"resource-snapshot"}\n',
      'trace.unrecognized': '{"token":"rotated-stream-token-999"}\n',
    });
    try {
      await expect(sanitize(rawPath, reviewPath, [])).rejects.toMatchObject({
        code: 'TRACE_PRIVACY_FAILED',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honors cancellation and an operation deadline before any archive work or publication', async () => {
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': '{"type":"context-options"}\n',
      'trace.network': '{"type":"resource-snapshot"}\n',
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(sanitize(rawPath, reviewPath, [], { signal: controller.signal })).rejects.toMatchObject({
        code: 'TRACE_PRIVACY_FAILED',
      });

      await expect(
        sanitize(rawPath, reviewPath, [], { signal: new AbortController().signal }),
      ).resolves.toMatchObject({ sanitizerVersion: 'hms-trace-sanitizer-v1' });

      const deadlineController = new AbortController();
      Object.defineProperty(deadlineController.signal, 'deadlineMs', {
        configurable: true,
        value: Date.now() - 1,
      });
      await expect(
        sanitize(rawPath, reviewPath, [], { signal: deadlineController.signal }),
      ).rejects.toMatchObject({ code: 'TRACE_PRIVACY_FAILED' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires the bounded input path to be an owned regular file before reading', async () => {
    const { root, rawPath, reviewPath } = await fixture({
      'trace.trace': '{"type":"context-options"}\n',
      'trace.network': '{"type":"resource-snapshot"}\n',
    });
    const alias = join(root, 'alias.trace.zip');
    try {
      await symlink(rawPath, alias);
      await expect(sanitize(alias, reviewPath, [])).rejects.toMatchObject({
        code: 'TRACE_PRIVACY_FAILED',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
