// Names on Moniker, the names chain, read from a state view
// `{ get(key), list(prefix) }` (see state.mjs) and written as
// `{ actions, payments? }` for the wallet (see wallet.mjs).
//
// An account owns names (@handles): assets it may sell or give, and point at
// an account, any account. An account shows `@h`, in every app, only while it
// names h (`user/<a>/name`) and h points at it: one read of Moniker decides.
//
// Keys:
//   name/<h>               <owner>, <owner>@<price> or <owner>><account> (offered to it)
//   names/<a>/<h>          1 while <a> owns <h>
//   points/<h>             the account <h> points at
//   user/<a>/name          the handle <a> shows
//   user/<a>/<field>       the account's other fields: key.x25519, app.<name>.<field>
//
// The policy reads a transaction in order: a name, then the index keys it
// moves (the one it leaves first), then its pointer, which only the name's
// owner writes. A released name may be followed only by deleting its pointer.
import { shortAccount } from "./account.mjs";
import { ACCOUNT, change, checkedTerms, combine, heldToken, isAddress, isHandle, paymentFor, takeable, tokenValue, unchanged, write } from "./shared.mjs";

/** The CID of the Moniker policy module this release reads and writes for; set at each release. */
export const MONIKER_POLICY = "bafyreicybs2dkpihbguywhftikjqbeh566p3zk5visa7bh2wxttdjinfp4";

/**
 * Whether a chain spec (see state.mjs `chainSpec`) runs the Moniker policy.
 * Every policy in a spec must accept a transaction, so further policies may
 * refuse more but never let through what this one refuses.
 */
export const runsMoniker = (spec) =>
  Array.isArray(spec?.wasmPolicies) &&
  spec.wasmPolicies.some(
    (policy) =>
      policy?.moduleCID === MONIKER_POLICY &&
      policy.scope === "transaction" &&
      policy.entrypoint === "lattice_validate_transaction",
  );

export const nameKey = (handle) => `name/${handle}`;
export const namesKey = (account, handle) => `names/${account}/${handle}`;
export const pointsKey = (handle) => `points/${handle}`;
export const fieldKey = (account, field) => `user/${account}/${field}`;
export const shownKey = (account) => fieldKey(account, "name");

const checkedHandle = (handle) => {
  if (!isHandle(handle)) throw new Error(`${handle}: a handle is lowercase letters, digits and _`);
  return handle;
};

const checkedAccount = (account) => {
  if (!isAddress(account)) throw new Error(`not an address: ${account}`);
  return account;
};

// Reading.

/** The name as held: `{ handle, value, owner, price?, offer?, pointer? }`, where `pointer` is the account it points at; undefined when free. */
export async function resolve(state, handle) {
  if (!isHandle(handle)) return undefined;
  const token = await heldToken(state, nameKey(handle));
  if (!token) return undefined;
  const pointer = await state.get(pointsKey(handle));
  return { handle, ...token, ...(pointer !== undefined && { pointer }) };
}

/** The account `handle` points at, or undefined. */
export async function pointer(state, handle) {
  if (!isHandle(handle)) return undefined;
  const value = await state.get(pointsKey(handle));
  return isAddress(value) ? value : undefined;
}

/** The owner of each of `handles`, in order, from one state: one read of `name/<h>` each; undefined when free. */
export const ownersOf = (state, handles) => Promise.all(handles.map(async (handle) => (isHandle(handle) ? (await heldToken(state, nameKey(handle)))?.owner : undefined)));

/** The handle `account` shows: the one it names, while that handle points at it; else undefined. */
export async function handleOf(state, account) {
  const handle = await state.get(shownKey(account));
  if (!isHandle(handle) || (await state.get(pointsKey(handle))) !== account) return undefined;
  // A name a release left pointing is free: it shows for nobody.
  return (await state.get(nameKey(handle))) === undefined ? undefined : handle;
}

/** `handleOf` for many accounts, in order, from one state. */
export const handlesOf = (state, accounts) => Promise.all(accounts.map((account) => handleOf(state, account)));

/** The names `account` owns, as `resolve` returns them, in handle order: one prefix read of `names/`. */
export async function namesOf(state, account) {
  const prefix = `names/${account}/`;
  const found = [];
  for await (const [key] of state.list(prefix)) {
    const entry = await resolve(state, key.slice(prefix.length));
    if (entry?.owner === account) found.push(entry);
  }
  return found;
}

