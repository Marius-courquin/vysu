// Pillow-exact resizes on a few worker threads: a burst resamples every one of its frames, 50 ms of
// integer maths each at 3x, and they do not depend on each other. The pool starts on first use,
// never keeps the process alive, and stays small: the machine is shared with other agents.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Raster } from './raster.ts';
import { resize } from './resample.ts';

const SIZE = Math.max(0, Math.min(3, availableParallelism() - 1));
// Workers that may die before the pool gives up on threads: one that cannot start at all (a runtime
// without worker support for .ts) must not cost a spawn per resize.
let respawns = SIZE * 2;

interface Job {
  resolve: (r: Raster) => void;
  reject: (e: Error) => void;
}
interface Slot {
  worker: Worker;
  jobs: Map<number, Job>;
}
const slots: Slot[] = [];
let next = 0;
let seq = 0;

// A worker is held (keeps Node running) exactly while it has a job out: an awaited promise alone
// does not keep Node running, and an idle one must not keep it either.
function hold(slot: Slot): void {
  if (slot.jobs.size) slot.worker.ref();
  else slot.worker.unref();
}

function spawnSlot(): Slot {
  const worker = new Worker(new URL('./resample-worker.ts', import.meta.url));
  const slot: Slot = { worker, jobs: new Map() };
  worker.unref();
  worker.on('message', ({ id, img }: { id: number; img: Raster }) => {
    const job = slot.jobs.get(id);
    slot.jobs.delete(id);
    hold(slot);
    job?.resolve({ ...img, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length) });
  });
  // A worker that dies (a resize that threw, memory) takes only its own jobs with it, and leaves the
  // pool: they are rejected, resized in place by resizeAsync, and the next job goes to a new worker.
  // Without this its jobs never settled and every job sent to it after hung the same way.
  const dead = (e: Error): void => {
    const i = slots.indexOf(slot);
    if (i < 0) return;
    slots.splice(i, 1);
    respawns--;
    const jobs = [...slot.jobs.values()];
    slot.jobs.clear();
    worker.unref();
    void worker.terminate();
    for (const job of jobs) job.reject(e);
  };
  worker.on('error', dead);
  worker.on('exit', (code) => dead(new Error(`resample worker exited with code ${code}`)));
  return slot;
}

function pick(): Slot | null {
  while (slots.length < SIZE && respawns > 0) slots.push(spawnSlot());
  return slots.length ? slots[next++ % slots.length]! : null;
}

function offThread(slot: Slot, img: Raster, width: number, height: number): Promise<Raster> {
  const id = ++seq;
  const data = img.data.slice();
  return new Promise((resolve, reject) => {
    slot.jobs.set(id, { resolve, reject });
    hold(slot);
    slot.worker.postMessage({ id, img: { ...img, data }, width, height }, [data.buffer]);
  });
}

// resize() off the main thread, the same bytes. The source's pixels are copied once into a
// transferable buffer, so the caller keeps its own. On a single core, or when the worker it went to
// died, in place.
export async function resizeAsync(img: Raster, width: number, height: number): Promise<Raster> {
  const slot = SIZE ? pick() : null;
  if (!slot) return resize(img, width, height);
  try {
    return await offThread(slot, img, width, height);
  } catch {
    return resize(img, width, height);
  }
}
