// From Murmur (adalinxx/murmur 13b2c11, src/storage.mjs), unchanged: the
// storage sponsor client Stoa and Murmur use, for Moniker's photos.
// Media kept for good, paid for with this device's work: a storage sponsor
// (0xLattice/lattice-sponsor run with --sell-storage) pins a file's Volume on
// its node once work it hands out covers the file's bytes. No key and no
// coins: the page uploads the Volume, grinds the sponsor's shares, and the
// sponsor pins it. The sponsor is trusted for keeping the file only; every
// reader checks the bytes against the CID.
//
//   POST /store {root, volumes}   → {root, bytes, needed, credit, stored}
//   POST /work  {client?, chain, store: root} → a nonce range and its share target
//   POST /shares {assignment, nonce} → accepted, or refused by name
//   GET  /store/:root             → the upload's status; stored once pinned
//   GET  /terms                   → {storageRates: {"<chain>": bytesPerCoin}, ...}

/** The sponsor won't or can't store it now; `message` says why, for a person. */
export class StorageRefused extends Error {}
/** Stopped from this side: nothing more is asked of the sponsor. */
export class StorageStopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

const TIMES = { call: 15_000, busy: 3000, longest: 10 * 60_000, pinned: 2 * 60_000, look: 2000 };

/** A call to the sponsor at `url`: its JSON, or an Error with the status and its reason. */
async function call(fetch, url, method, path, body, signal) {
  let response, text;
  const timeout = AbortSignal.timeout(TIMES.call);
  try {
    response = await fetch(new URL(path, url.endsWith("/") ? url : `${url}/`), {
      method,
      ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw new StorageStopped();
    throw new StorageRefused(error?.name === "TimeoutError" ? "The storage sponsor didn't answer." : "The storage sponsor can't be reached.");
  }
  if (!response.ok) {
    let reason = text || String(response.status);
    try {
      reason = JSON.parse(text)?.error?.message ?? reason;
    } catch {}
    throw Object.assign(new Error(reason), { status: response.status });
  }
  return JSON.parse(text);
}

/**
 * The chain whose work pays this sponsor for storage: the first of
 * `preferred` (chain paths as "A/B") it sets a rate on, else any it does, or
 * null when it sells no storage (or can't be asked).
 */
export async function storageChain(url, preferred = [], { fetch = globalThis.fetch } = {}) {
  let terms;
  try {
    terms = await call(fetch, url, "GET", "terms");
  } catch {
    return null;
  }
  const rates = Object.entries(terms?.storageRates ?? {}).filter(([, rate]) => Number(rate) > 0).map(([chain]) => chain);
  return preferred.find((chain) => rates.includes(chain)) ?? rates[0] ?? null;
}

/** What a refusal means for a person. */
function refusal(error) {
  const text = String(error?.message ?? error);
  if (/overBudget/.test(text)) return "The storage sponsor is full and takes no more files.";
  if (/noStorageRate/.test(text)) return "The storage sponsor doesn't take work on this chain.";
  if (/over 1 MiB/.test(text)) return "The file is too large to store: at most 1 MiB.";
  if (error?.status === 503) return "The storage sponsor is busy. Try again in a minute.";
  return `The storage sponsor refused it: ${text}`;
}

/**
 * Has the sponsor at `url` keep `volume` (`{ cid, entries }`, as `POST
 * /pins` takes it) for good, paying in shares of its work on `chain`, ground
 * by `hash(work, found, hashed)` (see work/hash.mjs). Resolves once it is
 * pinned, with the sponsor's status. `progress({ stage, done })`: "upload",
 * "work", "busy", "grind" (with `done`, 0 to 1, from the bytes paid), "pin".
 * Throws StorageRefused, with why, or StorageStopped once `signal` aborts.
 */
export async function store(url, volume, { chain, hash, fetch = globalThis.fetch, progress = () => {}, signal, times = TIMES } = {}) {
  const root = volume.cid;
  const ask = (method, path, body) => call(fetch, url, method, path, body, signal);
  const status = () => ask("GET", `store/${root}`);
  const upload = async () => {
    progress({ stage: "upload" });
    try {
      return await ask("POST", "store", { root, volumes: [volume] });
    } catch (error) {
      if (error instanceof StorageRefused || error instanceof StorageStopped) throw error;
      // Uploaded before (this file, from anyone): where it stands is the same.
      if (error.status === 400 && /already uploaded/.test(error.message)) return status();
      throw new StorageRefused(refusal(error));
    }
  };
  const paid = (s) => s.stored || BigInt(s.credit) >= BigInt(s.bytes);
  let now = await upload();
  let client = null;
  const deadline = Date.now() + times.longest;
  while (!paid(now)) {
    if (signal?.aborted) throw new StorageStopped();
    if (Date.now() > deadline) throw new StorageRefused("The storage sponsor took too little of this device's work. Try again later.");
    let work;
    try {
      progress({ stage: "work" });
      work = await ask("POST", "work", { ...(client && { client }), chain, store: root });
    } catch (error) {
      if (error instanceof StorageRefused || error instanceof StorageStopped) throw error;
      // Busy, or this block's credit sold: a block from now it has work again.
      if (error.status === 503) {
        progress({ stage: "busy" });
        await pause(times.busy, signal);
        continue;
      }
      if (client && /client token/.test(error.message)) {
        client = null;
        continue;
      }
      // Held an hour unpaid: uploaded again, it is held again.
      if (/unknownUpload/.test(error.message)) {
        now = await upload();
        continue;
      }
      throw new StorageRefused(refusal(error));
    }
    client = work.client;
    now = await grind(work, { ask, status, hash, progress, signal, paid, last: now });
  }
  // Paid: the sponsor pins it, reading and writing every Volume, then says so.
  progress({ stage: "pin" });
  const pinBy = Date.now() + times.pinned;
  while (!now.stored) {
    if (Date.now() > pinBy) throw new StorageRefused("The storage sponsor was paid but hasn't kept the file yet. Try again in a minute.");
    await pause(times.look, signal);
    now = await status().catch((error) => (error instanceof StorageStopped ? Promise.reject(error) : now));
  }
  return now;
}

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new StorageStopped());
    }, { once: true });
  });

