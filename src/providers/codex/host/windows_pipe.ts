import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { DesktopIpcTransport } from './contracts.js';

export function isLocalDesktopPipe(endpoint: string): boolean {
  return /^\\\\\.\\pipe\\[A-Za-z0-9_.-]{1,128}$/u.test(endpoint);
}

/** Fixed helper arguments only; prompts and IDs travel in the verified stream. */
export async function openDesktopPipeHelper(executable: string, args: string[], signal?: AbortSignal): Promise<DesktopIpcTransport> {
  signal?.throwIfAborted();
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  let output: Duplex | null = null;
  const exit = new Promise<void>(resolve => { child.once('close', () => { exited = true; resolve(); }); });
  void exit.then(() => { clearTimeout(lifetime); signal?.removeEventListener('abort', aborted); });
  child.on('error', () => {});
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 16_384) { child.kill(); }
  });
  const lifetime = setTimeout(() => child.kill(), 60_000);
  const aborted = () => { output?.destroy(new Error('Desktop IPC cancelled')); child.kill(); };
  signal?.addEventListener('abort', aborted, { once: true });
  const close = async () => {
    clearTimeout(lifetime);
    signal?.removeEventListener('abort', aborted);
    output?.destroy();
    child.stdin.destroy();
    if (!exited) { child.kill(); }
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })]);
    clearTimeout(timer!);
    if (!exited) { child.kill('SIGKILL'); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let preamble = Buffer.alloc(0);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout.off('data', data);
        child.off('error', failed).off('exit', failed);
        signal?.removeEventListener('abort', cancelled);
        error ? reject(error) : resolve();
      };
      const failed = () => finish(new Error('Windows 桌面管道助手不可用；请检查 PowerShell、执行策略和 WSL interoperability。'));
      const cancelled = () => finish(new Error('Desktop IPC cancelled'));
      const data = (chunk: Buffer) => {
        preamble = Buffer.concat([preamble, chunk]);
        const newline = preamble.indexOf(10);
        if (newline < 0 && preamble.length <= 4096) { return; }
        child.stdout.pause();
        if (newline < 0 || newline > 4096) { finish(new Error('Invalid desktop helper readiness')); return; }
        try {
          const ready = JSON.parse(preamble.subarray(0, newline).toString('utf8'));
          if (ready.ready !== true) {
            const code = ['owner-mismatch', 'owner-query-failed', 'pipe-unavailable'].includes(ready.code) ? ready.code : 'helper-unavailable';
            finish(new Error('Windows 桌面管道验证失败：' + code)); return;
          }
          const rest = preamble.subarray(newline + 1);
          if (rest.length) { child.stdout.unshift(rest); }
          finish();
        } catch { finish(new Error('Invalid desktop helper readiness')); }
      };
      const timer = setTimeout(failed, 15_000);
      child.stdout.on('data', data);
      child.once('error', failed).once('exit', failed);
      signal?.addEventListener('abort', cancelled, { once: true });
    });
    signal?.throwIfAborted();
    output = new Duplex({
      read() { child.stdout.resume(); },
      write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
      final(callback) { child.stdin.end(callback); },
      destroy(error, callback) { child.stdout.destroy(); child.stdin.destroy(); callback(error); },
    });
    child.stdout.on('data', chunk => { if (!output!.push(chunk)) { child.stdout.pause(); } });
    child.stdout.on('end', () => output!.push(null));
    child.stdout.on('error', error => output!.destroy(error));
    child.stdin.on('error', error => output!.destroy(error));
    child.on('exit', () => output?.destroy());
    return { stream: output, close };
  } catch (error) { await close(); throw error; }
}
