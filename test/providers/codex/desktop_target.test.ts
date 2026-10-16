import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCodexDesktopTarget, desktopTargetIdentity, assertDesktopTarget, type CodexDesktopTarget } from '../../../src/providers/codex/desktop_target.js';
import { CodexDesktopSessionCatalog } from '../../../src/providers/codex/desktop_session_catalog.js';
import { CodexDesktopThreadRelay, createCodexDesktopThreadRelayFromEnv } from '../../../src/providers/codex/desktop_thread_relay.js';
import { CodexProviderPlugin } from '../../../src/providers/codex/plugin.js';

test('WSL2 requires explicit storage and preserves distro host routing', () => {
  assert.throws(() => resolveCodexDesktopTarget({ env: {}, platform: 'linux', release: '6.6-microsoft-standard-WSL2' }), /DESKTOP_HOME/u);
  const target = resolveCodexDesktopTarget({
    platform: 'linux', release: '6.6-microsoft-standard-WSL2',
    env: { CODEXBRIDGE_CODEX_DESKTOP_HOME: '/home/用户/.codex', CODEXBRIDGE_CODEX_DESKTOP_HOST_ID: 'remote-wsl:Ubuntu%20Work' },
  });
  assert.equal(target.hostId, 'remote-wsl:Ubuntu%20Work');
  assert.equal(target.endpoint, '\\\\.\\pipe\\codex-ipc');
  assert.equal(target.isWsl, true);
  assert.throws(() => resolveCodexDesktopTarget({ env: {}, platform: 'linux', release: '4.4-Microsoft' }), /WSL2/u);
  assert.throws(() => resolveCodexDesktopTarget({
    env: { CODEXBRIDGE_CODEX_DESKTOP_HOME: '/home/a', CODEXBRIDGE_CODEX_DESKTOP_HOST_ID: 'remote-wsl:bad%2Fname' },
    platform: 'linux', release: '6.6-microsoft-standard-WSL2',
  }), /主机标识/u);
});

test('Windows selects a local pipe and rejects network/relative configuration', () => {
  const target = resolveCodexDesktopTarget({ env: {}, platform: 'win32', userHome: 'C:\\Users\\Alice' });
  assert.equal(target.home, 'C:\\Users\\Alice\\.codex');
  for (const endpoint of ['\\\\server\\pipe\\codex-ipc', '\\\\.\\pipe\\..\\bad', 'http://localhost:9000']) {
    assert.throws(() => resolveCodexDesktopTarget({ env: { CODEXBRIDGE_CODEX_DESKTOP_IPC_SOCKET: endpoint }, platform: 'win32' }), /入口/u);
  }
  assert.throws(() => resolveCodexDesktopTarget({ env: { CODEXBRIDGE_CODEX_DESKTOP_HOME: 'relative' }, platform: 'win32' }), /绝对路径/u);
});

test('invalid shared configuration leaves the provider available for exit but rejects shared operations without an independent client', async () => {
  const relay = createCodexDesktopThreadRelayFromEnv({
    CODEXBRIDGE_CODEX_DESKTOP_SHARED_THREAD: '1', CODEXBRIDGE_CODEX_DESKTOP_HOME: 'relative',
  }, 'win32')!;
  const event: any = { platform: 'weixin', text: 'hello', metadata: { codexbridge: { executionMode: 'desktop_shared' } } };
  assert.equal(relay.isAvailableForEvent(event), true);
  const plugin = new CodexProviderPlugin({ desktopThreadRelay: relay, clientFactory: () => assert.fail('No independent app-server') });
  assert.throws(() => plugin.getDesktopTarget(), /绝对路径/u);
  await assert.rejects(plugin.listDesktopThreads({ providerProfile: {} as any }), /绝对路径/u);
  await assert.rejects(plugin.prepareDesktopThreadSharing({ threadId: 'thread-1' }), /绝对路径/u);
  await assert.rejects(plugin.startTurn({
    providerProfile: {} as any, bridgeSession: { codexThreadId: 'thread-1' } as any,
    sessionSettings: null, inputText: 'hello', event,
  }), /绝对路径/u);
});

test('desktop catalog pages verified rollouts and isolates target identity from the independent home', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-desktop-目录 '));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sessions'));
  const records: string[] = [];
  for (let i = 0; i < 13; i++) {
    const id = 'thread-' + i;
    fs.writeFileSync(path.join(root, 'sessions', 'rollout-' + id + '.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/home/project' } }) + '\n'
      + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '输入 ' + i } }) + '\n');
    records.push(JSON.stringify({ id, thread_name: '桌面 ' + i, updated_at: new Date(1_800_000_000_000 + i * 1000).toISOString() }));
  }
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), records.join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'sessions', 'rollout-fake.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: '../escape' } }) + '\n');
  const target: CodexDesktopTarget = { home: root, hostId: 'local', endpoint: path.join(root, 'ipc.sock'), platform: process.platform, isWsl: false, legacyCompatible: false };
  const catalog = new CodexDesktopSessionCatalog(target);
  const first = catalog.list();
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0].title, '桌面 12');
  assert.equal(catalog.list({ cursor: first.nextCursor }).items.length, 3);
  assert.equal(catalog.list({ searchTerm: '桌面 11' }).items.length, 1);
  assert.equal(catalog.read('fake'), null);
  assert.equal(catalog.read('thread-2')?.cwd, '/home/project');
  fs.appendFileSync(path.join(root, 'sessions', 'rollout-thread-2.jsonl'), [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'private' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }), '',
  ].join('\n'));
  assert.deepEqual(catalog.read('thread-2', true)?.turns?.[0].items.map(item => item.text), ['question', 'answer']);
  assert.equal(catalog.read('thread-2', true)?.turns?.[0].status, 'completed');
  assert.equal(catalog.list().desktopTarget?.key, desktopTargetIdentity(target).key);
  assert.throws(() => assertDesktopTarget(target, 'another-home'), /重新发送 \/enter/u);
  assert.throws(() => assertDesktopTarget(target), /重新发送 \/enter/u);
  const anotherHost = new CodexDesktopSessionCatalog({ ...target, hostId: 'remote-wsl:Ubuntu' });
  assert.throws(() => anotherHost.list({ cursor: first.nextCursor }), /列表已变化/u);
  assert.equal(fs.readFileSync(path.join(root, 'session_index.jsonl'), 'utf8'), records.join('\n') + '\n');
});

