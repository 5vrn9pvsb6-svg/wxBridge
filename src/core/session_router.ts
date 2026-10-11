import { NotFoundError } from './errors.js';
import type { BridgeSession, PlatformScopeRef } from '../types/core.js';
import type { PlatformBinding, PlatformExecutionMode } from '../types/repository.js';
import { createI18n, type Translator } from '../i18n/index.js';

interface PlatformBindingsLike {
  getBinding(scopeRef: PlatformScopeRef): PlatformBinding | null;
  setBinding(binding: PlatformBinding): void;
  listBindingsForSession(bridgeSessionId: string): PlatformBinding[];
  list(): PlatformBinding[];
}

interface BridgeSessionsLike {
  get(bridgeSessionId: string): BridgeSession | null;
}

interface SessionRouterOptions {
  platformBindings: PlatformBindingsLike;
  bridgeSessions: BridgeSessionsLike;
  locale?: string | null;
}

export class SessionRouter {
  private readonly platformBindings: PlatformBindingsLike;

  private readonly bridgeSessions: BridgeSessionsLike;

  private readonly i18n: Translator;

  constructor({ platformBindings, bridgeSessions, locale = null }: SessionRouterOptions) {
    this.platformBindings = platformBindings;
    this.bridgeSessions = bridgeSessions;
    this.i18n = createI18n(locale);
  }

  resolveBoundSession(scopeRef: PlatformScopeRef): BridgeSession | null {
    const binding = this.platformBindings.getBinding(scopeRef);
    if (!binding) {
      return null;
    }
    return this.bridgeSessions.get(binding.bridgeSessionId);
  }

  resolveBinding(scopeRef: PlatformScopeRef): PlatformBinding | null {
    return this.platformBindings.getBinding(scopeRef);
  }

  requireBoundSession(scopeRef: PlatformScopeRef): BridgeSession {
    const session = this.resolveBoundSession(scopeRef);
    if (!session) {
      throw new NotFoundError(this.i18n.t('service.noBridgeSessionBound', {
        scope: `${scopeRef.platform}:${scopeRef.externalScopeId}`,
      }));
    }
    return session;
  }

  bindScope(
    scopeRef: PlatformScopeRef,
    bridgeSessionId: string,
    now = Date.now(),
    executionMode: PlatformExecutionMode = 'standalone',
    standaloneBridgeSessionId: string | null = null,
  ): void {
    this.platformBindings.setBinding({
      platform: scopeRef.platform,
      externalScopeId: scopeRef.externalScopeId,
      bridgeSessionId,
      executionMode,
      standaloneBridgeSessionId,
      updatedAt: now,
    });
  }

  setExecutionMode(scopeRef: PlatformScopeRef, executionMode: PlatformExecutionMode, now = Date.now()): void {
    const binding = this.platformBindings.getBinding(scopeRef);
    if (!binding) {
      throw new NotFoundError(this.i18n.t('service.noBridgeSessionBound', {
        scope: `${scopeRef.platform}:${scopeRef.externalScopeId}`,
      }));
    }
    this.platformBindings.setBinding({
      ...binding,
      executionMode,
      updatedAt: now,
    });
  }

  listBindingsForSession(bridgeSessionId: string): PlatformBinding[] {
    return this.platformBindings.listBindingsForSession(bridgeSessionId);
  }

  listBindings(): PlatformBinding[] {
    return this.platformBindings.list();
  }
}
