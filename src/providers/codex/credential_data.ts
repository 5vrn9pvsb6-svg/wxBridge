export type CodexCredentialStoreKind = 'secret-tool' | 'encrypted-file';

export interface CodexStoredCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string | null;
  expiresAt: number | null;
  tokenType: string | null;
  scope: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CodexCredentialStore {
  kind: CodexCredentialStoreKind;
  isAvailable(): Promise<boolean>;
  load(accountId: string): Promise<CodexStoredCredentials | null>;
  save(accountId: string, credentials: CodexStoredCredentials, label?: string | null): Promise<void>;
  remove(accountId: string): Promise<boolean>;
}

export function parseStoredCredentials(raw: string, source: string): CodexStoredCredentials {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Stored credentials in ${source} are invalid`);
  }
  const accessToken = normalizeString(parsed.accessToken);
  const refreshToken = normalizeString(parsed.refreshToken);
  if (!accessToken || !refreshToken) {
    throw new Error(`Stored credentials in ${source} are missing accessToken/refreshToken`);
  }
  return {
    accessToken,
    refreshToken,
    idToken: normalizeString(parsed.idToken),
    accountId: normalizeString(parsed.accountId),
    expiresAt: normalizeFiniteNumber(parsed.expiresAt),
    tokenType: normalizeString(parsed.tokenType),
    scope: normalizeString(parsed.scope),
    createdAt: normalizeFiniteNumber(parsed.createdAt) ?? Date.now(),
    updatedAt: normalizeFiniteNumber(parsed.updatedAt) ?? Date.now(),
  };
}

export function normalizeString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

export function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

