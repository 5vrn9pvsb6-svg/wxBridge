import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commonCodexHost, requireLocalDesktopHost, resolveDesktopTargetUsing } from './common.js';
import { isLocalDesktopPipe, openDesktopPipeHelper } from './windows_pipe.js';
import type { CodexDesktopTarget, CodexHostPlatform, DesktopIpcTransport } from './contracts.js';

export const windowsCodexHost: CodexHostPlatform = {
  ...commonCodexHost,
  commandNotFoundHint: ' Ensure the Codex CLI is installed and reachable on PATH, or set CODEX_REAL_BIN to the full path of codex.exe or codex.cmd.',
  resolveDesktopTarget: context => resolveDesktopTargetUsing(context, {
    paths: path.win32,
    isWsl: false,
    validateHost: requireLocalDesktopHost,
    defaultEndpoint: () => '\\\\.\\pipe\\codex-ipc',
    isValidEndpoint: isLocalDesktopPipe,
    isValidPowerShellPath: filePath => path.win32.isAbsolute(filePath),
    legacyCompatible: () => false,
  }),
  openDesktopTransport: (target, _timeoutMs, signal) => openNativeWindowsDesktopTransport(target, signal),
  createCliLaunchSpec: (command, args) => /\.(cmd|bat)$/iu.test(command) ? {
    command: buildWindowsShellCommandLine([command, ...args]),
    args: null,
    options: { shell: true, windowsHide: true },
    displayCommand: command,
  } : commonCodexHost.createCliLaunchSpec(command, args),
  normalizeCommandPath: command => path.sep === '/' ? command.replace(/\\/gu, '/') : command,
  explicitCommandCandidates: (filePath, env) => path.extname(filePath)
    ? [filePath] : [...new Set([filePath, ...resolveWindowsExecutableSuffixes(env).map(suffix => filePath + suffix)])],
  commandSuffixes: (command, env) => path.extname(command) ? [''] : resolveWindowsExecutableSuffixes(env),
  terminateChildProcess: async child => {
    if (typeof child.pid === 'number') { await terminateWindowsProcessTree(child.pid); }
    else { await commonCodexHost.terminateChildProcess(child); }
  },
};

export async function openNativeWindowsDesktopTransport(target: CodexDesktopTarget, signal?: AbortSignal): Promise<DesktopIpcTransport> {
  if (!isLocalDesktopPipe(target.endpoint)) { throw new Error('Only local Windows desktop pipes are allowed'); }
  signal?.throwIfAborted();
  const script = findDesktopPipeHelper();
  const executable = target.powershellBin
    ?? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return openWindowsPipeCommand(executable, script, target, signal);
}

/** Source and compiled layouts both resolve the packaged, fixed helper. */
export function findDesktopPipeHelper(): string {
  let script = fileURLToPath(new URL('../../../../scripts/codex-desktop-pipe.ps1', import.meta.url));
  if (!fs.existsSync(script)) { script = fileURLToPath(new URL('../../../../../scripts/codex-desktop-pipe.ps1', import.meta.url)); }
  try {
    if (!fs.statSync(script).isFile()) { throw new Error('not-file'); }
  } catch { throw new Error('Desktop pipe helper is missing from this installation'); }
  return script;
}

export function openWindowsPipeCommand(executable: string, script: string, target: CodexDesktopTarget, signal?: AbortSignal): Promise<DesktopIpcTransport> {
  if (!path.isAbsolute(executable) || /[\r\n\u0000]/u.test(executable)) { throw new Error('Invalid PowerShell executable path'); }
  return openDesktopPipeHelper(executable, [
    '-NoProfile', '-NonInteractive', '-File', script,
    '-PipeName', target.endpoint.slice('\\\\.\\pipe\\'.length), '-ConnectTimeoutMs', '5000', '-LifetimeMs', '60000',
  ], signal);
}

function resolveWindowsExecutableSuffixes(env: NodeJS.ProcessEnv): string[] {
  const raw = typeof env.PATHEXT === 'string' ? env.PATHEXT.trim() || null : null;
  const preferred = ['.exe', '.cmd', '.bat', '.com'];
  const allowed = new Set(preferred);
  const suffixes = (raw?.split(';') ?? ['.EXE', '.CMD', '.BAT', '.COM'])
    .map(value => value.trim().toLowerCase())
    .filter(value => allowed.has(value));
  return [...new Set([...preferred, ...(suffixes.length > 0 ? suffixes : preferred)])];
}

function buildWindowsShellCommandLine(parts: string[]): string {
  return parts.map(quoteWindowsShellArgument).join(' ');
}

function quoteWindowsShellArgument(value: string): string {
  const normalized = String(value ?? '');
  if (!normalized) {
    return '""';
  }
  if (!/[\s"]/u.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      resolve();
    });
    killer.on('exit', () => {
      resolve();
    });
  });
}
