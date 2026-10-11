import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { DesktopTargetIdentity } from '../../types/core.js';
import { getCodexHostPlatform } from './host/index.js';
import { DesktopTargetError, type CodexDesktopTarget } from './host/contracts.js';

export { DesktopTargetError, type CodexDesktopTarget } from './host/contracts.js';
export { isLocalDesktopPipe } from './host/windows_pipe.js';

export function resolveCodexDesktopTarget({
  env = process.env,
  platform = process.platform,
  release = os.release(),
  userHome = os.homedir(),
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  release?: string;
  userHome?: string;
} = {}): CodexDesktopTarget {
  return getCodexHostPlatform(platform).resolveDesktopTarget({ env, platform, release, userHome });
}

export function desktopTargetIdentity(target: CodexDesktopTarget): DesktopTargetIdentity {
  let home: string;
  try {
    home = fs.realpathSync(target.home);
    if (!fs.statSync(home).isDirectory()) { throw new Error('not-directory'); }
  } catch {
    throw new DesktopTargetError('storage-unavailable', '目标桌面会话目录不可读取；请检查 CODEXBRIDGE_CODEX_DESKTOP_HOME。');
  }
  const endpoint = getCodexHostPlatform(target.platform).canonicalDesktopEndpoint(target);
  const key = createHash('sha256').update(JSON.stringify(['codex-desktop-v1', target.hostId, home, endpoint])).digest('hex');
  return { key, hostId: target.hostId, label: target.hostId === 'local' ? 'local' : decodeURIComponent(target.hostId.slice(11)) + ' (WSL2)' };
}

export function assertDesktopTarget(target: CodexDesktopTarget, expectedKey?: string | null): DesktopTargetIdentity {
  const identity = desktopTargetIdentity(target);
  if (expectedKey ? expectedKey !== identity.key : !target.legacyCompatible) {
    throw new DesktopTargetError('stale-target', '桌面共享目标已变化或尚未绑定，请重新发送 /enter 并选择会话；也可发送 /exit。');
  }
  return identity;
}
