import net from 'node:net';
import tls from 'node:tls';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizeHost(host) {
  return String(host ?? '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function hostFromConnectArgs(args) {
  const first = args[0];
  if (Array.isArray(first)) return hostFromConnectArgs(first);
  if (typeof first === 'object' && first !== null) {
    if (first.path || first.socketPath) return { path: String(first.path ?? first.socketPath) };
    return { host: first.host ?? first.hostname ?? 'localhost' };
  }
  if (typeof first === 'number') return { host: args[1] ?? 'localhost' };
  if (typeof first === 'string') {
    if (first.startsWith('/')) return { path: first };
    return { host: args[1] ?? 'localhost' };
  }
  return { host: 'localhost' };
}

function enforceLoopback(args) {
  const target = hostFromConnectArgs(args);
  if (target.path) {
    throw new Error('external sockets denied: unix sockets are not allowed in fixture mode');
  }
  if (!LOOPBACK_HOSTS.has(normalizeHost(target.host))) {
    throw new Error(`external sockets denied: ${target.host}`);
  }
}

const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function fixtureSocketConnect(...args) {
  enforceLoopback(args);
  return socketConnect.apply(this, args);
};

const tlsConnect = tls.TLSSocket.prototype.connect;
if (typeof tlsConnect === 'function') {
  tls.TLSSocket.prototype.connect = function fixtureTlsConnect(...args) {
    enforceLoopback(args);
    return tlsConnect.apply(this, args);
  };
}

const nativeFetch = globalThis.fetch;
if (typeof nativeFetch === 'function') {
  globalThis.fetch = function fixtureFetch(input, ...args) {
    const rawUrl = typeof input === 'string' ? input : input?.url ?? input?.href;
    if (rawUrl) {
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new Error('external sockets denied: invalid fixture fetch URL');
      }
      enforceLoopback([{ host: parsed.hostname }]);
    }
    return nativeFetch.call(this, input, ...args);
  };
}
