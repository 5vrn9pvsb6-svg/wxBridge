import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WeixinBridgeRuntime } from '../../src/runtime/weixin_bridge_runtime.js';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(predicate(), 'queued output should recover automatically');
}

function harness(context: any, providerProfileId = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-output-recovery-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const event = { platform: 'weixin', externalScopeId: 'wechat-local-test', text: '/enter 2' };
  let shared = true;
  let online = true;
  let failNotice = false;
  let observer: any;
  let observerCount = 0;
  const sent: string[] = [];
  const attempts: Array<{ content: string; deliveryId?: string }> = [];
  const target = { threadId: 'thread', bridgeSessionId: 'session', providerProfileId };
  const coordinator = {
    resolveDesktopSharedThread: () => shared ? target : null,
    listDesktopSharedScopes: () => shared ? [event] : [],
    async handleInboundEvent(event: any, { onTurnStarted, onProgress }: any) {
      if (event.text === '/exit') { shared = false; return { type: 'message', messages: [{ text: 'exited' }] }; }
      if (event.text === 'own-turn') {
        await onTurnStarted({ turnId: 'own', threadId: target.threadId });
        await onProgress({ text: 'own progress', delta: 'own progress', outputKind: 'commentary' });
        await onProgress({ text: 'own result', delta: 'own result', outputKind: 'final_answer' });
        return { type: 'message', messages: [{ text: 'own result' }], meta: { codexTurn: {
          finalSource: 'desktop_rollout', outputState: 'complete', durationMs: 90000,
        } } };
      }
      return { type: 'message', messages: [{ text: 'entered' }] };
    },
    async observeDesktopSharedThread(_event: any, { signal, onEvent }: any) {
      observer = onEvent; observerCount++;
      if (!signal.aborted) { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
    },
  };
  const create = () => new WeixinBridgeRuntime({
    bridgeCoordinator: coordinator,
    desktopSyncCheckpointPath: path.join(root, 'checkpoint.json'),
    desktopSyncRetryBaseMs: 10, desktopSyncRetryMaxMs: 20, previewIntervalMs: 0, internalThreadCleanupMs: 0,
    platformPlugin: {
      async start() {}, async stop() {},
      async pollOnce() { await new Promise(resolve => setTimeout(resolve, 10)); return { events: [] }; },
      async sendText({ content, deliveryId }) {
        attempts.push({ content, deliveryId });
        const success = ['entered', 'exited'].includes(content) || (online && !(failNotice && content.includes('本轮回复')));
        if (success) { sent.push(content); }
        return { success, deliveredCount: success ? 1 : 0, deliveredText: success ? content : '', failedIndex: success ? null : 0,
          failedText: success ? '' : content, error: success ? '' : 'send rejected: -2', errorCode: success ? null : -2 };
      },
    },
  });
  return { create, event, sent, attempts, root, emit: (update: any) => observer(update), observers: () => observerCount,
    setOnline: (value: boolean) => { online = value; }, setFailNotice: (value: boolean) => { failNotice = value; } };
}

for (const provider of ['codex', 'claude-code']) {
test(`${provider}: offline desktop output including completion recovers without new input or resubscribing`, async context => {
  const h = harness(context, provider);
  const runtime = h.create(); context.after(() => runtime.stop());
  await runtime.processInboundEvent(h.event);
  h.setOnline(false);
  await h.emit({ kind: 'progress', turnId: 'pc', outputKind: 'commentary', text: 'progress' });
  await h.emit({ kind: 'progress', turnId: 'pc', outputKind: 'final_answer', text: 'final result' });
  await h.emit({ kind: 'complete', turnId: 'pc', text: 'final result', durationMs: 65000 });
  assert.deepEqual(h.sent, ['entered']);
  assert.equal(runtime.desktopThreadSync.isBusy(h.event.externalScopeId), false);
  h.setOnline(true);
  await until(() => h.sent.some(text => text.includes('本轮回复已结束')));
  assert.deepEqual(h.sent, ['entered', 'progress', 'final result', '本轮回复已结束，耗时：1分5秒。']);
  assert.equal(h.observers(), 1);
  const progressIds = h.attempts.filter(item => item.content === 'progress').map(item => item.deliveryId);
  assert.ok(progressIds.length > 1);
  assert.equal(new Set(progressIds).size, 1);
  assert.ok(progressIds[0]);
});

test(`${provider}: WeChat-started shared output finishes while delivery is offline and retries on its own`, async context => {
  const h = harness(context, provider);
  const runtime = h.create(); context.after(() => runtime.stop());
  h.setOnline(false);
  await runtime.processInboundEvent({ ...h.event, text: 'own-turn' });
  assert.deepEqual(h.sent, []);
  h.setOnline(true);
  await until(() => h.sent.some(text => text.includes('本轮回复已结束')));
  assert.deepEqual(h.sent, ['own progress', 'own result', '本轮回复已结束，耗时：1分30秒。']);
});
}

test('failed completion notices retry without resending already delivered text', async context => {
  const h = harness(context);
  const runtime = h.create(); context.after(() => runtime.stop());
  await runtime.processInboundEvent(h.event);
  h.setFailNotice(true);
  await h.emit({ kind: 'complete', turnId: 'pc', text: 'final result', durationMs: 2000 });
  assert.deepEqual(h.sent, ['entered', 'final result']);
  h.setFailNotice(false);
  await until(() => h.sent.length === 3);
  assert.deepEqual(h.sent, ['entered', 'final result', '本轮回复已结束，耗时：2秒。']);
});

test('startup restores an offline completed turn even when the provider has no active history to replay', async context => {
  const h = harness(context);
  const initial = h.create();
  await initial.processInboundEvent(h.event);
  h.setOnline(false);
  await h.emit({ kind: 'progress', turnId: 'pc', outputKind: 'final_answer', text: 'durable final' });
  await h.emit({ kind: 'complete', turnId: 'pc', text: 'durable final', durationMs: 1000 });
  await initial.stop();
  h.setOnline(true);
  const restored = h.create();
  const running = restored.start();
  context.after(async () => { await restored.stop(); await running; });
  await until(() => h.sent.some(text => text.includes('本轮回复已结束')));
  assert.deepEqual(h.sent, ['entered', 'durable final', '本轮回复已结束，耗时：1秒。']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.root, 'checkpoint.json.outbox.json'), 'utf8')).turns, []);
});

test('/exit discards queued old-session output and cancels retries', async context => {
  const h = harness(context);
  const runtime = h.create(); context.after(() => runtime.stop());
  await runtime.processInboundEvent(h.event);
  h.setOnline(false);
  await h.emit({ kind: 'complete', turnId: 'pc', text: 'do not send', durationMs: 1000 });
  await runtime.processInboundEvent({ ...h.event, text: '/exit' });
  h.setOnline(true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(h.sent, ['entered', 'exited']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.root, 'checkpoint.json.outbox.json'), 'utf8')).turns, []);
});
