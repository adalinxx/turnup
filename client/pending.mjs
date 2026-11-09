// Writes on their way: shown at once, until the chain agrees.
//
// A write takes a block or two to land (minutes on testnet). The app keeps
// what each sent write changes, per chain, and reads through it: the state
// it shows is the chain's with the person's own unlanded changes on top. A
// change drops out once the chain holds it, once its write is known to be
// dropped, or after STALE.
//
// A host pools only a write that executes on its tip, so an account has at
// most one write waiting per chain: a second, signed past the first, is
// refused. `fate` says whether the last one landed, waits, or was dropped.

/** How long a change is shown without the chain agreeing. */
export const STALE = 30 * 60_000;
/** How long after sending a write isn't judged dropped: the pool and the tip move apart for a moment. */
export const GRACE = 20_000;

/**
 * `sent` = `{ cid, nonce, host, account, chain, at }` (`chain` a path
 * string). Resolves "landed", "waiting" or "dropped". A host that doesn't
 * answer leaves it "waiting".
 */
export async function fate(sent, { fetch = globalThis.fetch, now = Date.now() } = {}) {
  if (!sent.host || sent.nonce === undefined) return now - sent.at < STALE ? "waiting" : "dropped";
  const get = async (path) => {
    const response = await fetch(`${sent.host.replace(/\/+$/, "")}${path}${path.includes("?") ? "&" : "?"}chainPath=${encodeURIComponent(sent.chain)}`, { cache: "no-store" });
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const passed = async () => BigInt((await get(`/api/state/account/${sent.account}`)).nonce ?? 0) > BigInt(sent.nonce);
  try {
    if (await passed()) return "landed";
    if (now - sent.at < GRACE) return "waiting";
    const pool = await get("/api/mempool");
    if ((pool.transactions ?? []).includes(sent.cid)) return "waiting";
    return (await passed()) ? "landed" : "dropped";
  } catch {
    return "waiting";
  }
}

/**
 * The changes on their way, kept in `storage` (localStorage) under `name`:
 * `[{ chain, account, sent, actions: [{ key, newValue? }], what, at }]`.
 */
export function createPending(storage, name) {
  const read = () => {
    try {
      const all = JSON.parse(storage.getItem(name) ?? "[]");
      return Array.isArray(all) ? all.filter((p) => Date.now() - p.at < STALE) : [];
    } catch {
      return [];
    }
  };
  const save = (all) => {
    try {
      if (all.length) storage.setItem(name, JSON.stringify(all));
      else storage.removeItem(name);
    } catch {}
  };
  return {
    all: read,
    /** Keeps a sent write's changes. */
    add(entry) {
      save([...read().filter((p) => !(p.chain === entry.chain && p.account === entry.account)), { ...entry, at: Date.now() }]);
    },
    /** The write still waiting on `chain` for `account`, if any. */
    waiting: (chain, account) => read().find((p) => p.chain === chain && p.account === account),
    remove(entry) {
      save(read().filter((p) => !(p.chain === entry.chain && p.account === entry.account && p.at === entry.at)));
    },
    /**
     * Drops what the chain now holds (every change it made is in `state`), or
     * what `fate` says was dropped. Resolves to the entries dropped as lost.
     */
    async settle(chain, state, fateOf = fate) {
      const lost = [];
      for (const p of read().filter((x) => x.chain === chain)) {
        let held = true;
        for (const a of p.actions) if ((await state.get(a.key)) !== a.newValue) held = false;
        if (held) this.remove(p);
        else if (p.sent && (await fateOf({ ...p.sent, chain })) !== "waiting") {
          // Landed but not as shown (someone changed it since), or dropped.
          this.remove(p);
          lost.push(p);
        }
      }
      return lost;
    },
    /** `state` (`{ get, list }`) with the unlanded changes on `chain` on top. */
    over(chain, state) {
      const changes = new Map();
      for (const p of read().filter((x) => x.chain === chain)) for (const a of p.actions) changes.set(a.key, a.newValue);
      if (changes.size === 0) return state;
      return {
        get: async (key) => (changes.has(key) ? changes.get(key) : state.get(key)),
        async *list(prefix) {
          const mine = [...changes].filter(([key]) => key.startsWith(prefix));
          const seen = new Set();
          const merged = [];
          for await (const [key, value] of state.list(prefix)) {
            seen.add(key);
            if (changes.has(key)) {
              if (changes.get(key) !== undefined) merged.push([key, changes.get(key)]);
            } else merged.push([key, value]);
          }
          for (const [key, value] of mine) if (!seen.has(key) && value !== undefined) merged.push([key, value]);
          merged.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
          yield* merged;
        },
      };
    },
  };
}
