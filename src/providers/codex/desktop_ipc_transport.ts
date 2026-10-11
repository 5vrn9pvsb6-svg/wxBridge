import { getCodexHostPlatform } from './host/index.js';
import type { CodexDesktopTarget, DesktopIpcTransportFactory } from './host/contracts.js';
export type { DesktopIpcTransport, DesktopIpcTransportFactory } from './host/contracts.js';
export { openUnixDesktopTransport } from './host/macos.js';
export { openDesktopPipeHelper } from './host/windows_pipe.js';
export { openWindowsCompatibleTransport as openWindowsDesktopTransport } from './host/index.js';

export function desktopTransportFactory(target: CodexDesktopTarget, timeoutMs = 15_000): DesktopIpcTransportFactory {
  return signal => getCodexHostPlatform(target.platform).openDesktopTransport(target, timeoutMs, signal);
}
