import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { openDesktopPipeHelper, openWindowsDesktopTransport } from '../../../src/providers/codex/desktop_ipc_transport.js';
import { CodexDesktopIpcClient } from '../../../src/providers/codex/desktop_ipc_client.js';

test('helper readiness consumes only its preamble and preserves binary data', async () => {
  const transport = await openDesktopPipeHelper(process.execPath, ['-e',
    'process.stdout.write(\'{"ready":true}\\n\'); process.stdin.pipe(process.stdout);']);
  try {
    const received = new Promise<Buffer>(resolve => transport.stream.once('data', resolve));
    const payload = Buffer.from([0, 1, 255, 195, 169, 10]);
    transport.stream.write(payload);
    assert.deepEqual(await received, payload);
  } finally { await transport.close(); }
});

test('binary data coalesced with helper readiness is not lost', async () => {
  const transport = await openDesktopPipeHelper(process.execPath, ['-e',
    'process.stdout.write(Buffer.concat([Buffer.from(\'{"ready":true}\\n\'), Buffer.from([0,255,10])])); process.stdin.resume();']);
  try {
    const bytes = await new Promise<Buffer>(resolve => transport.stream.once('data', resolve));
    assert.deepEqual(bytes, Buffer.from([0, 255, 10]));
  } finally { await transport.close(); }
});

test('helper duplex preserves a large binary payload while applying write backpressure', async () => {
  const transport = await openDesktopPipeHelper(process.execPath, ['-e',
    'process.stdout.write(\'{"ready":true}\\n\'); process.stdin.pipe(process.stdout);']);
  try {
    const payload = Buffer.alloc(768 * 1024, 0xa5);
    const chunks: Buffer[] = [];
    const received = new Promise<Buffer>((resolve, reject) => {
      let count = 0;
      transport.stream.on('error', reject);
      transport.stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk); count += chunk.length;
        if (count >= payload.length) { resolve(Buffer.concat(chunks)); }
      });
    });
    assert.equal(transport.stream.write(payload), false);
    assert.deepEqual(await received, payload);
  } finally { await transport.close(); }
});

test('helper ownership failure exposes a code and never sends task input', async () => {
  await assert.rejects(openDesktopPipeHelper(process.execPath, ['-e',
    'process.stdout.write(\'{"ready":false,"code":"owner-mismatch","secret":"do not expose"}\\n\'); process.stdin.resume();']),
  error => /owner-mismatch/u.test(String(error)) && !String(error).includes('do not expose'));
});

test('helper cancellation before readiness cleans up the subprocess promptly', async () => {
  const controller = new AbortController();
  const pending = openDesktopPipeHelper(process.execPath, ['-e', 'process.stdin.resume()'], controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled|abort/iu);
});

test('Windows helper verifies a real same-user pipe and routes a desktop request', { skip: process.platform !== 'win32' }, async context => {
  const name = 'codexbridge-test-' + process.pid;
  const endpoint = '\\\\.\\pipe\\' + name;
  const messages: any[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const size = buffer.readUInt32LE();
        const request = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        messages.push(request);
        const result = request.method === 'initialize' ? { clientId: 'bridge' }
          : request.method === 'thread-owner-discovery' ? { supportsUntrustedAppInput: true }
            : { result: { turn: { id: 'windows-turn' } } };
        const payload = Buffer.from(JSON.stringify({
          type: 'response', requestId: request.requestId, method: request.method,
          resultType: 'success', handledByClientId: 'desktop', result,
        }));
        const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
        socket.write(Buffer.concat([header, payload]));
      }
    });
  });
  context.after(async () => { for (const socket of sockets) { socket.destroy(); } await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const client = new CodexDesktopIpcClient({
    transportFactory: signal => openWindowsDesktopTransport({
      platform: 'win32', endpoint, home: path.join(process.env.USERPROFILE!, '.codex'),
      isWsl: false, hostId: 'local', legacyCompatible: false,
    }, signal),
  });
  assert.deepEqual(await client.submitTurn('thread-1', '中文 rc.129'), { turnId: 'windows-turn' });
  assert.equal(messages[2].params.turnStart.request.input[0].text, '中文 rc.129');
});
