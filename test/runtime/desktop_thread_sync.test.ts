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
