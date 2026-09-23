// Pillow-exact resizes on a few worker threads: a burst resamples every one of its frames, 50 ms of
// integer maths each at 3x, and they do not depend on each other. The pool starts on first use,
// never keeps the process alive, and stays small: the machine is shared with other agents.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Raster } from './raster.ts';
import { resize } from './resample.ts';

const SIZE = Math.max(0, Math.min(3, availableParallelism() - 1));
let workers: Worker[] | null = null;
let next = 0;
let seq = 0;
const pending = new Map<number, { resolve: (r: Raster) => void; reject: (e: Error) => void }>();

function start(): Worker[] {
  if (workers) return workers;
  workers = [];
  for (let i = 0; i < SIZE; i++) {
    const w = new Worker(new URL('./resample-worker.ts', import.meta.url));
    w.unref();
    w.on('message', ({ id, img }: { id: number; img: Raster }) => {
      const p = pending.get(id);
      pending.delete(id);
      if (!pending.size) for (const x of workers ?? []) x.unref();
      p?.resolve({ ...img, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length) });
    });
    w.on('error', (e) => {
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(e);
      }
    });
    workers.push(w);
  }
  return workers;
}

// resize() off the main thread, the same bytes. The source's pixels are copied once into a
// transferable buffer, so the caller keeps its own. On a single core, in place.
export function resizeAsync(img: Raster, width: number, height: number): Promise<Raster> {
  if (!SIZE) return Promise.resolve(resize(img, width, height));
  const pool = start();
  const id = ++seq;
  const data = img.data.slice();
  // Held while a job is out: an awaited promise alone does not keep Node running.
  if (!pending.size) for (const w of pool) w.ref();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    pool[next++ % pool.length]!.postMessage({ id, img: { ...img, data }, width, height }, [data.buffer]);
  });
}
