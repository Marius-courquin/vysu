// Ports and health checks: is a service up, stop what holds a port, wait for a url to answer.
import { die } from './errors.ts';
import { isListening, listenerPids } from './host.ts';
import { sleep } from './text.ts';

export const listening = (port: number): Promise<boolean> => isListening(port);

// The port must be free when this returns, or the next `up` sees a ghost. With a pid, only that
// listener: an isolated Metro is stopped by the process `up` recorded, never by whatever happens to
// hold its port now.
export async function killPort(port: number, pid?: number): Promise<void> {
  let pids = listenerPids(port);
  if (pid) pids = pids.filter((p) => p === pid);
  if (!pids.length) return;
  const kill = (sig: NodeJS.Signals): void => {
    for (const p of pids) {
      try {
        process.kill(p, sig);
      } catch {
        // already gone
      }
    }
  };
  kill('SIGTERM');
  for (let i = 0; i < 20; i++) {
    if (!(await listening(port))) return;
    await sleep(500);
  }
  kill('SIGKILL');
}

// Any answer counts, a 404 included: the question is whether the server is there. The timeout per
// try matters: a port that accepts the connection but never answers (a half-started bundler) would
// otherwise hold one try well past the budget this loop is supposed to bound.
export async function httpAnswers(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await r.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export async function waitHttp(url: string, seconds: number, label: string): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    if (await httpAnswers(url)) return;
    await sleep(1000);
  }
  die(`${label}: not up after ${seconds}s`);
}