/** Every name, as `resolve` returns it, in handle order. Reads all of `name/`. */
export async function* handles(state) {
  for await (const [key] of state.list("name/")) {
    const entry = await resolve(state, key.slice("name/".length));
    if (entry) yield entry;
  }
}

/** The names for sale, cheapest first. */
export async function forSale(state) {
  const found = [];
  for await (const entry of handles(state)) if (entry.price !== undefined) found.push(entry);
  return found.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.handle < b.handle ? -1 : 1));
}

/** `account`'s own fields, as `{ field: value }`. */
export async function getFields(state, account) {
  const prefix = `user/${account}/`;
  const fields = {};
  for await (const [key, value] of state.list(prefix)) fields[key.slice(prefix.length)] = value;
  return fields;
}

export const getField = (state, account, field) => state.get(fieldKey(account, field));

// What a card name may not carry: any @ (and its full-width and small
// look-alikes), which only a verified handle shows, and the invisible
// characters that reorder or hide text: bidi and format controls, zero-width
// characters.
const UNSHOWN = /[@\uFF20\uFE6B\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/g;

/** A card name for display: no `@` anywhere, no invisible controls, whitespace collapsed; undefined when empty. */
export const displayName = (name) => (typeof name === "string" ? name.replace(UNSHOWN, "").replace(/\s+/g, " ").trim() : "") || undefined;

/**
 * What to show for an account: a card `name` (an app's own, as
 * `displayName` cleans it) with the verified `handle` beside it ("Dana Okafor @dana"), else
 * the handle, else the account's short ID.
 */
export function label(account, { name, handle } = {}) {
  const shown = displayName(name);
  const at = handle ? `@${handle}` : undefined;
  return shown && at ? `${shown} ${at}` : (shown ?? at ?? shortAccount(account));
}

// Writing.

/** The name `handle`, which `account` owns. */
async function ownName(state, account, handle) {
  const entry = await resolve(state, checkedHandle(handle));
  if (!entry) throw new Error(`No one owns @${handle}`);
  if (entry.owner !== account) throw new Error(`@${handle} isn't yours`);
  return entry;
}

/** The pointer of `handle` changed from `old` to `to` (null or undefined: nowhere), if that changes it. */
const repoint = (handle, old, to) => (old === (to ?? undefined) ? [] : [change(pointsKey(handle), old, to ?? undefined)]);

/**
 * The pointer a name's new owner writes, as the policy requires of a name
 * claimed or taken, so none an owner before left survives: at `to`, else at
 * the new owner; `null` clears a pointer the chain holds, and where it holds
 * none, points at the owner too, since a write has to be made.
 */
const taken = (handle, old, to, account) => change(pointsKey(handle), old, to === null && old !== undefined ? undefined : (to ?? account));

/** `point` as an account, `true` standing for `account`. */
const target = (point, account) => (point === true ? account : point == null ? point : checkedAccount(point));

/** `point` for a write that `show`s the handle too: it must point at `account`. */
function showing(point, account, show) {
  if (!show) return point;
  if (point != null && point !== true && point !== account) throw new Error("a handle you show points at you");
  return true;
}

/** `account` names `handle` as the one it shows, after `w`, when `show`. */
const andShow = async (state, account, handle, w, show) => (show ? combine(w, await setField(state, account, "name", handle)) : w);

/**
 * `account` claims the free `handle`, for sale at `price` or not, pointed at
 * account `point` if given (`true`: itself), else at itself; with `show`,
 * pointed at itself and shown as its handle, in the same transaction.
 */
export async function claim(state, account, handle, { price, point, show = false } = {}) {
  checkedHandle(handle);
  if ((await state.get(nameKey(handle))) !== undefined) throw new Error(`@${handle} is taken`);
  const to = target(showing(point, account, show), account);
  const claimed = write([
    change(nameKey(handle), undefined, tokenValue(account, { price })),
    change(namesKey(account, handle), undefined, "1"),
    // Over any pointer a release left behind.
    taken(handle, await state.get(pointsKey(handle)), to, account),
  ]);
  return andShow(state, account, handle, claimed, show);
}

/** Points `handle`, which `account` owns, at account `to` (`true`: itself), or nowhere when null. */
export async function pointName(state, account, handle, to) {
  const entry = await ownName(state, account, handle);
  const changes = repoint(handle, entry.pointer, target(to, account));
  return write(changes.length > 0 ? [unchanged(nameKey(handle), entry.value), ...changes] : []);
}

/** Puts `handle` up for sale at `price`. Anyone may then buy it at that price. */
export async function list(state, account, handle, price) {
  if (price === undefined) throw new Error("a listing needs a price");
  const entry = await ownName(state, account, handle);
  return write([change(nameKey(handle), entry.value, tokenValue(account, { price }))]);
}

/** Takes `handle` off sale, or back from an offer. */
export async function unlist(state, account, handle) {
  const entry = await ownName(state, account, handle);
  return write([change(nameKey(handle), entry.value, account)]);
}

/** Offers `handle` to account `to`, which may then take it for nothing. */
export async function offerName(state, account, handle, to) {
  checkedTerms({ offer: to });
  const entry = await ownName(state, account, handle);
  return write([change(nameKey(handle), entry.value, tokenValue(account, { offer: to }))]);
}

/**
 * `account` takes `handle`: bought at the price the chain holds, its owner
 * paid in the same transaction, or taken as offered to it. Its pointer is
 * cleared, so no one keeps showing it, or where it had none points at the
 * buyer, unless `point` sets one (an account, or `true` for the buyer); with
 * `show`, pointed at the buyer and shown as its handle, in the same
 * transaction.
 */
export async function buy(state, account, handle, { point = null, show = false } = {}) {
  const entry = await resolve(state, checkedHandle(handle));
  if (!entry) throw new Error(`No one owns @${handle}`);
  takeable(entry, account, `@${handle}`);
  point = showing(point, account, show);
  const bought = write(
    [
      change(nameKey(handle), entry.value, account),
      change(namesKey(entry.owner, handle), "1", undefined),
      change(namesKey(account, handle), undefined, "1"),
      taken(handle, entry.pointer, target(point, account), account),
    ],
    paymentFor(entry),
  );
  return andShow(state, account, handle, bought, show);
}

/**
 * `handle` taken by whichever account signs, with no address needed, and
 * pointed at it: claimed when `entry` (as `resolve` returns it) is
 * undefined, else bought at its price. `pointerNow` is the pointer the chain
 * holds (for a free name, one a release left behind). For
 * `writeRequestURI`, not `send`. The signer isn't known here: if it already
 * owns the name, the transaction is refused.
 */
export function acquire(handle, entry, pointerNow = entry?.pointer) {
  checkedHandle(handle);
  if (entry && entry.price === undefined) throw new Error(`@${handle} is not for sale`);
  const taken = entry
    ? [change(nameKey(handle), entry.value, ACCOUNT), change(namesKey(entry.owner, handle), "1", undefined)]
    : [change(nameKey(handle), undefined, ACCOUNT)];
  return write([...taken, change(namesKey(ACCOUNT, handle), undefined, "1"), change(pointsKey(handle), pointerNow, ACCOUNT)], entry ? paymentFor(entry) : []);
}

/** Gives `handle` up, with its pointer; anyone may claim it next. */
export async function release(state, account, handle) {
  const entry = await ownName(state, account, handle);
  return write([change(nameKey(handle), entry.value, undefined), change(namesKey(account, handle), "1", undefined), ...repoint(handle, entry.pointer, null)]);
}

/** Sets `account`'s field, or removes it when undefined. */
export async function setField(state, account, field, value) {
  if (field === "") throw new Error("(empty): not a field name");
  const key = fieldKey(account, field);
  const oldValue = await state.get(key);
  if (value === oldValue) return write([]);
  return write([change(key, oldValue, value)]);
}

/**
 * `account` shows `handle`, in one transaction: it names the handle, and if
 * the handle is its own and points elsewhere, points it at itself. A handle
 * someone else owns can be shown only while it points at `account`.
 */
export async function showName(state, account, handle) {
  const entry = await resolve(state, checkedHandle(handle));
  if (!entry) throw new Error(`No one owns @${handle}`);
  let pointed = write([]);
  if (entry.pointer !== account) {
    if (entry.owner !== account) throw new Error(`@${handle} doesn't point at you`);
    pointed = await pointName(state, account, handle, account);
  }
  return combine(pointed, await setField(state, account, "name", handle));
}

/** `account` shows no handle. */
export const stopShowing = (state, account) => setField(state, account, "name", undefined);
