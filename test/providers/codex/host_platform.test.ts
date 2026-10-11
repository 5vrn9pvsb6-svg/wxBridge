import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { desktopTargetIdentity, resolveCodexDesktopTarget, DesktopTargetError } from '../../../src/providers/codex/desktop_target.js';
import { createCodexCliLaunchSpec } from '../../../src/providers/codex/cli_command.js';
import { findDesktopPipeHelper } from '../../../src/providers/codex/host/windows.js';
import { getServicePlatform } from '../../../scripts/service/platform/index.mjs';

test('macOS keeps the legacy default binding and rejects remote or relative desktop targets', () => {
  const target = resolveCodexDesktopTarget({ platform: 'darwin', env: {}, userHome: '/Users/example' });
  assert.deepEqual(target, {
    home: '/Users/example/.codex', hostId: 'local', endpoint: '/Users/example/.codex/ipc/ipc.sock',
    platform: 'darwin', isWsl: false, powershellBin: undefined, legacyCompatible: true,
  });
  const explicit = resolveCodexDesktopTarget({ platform: 'darwin', env: { CODEXBRIDGE_CODEX_DESKTOP_HOME: '/tmp/custom' } });
  assert.equal(explicit.legacyCompatible, false);
  for (const env of [
    { CODEXBRIDGE_CODEX_DESKTOP_HOST_ID: 'remote-wsl:Ubuntu' },
    { CODEXBRIDGE_CODEX_DESKTOP_IPC_SOCKET: 'relative.sock' },
  ]) {
    assert.throws(() => resolveCodexDesktopTarget({ platform: 'darwin', env }), DesktopTargetError);
  }
});

test('existing target keys survive adapter extraction without re-entering a shared session', context => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wxbridge-host-'));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const target = {
      home, platform, hostId: platform === 'linux' ? 'remote-wsl:Ubuntu' : 'local',
      endpoint: path.join(home, 'missing-endpoint'), isWsl: platform === 'linux', legacyCompatible: false,
    };
    const key = createHash('sha256').update(JSON.stringify([
      'codex-desktop-v1', target.hostId, fs.realpathSync(home), target.endpoint,
    ])).digest('hex');
    assert.equal(desktopTargetIdentity(target).key, key);
  }
});

test('Linux desktop sharing still requires WSL2 while independent CLI execution remains available', () => {
  assert.throws(() => resolveCodexDesktopTarget({ platform: 'linux', release: '6.8.0-generic', env: {} }),
    error => error instanceof DesktopTargetError && error.code === 'unsupported-platform');
  const args = ['app-server', '中文 & spaces'];
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(createCodexCliLaunchSpec({ platform, command: 'codex.cmd', args }), {
      command: 'codex.cmd', args, options: {}, displayCommand: 'codex.cmd',
    });
  }
});

test('moving Windows code retains the packaged PowerShell helper location', () => {
  const expected = fileURLToPath(new URL('../../../scripts/codex-desktop-pipe.ps1', import.meta.url));
  assert.equal(fs.realpathSync(findDesktopPipeHelper()), fs.realpathSync(expected));
});

test('service adapters keep each OS environment location and Windows home defaults', () => {
  const windows = getServicePlatform('win32');
  const env: NodeJS.ProcessEnv = { APPDATA: '/configured/roaming' };
  windows.configureServiceHome('/home/example', env);
  assert.equal(env.APPDATA, '/configured/roaming');
  assert.equal(env.LOCALAPPDATA, path.join('/home/example', 'AppData', 'Local'));
  assert.equal(windows.defaultServiceEnvFile(env, '/home/example'), path.join('/configured/roaming', 'codexbridge', 'weixin.service.env'));
  for (const platform of ['darwin', 'linux'] as const) {
    const host = getServicePlatform(platform);
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: '/custom/config' };
    host.configureServiceHome('/home/example', env);
    assert.deepEqual(env, { XDG_CONFIG_HOME: '/custom/config' });
    assert.equal(host.defaultServiceEnvFile(env, '/home/example'), path.join('/custom/config', 'codexbridge', 'weixin.service.env'));
    assert.equal(host.defaultServiceEnvFile({}, '/home/example'), path.join('/home/example', '.config', 'codexbridge', 'weixin.service.env'));
  }
});
