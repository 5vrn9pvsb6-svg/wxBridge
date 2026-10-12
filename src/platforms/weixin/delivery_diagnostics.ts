import { createHash } from 'node:crypto';
import { writeSequencedDebugLog } from '../../core/sequenced_stderr.js';

/** Operational delivery evidence without message bodies, account IDs or reusable credentials. */
export function logWeixinDelivery(event: 'context_updated' | 'send_result' | 'send_failed', fields: {
  scopeId: string;
  contextToken?: string | null;
  clientId?: string;
  attempt?: number;
  ret?: number | null;
  errcode?: number | null;
  durationMs?: number;
  hasContent?: boolean;
  reason?: 'prepare_failed' | 'rate_limited' | 'other' | 'none';
}): void {
  const fingerprint = (value?: string | null) => value
    ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null;
  writeSequencedDebugLog('weixin-delivery', event, {
    timestamp: new Date().toISOString(),
    scope: fingerprint(fields.scopeId), context: fingerprint(fields.contextToken), client: fingerprint(fields.clientId),
    attempt: fields.attempt, ret: fields.ret, errcode: fields.errcode,
    durationMs: fields.durationMs, hasContent: fields.hasContent,
    reason: fields.reason,
  }, { envVar: null });
}

export function weixinSendReason(message: unknown): 'prepare_failed' | 'rate_limited' | 'other' | 'none' {
  if (typeof message !== 'string' || !message.trim()) { return 'none'; }
  if (/prepare\s+failed/iu.test(message)) { return 'prepare_failed'; }
  if (/rate[ _-]?limit|too many|频率|限流/iu.test(message)) { return 'rate_limited'; }
  return 'other';
}
