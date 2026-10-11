import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WeixinBridgeRuntime } from '../../src/runtime/weixin_bridge_runtime.js';

function fixture(context: { after: (callback: () => void) => void }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-linked-runtime-'));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const report = path.join(cwd, 'report.zh-CN.md');
  fs.writeFileSync(report, '# 报告\n\n11 台设备未返回审计。');
  const answer = `完整分析已保存到[分析报告](${report})。`;
  const texts: string[] = [];
  const files: string[] = [];
  const create = (coordinator: any) => new WeixinBridgeRuntime({
    bridgeCoordinator: coordinator,
    desktopSyncCheckpointPath: path.join(cwd, 'checkpoint.json'),
    previewIntervalMs: 0,
    internalThreadCleanupMs: 0,
    platformPlugin: {
      async start() {}, async stop() {}, async pollOnce() { return { events: [] }; },
      async sendText({ content }) {
        texts.push(content);
        return { success: true, deliveredCount: 1, deliveredText: content, failedIndex: null, failedText: '', error: '' };
      },
      async sendMedia({ filePath }) {
        assert.equal(path.basename(filePath), 'report.zh-CN.md');
        files.push(fs.readFileSync(filePath, 'utf8'));
        return { success: true, messageId: 'sent', sentPath: filePath, sentCaption: '', error: '' };
      },
    },
  });
  return { cwd, answer, texts, files, create };
}

function complete(text: string, shared = false) {
  return { type: 'message', messages: [{ text }], meta: { codexTurn: {
    outputState: 'complete', finalSource: shared ? 'desktop_rollout' : 'thread_items', durationMs: 65000,
  } } };
}

test('independent WeChat replies send a linked report as a readable attachment without changing the answer', async (context) => {
  const { cwd, answer, texts, files, create } = fixture(context);
  const runtime = create({
    resolveOutputWorkspace() { return cwd; },
    async handleInboundEvent(_event: any, { onTurnStarted, onProgress }: any) {
      await onTurnStarted({ turnId: 'independent', threadId: 'one' });
      await onProgress({ text: answer, delta: answer, outputKind: 'final_answer' });
      return complete(answer);
    },
  });
  context.after(() => runtime.stop());
  await runtime.processInboundEvent({ platform: 'weixin', externalScopeId: 'wx', text: '分析报告' });
  assert.deepEqual(texts, [answer]);
  assert.deepEqual(files, ['# 报告\n\n11 台设备未返回审计。']);
});

test('desktop-started final links survive already-streamed text and replay without duplicate attachments or completion notices', async (context) => {
  const { cwd, answer, texts, files, create } = fixture(context);
  let callback: any;
  const coordinator = {
    resolveOutputWorkspace() { return cwd; },
    resolveDesktopSharedThread() { return { threadId: 'desktop', bridgeSessionId: 'shared', providerProfileId: 'openai-default' }; },
    async handleInboundEvent() { return { type: 'message', messages: [{ text: 'entered' }] }; },
    async observeDesktopSharedThread(_event: any, { onEvent, signal }: any) {
      callback = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
  for (let restart = 0; restart < 2; restart += 1) {
    const runtime = create(coordinator);
    await runtime.processInboundEvent({ platform: 'weixin', externalScopeId: 'wx', text: '/enter 2' });
    await callback({ kind: 'started', turnId: 'pc-turn', text: '' });
    await callback({ kind: 'progress', turnId: 'pc-turn', outputKind: 'final_answer', text: answer });
    await callback({ kind: 'complete', turnId: 'pc-turn', text: answer, durationMs: 65000 });
    await runtime.stop();
  }
  assert.equal(texts.filter((text) => text === answer).length, 1);
  assert.equal(texts.filter((text) => text.includes('本轮回复已结束，耗时：1分5秒')).length, 1);
  assert.equal(files.length, 1);
});

test('WeChat-submitted shared turns reuse file acknowledgements when the desktop observer replays them', async (context) => {
  const { cwd, answer, texts, files, create } = fixture(context);
  const target = { threadId: 'desktop', bridgeSessionId: 'shared', providerProfileId: 'openai-default' };
  const first = create({
    resolveOutputWorkspace() { return cwd; },
    resolveDesktopSharedThread() { return target; },
    async handleInboundEvent(_event: any, { onTurnStarted, onProgress }: any) {
      await onTurnStarted({ turnId: 'own', threadId: target.threadId });
      await onProgress({ text: answer, delta: answer, outputKind: 'final_answer' });
      return complete(answer, true);
    },
  });
  await first.processInboundEvent({ platform: 'weixin', externalScopeId: 'wx', text: '报告' });
  await first.stop();
  let callback: any;
  const restored = create({
    resolveOutputWorkspace() { return cwd; },
    resolveDesktopSharedThread() { return target; },
    async handleInboundEvent() { return { type: 'message', messages: [{ text: 'entered' }] }; },
    async observeDesktopSharedThread(_event: any, { onEvent, signal }: any) {
      callback = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  context.after(() => restored.stop());
  await restored.processInboundEvent({ platform: 'weixin', externalScopeId: 'wx', text: '/enter 2' });
  await callback({ kind: 'progress', turnId: 'own', outputKind: 'final_answer', text: answer });
  await callback({ kind: 'complete', turnId: 'own', text: answer, durationMs: 65000 });
  assert.equal(texts.filter((text) => text === answer).length, 1);
  assert.equal(texts.filter((text) => text.includes('本轮回复已结束')).length, 1);
  assert.equal(files.length, 1);
});

test('browsing historical replies does not automatically send their local files', async (context) => {
  const { cwd, answer, files, create } = fixture(context);
  const runtime = create({
    resolveOutputWorkspace() { return cwd; },
    async handleInboundEvent() { return { type: 'message', messages: [{ text: answer }] }; },
  });
  context.after(() => runtime.stop());
  await runtime.processInboundEvent({ platform: 'weixin', externalScopeId: 'wx', text: '/peek 2' });
  assert.equal(files.length, 0);
});

test('a missing shared report gets a separate failure notice and still reports completion and elapsed time', async (context) => {
  const { cwd, texts, files, create } = fixture(context);
  const answer = '[未生成报告](missing.md)';
  const target = { threadId: 'desktop', bridgeSessionId: 'shared', providerProfileId: 'claude-code' };
  const runtime = create({
    resolveOutputWorkspace() { return cwd; },
    resolveDesktopSharedThread() { return target; },
    async handleInboundEvent(_event: any, { onTurnStarted }: any) {
      await onTurnStarted({ turnId: 'own', threadId: target.threadId });
      return complete(answer, true);
    },
  });
  context.after(() => runtime.stop());
  await runtime.processInboundEvent({ platform: 'weixin', externalScopeId: 'wx', text: '报告' });
  assert.equal(files.length, 0);
  assert.equal(texts[0], answer);
  assert.match(texts[1], /文件不存在/);
  assert.match(texts[2], /本轮回复已结束，耗时：1分5秒/);
});
