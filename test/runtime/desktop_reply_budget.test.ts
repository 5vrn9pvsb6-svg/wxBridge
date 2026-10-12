import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WeixinPlatformPlugin } from '../../src/platforms/weixin/plugin.js';
import type { WeixinConfig } from '../../src/platforms/weixin/config.js';
import { WeixinReplyBudget } from '../../src/platforms/weixin/reply_budget.js';
import { setContextToken, _resetContextTokenStoreForTest } from '../../src/platforms/weixin/official/context_tokens.js';
import { WeixinBridgeRuntime } from '../../src/runtime/weixin_bridge_runtime.js';
import { desktopThreadBindingKey } from '../../src/runtime/desktop_thread_sync.js';
import { DesktopSyncCheckpointStore, desktopSyncKey } from '../../src/runtime/desktop_sync_checkpoint.js';
import { deliverDesktopProgress, deliverDesktopSegment } from '../../src/runtime/desktop_segment_delivery.js';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(predicate(), 'expected output within the bounded test interval');
}

function harness(context: any, providerProfileId = 'codex') {
  _resetContextTokenStoreForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-reply-budget-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config: WeixinConfig = { enabled: true, accountId: 'bot', token: 'synthetic-secret', baseUrl: 'https://example.test',
    cdnBaseUrl: 'https://example.test', dmPolicy: 'allowlist', allowFrom: ['user'], groupPolicy: 'disabled',
    groupAllowFrom: [], stateDir: root, accountsDir: root, maxMessageLength: 4000 };
  const sent: Array<{ text: string; token: string; id: string }> = [];
  let rejected = 0;
  const createPlugin = () => {
    const plugin = new WeixinPlatformPlugin({ config, chunkIntervalMs: 0 });
    plugin.client = { sendMessage: async ({ contextToken, text, clientId }: any) => {
      if (sent.filter(item => item.token === contextToken).length >= 10) { rejected++; return { ret: -2 }; }
      sent.push({ text, token: contextToken, id: clientId }); return { ret: 0 };
    } } as any;
    return plugin;
  };
  setContextToken(root, 'bot', 'user', 'context-one');
  const plugin = createPlugin();
  const target = { providerProfileId, threadId: 'thread', bridgeSessionId: 'session' };
  const identity = { event: { platform: 'weixin', externalScopeId: 'user' }, bindingKey: desktopThreadBindingKey(target), turnId: 'turn', cwd: null };
  const createRuntime = (platformPlugin = plugin, batchMs = 10) => new WeixinBridgeRuntime({ platformPlugin,
    bridgeCoordinator: { resolveDesktopSharedThread: () => target, async handleInboundEvent() { return { type: 'message', messages: [{ text: 'status' }] }; } },
    desktopSyncCheckpointPath: path.join(root, 'checkpoint.json'), desktopSyncOutboxPath: path.join(root, 'outbox.json'),
    desktopSyncProgressBatchMs: batchMs, desktopSyncRetryBaseMs: 10, desktopSyncRetryMaxMs: 20,
  });
  return { root, plugin, createPlugin, identity, createRuntime, sent, rejected: () => rejected };
}

for (const provider of ['codex', 'claude-code']) {
  test(`${provider}: progress batches preserve the result and elapsed-time budget under a ten-send server quota`, async context => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const tick = async (ms: number) => { context.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); };
    const h = harness(context, provider);
    const runtime = h.createRuntime(h.plugin, 30_000); context.after(() => runtime.stop());
    await h.plugin.sendText({ externalScopeId: 'user', content: 'entered' });
    for (let index = 0; index < 20; index++) { await runtime.desktopOutputQueue.segment(h.identity, 'commentary', `片段 ${index}。`); }
    assert.equal(h.sent.length, 1, 'progress must wait for the batching window');
    await tick(29_999);
    assert.equal(h.sent.length, 1);
    await tick(1);
    assert.equal(h.sent.length, 2);
    for (let index = 0; index < 20; index++) { assert.ok(h.sent[1].text.includes(`片段 ${index}。`)); }
    for (let index = 0; index < 5; index++) {
      await runtime.desktopOutputQueue.segment(h.identity, 'commentary', `后续进度 ${index}。`);
      await tick(30_000);
      assert.equal(h.sent.length, index + 3);
    }
    assert.equal(h.sent.length, 7);
    assert.equal(h.sent.filter(item => item.text.includes('发送 /status')).length, 1);
    for (let index = 0; index < 15; index++) { await runtime.desktopOutputQueue.segment(h.identity, 'commentary', `暂存进度 ${index}`); }
    await tick(30_000);
    assert.equal(h.sent.length, 7, 'progress must leave three sends for the result and completion');
    await runtime.desktopOutputQueue.complete(h.identity, { kind: 'complete', text: '最终结果：验证通过。', durationMs: 125000 });
    assert.equal(h.sent.length, 9);
    assert.equal(h.sent[7].text, '最终结果：验证通过。');
    assert.equal(h.sent[8].text, '本轮回复已结束，耗时：2分5秒。');
    assert.equal(h.rejected(), 0, 'local budgeting must avoid exhausting the server quota');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.root, 'outbox.json'), 'utf8')).turns, []);
  });
}

