// From Murmur (adalinxx/murmur 13b2c11, app/vendor/work/), unchanged.
// Hashes a sponsor's work on this device: its graphics chip where the page
// can use one (gpu.mjs), else its processor's cores (worker.mjs). Adapted
// from Selfhold's sponsor.ts (adalinxx/selfhold-wallet 5a631dd; MIT, see
// LICENSE here).
import { gpuFailed, gpuGrinder } from "./gpu.mjs";

/** What does the work here: "GPU" where WebGPU runs, else "processor". */
export const workDevice = async () => ((await gpuGrinder()) ? "GPU" : "processor");

/**
 * Hashes `work`'s nonces, `found(nonce)` for each share and `hashed(count)`
 * as it goes. `done` settles when the range is through; `stop()` ends it.
 */
export async function hasher(work, found, hashed) {
  const gpu = await gpuGrinder();
  if (gpu) {
    let stopped = false;
    let next = BigInt(work.startNonce);
    const end = next + BigInt(work.count);
    let processor = null;
    const done = (async () => {
      const job = gpu.job(work.prefixHex, work.shareTarget);
      let batch = 1 << 16;
      try {
        while (!stopped && next < end) {
          const size = end - next < BigInt(batch) ? Number(end - next) : batch;
          const began = performance.now();
          const shares = await job.run(next, size);
          if (stopped) return;
          next += BigInt(size);
          hashed(size);
          shares.forEach(found);
          // Batches of a tenth of a second or so: the chip still draws the page.
          const spent = performance.now() - began;
          if (spent < 100 && batch < 1 << 26) batch *= 2;
          else if (spent > 400 && batch > 1 << 12) batch /= 2;
        }
      } finally {
        job.close();
      }
    })().catch(async () => {
      // The chip gave up partway: the rest of this work, and all after, on the processor.
      gpuFailed();
      if (stopped || next >= end) return;
      processor = cores(work.prefixHex, work.shareTarget, next, end - next, found, hashed);
      await processor.done;
    });
    return { done, stop: () => { stopped = true; processor?.stop(); } };
  }
  return cores(work.prefixHex, work.shareTarget, BigInt(work.startNonce), BigInt(work.count), found, hashed);
}

/** Hashes nonces [start, start + total) on this device's processor cores, in workers. */
function cores(prefixHex, targetHex, start, total, found, hashed) {
  const count = Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 2) - 1));
  const span = total / BigInt(count);
  const workers = [];
  const done = Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.share) found(BigInt(data.share));
      if (data.hashes) hashed(data.hashes);
      if (data.done) resolve();
    };
    worker.onerror = (event) => reject(new Error(event.message));
    // The last worker takes the remainder of the range too.
    const mine = i === count - 1 ? total - span * BigInt(count - 1) : span;
    worker.postMessage({ prefixHex, targetHex, start: String(start + BigInt(i) * span), count: String(mine) });
    workers.push(worker);
  })));
  return { done, stop: () => workers.forEach((worker) => worker.terminate()) };
}
