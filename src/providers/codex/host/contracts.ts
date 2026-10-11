import type { ChildProcess } from 'node:child_process';
import type { Duplex } from 'node:stream';

export class DesktopTargetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DesktopTargetError';
  }
}

export interface CodexDesktopTarget {
  home: string;
  hostId: string;
  endpoint: string;
  platform: NodeJS.Platform;
  isWsl: boolean;
  powershellBin?: string;
  legacyCompatible: boolean;
}

export interface DesktopTargetContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  release: string;
  userHome: string;
}

export interface DesktopIpcTransport {
  stream: Duplex;
  close(): Promise<void>;
}

export type DesktopIpcTransportFactory = (signal?: AbortSignal) => Promise<DesktopIpcTransport>;

export interface CodexCliLaunchSpec {
  command: string;
  args: string[] | null;
  options: Record<string, unknown>;
  displayCommand: string;
}

export type DesktopCommandRunner = (file: string, args: string[]) => Promise<void>;

export interface DesktopGuiSubmission {
  deepLink: string;
  appName: string;
  submitDelayMs: number;
  runCommand: DesktopCommandRunner;
  sleep: (ms: number) => Promise<void>;
}

/** OS details stay behind this provider-local contract. */
export interface CodexHostPlatform {
  supportsDesktopGui: boolean;
  requiresDesktopTarget: boolean;
  commandNotFoundHint: string;
  resolveDesktopTarget(context: DesktopTargetContext): CodexDesktopTarget;
  canonicalDesktopEndpoint(target: CodexDesktopTarget): string;
  openDesktopTransport(target: CodexDesktopTarget, timeoutMs: number, signal?: AbortSignal): Promise<DesktopIpcTransport>;
  submitDesktopGui(params: DesktopGuiSubmission): Promise<void>;
  createCliLaunchSpec(command: string, args: string[]): CodexCliLaunchSpec;
  normalizeCommandPath(command: string): string;
  explicitCommandCandidates(filePath: string, env: NodeJS.ProcessEnv): string[];
  commandSuffixes(command: string, env: NodeJS.ProcessEnv): string[];
  terminateChildProcess(child: ChildProcess): Promise<void>;
}