test('a long final result sends completion on the last slot and resumes after a fresh context without duplicates', async context => {
  const h = harness(context);
  const runtime = h.createRuntime(); context.after(() => runtime.stop());
  for (let index = 0; index < 7; index++) { await h.plugin.sendText({ externalScopeId: 'user', content: `prior ${index}` }); }
  const final = Array.from({ length: 4 }, (_, index) => `结果 ${index}：${'内容'.repeat(280)}。`).join('\n\n');
  await runtime.desktopOutputQueue.complete(h.identity, { kind: 'complete', text: final, durationMs: 3000 });
  assert.equal(h.sent.length, 10);
  assert.match(h.sent[9].text, /本轮回复已结束，耗时：3秒/);
  assert.match(h.sent[9].text, /部分结果仍在等待/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, 'outbox.json'), 'utf8')).turns.length, 1);
  const firstChunks = h.sent.slice(7, 9).map(item => item.text);
  await h.plugin.normalizeInboundEvent({ from_user_id: 'user', context_token: 'context-two', item_list: [] });
  runtime.desktopOutputQueue.wake(h.identity.event);
  await until(() => JSON.parse(fs.readFileSync(path.join(h.root, 'outbox.json'), 'utf8')).turns.length === 0);
  for (const chunk of firstChunks) { assert.equal(h.sent.filter(item => item.text === chunk).length, 1); }
  assert.equal(h.sent.filter(item => item.text.includes('本轮回复已结束')).length, 1);
  assert.equal(h.sent.slice(7).filter(item => !item.text.includes('本轮回复')).map(item => item.text).join('\n\n'), final);
  assert.equal(h.rejected(), 0);
});

test('progress budget and frozen batch survive restart; duplicate context envelopes do not replenish it', async context => {
  const h = harness(context);
  for (let index = 0; index < 7; index++) { await h.plugin.sendText({ externalScopeId: 'user', content: `prior ${index}` }); }
  const runtime = h.createRuntime(h.plugin, 0);
  await runtime.desktopOutputQueue.segment(h.identity, 'commentary', '未发进度');
  await runtime.stop();
  const plugin = h.createPlugin();
  await plugin.normalizeInboundEvent({ from_user_id: 'user', context_token: 'context-one', item_list: [] });
  const blocked = await plugin.sendText({ externalScopeId: 'user', content: '进度', deliveryId: 'shared-id', deliveryPurpose: 'progress' });
  assert.equal(blocked.deferred, true);
  assert.equal(h.sent.length, 7);
  const restored = h.createRuntime(plugin, 0); context.after(() => restored.stop());
  restored.desktopOutputQueue.resume();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.sent.length, 7);
  await plugin.normalizeInboundEvent({ from_user_id: 'user', context_token: 'context-two', item_list: [] });
  restored.desktopOutputQueue.wake(h.identity.event);
  await until(() => h.sent.length === 8);
  assert.equal(h.sent[7].text, '未发进度');
  const budget = fs.readFileSync(path.join(h.root, 'bot.reply-budget.json'), 'utf8');
  for (const secret of ['context-one', 'context-two', '未发进度', 'synthetic-secret']) { assert.ok(!budget.includes(secret)); }
  if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(h.root, 'bot.reply-budget.json')).mode & 0o777, 0o600); }
});

test('frozen progress retry keeps the same body and ID when more output arrives, and obeys UTF-8 wire size', async context => {
  const h = harness(context);
  const file = path.join(h.root, 'batch.json');
  const key = desktopSyncKey('scope', 'turn');
  const attempts: Array<{ text: string; id: string }> = [];
  const options = { key, signal: new AbortController().signal, maxMessageLength: 4000 };
  await assert.rejects(deliverDesktopProgress({ ...options, store: new DesktopSyncCheckpointStore(file), texts: ['原始进度。'],
    send: async (text, id) => { attempts.push({ text, id }); return { success: false, error: 'offline' }; } }), /offline/);
  await deliverDesktopProgress({ ...options, store: new DesktopSyncCheckpointStore(file), texts: ['原始进度。', '新进度。'.repeat(500)],
    send: async (text, id) => { attempts.push({ text, id }); return { success: true, error: '' }; } });
  assert.deepEqual(attempts[0], attempts[1]);
  assert.ok(attempts.slice(2).every(item => !item.text.includes('原始进度')));
  assert.ok(attempts.every(item => Buffer.byteLength(item.text, 'utf8') <= 1536));
  assert.equal(attempts.slice(2).map(item => item.text).join(''), '新进度。'.repeat(500));
});

