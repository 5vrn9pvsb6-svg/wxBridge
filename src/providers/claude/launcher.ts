import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { channelSocketPath, ClaudeChannelClient } from './channel_client.js';
import { ClaudeSessionCatalog, requireSessionId } from './session_catalog.js';

export function buildClaudeShareArgs(options: { sessionId: string; stateDir: string; projectsDir: string; newSession?: boolean }): string[] {
  const sessionId = requireSessionId(options.sessionId);
  const root = path.join(options.stateDir, 'claude-channels');
  channelSocketPath(root, sessionId);
  const serverFile = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './channel_server.ts' : './channel_server.js', import.meta.url));
  const config = { mcpServers: { 'codexbridge-weixin': { type: 'stdio', command: process.execPath,
    args: ['--import', fileURLToPath(import.meta.resolve('tsx')), serverFile, root, sessionId, options.projectsDir] } } };
  return [options.newSession ? '--session-id' : '--resume', sessionId, '--mcp-config', JSON.stringify(config),
    '--dangerously-load-development-channels', 'server:codexbridge-weixin'];
}

export async function launchClaudeSharedSession(options: { sessionId?: string; stateDir: string; cwd?: string; cliBin?: string; projectsDir?: string }) {
  const catalog = new ClaudeSessionCatalog(options.projectsDir);
  const newSession = !options.sessionId;
  const sessionId = options.sessionId ? requireSessionId(options.sessionId) : randomUUID();
  const session = options.sessionId ? await catalog.read(sessionId) : null;
  if (options.sessionId && !session) { throw new Error('找不到要共享的 Claude Code 会话。'); }
  const root = path.join(options.stateDir, 'claude-channels');
  let live = false;
  try { await new ClaudeChannelClient(root, 1000).request(sessionId, { op: 'probe', requestId: randomUUID() }); live = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !/通道已断开/u.test((error as Error).message)) { throw error; }
  }
  if (live) { throw new Error('这个 Claude 会话已有共享通道，请直接在微信 /enter claude 后选择它。'); }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { throw new Error('请在电脑的交互式终端运行 claude share，确认 Claude 的通道启用提示。'); }
  const args = buildClaudeShareArgs({ sessionId, stateDir: options.stateDir, projectsDir: catalog.projectsDir, newSession });
  const child = spawn(options.cliBin ?? process.env.CODEXBRIDGE_CLAUDE_BIN ?? 'claude', args,
    { cwd: session?.cwd ?? options.cwd ?? process.cwd(), stdio: 'inherit' });
  return await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)); });
}
