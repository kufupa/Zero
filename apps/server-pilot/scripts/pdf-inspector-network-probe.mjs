#!/usr/bin/env node

import { createConnection, createServer } from 'node:net';

const LISTEN = '--listen';
const PROBE = '--probe';
const EXPECT_CONNECTED = '--expect-connected';
const EXPECT_BLOCKED = '--expect-blocked';
const PROBE_TIMEOUT_MS = 1_000;

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function exit(code) {
  process.exitCode = code;
}

function runProbe(port, expectConnected) {
  let settled = false;
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.setTimeout(PROBE_TIMEOUT_MS);
  const finish = (connected) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    exit(connected === expectConnected ? 0 : 1);
  };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.once('timeout', () => finish(false));
}

function runListener() {
  const server = createServer((socket) => socket.end());
  server.once('error', () => exit(1));
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      exit(1);
      return;
    }
    process.stdout.write(`${address.port}\n`);
  });
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === LISTEN) {
  runListener();
} else if (
  args.length === 3 &&
  args[0] === PROBE &&
  (args[2] === EXPECT_CONNECTED || args[2] === EXPECT_BLOCKED)
) {
  const port = validPort(args[1]);
  if (port === null) {
    exit(1);
  } else {
    runProbe(port, args[2] === EXPECT_CONNECTED);
  }
} else {
  exit(1);
}
