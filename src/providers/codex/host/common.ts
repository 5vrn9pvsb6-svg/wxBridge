import type { ChildProcess } from 'node:child_process';
import type path from 'node:path';
import { DesktopTargetError, type CodexHostPlatform, type DesktopTargetContext, type CodexDesktopTarget } from './contracts.js';

export function unsupportedDesktopPlatform(): never {
  throw new DesktopTargetError('unsupported-platform', '桌面共享支持 macOS、Windows 和 WSL2；请确认当前环境为 WSL2。');
}

interface DesktopTargetPolicy {
  paths: typeof path.posix;
  isWsl: boolean;
  validateHost(hostId: string): void;
  defaultEndpoint(home: string): string;
  isValidEndpoint(endpoint: string): boolean;
  isValidPowerShellPath(filePath: string): boolean;
  legacyCompatible(explicitHome: string | undefined, hostId: string, env: NodeJS.ProcessEnv): boolean;
}

/** Common validation order and error semantics; each adapter supplies OS policy. */
export function resolveDesktopTargetUsing(
  { env, platform, userHome }: DesktopTargetContext,
  policy: DesktopTargetPolicy,
): CodexDesktopTarget {
  const explicitHome = env.CODEXBRIDGE_CODEX_DESKTOP_HOME?.trim();
  const home = explicitHome || env.CODEX_HOME?.trim() || policy.paths.join(userHome, '.codex');
  if (!policy.paths.isAbsolute(home)) { throw new DesktopTargetError('invalid-home', '桌面 Codex 目录必须是当前运行环境可读取的绝对路径。'); }
  const hostId = env.CODEXBRIDGE_CODEX_DESKTOP_HOST_ID?.trim() || 'local';
  policy.validateHost(hostId);
  const endpoint = env.CODEXBRIDGE_CODEX_DESKTOP_IPC_SOCKET?.trim() || policy.defaultEndpoint(home);
  if (!policy.isValidEndpoint(endpoint)) {
    throw new DesktopTargetError('invalid-endpoint', '桌面共享入口必须是本机 Unix socket 或本机 Windows 命名管道。');
  }
  const powershellBin = env.CODEXBRIDGE_CODEX_DESKTOP_POWERSHELL_BIN?.trim();
  if (powershellBin && !policy.isValidPowerShellPath(powershellBin)) {
    throw new DesktopTargetError('invalid-powershell', 'PowerShell 程序路径必须是绝对路径。');
  }
  return {
    home: policy.paths.normalize(home), hostId, endpoint, platform,
    isWsl: policy.isWsl, powershellBin,
    legacyCompatible: policy.legacyCompatible(explicitHome, hostId, env),
  };
}

export function requireLocalDesktopHost(hostId: string): void {
  if (hostId !== 'local') { invalidDesktopHost(); }
}

export function invalidDesktopHost(): never {
  throw new DesktopTargetError('invalid-host', '主机标识无效；WSL2 使用 local 或 remote-wsl:<URI 编码的发行版名称>。');
}

export const commonCodexHost: CodexHostPlatform = {
  supportsDesktopGui: false,
  requiresDesktopTarget: true,
  commandNotFoundHint: ' Ensure the Codex CLI is installed and reachable on PATH.',
  resolveDesktopTarget: unsupportedDesktopPlatform,
  canonicalDesktopEndpoint: target => target.endpoint,
  openDesktopTransport: async () => unsupportedDesktopPlatform(),
  submitDesktopGui: async () => {
    throw new Error('GUI desktop relay is only supported on macOS; use ipc on Windows/WSL2');
  },
  createCliLaunchSpec: (command, args) => ({ command, args, options: {}, displayCommand: command }),
  normalizeCommandPath: command => command,
  explicitCommandCandidates: filePath => [filePath],
  commandSuffixes: () => [''],
  terminateChildProcess: terminatePosixChildProcess,
};

async function terminatePosixChildProcess(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  await waitForChildExit(child, 5000).catch(() => {
    if (child.exitCode === null) { child.kill('SIGKILL'); }
    return waitForChildExit(child, 2000).catch(() => {});
  });
}

function waitForChildExit(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!child || child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Codex child process to exit'));
    }, timeoutMs);
    const onExit = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(timer); child.off('exit', onExit); };
    child.on('exit', onExit);
  });
}
