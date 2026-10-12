import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopThreadSync } from '../../src/runtime/desktop_thread_sync.js';

test('changing desktop target cancels its observer and gives the new target separate delivery acknowledgements', async () => {
  let target = { threadId: 'same-thread', bridgeSessionId: 'same-session', providerProfileId: 'codex', desktopTargetKey: 'windows' };
  const observers: any[] = [];
  const keys: string[] = [];
  const sync = new DesktopThreadSync({
    coordinator: {
      resolveDesktopSharedThread: () => target,
      observeDesktopSharedThread: async (_event, options) => {
        observers.push(options);
        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    },
    createDelivery: (_event, _signal, identity) => {
      keys.push(identity.bindingKey);
      return { progress: async () => {}, finish: async () => {}, stop: async () => {} };
    },
    onError: async error => assert.fail(String(error)),
  });
  const event = { platform: 'weixin', externalScopeId: 'chat', text: '' } as any;
  sync.reconcile(event);
  await observers[0].onEvent({ kind: 'progress', turnId: 'turn', text: 'result' });
  target = { ...target, desktopTargetKey: 'wsl-ubuntu' };
  sync.reconcile(event);
  assert.equal(observers[0].signal.aborted, true);
  await observers[1].onEvent({ kind: 'progress', turnId: 'turn', text: 'result' });
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  await sync.stop();
  assert.equal(observers[1].signal.aborted, true);
});

test('observer read failures reconnect automatically and stop cancels future reconnects', async () => {
  let attempts = 0;
  let errors = 0;
  const delivered: string[] = [];
  const sync = new DesktopThreadSync({
    coordinator: {
      resolveDesktopSharedThread: () => ({ threadId: 'thread', bridgeSessionId: 'session', providerProfileId: 'claude-code' }),
      observeDesktopSharedThread: async (_event, { signal, onEvent }) => {
        attempts++;
        if (attempts === 1) { throw new Error('temporarily unreadable transcript'); }
        await onEvent({ kind: 'progress', turnId: 'turn', text: 'recovered' });
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    },
    createDelivery: () => ({ progress: async progress => { delivered.push(progress.text); }, finish: async () => {}, stop: async () => {} }),
    onError: async () => { errors++; throw new Error('notification also unavailable'); },
    retryBaseMs: 5, retryMaxMs: 10,
  });
  sync.reconcile({ platform: 'weixin', externalScopeId: 'chat', text: '' });
  const deadline = Date.now() + 1000;
  while (!delivered.length && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.deepEqual(delivered, ['recovered']);
  assert.equal(attempts, 2);
  assert.equal(errors, 1);
  await sync.stop();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 2);
});
