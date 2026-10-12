import { formatWeixinText, splitWeixinText, WEIXIN_DELIVERY_LIMIT_BYTES } from '../platforms/weixin/formatting.js';
import { DesktopSyncCheckpointStore, desktopSyncKey } from './desktop_sync_checkpoint.js';

export class DesktopOutputDeferredError extends Error {}

/** Rollout messages are complete segments; acknowledge each platform-sized chunk before advancing. */
export async function deliverDesktopSegment(options: {
  store: DesktopSyncCheckpointStore;
  key: string;
  phase: string;
  text: string;
  signal: AbortSignal;
  maxMessageLength?: number;
  send: (content: string, deliveryId: string) => Promise<{ success: boolean; error: string; deferred?: boolean }>;
}): Promise<boolean> {
  const { store, key, phase, text, signal, send } = options;
  const chunks = splitWeixinText(formatWeixinText(text), options.maxMessageLength);
  for (const [index, chunk] of chunks.entries()) {
    if (signal.aborted) { return false; }
    const chunkKey = desktopSyncKey(phase, text, String(index), chunk);
    if (store.get(key).chunks.includes(chunkKey)) { continue; }
    const result = await send(chunk, `codexbridge-weixin-${desktopSyncKey(key, chunkKey).slice(0, 32)}`);
    if (!result.success) {
      if (result.deferred) { throw new DesktopOutputDeferredError(result.error); }
      throw new Error(result.error || 'Desktop output delivery failed');
    }
    // Record acknowledged sends even when exit/shutdown happened while the request was in flight.
    store.acknowledgeChunk(key, chunkKey);
  }
  return !signal.aborted;
}

/** Freeze a batch before sending so new progress cannot change an unacknowledged retry. */
export async function deliverDesktopProgress(options: {
  store: DesktopSyncCheckpointStore; key: string; texts: string[]; signal: AbortSignal;
  maxMessageLength: number;
  send: (content: string, deliveryId: string) => Promise<{ success: boolean; error: string; deferred?: boolean }>;
}): Promise<boolean> {
  const { store, key, signal } = options;
  // Leave room for the localized quota warning, which shares the same chat bubble.
  const wireLimit = Math.min(options.maxMessageLength, WEIXIN_DELIVERY_LIMIT_BYTES);
  const limit = Math.max(1, wireLimit - Math.min(512, Math.floor(wireLimit / 2)));
  const pending: Array<{ text: string; key: string }> = [];
  for (const text of options.texts) {
    for (const [index, chunk] of splitWeixinText(formatWeixinText(text), options.maxMessageLength).entries()) {
      const originalKey = desktopSyncKey('commentary', text, String(index), chunk);
      if (store.get(key).chunks.includes(originalKey)) { continue; }
      const parts = splitWeixinText(chunk, limit);
      for (const [partIndex, part] of parts.entries()) {
        const partKey = parts.length === 1 ? originalKey : desktopSyncKey(originalKey, String(partIndex), part);
        if (!store.get(key).chunks.includes(partKey)) { pending.push({ text: part, key: partKey }); }
      }
    }
  }
  while (!signal.aborted) {
    if (!store.get(key).progressBatch) {
      let text = '';
      const chunks: string[] = [];
      for (const item of pending) {
        if (store.get(key).chunks.includes(item.key)) { continue; }
        const candidate = text ? `${text}\n\n${item.text}` : item.text;
        if (Buffer.byteLength(candidate, 'utf8') > limit && chunks.length) { break; }
        text = candidate; chunks.push(item.key);
      }
      if (!chunks.length) { return true; }
      store.setProgressBatch(key, { text, chunks });
    }
    const batch = store.get(key).progressBatch!;
    const result = await options.send(batch.text, `codexbridge-weixin-${desktopSyncKey(key, 'progress-batch', ...batch.chunks).slice(0, 32)}`);
    if (!result.success) {
      if (result.deferred) { throw new DesktopOutputDeferredError(result.error); }
      throw new Error(result.error || 'Desktop progress delivery failed');
    }
    store.acknowledgeProgressBatch(key);
  }
  return false;
}
