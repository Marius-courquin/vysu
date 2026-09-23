// A worker of the resampling pool (src/img/pool.ts): one Pillow-exact resize per message, the pixels
// moved in and out without a copy.
import { parentPort } from 'node:worker_threads';
import { resize } from './resample.ts';
import type { Raster } from './raster.ts';

interface Job {
  id: number;
  img: Raster;
  width: number;
  height: number;
}

parentPort!.on('message', ({ id, img, width, height }: Job) => {
  const out = resize(img, width, height);
  parentPort!.postMessage({ id, img: out }, [out.data.buffer as ArrayBuffer]);
});
