import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { CodexDesktopIpcClient, DesktopIpcSubmissionError } from '../../../src/providers/codex/desktop_ipc_client.js';

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

async function fixture(context: TestContext, handle?: (message: any, socket: net.Socket) => boolean) {
  const root = fs.mkdtempSync('/tmp/cb-ipc-');
  const socketPath = path.join(root, 'ipc.sock');
  const messages: any[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE();
        if (buffer.length < 4 + size) { return; }
        const message = JSON.parse(buffer.subarray(4, 4 + size).toString());
        buffer = buffer.subarray(4 + size);
        messages.push(message);
        if (handle?.(message, socket)) { continue; }
        if (message.type !== 'request') { continue; }
        const result = message.method === 'initialize' ? { clientId: 'bridge-client' }
          : message.method === 'thread-owner-discovery' ? { supportsUntrustedAppInput: true }
            : { result: { turn: { id: 'desktop-turn' } } };
        const response = frame({ type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result });
        // Both partial headers and a multi-byte body split must be supported.
        socket.write(response.subarray(0, 2));
        setImmediate(() => {
          socket.write(response.subarray(2, 19));
          socket.write(response.subarray(19));
        });
      }
    });
  });
  context.after(async () => {
    for (const socket of sockets) { socket.destroy(); }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); resolve(); });
  });
  return { root, socketPath, messages, sockets, client: new CodexDesktopIpcClient({ socketPath, timeoutMs: 500 }) };
}

test('background submission targets the desktop owner and preserves desktop settings and literal text', async (context) => {
  const f = await fixture(context);
  const prompt = '中文\n"$(touch /tmp/never)" rc.129';
  assert.deepEqual(await f.client.submitTurn('thread-1', prompt), { turnId: 'desktop-turn' });
  const requests = f.messages.filter((message) => message.type === 'request');
  assert.deepEqual(requests.map((message) => [message.method, message.version]), [
    ['initialize', 0], ['thread-owner-discovery', 1], ['thread-follower-start-turn', 2],
  ]);
  const submitted = requests[2];
  assert.equal(submitted.targetClientId, 'desktop-owner');
  assert.equal(submitted.sourceClientId, 'bridge-client');
  assert.equal(submitted.params.conversationId, 'thread-1');
  assert.equal(submitted.params.turnStart.request.threadId, 'thread-1');
  assert.deepEqual(submitted.params.turnStart.request.input, [{ type: 'text', text: prompt, text_elements: [] }]);
  assert.deepEqual(submitted.params.turnStart.context, { inheritThreadSettings: true });
  for (const setting of ['model', 'permissions', 'approvalPolicy', 'cwd', 'sandboxPolicy']) {
    assert.equal(setting in submitted.params.turnStart.request, false);
  }
  assert.match(submitted.params.turnStart.request.clientUserMessageId, /^[a-f0-9-]{36}$/u);
});

test('owner probe is read-only and rejects follower discovery instead of claiming ownership', async (context) => {
  const f = await fixture(context, (message, socket) => {
    if (message.method !== 'initialize') { return false; }
    socket.write(Buffer.concat([
      frame({ type: 'client-discovery-request', requestId: 'other-client', request: { method: 'thread-owner-discovery' } }),
      frame({ type: 'response', requestId: message.requestId, method: 'initialize', resultType: 'success',
        result: { clientId: 'bridge-client' } }),
    ]));
    return true;
  });
  assert.deepEqual(await f.client.probeThreadOwner('thread-1'), { clientId: 'desktop-owner' });
  assert.ok(f.messages.some((message) => message.type === 'client-discovery-response' && message.response.canHandle === false));
  assert.ok(!f.messages.some((message) => message.method === 'thread-follower-start-turn'));
});

test('unavailable or incompatible owners do not receive a submission', async (context) => {
  const f = await fixture(context, (message, socket) => {
    if (message.method !== 'thread-owner-discovery') { return false; }
    socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' }));
    return true;
  });
  await assert.rejects(f.client.submitTurn('thread-1', 'hello'), /未找到兼容/u);
  assert.equal(f.messages.filter((message) => message.method === 'thread-follower-start-turn').length, 0);
});

for (const failure of ['timeout', 'disconnect', 'invalid-ack']) {
  test(`ambiguous ${failure} is not retried or reported as definitely unsent`, async (context) => {
    const f = await fixture(context, (message, socket) => {
      if (message.method !== 'thread-follower-start-turn') { return false; }
      if (failure === 'disconnect') { socket.destroy(); }
      if (failure === 'invalid-ack') {
        socket.write(frame({ type: 'response', requestId: message.requestId, method: message.method,
          resultType: 'success', handledByClientId: 'desktop-owner', result: {} }));
      }
      return true;
    });
    const client = new CodexDesktopIpcClient({ socketPath: f.socketPath, timeoutMs: 40 });
    await assert.rejects(client.submitTurn('thread-1', 'hello'), (error: unknown) =>
      error instanceof DesktopIpcSubmissionError && error.outcomeUnknown && /可能已提交/u.test(error.message));
    assert.equal(f.messages.filter((message) => message.method === 'thread-follower-start-turn').length, 1);
  });
}

for (const badFrame of ['oversized', 'zero', 'invalid-json', 'wrong-method']) {
  test(`invalid ${badFrame} responses close the connection before submission`, async (context) => {
    const f = await fixture(context, (message, socket) => {
      if (message.method !== 'initialize') { return false; }
      const buffer = Buffer.alloc(4);
      if (badFrame === 'oversized') { buffer.writeUInt32LE(8 * 1024 * 1024 + 1); }
      if (badFrame === 'invalid-json') { buffer.writeUInt32LE(1); }
      socket.write(badFrame === 'invalid-json' ? Buffer.concat([buffer, Buffer.from('{')])
        : badFrame === 'wrong-method' ? frame({ type: 'response', requestId: message.requestId,
          resultType: 'success', method: 'unrelated', result: {} }) : buffer);
      return true;
    });
    await assert.rejects(f.client.submitTurn('thread-1', 'hello'), /Invalid desktop IPC/u);
    assert.equal(f.messages.length, 1);
  });
}

test('unsafe local endpoints and malformed thread IDs fail before connecting', async (context) => {
  const f = await fixture(context);
  await assert.rejects(f.client.submitTurn('../thread', 'hello'), /Invalid desktop thread/u);
  fs.chmodSync(f.root, 0o777);
  await assert.rejects(f.client.submitTurn('thread-1', 'hello'), /权限不安全/u);
  fs.chmodSync(f.root, 0o700);
  fs.chmodSync(f.socketPath, 0o666);
  await assert.rejects(f.client.submitTurn('thread-1', 'hello'), /权限不安全/u);
  assert.equal(f.messages.length, 0);
});
