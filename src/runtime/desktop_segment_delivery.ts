import { formatWeixinText, splitWeixinText } from '../platforms/weixin/formatting.js';
import { DesktopSyncCheckpointStore, desktopSyncKey } from './desktop_sync_checkpoint.js';

/** Rollout messages are complete segments; acknowledge each platform-sized chunk before advancing. */
export async function deliverDesktopSegment(options: {
  store: DesktopSyncCheckpointStore;
  key: string;
  phase: string;
  text: string;
  signal: AbortSignal;
  maxMessageLength?: number;
  send: (content: string) => Promise<{ success: boolean; error: string }>;
}): Promise<boolean> {
  const { store, key, phase, text, signal, send } = options;
  const chunks = splitWeixinText(formatWeixinText(text), options.maxMessageLength);
  for (const [index, chunk] of chunks.entries()) {
    if (signal.aborted) { return false; }
    const chunkKey = desktopSyncKey(phase, text, String(index), chunk);
    if (store.get(key).chunks.includes(chunkKey)) { continue; }
    const result = await send(chunk);
    if (!result.success) { throw new Error(result.error || 'Desktop output delivery failed'); }
    // Record acknowledged sends even when exit/shutdown happened while the request was in flight.
    store.acknowledgeChunk(key, chunkKey);
  }
  return !signal.aborted;
}
