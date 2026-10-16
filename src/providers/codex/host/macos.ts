import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { commonCodexHost, requireLocalDesktopHost, resolveDesktopTargetUsing } from './common.js';
import type { CodexHostPlatform, DesktopIpcTransport } from './contracts.js';

export const macosCodexHost: CodexHostPlatform = {
  ...commonCodexHost,
  supportsDesktopGui: true,
  requiresDesktopTarget: false,
  resolveDesktopTarget: context => resolveDesktopTargetUsing(context, {
    paths: path.posix,
    isWsl: false,
    validateHost: requireLocalDesktopHost,
    defaultEndpoint: home => path.posix.join(home, 'ipc', 'ipc.sock'),
    isValidEndpoint: endpoint => path.posix.isAbsolute(endpoint),
    isValidPowerShellPath: filePath => path.win32.isAbsolute(filePath),
    legacyCompatible: (explicitHome, hostId, env) => hostId === 'local'
      && !explicitHome && !env.CODEXBRIDGE_CODEX_DESKTOP_IPC_SOCKET,
  }),
  canonicalDesktopEndpoint: target => fs.existsSync(target.endpoint) ? fs.realpathSync(target.endpoint) : target.endpoint,
  openDesktopTransport: (target, timeoutMs, signal) => openUnixDesktopTransport(target.endpoint, timeoutMs, signal),
  wakeDesktopThread: async ({ threadId, hostId, runCommand }) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) { throw new Error('Invalid desktop thread id'); }
    requireLocalDesktopHost(hostId);
    const url = new URL(`codex://threads/${threadId}`);
    url.searchParams.set('hostId', hostId);
    // No prompt, Return key, new writer or unlock operation. The existing app
    // loads its own thread; -g asks Launch Services not to foreground it.
    await runCommand('/usr/bin/open', ['-g', url.toString()]);
  },
  submitDesktopGui: async ({ deepLink, appName, submitDelayMs, runCommand, sleep }) => {
    await runCommand('/usr/bin/open', [deepLink]);
    await sleep(submitDelayMs);
    await runCommand('/usr/bin/osascript', ['-e', buildSubmitAppleScript(appName)]);
  },
};

export async function openUnixDesktopTransport(socketPath: string, timeoutMs: number, signal?: AbortSignal): Promise<DesktopIpcTransport> {
  const uid = process.getuid?.();
  try {
    const socket = fs.lstatSync(socketPath);
    const directory = fs.lstatSync(path.dirname(socketPath));
    if (uid === undefined || !socket.isSocket() || socket.uid !== uid || socket.mode & 0o022
      || !directory.isDirectory() || directory.uid !== uid || directory.mode & 0o022) { throw new Error('unsafe'); }
  } catch { throw new Error('桌面 IPC 入口不存在或权限不安全；请保持桌面端运行。'); }
  signal?.throwIfAborted();
  const stream = net.createConnection(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        stream.off('connect', connected);
        stream.off('error', failed);
        stream.off('close', failed);
        signal?.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const connected = () => finish();
      const failed = () => finish(new Error('无法连接桌面共享服务；请保持桌面端运行。'));
      const aborted = () => finish(new Error('Desktop IPC cancelled'));
      const timer = setTimeout(failed, timeoutMs);
      stream.once('connect', connected).once('error', failed).once('close', failed);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  } catch (error) { stream.destroy(); throw error; }
  const aborted = () => stream.destroy(new Error('Desktop IPC cancelled'));
  signal?.addEventListener('abort', aborted, { once: true });
  return { stream, close: async () => { signal?.removeEventListener('abort', aborted); stream.destroy(); } };
}

function buildSubmitAppleScript(appName: string): string {
  const escapedAppName = appName.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  return [
    `tell application "${escapedAppName}" to activate`,
    'delay 0.2',
    'tell application "System Events"',
    `  tell process "${escapedAppName}"`,
    '    set frontmost to true',
    '    key code 36',
    '  end tell',
    'end tell',
  ].join('\n');
}
