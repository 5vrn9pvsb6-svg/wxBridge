import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { requireSessionId } from './session_catalog.js';

export const MAX_FRAME_BYTES = 256 * 1024;
export function channelSocketPath(root: string, sessionId: string): string {
  const socket = path.join(root, `${requireSessionId(sessionId)}.sock`);
  if (Buffer.byteLength(socket) > 100) { throw new Error('Claude 通道目录过长，请使用较短的 state-dir。'); }
  return socket;
}
export async function ensurePrivateChannelRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error('Claude 通道目录必须属于当前用户且权限为 0700。');
  }
}
export class ClaudeChannelClient {
  constructor(readonly root: string, readonly timeoutMs = 5000) {}
  async request(sessionId: string, request: Record<string, unknown>): Promise<any> {
    const socketPath = channelSocketPath(this.root, sessionId);
    const [dir, socketStat] = await Promise.all([fs.lstat(this.root), fs.lstat(socketPath)]);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid?.()
      || !socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== process.getuid?.() || (socketStat.mode & 0o077)) {
      throw new Error('Claude 通道权限检查失败。');
    }
    const frame = JSON.stringify({ ...request, sessionId }) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { throw new Error('Claude 消息过长。'); }
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = Buffer.alloc(0); let sent = false; let settled = false;
      const finish = (error: Error | null, result?: any) => {
        if (settled) { return; } settled = true; clearTimeout(timer); socket.destroy();
        if (error) { reject(error); } else { resolve(result); }
      };
      const uncertain = () => new Error(sent && request.op === 'submit'
        ? 'Claude 消息可能已提交，但通道确认丢失；请检查电脑会话，不要重复发送。'
        : 'Claude 通道已断开或未响应，请在电脑上重新启用共享。');
      const timer = setTimeout(() => finish(uncertain()), this.timeoutMs);
      socket.once('connect', () => { sent = true; socket.write(frame); });
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
        if (buffer.length > MAX_FRAME_BYTES) { finish(new Error('Claude 通道响应过长。')); return; }
        const end = buffer.indexOf(10);
        if (end < 0) { return; }
        try {
          const response = JSON.parse(buffer.subarray(0, end).toString());
          if (response.sessionId !== sessionId || response.requestId !== request.requestId) { finish(uncertain()); return; }
          finish(response.ok ? null : new Error(typeof response.error === 'string' ? response.error : 'Claude 通道拒绝请求。'), response);
        } catch { finish(uncertain()); }
      });
      socket.once('error', () => finish(uncertain())); socket.once('close', () => finish(uncertain()));
    });
  }
}
