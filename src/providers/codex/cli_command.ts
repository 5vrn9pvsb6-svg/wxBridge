import { getCodexHostPlatform } from './host/index.js';
import type { CodexCliLaunchSpec } from './host/contracts.js';
export type { CodexCliLaunchSpec } from './host/contracts.js';

export function createCodexCliLaunchSpec({ command, args, platform = process.platform }: {
  command: string;
  args: string[];
  platform?: NodeJS.Platform;
}): CodexCliLaunchSpec {
  return getCodexHostPlatform(platform).createCliLaunchSpec(command, args);
}
