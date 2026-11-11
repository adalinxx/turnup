// Turnup over Lattice: one root chain and the area chains below it.
//
// The root chain holds what isn't anywhere in particular: inbox keys,
// messages and QR tags, plus items posted where no area chain is. An area
// chain is a child of the root named by a geohash prefix (`dr5`, a box about
// 150 km across), hosted by whoever cares about that area; items posted
// inside it go there. A reader finds the areas from the root's committed
// children, and uses one only when it runs the root's exact spec (same
// policy, same rules), so nobody can slip other rules in under an area's name.
//
// Every read is checked by CID from whichever host answers; writes go to the
// person's wallet, which signs them and pays the fee with this device's work
// through a fee sponsor.

import * as records from "./records.mjs";
import { encode } from "./geo.mjs";
import { anyHost, view, volumeLoader } from "./state.mjs";

/** An area chain's directory: a geohash prefix of 2 to 4 characters. */
export const AREA = /^[0-9b-hjkmnp-z]{2,4}$/;

/**
 * `overlay(path, state)`, if given, lays changes on their way over every
 * state read (pending.mjs); `chainState` reads the chain alone, for writes.
 */
export function createTurnup({ sdk, root, nodes, freshFor = 10_000, fetch = globalThis.fetch.bind(globalThis), overlay = (path, state) => state }) {
  if (!sdk || !root?.length || !nodes?.length) throw new Error("createTurnup needs { sdk, root, nodes }");
  const chains = new Map(); // path string -> { path, load, volumes, current }
  const chain = (path) => {
    const name = path.join("/");
    if (!chains.has(name)) {
      const volumes = new sdk.VolumeClient(anyHost(nodes.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: path }))));
      chains.set(name, { path, volumes, load: volumeLoader(volumes, sdk.decodeDagCbor), current: null });
    }
    return chains.get(name);
  };
  const get = async (node, route, path) => {
    const url = new URL(route, node);
    url.searchParams.set("chainPath", path.join("/"));
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw Object.assign(new Error(`${route}: HTTP ${response.status}`), { status: response.status });
    return response.json();
  };
  const first = async (ask, path) => {
    try {
      return await Promise.any(nodes.map(ask));
    } catch (error) {
      throw new Error(`No host is serving ${path.join("/")}`, { cause: error.errors?.[0] ?? error });
    }
  };

  /** The chain's tip as the first host to answer has it: `{ hash, height, specCID, state }`, reused for `freshFor`. */
  function tip(path, { fresh = false } = {}) {
    const c = chain(path);
    if (!fresh && c.current && Date.now() - c.current.at < freshFor) return c.current.read;
    const read = first(async (node) => {
      const { hash } = await get(node, "/api/block/latest", path);
      const block = sdk.decodeCanonicalBlock((await c.volumes.get(hash)).rootBytes());
      const post = sdk.decodeCanonicalLatticeState((await c.volumes.get(block.postStateCID)).rootBytes());
      return { hash, height: Number(block.height), specCID: block.specCID, state: view(c.load, post.generalStateCID) };
    }, path);
    c.current = { at: Date.now(), read };
    read.catch(() => c.current?.read === read && (c.current = null));
    return read;
  }
  const chainState = async (path, options) => (await tip(path, options)).state;
  const state = async (path, options) => overlay(path.join("/"), await chainState(path, options));
  /** Forget what was read, so the next read asks for the tip. */
  const refresh = (path) => {
    if (path) chain(path).current = null;
    else for (const c of chains.values()) c.current = null;
  };

  let areasRead = null;
  /**
   * The area chains a host lists under the root and serves with the root's
   * spec: `Map<label, path>`. Read once, and again after `refreshAreas`.
   */
  function areas() {
    areasRead ??= (async () => {
      const [rootTip, listed] = await Promise.all([
        tip(root),
        first(async (node) => {
          const names = [];
          let after;
          for (let page = 0; page < 20; page++) {
            const url = new URL("/api/chain/children", node);
            url.searchParams.set("chainPath", root.join("/"));
            if (after) url.searchParams.set("after", after);
            const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
            if (!response.ok) throw new Error(`children: HTTP ${response.status}`);
            const body = await response.json();
            names.push(...(body.directories ?? []));
            if (!body.next) break;
            after = body.next;
          }
          return names;
        }, root),
      ]);
      const found = new Map();
      await Promise.all(
        listed.filter((name) => AREA.test(name)).map(async (name) => {
          const path = [...root, name];
          try {
            if ((await tip(path)).specCID === rootTip.specCID) found.set(name, path);
          } catch {
            // Listed, but no host serves it: posts there can't be read or written.
          }
        }),
      );
      return found;
    })();
    areasRead.catch(() => (areasRead = null));
    return areasRead;
  }
  const refreshAreas = () => (areasRead = null);

  /** The chain an item at `point` goes on: its area's, or the root. `{ path, label }`. */
  async function chainAt(point) {
    const hash = encode(point.lat, point.lon, 4);
    const all = await areas().catch(() => new Map());
    let best = "";
    for (const label of all.keys()) if (hash.startsWith(label) && label.length > best.length) best = label;
    return best ? { path: all.get(best), label: best } : { path: root, label: "" };
  }
  const pathOf = (label) => (label ? [...root, label] : root);

  /**
   * Open items in geohash `cells`, from the root and every area chain that
   * overlaps them; each tagged with its `chain` label.
   */
  async function itemsIn(cells, options) {
    const all = await areas().catch(() => new Map());
    const reads = [records.itemsIn(await state(root, options), cells).then((items) => items.map((it) => ({ ...it, chain: "" })))];
    for (const [label, path] of all) {
      const overlap = cells.filter((cell) => cell.startsWith(label) || label.startsWith(cell));
      if (overlap.length) reads.push(state(path, options).then((s) => records.itemsIn(s, overlap)).then((items) => items.map((it) => ({ ...it, chain: label }))).catch(() => []));
    }
    return (await Promise.all(reads)).flat();
  }

  const itemOf = async (label, author, id, options) => {
    const it = await records.itemOf(await state(pathOf(label), options), author, id);
    return it && { ...it, chain: label };
  };

  /** Everything `a` posted, on the root and every area: `{ items, tags }`. */
  async function mine(a, options) {
    const all = await areas().catch(() => new Map());
    const parts = await Promise.all([
      state(root, options).then((s) => records.by(s, a)).then((r) => ({ ...r, items: r.items.map((it) => ({ ...it, chain: "" })) })),
      ...[...all].map(([label, path]) =>
        state(path, options).then((s) => records.by(s, a)).then((r) => ({ items: r.items.map((it) => ({ ...it, chain: label })), tags: [] })).catch(() => ({ items: [], tags: [] })),
      ),
    ]);
    return { items: parts.flatMap((p) => p.items).sort((x, y) => y.time - x.time), tags: parts[0].tags };
  }

  /** The account's next nonce on a chain, as the first host answers: a BigInt. */
  async function nonce(path, account) {
    try {
      return BigInt((await first((node) => get(node, `/api/state/account/${account}`, path), path)).nonce ?? 0);
    } catch (error) {
      if (error.cause?.status === 404) return 0n;
      throw error;
    }
  }

  return {
    root,
    nodes,
    chain: (label) => pathOf(label),
    tip,
    state,
    chainState,
    refresh,
    areas,
    refreshAreas,
    chainAt,
    itemsIn,
    itemOf,
    mine,
    nonce,
    /** `account`'s coins on `path`, as a bigint. */
    balance: async (path, account) => {
      try {
        return BigInt((await first((node) => get(node, `/api/state/account/${account}`, path), path)).balance ?? 0);
      } catch (error) {
        if (error.cause?.status === 404) return 0n;
        throw error;
      }
    },
    tagOf: async (a, id, options) => records.tagOf(await state(root, options), a, id),
    boxOf: async (a, options) => records.boxOf(await state(root, options), a),
    messages: async (me, key, options) => records.messages(await state(root, options), me, key),
  };
}
