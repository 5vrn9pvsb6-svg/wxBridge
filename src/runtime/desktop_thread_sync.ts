import type { InboundTextEvent } from '../types/platform.js';
import type { ProviderDesktopThreadEvent, ProviderTurnProgress } from '../types/provider.js';

export interface DesktopSharedThreadTarget {
  threadId: string;
  bridgeSessionId: string;
  providerProfileId: string;
  desktopTargetKey?: string | null;
}

export interface DesktopThreadSyncCoordinator {
  resolveDesktopSharedThread?(event: InboundTextEvent): DesktopSharedThreadTarget | null;
  observeDesktopSharedThread?(event: InboundTextEvent, options: {
    signal: AbortSignal;
    onEvent: (event: ProviderDesktopThreadEvent) => Promise<void>;
  }): Promise<void>;
}

interface SyncDelivery {
  progress(progress: ProviderTurnProgress): Promise<void>;
  finish(event: ProviderDesktopThreadEvent): Promise<void>;
  stop(): Promise<void>;
}

interface Subscription {
  key: string;
  controller: AbortController;
  task: Promise<void>;
  turnId: string | null;
  delivery: SyncDelivery | null;
  finalText: string;
}

/** Owns read-only subscriptions; desktop turns never become bridge execution turns. */
export class DesktopThreadSync {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly retiring = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: {
    coordinator: DesktopThreadSyncCoordinator;
    createDelivery: (event: InboundTextEvent, signal: AbortSignal, identity: { bindingKey: string; turnId: string }) => SyncDelivery;
    onError: (error: unknown, event: InboundTextEvent) => Promise<void>;
    retryBaseMs?: number;
    retryMaxMs?: number;
  }) {}

  isBusy(scopeId: string): boolean {
    return Boolean(this.subscriptions.get(scopeId)?.turnId);
  }

  reconcile(event: InboundTextEvent, start = true): void {
    if (this.stopped) { return; }
    const target = this.options.coordinator.resolveDesktopSharedThread?.(event);
    const key = target ? desktopThreadBindingKey(target) : '';
    const previous = this.subscriptions.get(event.externalScopeId);
    if (previous?.key === key) { return; }
    if (previous) { this.cancel(event.externalScopeId, previous); }
    if (!start || !target || !this.options.coordinator.observeDesktopSharedThread) { return; }

    const subscription: Subscription = {
      key, controller: new AbortController(), task: Promise.resolve(),
      turnId: null, delivery: null, finalText: '',
    };
    this.subscriptions.set(event.externalScopeId, subscription);
    subscription.task = this.run(event, subscription)
      .catch(async (error) => {
        if (!subscription.controller.signal.aborted) { await this.options.onError(error, event); }
      })
      .finally(async () => {
        await subscription.delivery?.stop();
        if (this.subscriptions.get(event.externalScopeId) === subscription) {
          this.subscriptions.delete(event.externalScopeId);
        }
      });
    // Errors from the error handler itself must not become unhandled rejections.
    void subscription.task.catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [scopeId, subscription] of this.subscriptions) { this.cancel(scopeId, subscription); }
    await Promise.allSettled([...this.retiring]);
  }

  resume(): void { this.stopped = false; }

  private cancel(scopeId: string, subscription: Subscription): void {
    subscription.controller.abort();
    this.subscriptions.delete(scopeId);
    const cleanup = Promise.allSettled([subscription.task, subscription.delivery?.stop()])
      .then(() => undefined);
    this.retiring.add(cleanup);
    void cleanup.finally(() => this.retiring.delete(cleanup));
  }

  private async run(event: InboundTextEvent, subscription: Subscription): Promise<void> {
    let failures = 0;
    while (!subscription.controller.signal.aborted) {
      try {
        await this.observe(event, subscription);
        if (subscription.controller.signal.aborted) { return; }
      } catch (error) {
        if (subscription.controller.signal.aborted) { return; }
        failures += 1;
        if (failures === 1 || failures % 10 === 0) {
          try { await this.options.onError(error, event); } catch { /* Keep recovering if the notification also fails. */ }
        }
      }
      await subscription.delivery?.stop();
      subscription.delivery = null;
      subscription.turnId = null;
      subscription.finalText = '';
      await waitForRetry(Math.min(this.options.retryMaxMs ?? 60_000,
        (this.options.retryBaseMs ?? 5_000) * 2 ** Math.min(Math.max(0, failures - 1), 10)), subscription.controller.signal);
      const target = this.options.coordinator.resolveDesktopSharedThread?.(event);
      if (!target || desktopThreadBindingKey(target) !== subscription.key) {
        this.cancel(event.externalScopeId, subscription);
      }
    }
  }

  private async observe(event: InboundTextEvent, subscription: Subscription): Promise<void> {
    const signal = subscription.controller.signal;
    await this.options.coordinator.observeDesktopSharedThread!(event, {
      signal,
      onEvent: async (update) => {
        if (signal.aborted) { return; }
        const current = this.options.coordinator.resolveDesktopSharedThread?.(event);
        if (!current || desktopThreadBindingKey(current) !== subscription.key) {
          this.cancel(event.externalScopeId, subscription);
          return;
        }
        if (subscription.turnId !== update.turnId) {
          await subscription.delivery?.stop();
          subscription.turnId = update.turnId;
          subscription.finalText = '';
          subscription.delivery = this.options.createDelivery(event, signal, { bindingKey: subscription.key, turnId: update.turnId });
        }
        if (update.kind === 'progress') {
          const outputKind = update.outputKind ?? 'commentary';
          const delta = outputKind === 'final_answer'
            ? `${subscription.finalText ? '\n\n' : ''}${update.text}`
            : `${update.text}\n\n`;
          if (outputKind === 'final_answer') { subscription.finalText += delta; }
          await subscription.delivery!.progress({
            text: outputKind === 'final_answer' ? subscription.finalText : update.text,
            delta, outputKind,
          });
        } else if (update.kind === 'complete' || update.kind === 'failed') {
          const text = update.kind === 'complete'
            && (!update.text || subscription.finalText.endsWith(update.text))
            ? subscription.finalText : update.text;
          await subscription.delivery!.finish({ ...update, text });
          await subscription.delivery!.stop();
          subscription.turnId = null;
          subscription.delivery = null;
        }
      },
    });
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) { return Promise.resolve(); }
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function desktopThreadBindingKey(target: DesktopSharedThreadTarget): string {
  const legacy = [target.providerProfileId, target.bridgeSessionId, target.threadId].join(':');
  return target.desktopTargetKey ? target.desktopTargetKey + ':' + legacy : legacy;
}
