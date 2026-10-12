import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WeixinPlatformPlugin } from '../../../src/platforms/weixin/plugin.js';
import { WeixinPoller } from '../../../src/platforms/weixin/poller.js';
import { DesktopOutputQueue } from '../../../src/runtime/desktop_output_queue.js';
import { getContextToken, setContextToken, _resetContextTokenStoreForTest } from '../../../src/platforms/weixin/official/context_tokens.js';
import { logWeixinDelivery } from '../../../src/platforms/weixin/delivery_diagnostics.js';

function harness(context: any) {
  _resetContextTokenStoreForTest();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-context-recovery-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = new WeixinPlatformPlugin({ chunkIntervalMs: 0, sleepImpl: async () => {},
    config: { enabled: true, accountId: 'bot', token: 'account-secret', baseUrl: 'https://example.test',
      cdnBaseUrl: 'https://example.test', dmPolicy: 'allowlist', allowFrom: ['user'], groupPolicy: 'disabled',
      groupAllowFrom: [], stateDir: root, accountsDir: root, maxMessageLength: 4000 },
  });
  setContextToken(root, 'bot', 'user', 'old-context');
  return { plugin, root };
}

test('context-only envelopes recover queued output without creating an inbound model turn', async context => {
  const { plugin, root } = harness(context);
  const sent: string[] = [];
  plugin.client = {
    getUpdates: async () => ({ ret: 0, get_updates_buf: 'next', msgs: [{ from_user_id: 'user',
      to_user_id: 'bot', message_type: 1, context_token: 'fresh-context', item_list: [] }] }),
    sendMessage: async ({ contextToken, text }: any) => {
      if (contextToken !== 'fresh-context') { return { ret: -2 }; }
      sent.push(text); return { ret: 0 };
    },
  } as any;
  const queue = new DesktopOutputQueue({ isCurrent: () => true, retryBaseMs: 60000, onError: () => {},
    deliver: async () => (await plugin.sendText({ externalScopeId: 'user', content: 'pending result' })).success,
  });
  context.after(() => queue.stop());
  await queue.complete({ event: { platform: 'weixin', externalScopeId: 'user' }, bindingKey: 'shared', turnId: 'turn', cwd: null },
    { kind: 'complete', text: 'pending result', durationMs: 1000 });
  assert.deepEqual(sent, []);
  let inboundTurns = 0;
  const poller = new WeixinPoller({ plugin: { pollOnce: params => plugin.pollOnce(params),
    commitSyncCursor: async cursor => { await plugin.commitSyncCursor(cursor); } },
    onContextUpdated: scope => { queue.wake({ platform: 'weixin', externalScopeId: scope }); poller.stop(); },
    onEvent: () => { inboundTurns++; },
  });
  await poller.start();
  const deadline = Date.now() + 1000;
  while (!sent.length && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.deepEqual(sent, ['pending result'], 'fresh context should wake the queue before its 60-second timer');
  assert.equal(inboundTurns, 0);
  assert.equal(getContextToken(root, 'bot', 'user'), 'fresh-context');
  assert.deepEqual((await plugin.pollOnce()).contextUpdatedScopes, [], 'same token should not repeatedly wake delivery');
});

test('unsupported content still refreshes context; blocked senders and bot echoes cannot overwrite it', async context => {
  const { plugin, root } = harness(context);
  assert.equal(await plugin.normalizeInboundEvent({ from_user_id: 'user', context_token: 'new-context', item_list: [{ type: 999 }] }), null);
  assert.equal(getContextToken(root, 'bot', 'user'), 'new-context');
  for (const message of [
    { from_user_id: 'blocked', context_token: 'bad' },
    { from_user_id: 'bot', context_token: 'bad' },
    { from_user_id: 'user', message_type: 2, context_token: 'bad' },
  ]) { assert.equal(await plugin.normalizeInboundEvent(message), null); }
  assert.equal(getContextToken(root, 'bot', 'user'), 'new-context');
  assert.equal(getContextToken(root, 'bot', 'blocked'), null);
});

test('safe delivery diagnostics contain timestamps and result codes without raw credentials or identities', () => {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((value: string) => { lines.push(value); return true; }) as any;
  try {
    logWeixinDelivery('send_result', { scopeId: 'private-user', contextToken: 'secret-context', clientId: 'private-client', ret: -2 });
  } finally { process.stderr.write = original; }
  assert.match(lines.join(''), /"timestamp":/);
  assert.match(lines.join(''), /"ret":-2/);
  assert.doesNotMatch(lines.join(''), /private-user|secret-context|private-client/);
});
