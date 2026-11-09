// Turnup's records: what is written where, and how a reader checks it.
//
// The chain's policy (Stoa's, byte for byte) says only whose a key is:
// `user/<a>/...` and `index/.../<a>` are `<a>`'s, and only `<a>` signs a
// change to them. Everything below is a convention clients share. Records
// are written by anyone, so every value read is untrusted: one that doesn't
// parse is skipped, and a listing counts only when the record it lists
// agrees with it.
//
//   user/<a>/post/<id>          an item {kind:"item"}, a tag {kind:"tag"} or a message {kind:"msg"}
//   user/<a>/post/<id>/media/<n> the CID of an item's n-th photo
//   user/<a>/box                <a>'s inbox public key (seal.mjs)
//   index/geo/<g1>/…/<g6>/<id>/<a>   "lost" or "found": an open item at that geohash
//   index/inbox/<b>/<mid>/<a>   "1": <a> wrote message <mid> to <b>

import { encode, PRECISION } from "./geo.mjs";
import { isPublicKey, open, seal } from "./seal.mjs";

// ------------------------------------------------------------------ vocabulary

export const CATEGORIES = [
  ["phone", "Phone"],
  ["wallet", "Wallet or purse"],
  ["keys", "Keys"],
  ["bag", "Bag or backpack"],
  ["cards", "ID or cards"],
  ["electronics", "Laptop, tablet or headphones"],
  ["jewelry", "Jewelry or watch"],
  ["clothing", "Clothing"],
  ["glasses", "Glasses"],
  ["pet", "Pet"],
  ["bike", "Bike or scooter"],
  ["toy", "Toy"],
  ["documents", "Documents"],
  ["other", "Something else"],
];
const CATEGORY = new Map(CATEGORIES);
export const categoryName = (id) => CATEGORY.get(id) ?? "Something else";

/** Field limits, in characters. Clients refuse longer; readers skip records past them. */
export const LIMITS = { title: 80, details: 1000, place: 120, question: 200, held: 200, reward: 120, tagName: 60, tagNote: 300, message: 2000, photos: 3 };

/** How finely an item's point is kept: three decimals, about 100 m. */
export const roundPoint = (value) => Math.round(value * 1000) / 1000;

// ------------------------------------------------------------------ writing

const POST = /^user\/[^/]+\/post\/[^/]+$/;

/** A new record id: the time in base 36 then random, so ids sort by time. */
export function newId(now = Date.now()) {
  const random = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => (b % 36).toString(36)).join("");
  return now.toString(36).padStart(9, "0") + random;
}

/**
 * The policy holds a post's `time` to the block that creates it (no later,
 * at most 60 block times earlier) and keeps it on every change. A new post is
 * stamped a few seconds back, since a writer's clock may run ahead.
 */
export const SKEW = 5000;

function stamped(key, newValue, oldValue, time) {
  if (newValue === undefined || !POST.test(key)) return newValue;
  const record = parse(newValue);
  if (!isObject(record)) return newValue;
  return JSON.stringify({ ...record, time: parse(oldValue)?.time ?? record.time ?? time });
}

/**
 * The general-state actions for `[key, value]` writes against `state` (a
 * view: `{ get, list }`), a value of undefined deleting. Consensus applies an
 * action only when `oldValue` is what the key holds, so a write is always made
 * against what its writer read.
 */
export async function changes(state, writes, time = Date.now() - SKEW) {
  const last = new Map(writes);
  const actions = await Promise.all(
    [...last].map(async ([key, value]) => {
      const oldValue = await state.get(key);
      const newValue = stamped(key, value, oldValue, time);
      return { key, ...(oldValue !== undefined && { oldValue }), ...(newValue !== undefined && { newValue }) };
    }),
  );
  return actions.filter((action) => action.oldValue !== action.newValue);
}

