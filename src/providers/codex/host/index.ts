import { commonCodexHost } from './common.js';
import { macosCodexHost } from './macos.js';
import { windowsCodexHost, openNativeWindowsDesktopTransport } from './windows.js';
import { linuxCodexHost, openWslDesktopTransport } from './linux.js';
import type { CodexDesktopTarget, CodexHostPlatform, DesktopIpcTransport } from './contracts.js';

/** The only OS selection point; common provider code uses capabilities. */
export function getCodexHostPlatform(platform: NodeJS.Platform = process.platform): CodexHostPlatform {
  switch (platform) {
    case 'darwin': return macosCodexHost;
    case 'win32': return windowsCodexHost;
    case 'linux': return linuxCodexHost;
    default: return commonCodexHost;
  }
}

/** Retain the existing public helper for callers that explicitly choose a pipe. */
export function openWindowsCompatibleTransport(target: CodexDesktopTarget, signal?: AbortSignal): Promise<DesktopIpcTransport> {
  return target.isWsl ? openWslDesktopTransport(target, signal) : openNativeWindowsDesktopTransport(target, signal);
}
