import { createServer, Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

type Reply = string;

const ok: Reply = '+OK\r\n';
const integer = (n: number): Reply => `:${n}\r\n`;
const bulk = (value: string | undefined): Reply =>
  value === undefined
    ? '$-1\r\n'
    : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
const array = (items: Reply[]): Reply =>
  `*${items.length}\r\n${items.join('')}`;

function parseCommands(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  const readLine = (): string | undefined => {
    const end = buffer.indexOf('\r\n', offset);
    if (end === -1) return undefined;
    const line = buffer.toString('utf8', offset, end);
    offset = end + 2;
    return line;
  };
  while (offset < buffer.length) {
    const start = offset;
    const header = readLine();
    if (header === undefined) break;
    const count = Number(header.slice(1));
    const args: string[] = [];
    for (let i = 0; i < count; i++) {
      const lengthLine = readLine();
      if (lengthLine === undefined) break;
      const length = Number(lengthLine.slice(1));
      if (offset + length + 2 > buffer.length) break;
      args.push(buffer.toString('utf8', offset, offset + length));
      offset += length + 2;
    }
    if (args.length < count) {
      offset = start;
      break;
    }
    commands.push(args);
  }
  return { commands, rest: buffer.subarray(offset) };
}

/**
 * A minimal in-memory Redis that speaks enough RESP2 for the cache handlers.
 * `pause()` acts like `CLIENT PAUSE`: from the first matching command on, a
 * connection gets no replies until `resume()`, which then answers the held
 * commands in order.
 */
export async function startPausableRedisServer() {
  const store = new Map<string, string>();
  const received: string[][] = [];
  let pausedCommands: Set<string> | 'ALL' | undefined;
  const connections = new Set<{
    socket: Socket;
    held: string[][];
  }>();

  const reply = (args: string[]): Reply => {
    const [name, ...rest] = args;
    switch (name.toUpperCase()) {
      case 'PING':
        return '+PONG\r\n';
      case 'GET':
        return bulk(store.get(rest[0]));
      case 'SET':
        store.set(rest[0], rest[1]);
        return ok;
      case 'UNLINK':
        return integer(rest.filter((key) => store.delete(key)).length);
      case 'HSET':
      case 'HDEL':
      case 'PUBLISH':
        return integer(1);
      case 'HSCAN':
      case 'SCAN':
        return array([bulk('0'), array([])]);
      case 'SUBSCRIBE':
        return rest
          .map((channel, i) =>
            array([bulk('subscribe'), bulk(channel), integer(i + 1)]),
          )
          .join('');
      case 'EVAL': {
        const [, , key, expected] = rest;
        if (store.get(key) === expected) {
          store.delete(key);
          return integer(1);
        }
        return integer(0);
      }
      default:
        return ok;
    }
  };

  const isPaused = (args: string[]) =>
    pausedCommands === 'ALL' ||
    (pausedCommands?.has(args[0].toUpperCase()) ?? false);

  const server = createServer((socket) => {
    const connection = { socket, held: [] as string[][] };
    connections.add(connection);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const parsed = parseCommands(Buffer.concat([pending, chunk]));
      pending = parsed.rest;
      for (const args of parsed.commands) {
        received.push(args);
        if (connection.held.length > 0 || isPaused(args)) {
          connection.held.push(args);
        } else {
          socket.write(reply(args));
        }
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => connections.delete(connection));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `redis://127.0.0.1:${port}`,
    store,
    received,
    pause(commands: string[] | 'ALL' = 'ALL') {
      pausedCommands = commands === 'ALL' ? 'ALL' : new Set(commands);
    },
    resume() {
      pausedCommands = undefined;
      for (const connection of connections) {
        const held = connection.held;
        connection.held = [];
        for (const args of held) {
          connection.socket.write(reply(args));
        }
      }
    },
    async close() {
      for (const { socket } of connections) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
