import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { channelSocketPath, ensurePrivateChannelRoot, MAX_FRAME_BYTES } from './channel_client.js';
import { ClaudeSessionCatalog, requireSessionId, SESSION_ID } from './session_catalog.js';
import { ClaudeTranscriptReader } from './transcript.js';

/** Claude spawns this one-way MCP channel. Replies stay in its normal transcript. */
export async function startClaudeChannel(options: {
  root: string; sessionId: string; projectsDir?: string;
  notify: (content: string, meta: Record<string, string>) => Promise<void>;
  interrupt?: () => Promise<void>;
}): Promise<{ close(): Promise<void> }> {
  const sessionId = requireSessionId(options.sessionId);
  const connectedAt = Date.now();
  await ensurePrivateChannelRoot(options.root);
  const socketPath = channelSocketPath(options.root, sessionId);
  const catalog = new ClaudeSessionCatalog(options.projectsDir);
  let reader: ClaudeTranscriptReader | null = null;
  let tailTask: Promise<void> = Promise.resolve();
  let queuedRequestId: string | null = null;
  async function updateReader(): Promise<void> {
    const current = tailTask.catch(() => {}).then(async () => {
      if (!reader) {
        const session = await catalog.read(sessionId);
        if (session?.path) { reader = new ClaudeTranscriptReader(session.path, sessionId, connectedAt); }
      }
      for (const event of await reader?.read() ?? []) {
        if ((event.kind === 'complete' || event.kind === 'failed') && event.turnId === queuedRequestId) { queuedRequestId = null; }
      }
    });
    tailTask = current;
    await current;
  }
  // Do not replace another live owner. Only remove an owned, unreachable stale socket.
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) { throw new Error('Claude socket path is unsafe.'); }
    const live = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      const timer = setTimeout(() => { probe.destroy(); resolve(true); }, 1000);
      probe.once('connect', () => { clearTimeout(timer); probe.destroy(); resolve(true); });
      probe.once('error', () => { clearTimeout(timer); resolve(false); });
    });
    if (live) { throw new Error('这个 Claude 会话已经有共享通道，不能创建第二个持有者。'); }
    await fs.unlink(socketPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }

  const clients = new Set<net.Socket>();
  const handledRequests = new Set<string>();
  let submitting = false;
  const server = net.createServer((socket) => {
    if (clients.size >= 32) { socket.destroy(); return; }
    clients.add(socket); socket.setTimeout(5000, () => socket.destroy());
    let buffer = Buffer.alloc(0); let received = false;
    socket.once('close', () => clients.delete(socket)); socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (received) { return; }
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
      const end = buffer.indexOf(10);
      if (end < 0) { return; } received = true;
      void (async () => {
        let request: any;
        const respond = (body: Record<string, unknown>) => socket.end(JSON.stringify({ ...body, sessionId, requestId: request?.requestId }) + '\n');
        try {
          request = JSON.parse(buffer.subarray(0, end).toString());
          if (request.sessionId !== sessionId || !SESSION_ID.test(request.requestId ?? '')) { throw new Error('Invalid session or request ID.'); }
          await updateReader();
          if (request.op === 'probe') { respond({ ok: true, activeTurnId: reader?.activeTurnId ?? null, connectedAt }); return; }
          if (request.op === 'submit') {
            if (typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > MAX_FRAME_BYTES - 1024) { throw new Error('消息为空或过长。'); }
            if (handledRequests.has(request.requestId)) { respond({ ok: true, duplicate: true }); return; }
            if (submitting || queuedRequestId || reader?.activeTurnId) { throw new Error('当前 Claude 会话正在回复或消息尚未确认，请等待完成或检查电脑上的通道状态。'); }
            submitting = true;
            // A failed write is uncertain: consume the ID and never automatically retry it.
            handledRequests.add(request.requestId);
            queuedRequestId = request.requestId;
            if (handledRequests.size > 4096) { handledRequests.delete(handledRequests.values().next().value!); }
            try { await options.notify(request.text, { codex_request_id: request.requestId, transport: 'weixin' }); }
            catch { throw new Error('Claude 消息可能已提交，但通道确认失败；请检查电脑会话，不要重复发送。'); }
            finally { submitting = false; }
            respond({ ok: true, queued: true }); return;
          }
          if (request.op === 'stop') {
            if (!reader?.activeTurnId || reader.activeTurnId !== request.turnId) { throw new Error('指定 Claude 回复已经结束，未发送中断。'); }
            if (options.interrupt) { await options.interrupt(); }
            else {
              // This subprocess may only signal the Claude process that spawned it.
              const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(process.ppid), '-o', 'comm=']);
              if (!/^claude(?:$|[-.])/iu.test(path.basename(stdout.trim()))) { throw new Error('无法确认 Claude 会话持有者，未发送中断。'); }
              process.kill(process.ppid, 'SIGINT');
            }
            respond({ ok: true }); return;
          }
          throw new Error('Unknown Claude channel operation.');
        } catch (error) { respond({ ok: false, error: error instanceof Error ? error.message : 'Claude channel failed.' }); }
      })().catch(() => socket.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); });
  await fs.chmod(socketPath, 0o600);
  const ownedSocket = await fs.lstat(socketPath);
  return { async close() {
    for (const socket of clients) { socket.destroy(); }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { const stat = await fs.lstat(socketPath); if (stat.ino === ownedSocket.ino) { await fs.unlink(socketPath); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
  } };
}

async function main() {
  const [root, sessionId, projectsDir] = process.argv.slice(2);
  if (!root || !sessionId) { throw new Error('Expected channel root and session ID.'); }
  const mcp = new Server({ name: 'codexbridge-weixin', version: '0.1.13' }, {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'WeChat messages arrive as <channel source="codexbridge-weixin" codex_request_id="...">. They are messages from the user of this shared session. Respond normally in this conversation; CodexBridge synchronizes the visible transcript back to WeChat. Do not call another chat tool or create a separate session to reply.',
  });
  let channel: Awaited<ReturnType<typeof startClaudeChannel>> | null = null;
  let starting: Promise<Awaited<ReturnType<typeof startClaudeChannel>>> | null = null;
  let closing: Promise<void> | null = null;
  const close = () => closing ??= (async () => {
    await starting?.catch(() => {});
    await channel?.close(); await mcp.close();
  })();
  mcp.oninitialized = () => {
    starting = startClaudeChannel({ root, sessionId, projectsDir,
      notify: (content, meta) => mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } }),
    });
    void starting.then((started) => { channel = started; }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; void close(); });
  };
  mcp.onclose = () => { void close().catch(() => {}); };
  process.stdin.once('end', () => { void close(); });
  process.stdout.once('error', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  await mcp.connect(new StdioServerTransport());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