test('catalog rejects symlink escapes and missing sessions instead of selecting another home', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-desktop-safe-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const target: CodexDesktopTarget = { home, hostId: 'local', endpoint: path.join(home, 'ipc.sock'), platform: process.platform, isWsl: false, legacyCompatible: false };
  assert.throws(() => new CodexDesktopSessionCatalog(target).list(), /sessions/u);
  assert.throws(() => new CodexDesktopSessionCatalog(target).read('missing'), /sessions/u);
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(root, 'outside.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'outside' } }) + '\n');
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'outside.jsonl'), path.join(home, 'sessions', 'rollout-outside.jsonl'));
    assert.equal(new CodexDesktopSessionCatalog(target).list().items.length, 0);
    fs.symlinkSync(path.join(root, 'outside.jsonl'), path.join(home, 'session_index.jsonl'));
    assert.throws(() => new CodexDesktopSessionCatalog(target).list(), /索引不可读取/u);
  }
});

test('shared entry ensures the original desktop owner only after validating the selected target and catalog', async context => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-wake-target-'));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', 'rollout-thread-1.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd: '/project' } }) + '\n');
  const target: CodexDesktopTarget = {
    home, platform: 'darwin', endpoint: path.join(home, 'ipc.sock'), hostId: 'local', isWsl: false, legacyCompatible: false,
  };
  const ensured: string[] = [];
  const relay = new CodexDesktopThreadRelay({ enabled: true, target, submitter: {
    ensureThreadOwner: async threadId => { ensured.push(threadId); return { clientId: 'desktop-owner' }; },
    probeThreadOwner: async () => assert.fail('Entry must use recovery-capable owner discovery'),
    submitTurn: async () => assert.fail('Entry must never submit input'),
  } });
  await assert.rejects(relay.prepareSharing('thread-1', 'different-target'), /目标已变化/u);
  await assert.rejects(relay.prepareSharing('missing'), /未找到所选桌面会话/u);
  assert.deepEqual(ensured, []);
  const prepared = await relay.prepareSharing('thread-1', desktopTargetIdentity(target).key);
  assert.equal(prepared.thread.threadId, 'thread-1');
  assert.deepEqual(ensured, ['thread-1']);
});

for (const platform of ['win32', 'linux'] as const) {
  test('simulated ' + platform + ' shared relay uses its target and never starts an independent client', async context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-platform-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'sessions'));
    fs.writeFileSync(path.join(root, 'sessions', 'rollout-thread-1.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd: 'C:\\project' } }) + '\n');
    const target: CodexDesktopTarget = {
      home: root, platform, endpoint: '\\\\.\\pipe\\codex-ipc', hostId: platform === 'linux' ? 'remote-wsl:Ubuntu' : 'local',
      isWsl: platform === 'linux', legacyCompatible: false,
    };
    let submitted = 0;
    const relay = new CodexDesktopThreadRelay({
      enabled: true, target, platform,
      submitter: {
        probeThreadOwner: async thread => { assert.equal(thread, 'thread-1'); return { clientId: 'desktop' }; },
        submitTurn: async (thread, prompt) => {
          submitted++; assert.equal(thread, 'thread-1'); assert.equal(prompt, '中文 rc.129');
          return { turnId: 'turn-1' };
        },
      },
      rolloutReader: {
        snapshot: async () => ({ offsets: new Map(), remainders: new Map() }),
        readEvents: async () => [{ kind: 'complete', turnId: 'turn-1', text: '完成', durationMs: 125000 }],
      },
      runCommand: async () => assert.fail('GUI must not be used'),
    });
    const plugin = new CodexProviderPlugin({ desktopThreadRelay: relay, clientFactory: () => assert.fail('No independent app-server') });
    const prepared = await plugin.prepareDesktopThreadSharing({ threadId: 'thread-1' });
    const params: any = {
      providerProfile: { id: 'codex', providerKind: 'codex', config: {} },
      bridgeSession: { codexThreadId: 'thread-1', desktopTarget: prepared.desktopTarget },
      sessionSettings: null, inputText: '中文 rc.129',
      event: { platform: 'weixin', text: '中文 rc.129', metadata: { codexbridge: {
        executionMode: 'desktop_shared', desktopTargetKey: prepared.desktopTarget.key,
      } } },
    };
    const result = await plugin.startTurn(params);
    assert.equal(result.outputText, '完成');
    assert.equal(result.durationMs, 125000);
    params.event.metadata.codexbridge.desktopTargetKey = 'other-host';
    await assert.rejects(plugin.startTurn(params), /目标已变化/u);
    assert.equal(submitted, 1);
    params.event.metadata.codexbridge.executionMode = 'standalone';
    await assert.rejects(plugin.startTurn(params), /只能通过共享连接/u);
  });
}
