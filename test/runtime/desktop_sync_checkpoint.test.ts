import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopSyncCheckpointStore, desktopSyncKey } from '../../src/runtime/desktop_sync_checkpoint.js';
import { deliverDesktopSegment } from '../../src/runtime/desktop_segment_delivery.js';

test('desktop segment restart retries a failed chunk while retaining acknowledgements and scope isolation', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-checkpoint-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'checkpoint.json');
  const key = desktopSyncKey('weixin', 'scope', 'binding', 'turn');
  const text = `${'第一段。'.repeat(160)}\n\n${'第二段。'.repeat(160)}`;
  const sent: string[] = [];
  let attempts = 0;
  await assert.rejects(deliverDesktopSegment({
    store: new DesktopSyncCheckpointStore(file), key, text, phase: 'commentary', signal: new AbortController().signal,
    send: async (chunk) => {
      attempts += 1;
      if (attempts === 2) { return { success: false, error: 'simulated delivery failure' }; }
      sent.push(chunk);
      return { success: true, error: '' };
    },
  }), /simulated delivery failure/);
  const acknowledged = sent[0];
  const restored = new DesktopSyncCheckpointStore(file);
  await deliverDesktopSegment({ store: restored, key, text, phase: 'commentary', signal: new AbortController().signal,
    send: async (chunk) => { sent.push(chunk); return { success: true, error: '' }; } });
  assert.equal(sent.filter((chunk) => chunk === acknowledged).length, 1);
  assert.equal(sent.length, 2);
  await deliverDesktopSegment({ store: restored, key: desktopSyncKey('weixin', 'different-scope', 'binding', 'turn'),
    text, phase: 'commentary', signal: new AbortController().signal,
    send: async (chunk) => { sent.push(chunk); return { success: true, error: '' }; } });
  assert.equal(sent.length, 4);
  // Windows does not expose separate owner/group/other permission bits.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(directory), ['checkpoint.json']);
});

test('desktop checkpoint rejects corrupt state rather than silently replaying and cancellation retains an in-flight acknowledgement', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-checkpoint-abort-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'checkpoint.json');
  const key = desktopSyncKey('scope', 'turn');
  const controller = new AbortController();
  const result = await deliverDesktopSegment({ store: new DesktopSyncCheckpointStore(file), key, text: '完整消息。',
    phase: 'commentary', signal: controller.signal,
    send: async () => { controller.abort(); return { success: true, error: '' }; } });
  assert.equal(result, false);
  await deliverDesktopSegment({ store: new DesktopSyncCheckpointStore(file), key, text: '完整消息。',
    phase: 'commentary', signal: new AbortController().signal,
    send: async () => assert.fail('an acknowledged in-flight send must not replay') });
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new DesktopSyncCheckpointStore(file));
});

test('desktop segment delivery honors a smaller configured WeChat message limit', async () => {
  const sent: string[] = [];
  await deliverDesktopSegment({
    store: new DesktopSyncCheckpointStore(), key: desktopSyncKey('scope', 'turn'),
    text: '准备更新 rc.129。\n继续验证 10.0.6.91。', phase: 'commentary',
    signal: new AbortController().signal, maxMessageLength: 32,
    send: async (chunk) => { sent.push(chunk); return { success: true, error: '' }; },
  });
  assert.ok(sent.length > 1);
  assert.ok(sent.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 32));
  assert.ok(sent.join('\n').includes('rc.129') && sent.join('\n').includes('10.0.6.91'));
});
