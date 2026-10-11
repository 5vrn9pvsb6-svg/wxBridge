import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Translator } from '../i18n/index.js';
import { DesktopSyncCheckpointStore, desktopSyncKey } from './desktop_sync_checkpoint.js';

interface FileLink { label: string; destination: string }

// Only report/document formats are auto-delivered. Source/configuration links remain text.
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.pdf', '.csv', '.doc', '.docx',
  '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_LINKS = 32;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Parse explicit Markdown links, never bare paths or examples inside code. */
export function extractLocalFileLinks(text: string): FileLink[] {
  let fence = '';
  const prose = text.split('\n').map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) { fence = marker; }
      else if (marker[0] === fence[0] && marker.length >= fence.length) { fence = ''; }
      return '';
    }
    return fence ? '' : line;
  }).join('\n').replace(/(`+)[\s\S]*?\1/gu, '');
  const links: FileLink[] = [];
  const pattern = /!?\[([^\]\n]{1,300})\]\(/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prose)) && links.length < MAX_LINKS) {
    let depth = 1;
    let end = pattern.lastIndex;
    let angle = false;
    for (; end < Math.min(prose.length, pattern.lastIndex + 4096); end += 1) {
      const char = prose[end];
      if (char === '\\' && /[()<>]/u.test(prose[end + 1] ?? '')) { end += 1; continue; }
      if (char === '<') { angle = true; }
      if (char === '>') { angle = false; }
      if (!angle && char === '(') { depth += 1; }
      if (!angle && char === ')' && --depth === 0) { break; }
    }
    if (depth !== 0) { continue; }
    let destination = prose.slice(pattern.lastIndex, end).trim();
    pattern.lastIndex = end + 1;
    if (destination.startsWith('<')) {
      destination = destination.slice(1, destination.indexOf('>'));
    } else {
      destination = destination.replace(/\s+["'][^\n]*["']$/u, '');
    }
    destination = destination.replace(/\\([()<>])/gu, '$1').replace(/#.*$/u, '').replace(/:\d+(?::\d+)?$/u, '');
    try {
      if (/^file:/iu.test(destination)) { destination = fileURLToPath(destination); }
      else {
        if (/^[a-z][a-z\d+.-]*:/iu.test(destination) && !/^[a-z]:[\\/]/iu.test(destination)) { continue; }
        destination = decodeURIComponent(destination);
      }
    } catch { continue; }
    if (!destination || /[\0-\x1f]/u.test(destination) || /^(?:\\\\|\/\/)/u.test(destination)) { continue; }
    if (!DOCUMENT_EXTENSIONS.has(path.extname(destination).toLowerCase())) { continue; }
    links.push({ label: match[1].replace(/[\x00-\x1f]/gu, '').trim(), destination });
  }
  return links;
}

interface DeliveryOptions {
  cwd: string | null | undefined;
  i18n: Translator;
  signal?: AbortSignal;
  checkpoint?: { store: DesktopSyncCheckpointStore; key: string } | null;
  existingPaths?: string[];
  sendFile: (filePath: string, caption: string) => Promise<{ success: boolean }>;
  sendNotice: (text: string) => Promise<{ success: boolean }>;
}

class LinkedFileError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Collect visible final-answer links and send private snapshots only after the turn finishes. */
export class WeixinLinkedFiles {
  private readonly links = new Map<string, FileLink>();
  private readonly acknowledged = new Set<string>();

  collect(text: string): void {
    for (const link of extractLocalFileLinks(text)) {
      if (this.links.size >= MAX_LINKS) { break; }
      this.links.set(link.destination, link);
    }
  }

  async deliver(options: DeliveryOptions): Promise<void> {
    if (this.links.size === 0 || options.signal?.aborted) { return; }
    const { checkpoint, i18n } = options;
    const seen = (key: string) => this.acknowledged.has(key) || Boolean(checkpoint?.store.get(checkpoint.key).chunks.includes(key));
    const acknowledge = (key: string) => {
      checkpoint?.store.acknowledgeChunk(checkpoint.key, key);
      this.acknowledged.add(key);
    };
    const maxFiles = Math.min(MAX_FILES, positiveLimit('CODEXBRIDGE_MAX_OUTPUT_ARTIFACTS', MAX_FILES));
    const maxBytes = Math.min(MAX_FILE_BYTES, positiveLimit('CODEXBRIDGE_MAX_ARTIFACT_SIZE_BYTES', MAX_FILE_BYTES));
    const excluded = new Set((options.existingPaths ?? []).map((file) => path.resolve(file)));
    const visited = new Set<string>();
    const failures: string[] = [];
    let fileCount = excluded.size;
    for (const link of this.links.values()) {
      if (options.signal?.aborted) { return; }
      const source = path.resolve(options.cwd || '.', link.destination);
      if (visited.has(source) || excluded.has(source)) { continue; }
      visited.add(source);
      const fileKey = desktopSyncKey('linked-file', source);
      // Count already delivered files too: a reconnect must not bypass the turn limit.
      if (seen(fileKey)) { fileCount += 1; continue; }
      let spool: string | null = null;
      let reason: string | null = null;
      let uploading = false;
      try {
        if (fileCount >= maxFiles) { throw new LinkedFileError('countLimit'); }
        const bytes = readWorkspaceDocument(source, options.cwd, maxBytes);
        const name = path.basename(source).replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_');
        spool = fs.mkdtempSync(path.join(os.tmpdir(), 'wxbridage-linked-file-'));
        const snapshot = path.join(spool, name);
        fs.writeFileSync(snapshot, bytes, { mode: 0o600 });
        fileCount += 1;
        if (options.signal?.aborted) { return; }
        uploading = true;
        const result = await options.sendFile(snapshot, i18n.t('runtime.linkedFile.caption', { label: link.label }));
        if (result.success) { acknowledge(fileKey); }
        else { reason = 'uploadFailed'; }
      } catch (error) {
        reason = uploading ? 'uploadFailed' : error instanceof LinkedFileError ? error.reason : 'unavailable';
      } finally {
        if (spool) { fs.rmSync(spool, { recursive: true, force: true }); }
      }
      if (reason) { failures.push(`${link.label}：${i18n.t(`runtime.linkedFile.${reason}`)}`); }
    }
    if (failures.length > 0 && !options.signal?.aborted) {
      const noticeKey = desktopSyncKey('linked-file-notice', ...failures);
      if (!seen(noticeKey)) {
        const result = await options.sendNotice(i18n.t('runtime.linkedFile.failed', { details: failures.join('\n') }));
        if (result.success) { acknowledge(noticeKey); }
      }
    }
  }
}

function positiveLimit(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readWorkspaceDocument(source: string, cwd: string | null | undefined, maxBytes: number): Buffer {
  if (!cwd || !path.isAbsolute(cwd)) { throw new LinkedFileError('outsideWorkspace'); }
  const workspace = path.resolve(cwd);
  if (!within(workspace, source)) { throw new LinkedFileError('outsideWorkspace'); }
  // Do not auto-export hidden credentials/state, even when the session uses the home directory.
  if (path.relative(workspace, source).split(path.sep).some((part) => part.startsWith('.'))
    || /(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?)(?:[._-]|$)/iu.test(path.basename(source))) {
    throw new LinkedFileError('protectedFile');
  }
  const realRoot = fs.realpathSync(workspace);
  const realSource = fs.realpathSync(source);
  if (!within(realRoot, realSource)) { throw new LinkedFileError('outsideWorkspace'); }
  if (path.relative(realRoot, realSource).split(path.sep).some((part) => part.startsWith('.'))) {
    throw new LinkedFileError('protectedFile');
  }
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) { throw new LinkedFileError('unavailable'); }
  if (stat.size > maxBytes) { throw new LinkedFileError('sizeLimit'); }
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) {
      throw new LinkedFileError('unavailable');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) { throw new LinkedFileError('unavailable'); }
      offset += count;
    }
    if (fs.fstatSync(fd).size !== opened.size) { throw new LinkedFileError('unavailable'); }
    return bytes;
  } finally { fs.closeSync(fd); }
}