test('reply budgets isolate chats and late acknowledgements for an old context', () => {
  const budget = new WeixinReplyBudget();
  for (let index = 0; index < 7; index++) { budget.acknowledge('chat', 'old', `id-${index}`); }
  budget.acknowledge('chat', 'old', 'id-0');
  assert.equal(budget.remaining('chat', 'old'), 3);
  assert.equal(budget.canSend('chat', 'old', 'progress'), false);
  assert.equal(budget.remaining('chat', 'new'), 10);
  assert.equal(budget.remaining('other-chat', 'old'), 10);
  budget.acknowledge('chat', 'new', 'new-id');
  budget.acknowledge('chat', 'old', 'late-id');
  assert.equal(budget.remaining('chat', 'new'), 9);
});

test('concurrent progress cannot overspend; media and caption successes count while rejected sends do not', async context => {
  const h = harness(context);
  let attempts = 0;
  const originalSend = h.plugin.client!.sendMessage;
  h.plugin.client!.sendMessage = async params => {
    if (attempts++ === 0) { return { ret: -2 }; }
    return originalSend(params);
  };
  const failed = await h.plugin.sendText({ externalScopeId: 'user', content: 'offline', deliveryId: 'retry-owned-by-outbox', deliveryPurpose: 'progress' });
  assert.equal(failed.success, false);
  assert.equal(h.plugin.replyBudget.remaining('user', 'context-one'), 10);
  h.plugin.client!.sendMediaFile = async () => ({ messageId: 'image-id', captionMessageId: 'caption-id' });
  await h.plugin.sendMedia({ externalScopeId: 'user', filePath: '/synthetic/image.png', caption: 'image' });
  assert.equal(h.plugin.replyBudget.remaining('user', 'context-one'), 8);
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => h.plugin.sendText({ externalScopeId: 'user',
    content: `progress ${index}`, deliveryId: `progress-${index}`, deliveryPurpose: 'progress' })));
  assert.equal(outcomes.filter(result => result.success).length, 5);
  assert.equal(outcomes.filter(result => result.deferred).length, 3);
  assert.equal(h.plugin.replyBudget.remaining('user', 'context-one'), 3);
  assert.equal(h.sent.filter(item => item.text.includes('发送 /status')).length, 1);
});

test('batching honors pre-upgrade individual chunk acknowledgements', async context => {
  const h = harness(context);
  const file = path.join(h.root, 'old-checkpoint.json');
  const key = desktopSyncKey('scope', 'turn');
  const text = '已发送的旧版进度。'.repeat(220);
  await deliverDesktopSegment({ store: new DesktopSyncCheckpointStore(file), key, text, phase: 'commentary',
    signal: new AbortController().signal, send: async () => ({ success: true, error: '' }) });
  const sent: string[] = [];
  await deliverDesktopProgress({ store: new DesktopSyncCheckpointStore(file), key, texts: [text, '新增进度'], maxMessageLength: 4000,
    signal: new AbortController().signal, send: async content => { sent.push(content); return { success: true, error: '' }; } });
  assert.deepEqual(sent, ['新增进度']);
});

test('completion notices keep retrying if the server recovers without a fresh context', async context => {
  const h = harness(context);
  let offline = true;
  let attempts = 0;
  h.plugin.client!.sendMessage = async () => { attempts++; return { ret: offline ? -2 : 0 }; };
  for (let index = 0; index < 10; index++) { h.plugin.replyBudget.acknowledge('user', 'context-one', `prior-${index}`); }
  const runtime = h.createRuntime(); context.after(() => runtime.stop());
  await runtime.desktopOutputQueue.complete(h.identity, { kind: 'complete', text: 'pending final', durationMs: 1200 });
  assert.equal(attempts, 1, 'completion must probe even when the local allowance estimate is zero');
  offline = false;
  await until(() => JSON.parse(fs.readFileSync(path.join(h.root, 'outbox.json'), 'utf8')).turns.length === 0);
  assert.equal(attempts, 3, 'retry completion, then deliver the retained final without requiring input');
});
