import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { normalizeString, parseStoredCredentials, type CodexCredentialStore, type CodexCredentialStoreKind, type CodexStoredCredentials } from '../credential_data.js';

type CommandRunner = typeof spawnSync;

const SECRET_TOOL_SERVICE = 'codexbridge-codex-account';
const SECRET_TOOL_UNAVAILABLE_MARKERS = [
  'no such file or directory',
  'cannot autolaunch d-bus',
  'org.freedesktop.secrets',
  'service unavailable',
  'connection refused',
  'timed out',
  'not supported',
];

export class SecretToolCodexCredentialStore implements CodexCredentialStore {
  kind: CodexCredentialStoreKind;

  platform: NodeJS.Platform;

  commandRunner: CommandRunner;

  command: string;

  availabilityCache: boolean | null;

  constructor({
    platform = process.platform,
    commandRunner = spawnSync,
    command = 'secret-tool',
  }: {
    platform?: NodeJS.Platform;
    commandRunner?: CommandRunner;
    command?: string;
  } = {}) {
    this.kind = 'secret-tool';
    this.platform = platform;
    this.commandRunner = commandRunner;
    this.command = command;
    this.availabilityCache = null;
  }

  async isAvailable(): Promise<boolean> {
    if (this.platform !== 'linux') {
      return false;
    }
    if (this.availabilityCache !== null) {
      return this.availabilityCache;
    }
    const probe = this.runCommand(['lookup', 'service', SECRET_TOOL_SERVICE, 'account_id', '__codexbridge_probe__']);
    this.availabilityCache = probe.ok || !probe.unavailable;
    return this.availabilityCache;
  }

  async load(accountId: string): Promise<CodexStoredCredentials | null> {
    const result = this.runCommand(['lookup', 'service', SECRET_TOOL_SERVICE, 'account_id', accountId]);
    if (!result.ok) {
      if (result.unavailable) {
        throw new Error(result.message || 'secret-tool is unavailable');
      }
      return null;
    }
    const text = result.stdout.trim();
    if (!text) {
      return null;
    }
    return parseStoredCredentials(text, `secret-tool account ${accountId}`);
  }

  async save(accountId: string, credentials: CodexStoredCredentials, label: string | null = null): Promise<void> {
    const args = ['store'];
    const normalizedLabel = normalizeString(label);
    if (normalizedLabel) {
      args.push(`--label=${normalizedLabel}`);
    }
    args.push('service', SECRET_TOOL_SERVICE, 'account_id', accountId);
    const result = this.runCommand(args, JSON.stringify(credentials));
    if (!result.ok) {
      throw new Error(result.message || `Failed to store credentials for ${accountId} with secret-tool`);
    }
  }

  async remove(accountId: string): Promise<boolean> {
    const result = this.runCommand(['clear', 'service', SECRET_TOOL_SERVICE, 'account_id', accountId]);
    return result.ok;
  }

  runCommand(args: string[], input?: string): {
    ok: boolean;
    stdout: string;
    stderr: string;
    unavailable: boolean;
    message: string;
  } {
    const result = this.commandRunner(this.command, args, {
      encoding: 'utf8',
      input,
      timeout: 2500,
      maxBuffer: 1024 * 1024,
    }) as SpawnSyncReturns<string>;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const nodeError = result.error as NodeJS.ErrnoException | undefined;
    const errorMessage = nodeError?.message ?? stderr.trim();
    const unavailable = hasUnavailableMarker(errorMessage) || nodeError?.code === 'ENOENT';
    const ok = result.status === 0;
    return {
      ok,
      stdout,
      stderr,
      unavailable,
      message: errorMessage,
    };
  }
}

function hasUnavailableMarker(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return SECRET_TOOL_UNAVAILABLE_MARKERS.some((marker) => normalized.includes(marker));
}