/**
 * Grinds one work's nonces, sending each share, until the upload is paid or
 * the work runs out or expires. Resolves to the upload's status last read.
 */
async function grind(work, { ask, status, hash, progress, signal, paid, last }) {
  let now = last;
  const tell = () => progress({ stage: "grind", done: Math.min(1, Number((BigInt(now.credit) * 1000n) / BigInt(Math.max(1, Number(now.bytes)))) / 1000) });
  tell();
  let finish;
  const outcome = new Promise((resolve, reject) => (finish = { resolve, reject }));
  let over = false;
  const end = (error) => {
    if (over) return;
    over = true;
    if (error) finish.reject(error);
    else finish.resolve(now);
  };
  // One share at a time, each followed by the upload's status.
  let sending = Promise.resolve();
  const found = (nonce) => {
    sending = sending.then(async () => {
      if (over) return;
      try {
        await ask("POST", "shares", { assignment: work.assignment, nonce: String(nonce) });
      } catch (error) {
        if (error instanceof StorageStopped) return end(error);
        // A doubled share earns nothing; expired work, a full block or a gone upload call for new work.
        if (/duplicateShare|missesShareTarget/.test(error.message)) return;
        return end();
      }
      try {
        now = await status();
      } catch (error) {
        if (error instanceof StorageStopped) return end(error);
        return;
      }
      tell();
      if (paid(now)) end();
    });
  };
  const timer = setTimeout(() => end(), Number(work.expiresInMilliseconds));
  const stop = () => end(new StorageStopped());
  signal?.addEventListener("abort", stop);
  const hashing = await hash(work, found, () => {});
  hashing.done.then(
    () => sending.then(() => end()),
    (error) => end(new StorageRefused(`This device's work stopped: ${error?.message ?? error}`)),
  );
  try {
    return await outcome;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    hashing.stop();
  }
}
