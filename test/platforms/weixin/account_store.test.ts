import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WeixinAccountStore } from '../../../src/platforms/weixin/account_store.js';
import { loadWeixinConfig } from '../../../src/platforms/weixin/config.js';
import { WeixinReplyBudget } from '../../../src/platforms/weixin/reply_budget.js';

function fixture(context: { after(callback: () => void): void }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-account-discovery-'));
  context.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const rootDir = path.join(stateDir, 'weixin', 'accounts');
  const store = new WeixinAccountStore({ rootDir });
  const saveAccount = (accountId: string) => store.saveAccount({
    accountId, token: `synthetic-${accountId}`, baseUrl: 'https://ilink.example.com',
  });
  const saveSidecars = (accountId: string) => {
    store.setContextToken(accountId, 'synthetic-peer', 'synthetic-context');
    store.saveSyncCursor(accountId, 'synthetic-cursor');
    new WeixinReplyBudget(path.join(rootDir, `${accountId}.reply-budget.json`))
      .acknowledge('synthetic-peer', 'synthetic-context', 'synthetic-message');
  };
  return { stateDir, rootDir, store, saveAccount, saveSidecars };
}

test('account discovery excludes reply budgets and other sidecars without changing their contents', context => {
  const { rootDir, store, saveAccount, saveSidecars } = fixture(context);
  saveAccount('bot');
  saveSidecars('bot');
  store.saveSyncCursor('legacy', 'legacy-cursor');
  const before = Object.fromEntries(fs.readdirSync(rootDir).map(name => [name, fs.readFileSync(path.join(rootDir, name), 'utf8')]));

  assert.deepEqual(store.listAccounts(), ['bot']);
  for (const [name, content] of Object.entries(before)) {
    assert.equal(fs.readFileSync(path.join(rootDir, name), 'utf8'), content);
  }
});

test('a restarted service auto-selects its sole saved account after a reply budget has been persisted', context => {
  const { rootDir, saveAccount, saveSidecars } = fixture(context);
  saveAccount('bot');
  saveSidecars('bot');
  const config = loadWeixinConfig({ env: { WEIXIN_ACCOUNT_ID: '' }, accountStore: new WeixinAccountStore({ rootDir }) });

  assert.equal(config.accountId, 'bot');
  assert.equal(config.token, 'synthetic-bot');
  assert.equal(config.enabled, true);
});

test('multiple real accounts still require explicit selection even when reply budgets exist', context => {
  const { store, saveAccount, saveSidecars } = fixture(context);
  for (const account of ['bot-b', 'bot-a']) {
    saveAccount(account);
    saveSidecars(account);
  }
  assert.deepEqual(store.listAccounts(), ['bot-a', 'bot-b']);
  const automatic = loadWeixinConfig({ env: {}, accountStore: store });
  assert.equal(automatic.accountId, null);
  assert.equal(automatic.token, null);
  assert.equal(automatic.enabled, false);
  const selected = loadWeixinConfig({ env: { WEIXIN_ACCOUNT_ID: 'bot-b' }, accountStore: store });
  assert.equal(selected.accountId, 'bot-b');
  assert.equal(selected.token, 'synthetic-bot-b');
});

test('orphaned sidecars are not treated as saved accounts', context => {
  const { store, saveSidecars } = fixture(context);
  saveSidecars('deleted-bot');
  assert.deepEqual(store.listAccounts(), []);
  assert.equal(loadWeixinConfig({ env: {}, accountStore: store }).enabled, false);
});

test('Linux and WSL service account detection ignores reply budget sidecars', { skip: process.platform === 'win32' }, context => {
  const { stateDir, saveAccount, saveSidecars } = fixture(context);
  saveAccount('bot');
  saveSidecars('bot');
  const commonScript = fileURLToPath(new URL('../../../scripts/service/_common.sh', import.meta.url));
  const result = spawnSync('bash', ['-c', 'source "$1"; find_single_weixin_account_id', 'wx-account-test', commonScript], {
    encoding: 'utf8',
    env: { ...process.env, CODEXBRIDGE_STATE_DIR: stateDir, CODEX_REAL_BIN: process.execPath, NODE_BIN: process.execPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'bot');
});
