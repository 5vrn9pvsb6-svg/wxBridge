import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DesktopOutputQueue, type DesktopOutputIdentity } from '../../src/runtime/desktop_output_queue.js';

const identity: DesktopOutputIdentity = { event: { platform: 'weixin', externalScopeId: 'wx' }, bindingKey: 'codex:thread', turnId: 'turn', cwd: null };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(predicate(), 'condition should become true without incoming messages');
}

test('failed sends retry automatically, preserve order and retain a completion produced while offline', async context => {
  const events: string[] = [];
  let online = false;
  let attempts = 0;
  const queue = new DesktopOutputQueue({ isCurrent: () => true, retryBaseMs: 5, retryMaxMs: 10, onError: async () => {},
    deliver: async turn => {
      attempts++;
      if (!online) { throw new Error('send rejected: -2'); }
      events.push(turn.segments.map(item => item.text).join('|') + ':' + turn.completion?.text);
      return true;
    },
  });
  context.after(() => queue.stop());
  await queue.segment(identity, 'commentary', 'progress');
  await queue.segment(identity, 'final_answer', 'result');
  await queue.complete(identity, { kind: 'complete', text: 'result', durationMs: 90000 });
  assert.equal(events.length, 0);
  online = true;
  await until(() => events.length === 1);
  assert.deepEqual(events, ['progress|result:result']);
  assert.ok(attempts >= 2);
});

test('persistent queue resumes a completed turn after restart and clears private pending text once delivered', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-outbox-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'outbox.json');
  const queue = new DesktopOutputQueue({ filePath, isCurrent: () => true, retryBaseMs: 10000,
    deliver: async () => false, onError: async () => {},
  });
  await queue.segment(identity, 'final_answer', 'private pending result');
  await queue.complete(identity, { kind: 'complete', text: 'private pending result', durationMs: 1234 });
  await queue.stop();
  assert.match(fs.readFileSync(filePath, 'utf8'), /private pending result/);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(filePath).mode & 0o777, 0o600); }
  const received: any[] = [];
  const restored = new DesktopOutputQueue({ filePath, isCurrent: () => true,
    deliver: async turn => { received.push(turn); return true; }, onError: async () => {},
  });
  context.after(() => restored.stop());
  restored.resume();
  await until(() => received.length === 1);
  assert.equal(received[0].completion.durationMs, 1234);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).turns, []);
});

test('binding changes cancel pending sends and do not leak the old queue to a new conversation', async context => {
  let current = identity.bindingKey;
  const sent: string[] = [];
  let attempts = 0;
  const queue = new DesktopOutputQueue({ isCurrent: item => item.bindingKey === current, retryBaseMs: 10,
    deliver: async turn => { attempts++; if (turn.bindingKey === identity.bindingKey) { return false; } sent.push(turn.bindingKey); return true; },
    onError: async () => {},
  });
  context.after(() => queue.stop());
  await queue.segment(identity, 'final_answer', 'old result');
  current = 'claude:new-thread';
  queue.reconcile();
  await queue.complete({ ...identity, bindingKey: current }, { kind: 'complete', text: 'new result' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(attempts, 2);
  assert.deepEqual(sent, [current]);
});

test('a failed scope does not block delivery to another scope and stopping cancels scheduled retries', async () => {
  let failedAttempts = 0;
  let successful = 0;
  const queue = new DesktopOutputQueue({ isCurrent: () => true, retryBaseMs: 5,
    deliver: async turn => {
      if (turn.event.externalScopeId === 'wx') { failedAttempts++; return false; }
      successful++; return true;
    }, onError: async () => {},
  });
  await queue.segment(identity, 'commentary', 'offline');
  await queue.complete({ ...identity, event: { platform: 'weixin', externalScopeId: 'another' } }, { kind: 'complete', text: 'online' });
  assert.equal(successful, 1);
  await queue.stop();
  const before = failedAttempts;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(failedAttempts, before);
});

test('an in-flight snapshot cannot erase a completion enqueued while it is being delivered', async context => {
  let release: () => void;
  let started: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const delivered: Array<boolean> = [];
  const queue = new DesktopOutputQueue({ isCurrent: () => true, onError: async () => {},
    deliver: async turn => { started!(); await gate; delivered.push(Boolean(turn.completion)); return true; },
  });
  context.after(() => queue.stop());
  const progress = queue.segment(identity, 'final_answer', 'final');
  await entered;
  const completion = queue.complete(identity, { kind: 'complete', text: 'final' });
  release!();
  await Promise.all([progress, completion]);
  assert.deepEqual(delivered, [false, true]);
});

test('rejects corrupt queues and oversized entries without dropping previously queued output', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-outbox-validation-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'outbox.json');
  const options = { filePath, isCurrent: () => true, deliver: async () => false, onError: async () => {} };
  const queue = new DesktopOutputQueue(options);
  context.after(() => queue.stop());
  await queue.segment(identity, 'commentary', 'keep this');
  const saved = fs.readFileSync(filePath, 'utf8');
  await assert.rejects(queue.segment(identity, 'final_answer', 'x'.repeat(1024 * 1024)), /size limit/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), saved);
  fs.writeFileSync(filePath, JSON.stringify({version: 1, turns: [{ key: 'bad' }] }));
  assert.throws(() => new DesktopOutputQueue(options), /Invalid desktop output queue/);
});

test('a failed acknowledgement write backs off instead of spinning and resumes after storage recovers', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-outbox-storage-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'outbox.json');
  let attempts = 0;
  let failures = 0;
  const queue = new DesktopOutputQueue({ filePath, isCurrent: () => true, retryBaseMs: 5, retryMaxMs: 100,
    onError: () => { failures++; },
    deliver: async () => {
      attempts++;
      if (attempts === 1) {
        // An unwritable destination simulates an atomic rename failing after delivery.
        fs.renameSync(filePath, `${filePath}.saved`);
        fs.mkdirSync(filePath);
      }
      return true;
    },
  });
  context.after(() => queue.stop());
  await queue.complete(identity, { kind: 'complete', text: 'preserved result' });
  assert.equal(failures, 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(attempts, 1, 'storage errors must not cause rapid repeat sends');
  fs.rmdirSync(filePath);
  fs.renameSync(`${filePath}.saved`, filePath);
  await until(() => attempts === 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).turns, []);
});