/** A transaction body for `actions` signed by `owner`: for scripts and tests that hold a key. */
export function transaction({ owner, actions, fee = 0n, nonce, chainPath }) {
  return {
    accountActions: fee > 0n ? [{ owner, delta: -fee }] : [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}

const json = (value) => (value === undefined ? undefined : JSON.stringify(value));
const postKey = (a, id) => `user/${a}/post/${id}`;
const geoKey = (point, id, a) => `index/geo/${encode(point.lat, point.lon).split("").join("/")}/${id}/${a}`;
const trimmed = (value, max) => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (text.length > max) throw new Error(`At most ${max} characters`);
  return text || undefined;
};

/** Checks and shapes an item draft; throws with a reason a person can read. */
export function itemValue(draft) {
  if (draft.type !== "lost" && draft.type !== "found") throw new Error("Lost or found?");
  if (!CATEGORY.has(draft.category)) throw new Error("Choose what kind of thing it is");
  const title = trimmed(draft.title, LIMITS.title);
  if (!title) throw new Error("Say what it is, in a few words");
  const lat = Number(draft.lat);
  const lon = Number(draft.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("Put a pin where it was");
  const when = Number(draft.when);
  if (!Number.isSafeInteger(when) || when <= 0) throw new Error("Say when");
  const value = {
    kind: "item",
    type: draft.type,
    category: draft.category,
    title,
    lat: roundPoint(lat),
    lon: roundPoint(lon),
    when,
    status: draft.status === "resolved" ? "resolved" : "open",
  };
  const optional = { details: LIMITS.details, place: LIMITS.place };
  if (draft.type === "found") Object.assign(optional, { question: LIMITS.question, held: LIMITS.held });
  else optional.reward = LIMITS.reward;
  for (const [field, max] of Object.entries(optional)) {
    const text = trimmed(draft[field], max);
    if (text) value[field] = text;
  }
  if (value.status === "resolved") value.resolved = Number.isSafeInteger(draft.resolved) ? draft.resolved : Date.now();
  return value;
}

/**
 * `a` posts or edits item `id`. `before` is the item as it stands (so a
 * moved or resolved item leaves its old listing); `photos` the CIDs in order,
 * `slots` how many photo keys it has now. `box`: `a`'s inbox public key,
 * written alongside when it isn't yet, so whoever answers can seal to them.
 * Undefined `draft` deletes the item, its photos and its listing.
 */
export function item(a, id, draft, { before, photos = [], slots = 0, box } = {}) {
  const value = draft && itemValue(draft);
  const writes = [];
  if (before && (!value || value.status !== "open" || encode(before.lat, before.lon) !== encode(value.lat, value.lon))) {
    writes.push([geoKey(before, id, a), undefined]);
  }
  writes.push([postKey(a, id), json(value)]);
  if (value?.status === "open") writes.push([geoKey(value, id, a), value.type]);
  const count = value ? Math.min(photos.length, LIMITS.photos) : 0;
  for (let n = 0; n < Math.max(count, slots); n++) writes.push([`${postKey(a, id)}/media/${n}`, n < count ? photos[n] : undefined]);
  if (box) writes.push(...boxWrite(a, box));
  return writes;
}

/** `a` publishes their inbox public key. */
export const boxWrite = (a, publicKey) => {
  if (!isPublicKey(publicKey)) throw new Error("Not an inbox key");
  return [[`user/${a}/box`, publicKey]];
};

/** `a`'s tag `id`: `{ name, note?, missing? }`, for a QR sticker on something they own. Undefined deletes it. */
export function tag(a, id, draft, { box } = {}) {
  let value;
  if (draft) {
    const name = trimmed(draft.name, LIMITS.tagName);
    if (!name) throw new Error("Name the thing this tag goes on");
    value = { kind: "tag", name, ...(trimmed(draft.note, LIMITS.tagNote) && { note: trimmed(draft.note, LIMITS.tagNote) }), ...(draft.missing && { missing: true }) };
  }
  return [[postKey(a, id), json(value)], ...(box ? boxWrite(a, box) : [])];
}

/**
 * `a` writes to `to`: `body` = `{ about, text, claim?, share?, contact? }`,
 * sealed for both of them (`keys` = `{ [a]: key, [to]: key }`). `about` is
 * `{ type: "item", chain, author, id, title }` or `{ type: "tag", author, id,
 * name }`, inside the seal: outsiders see only that `a` wrote to `to`.
 */
export async function message(a, mid, to, body, keys, { box } = {}) {
  if (a === to) throw new Error("That's you");
  const text = trimmed(body.text, LIMITS.message);
  if (!text && !body.share) throw new Error("Write something");
  const sealed = await seal({ ...body, ...(text && { text }) }, keys);
  return [
    [postKey(a, mid), json({ kind: "msg", to, box: sealed })],
    [`index/inbox/${to}/${mid}/${a}`, "1"],
    ...(box ? boxWrite(a, box) : []),
  ];
}

// ------------------------------------------------------------------ reading

function parse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value, max) => (typeof value === "string" && value.length <= max && value.trim() ? value : undefined);
const timeOf = (record) => (Number.isSafeInteger(record.time) && record.time > 0 ? record.time : 0);
async function collect(entries) {
  const found = [];
  for await (const entry of entries) found.push(entry);
  return found;
}
/** Keys under `prefix` exactly `parts` segments deeper. */
const depth = (entries, prefix, parts) => entries.filter(([key]) => key.slice(prefix.length).split("/").length === parts);

/** An item record, shaped, or undefined. */
export function shapeItem(author, id, record, media = []) {
  if (!isObject(record) || record.kind !== "item") return undefined;
  if (record.type !== "lost" && record.type !== "found") return undefined;
  const title = text(record.title, LIMITS.title);
  const { lat, lon, when } = record;
  if (!title || typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  if (!Number.isSafeInteger(when) || when <= 0) return undefined;
  const out = {
    author,
    id,
    time: timeOf(record),
    type: record.type,
    category: CATEGORY.has(record.category) ? record.category : "other",
    title,
    lat,
    lon,
    when,
    status: record.status === "resolved" ? "resolved" : "open",
    photos: media
      .map(([key, cid]) => [Number(key.slice(key.lastIndexOf("/") + 1)), cid])
      .filter(([n, cid]) => Number.isInteger(n) && n >= 0 && n < LIMITS.photos && typeof cid === "string" && cid.length < 200)
      .sort(([x], [y]) => x - y)
      .map(([, cid]) => cid),
  };
  for (const field of ["details", "place", "question", "held", "reward"]) {
    const value = text(record[field], LIMITS[field]);
    if (value) out[field] = value;
  }
  if (out.status === "resolved" && Number.isSafeInteger(record.resolved)) out.resolved = record.resolved;
  return out;
}

/** `author`'s item `id`, or undefined. */
export async function itemOf(state, author, id) {
  if (!author || !id) return undefined;
  const [value, media] = await Promise.all([state.get(postKey(author, id)), collect(state.list(`${postKey(author, id)}/media/`))]);
  return shapeItem(author, id, parse(value), media);
}

/** How many photo keys an item has, so an edit clears the ones past its new count. */
export async function photoSlots(state, author, id) {
  let slots = 0;
  for await (const [key] of state.list(`${postKey(author, id)}/media/`)) {
    const n = Number(key.slice(key.lastIndexOf("/") + 1));
    if (Number.isSafeInteger(n) && n >= 0 && n < 1000) slots = Math.max(slots, n + 1);
  }
  return slots;
}

/**
 * The open items listed in geohash `cells` (geo.cover): each counts only
 * when its record is open, of the type listed, and really in that cell.
 */
export async function itemsIn(state, cells) {
  const listed = (await Promise.all(cells.map((cell) => collect(state.list(`index/geo/${cell.split("").join("/")}/`))))).flat();
  const seen = new Set();
  const found = await Promise.all(
    listed.map(async ([key, type]) => {
      const segments = key.split("/");
      if (segments.length !== 2 + PRECISION + 2) return undefined;
      const [id, author] = segments.slice(-2);
      if (seen.has(`${author}/${id}`)) return undefined;
      seen.add(`${author}/${id}`);
      const it = await itemOf(state, author, id);
      return it && it.status === "open" && it.type === type && encode(it.lat, it.lon) === segments.slice(2, 2 + PRECISION).join("") ? it : undefined;
    }),
  );
  return found.filter(Boolean);
}

/** `a`'s tag `id`, or undefined. */
export async function tagOf(state, a, id) {
  const record = parse(await state.get(postKey(a, id)));
  return shapeTag(a, id, record);
}
function shapeTag(author, id, record) {
  if (!isObject(record) || record.kind !== "tag") return undefined;
  const name = text(record.name, LIMITS.tagName);
  if (!name) return undefined;
  return { author, id, time: timeOf(record), name, ...(text(record.note, LIMITS.tagNote) && { note: record.note }), missing: record.missing === true };
}

/** Everything `a` wrote: `{ items, tags }`, newest first. */
export async function by(state, a) {
  const prefix = `user/${a}/post/`;
  const all = await collect(state.list(prefix));
  const media = new Map();
  for (const [key, cid] of all) {
    const [id, slot] = key.slice(prefix.length).split("/");
    if (slot === "media") media.set(id, [...(media.get(id) ?? []), [key, cid]]);
  }
  const out = { items: [], tags: [] };
  for (const [key, value] of depth(all, prefix, 1)) {
    const id = key.slice(prefix.length);
    const record = parse(value);
    if (record?.kind === "item") {
      const it = shapeItem(a, id, record, media.get(id) ?? []);
      if (it) out.items.push(it);
    } else if (record?.kind === "tag") {
      const t = shapeTag(a, id, record);
      if (t) out.tags.push(t);
    }
  }
  out.items.sort((x, y) => y.time - x.time);
  out.tags.sort((x, y) => y.time - x.time);
  return out;
}

/** `a`'s inbox public key, or undefined. */
export async function boxOf(state, a) {
  const key = await state.get(`user/${a}/box`);
  return isPublicKey(key) ? key : undefined;
}

/**
 * Every message to or from `me` that opens with their inbox key `key`:
 * `{ mid, from, to, time, body }`, oldest first. A message counts only when
 * its record names the recipient its listing does.
 */
export async function messages(state, me, key) {
  const inboxPrefix = `index/inbox/${me}/`;
  const listed = depth(await collect(state.list(inboxPrefix)), inboxPrefix, 2).map(([k]) => {
    const [mid, from] = k.slice(inboxPrefix.length).split("/");
    return { mid, from, to: me };
  });
  const sentPrefix = `user/${me}/post/`;
  const sent = [];
  for (const [k, value] of depth(await collect(state.list(sentPrefix)), sentPrefix, 1)) {
    const record = parse(value);
    if (record?.kind === "msg") sent.push({ mid: k.slice(sentPrefix.length), from: me, to: record.to, record });
  }
  const read = async ({ mid, from, to, record }) => {
    const r = record ?? parse(await state.get(postKey(from, mid)));
    if (!isObject(r) || r.kind !== "msg" || r.to !== to || typeof r.box !== "string") return undefined;
    const body = await open(r.box, me, key);
    if (!isObject(body) || !isObject(body.about)) return undefined;
    const about = aboutOf(body.about);
    if (!about) return undefined;
    const share = isObject(body.share) && typeof body.share.lat === "number" && typeof body.share.lon === "number" && Math.abs(body.share.lat) <= 90 && Math.abs(body.share.lon) <= 180 ? { lat: body.share.lat, lon: body.share.lon } : undefined;
    return {
      mid,
      from,
      to,
      time: timeOf(r),
      body: {
        about,
        text: text(body.text, LIMITS.message) ?? "",
        ...(body.claim === true && { claim: true }),
        ...(body.confirm === true && { confirm: true }),
        ...(share && { share }),
      },
    };
  };
  const all = await Promise.all([...listed.filter((m) => m.from !== me), ...sent].map(read));
  return all.filter(Boolean).sort((x, y) => x.time - y.time || (x.mid < y.mid ? -1 : 1));
}

function aboutOf(about) {
  const author = text(about.author, 200);
  const id = text(about.id, 100);
  if (!author || !id) return undefined;
  if (about.type === "item") return { type: "item", chain: typeof about.chain === "string" && about.chain.length < 20 ? about.chain : "", author, id, title: text(about.title, LIMITS.title) ?? "" };
  if (about.type === "tag") return { type: "tag", author, id, name: text(about.name, LIMITS.tagName) ?? "" };
  return undefined;
}

/** What a thread is about, as one key: the same for both people in it. */
export const aboutKey = (about) => (about.type === "item" ? `item:${about.chain}:${about.author}/${about.id}` : `tag:${about.author}/${about.id}`);

/**
 * Messages as conversations: one per thing and other person, newest first:
 * `{ key, about, with, messages, last }`.
 */
export function threads(all, me) {
  const by = new Map();
  for (const m of all) {
    const other = m.from === me ? m.to : m.from;
    const key = `${aboutKey(m.body.about)}|${other}`;
    if (!by.has(key)) by.set(key, { key, about: m.body.about, with: other, messages: [] });
    by.get(key).messages.push(m);
  }
  return [...by.values()].map((t) => ({ ...t, last: t.messages[t.messages.length - 1].time })).sort((x, y) => y.last - x.last);
}
