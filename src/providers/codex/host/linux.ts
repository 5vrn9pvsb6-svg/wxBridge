import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commonCodexHost, invalidDesktopHost, resolveDesktopTargetUsing, unsupportedDesktopPlatform } from './common.js';
import { DesktopTargetError, type CodexDesktopTarget, type CodexHostPlatform, type DesktopIpcTransport } from './contracts.js';
import { findDesktopPipeHelper, openWindowsPipeCommand } from './windows.js';
import { isLocalDesktopPipe } from './windows_pipe.js';

const execFileAsync = promisify(execFile);

export const linuxCodexHost: CodexHostPlatform = {
  ...commonCodexHost,
  resolveDesktopTarget: context => {
    if (!/microsoft.*wsl2|wsl2.*microsoft/iu.test(context.release)) { unsupportedDesktopPlatform(); }
    if (!context.env.CODEXBRIDGE_CODEX_DESKTOP_HOME?.trim()) {
      throw new DesktopTargetError('home-required', 'WSL2 共享需要设置 CODEXBRIDGE_CODEX_DESKTOP_HOME，指向目标桌面会话的 Codex 目录。');
    }
    return resolveDesktopTargetUsing(context, {
      paths: path.posix,
      isWsl: true,
      validateHost: validateWslHost,
      defaultEndpoint: () => '\\\\.\\pipe\\codex-ipc',
      isValidEndpoint: isLocalDesktopPipe,
      isValidPowerShellPath: filePath => path.win32.isAbsolute(filePath) || path.posix.isAbsolute(filePath),
      legacyCompatible: () => false,
    });
  },
  openDesktopTransport: (target, _timeoutMs, signal) => openWslDesktopTransport(target, signal),
};

function validateWslHost(hostId: string): void {
  if (hostId === 'local') { return; }
  const encoded = hostId.startsWith('remote-wsl:') ? hostId.slice(11) : '';
  let distro = '';
  try { distro = decodeURIComponent(encoded); } catch { /* Rejected below. */ }
  if (!distro || distro.length > 128 || /[\u0000-\u001f/\\]/u.test(distro) || encodeURIComponent(distro) !== encoded) {
    invalidDesktopHost();
  }
}

export async function openWslDesktopTransport(target: CodexDesktopTarget, signal?: AbortSignal): Promise<DesktopIpcTransport> {
  if (!isLocalDesktopPipe(target.endpoint)) { throw new Error('Only local Windows desktop pipes are allowed'); }
  signal?.throwIfAborted();
  let script = findDesktopPipeHelper();
  let executable = target.powershellBin;
  try {
    const translated = await execFileAsync('wslpath', ['-w', script], { timeout: 5_000, maxBuffer: 4096, signal });
    script = translated.stdout.trim();
  } catch { throw new Error('WSL 桌面助手路径映射失败；请检查 wslpath 和 Windows interoperability。'); }
  if (!path.win32.isAbsolute(script) || /[\r\n\u0000]/u.test(script)) { throw new Error('WSL helper path translation failed'); }
  if (!executable) {
    const systemPaths = (process.env.PATH ?? '').split(path.delimiter).filter(directory =>
      /^\/mnt\/[a-z]\/Windows\/System32\/WindowsPowerShell\/v1\.0\/?$/iu.test(directory));
    executable = systemPaths.map(directory => path.join(directory, 'powershell.exe')).find(file => fs.existsSync(file))
      ?? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  } else if (path.win32.isAbsolute(executable) && !path.posix.isAbsolute(executable)) {
    try {
      const translatedBin = await execFileAsync('wslpath', ['-u', executable], { timeout: 5_000, maxBuffer: 4096, signal });
      executable = translatedBin.stdout.trim();
    } catch { throw new Error('WSL PowerShell 路径映射失败；请检查桌面 PowerShell 程序设置。'); }
  }
  return openWindowsPipeCommand(executable, script, target, signal);
}
