import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createI18n } from '../../src/i18n/index.js';
import { DesktopSyncCheckpointStore, desktopSyncKey } from '../../src/runtime/desktop_sync_checkpoint.js';
import { extractLocalFileLinks, WeixinLinkedFiles } from '../../src/runtime/weixin_linked_files.js';

function fixture(context: { after: (callback: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-linked-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  const notices: string[] = [];
  const sent: Array<{ filePath: string; caption: string; bytes: Buffer }> = [];
  const options = {
    cwd, i18n: createI18n(),
    sendFile: async (filePath: string, caption: string) => {
      sent.push({ filePath, caption, bytes: fs.readFileSync(filePath) });
      return { success: true };
    },
    sendNotice: async (text: string) => { notices.push(text); return { success: true }; },
  };
  return { root, cwd, sent, notices, options };
}

test('extracts explicit local report links with Chinese, spaces, parentheses, file URLs and line anchors', () => {
  const urlFile = path.join(os.tmpdir(), 'report one.md');
  const text = '[分析报告](/项目/报告 (最终)/report.zh-CN.md:12) [阅读版](<./我的 报告.txt> "title") '
    + `[证据](./evidence.pdf#page=2) [URL](${pathToFileURL(urlFile)}) `
    + '[网页](https://example.org/report.md) [代码](./app.ts) ` [示例](./secret.txt) `\n'
    + '```markdown\n[example](./example.md)\n```\n~~~\n[example](./example2.md)\n~~~';
  assert.deepEqual(extractLocalFileLinks(text).map((link) => link.destination), [
    '/项目/报告 (最终)/report.zh-CN.md', './我的 报告.txt', './evidence.pdf', urlFile,
  ]);
  assert.equal(extractLocalFileLinks('[网络](file://remote/share/report.txt) [共享](//host/share/file.pdf)').length, 0);
});

test('sends complete Markdown as UTF-8 TXT, preserves PDF bytes, deduplicates links and cleans temporary files', async (context) => {
  const { cwd, options, sent, notices } = fixture(context);
  const markdown = '# 安全报告\n\n**11 台设备**无审计。\n| 主机 | 证据 |\n| A | 外连为空 |\n';
  const report = path.join(cwd, '报告 (完整).md');
  const pdf = path.join(cwd, 'evidence.pdf');
  fs.writeFileSync(report, markdown);
  fs.writeFileSync(pdf, Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff]));
  const files = new WeixinLinkedFiles();
  files.collect(`[分析报告](${report}) [再次引用](${pathToFileURL(report)}) [PDF](./evidence.pdf)`);
  await files.deliver(options);
  await files.deliver(options);
  assert.equal(sent.length, 2);
  assert.equal(path.basename(sent[0].filePath), '报告 (完整).txt');
  assert.equal(sent[0].bytes.toString('utf8'), '\uFEFF' + markdown);
  assert.match(sent[0].caption, /TXT/);
  assert.deepEqual(sent[1].bytes, fs.readFileSync(pdf));
  assert.equal(notices.length, 0);
  assert.ok(sent.every((item) => !fs.existsSync(item.filePath)));
  assert.equal(fs.readFileSync(report, 'utf8'), markdown);
});

test('rejects out-of-workspace, hidden credentials, missing files and directories while delivering valid reports', async (context) => {
  const { root, cwd, options, sent, notices } = fixture(context);
  fs.writeFileSync(path.join(root, 'outside.txt'), 'private');
  fs.mkdirSync(path.join(cwd, '.private'));
  fs.writeFileSync(path.join(cwd, '.private', 'key.txt'), 'private');
  fs.writeFileSync(path.join(cwd, 'credentials.txt'), 'private');
  fs.mkdirSync(path.join(cwd, 'directory.pdf'));
  fs.writeFileSync(path.join(cwd, 'report.txt'), 'valid');
  const files = new WeixinLinkedFiles();
  files.collect('[outside](../outside.txt) [hidden](.private/key.txt) [credential](credentials.txt) '
    + '[missing](missing.pdf) [directory](directory.pdf) [valid](report.txt)');
  await files.deliver(options);
  assert.deepEqual(sent.map((item) => item.bytes.toString()), ['valid']);
  assert.match(notices[0], /outside：.*工作目录/);
  assert.match(notices[0], /hidden：.*凭据/);
  assert.match(notices[0], /missing：.*不存在/);
  assert.ok(!notices[0].includes(root));
});

