import type { Translator } from '../i18n/index.js';

/** Report a completed turn, never the lifetime of a shared thread or the observer. */
export function desktopTurnNotice(i18n: Translator, failed: boolean, durationMs?: number | null): string {
  const status = i18n.t(failed ? 'runtime.desktopSync.turnFailed' : 'runtime.desktopSync.turnCompleted');
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return i18n.t('runtime.desktopSync.completionUnknownDuration', { status });
  }
  let seconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const duration = [
    hours ? i18n.t('runtime.desktopSync.durationHours', { count: hours }) : '',
    minutes ? i18n.t('runtime.desktopSync.durationMinutes', { count: minutes }) : '',
    seconds ? i18n.t('runtime.desktopSync.durationSeconds', { count: seconds }) : '',
  ].join('').trim() || i18n.t('runtime.desktopSync.durationUnderSecond');
  return i18n.t('runtime.desktopSync.completionDuration', { status, duration });
}