test('refuses symlinks escaping the workspace or pointing to hidden directories', { skip: process.platform === 'win32' }, async (context) => {
  const { root, cwd, options, sent } = fixture(context);
  fs.writeFileSync(path.join(root, 'outside.txt'), 'private');
  fs.symlinkSync(path.join(root, 'outside.txt'), path.join(cwd, 'alias.txt'));
  fs.mkdirSync(path.join(cwd, '.private'));
  fs.writeFileSync(path.join(cwd, '.private', 'key.txt'), 'private');
  fs.symlinkSync(path.join(cwd, '.private'), path.join(cwd, 'public'));
  const files = new WeixinLinkedFiles();
  files.collect('[outside alias](alias.txt) [hidden alias](public/key.txt)');
  await files.deliver(options);
  assert.equal(sent.length, 0);
});

test('does not auto-read reports without a known workspace', async (context) => {
  const { cwd, options, sent, notices } = fixture(context);
  const report = path.join(cwd, 'report.txt');
  fs.writeFileSync(report, 'content');
  const files = new WeixinLinkedFiles();
  files.collect(`[报告](${report})`);
  await files.deliver({ ...options, cwd: null });
  assert.equal(sent.length, 0);
  assert.match(notices[0], /工作目录/);
});

test('enforces bounded size and count, and skips provider-native artifacts already in the response', async (context) => {
  const { cwd, options, sent, notices } = fixture(context);
  const large = path.join(cwd, 'large.pdf');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, 25 * 1024 * 1024 + 1);
  const files = new WeixinLinkedFiles();
  files.collect('[large](large.pdf)');
  for (let index = 0; index < 4; index += 1) {
    fs.writeFileSync(path.join(cwd, `${index}.txt`), String(index));
    files.collect(`[报告 ${index}](${index}.txt)`);
  }
  await files.deliver({ ...options, existingPaths: [path.join(cwd, '0.txt')] });
  assert.deepEqual(sent.map((item) => item.bytes.toString()), ['1', '2']);
  assert.match(notices[0], /25 MiB/);
  assert.match(notices[0], /最多 3 个/);
});

test('persistent acknowledgements suppress delivered attachments across restarts but retry failed uploads', async (context) => {
  const { root, cwd, options, sent, notices } = fixture(context);
  fs.writeFileSync(path.join(cwd, 'report.md'), '# full report');
  const checkpointPath = path.join(root, 'checkpoints.json');
  const key = desktopSyncKey('scope', 'binding', 'turn');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const files = new WeixinLinkedFiles();
    files.collect('[report](report.md)');
    const store = new DesktopSyncCheckpointStore(checkpointPath);
    store.markFinalDelivered(key);
    await files.deliver({ ...options, checkpoint: { store, key },
      sendFile: async (filePath, caption) => {
        await options.sendFile(filePath, caption);
        return { success: attempt > 0 };
      },
    });
  }
  assert.equal(sent.length, 2);
  assert.equal(notices.length, 1);
  assert.ok(!fs.readFileSync(checkpointPath, 'utf8').includes('report'));
});

test('cancellation stops pending files but acknowledges a successful upload already in flight', async (context) => {
  const { cwd, options, sent } = fixture(context);
  fs.writeFileSync(path.join(cwd, 'one.txt'), 'one');
  fs.writeFileSync(path.join(cwd, 'two.txt'), 'two');
  const controller = new AbortController();
  const files = new WeixinLinkedFiles();
  files.collect('[one](one.txt) [two](two.txt)');
  await files.deliver({ ...options, signal: controller.signal, sendFile: async (file, caption) => {
    controller.abort();
    return options.sendFile(file, caption);
  } });
  assert.equal(sent.length, 1);
  await files.deliver(options);
  assert.deepEqual(sent.map((item) => item.bytes.toString()), ['one', 'two']);
});

test('thrown upload errors clean their snapshots and remain retryable', async (context) => {
  const { cwd, options, sent, notices } = fixture(context);
  fs.writeFileSync(path.join(cwd, 'report.txt'), 'report');
  const files = new WeixinLinkedFiles();
  files.collect('[report](report.txt)');
  let snapshot = '';
  await files.deliver({ ...options, sendFile: async (file) => {
    snapshot = file;
    throw new Error('network unavailable');
  } });
  assert.ok(!fs.existsSync(snapshot));
  assert.match(notices[0], /微信上传失败/);
  await files.deliver(options);
  assert.equal(sent.length, 1);
});
