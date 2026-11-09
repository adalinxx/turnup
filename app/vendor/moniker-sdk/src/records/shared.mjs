// What the records share: the checks the policy makes, token values, and
// writes as `{ actions, payments }` for the wallet (see wallet.mjs).
//
// A token is a key an account holds: `<owner>`, `<owner>@<price>` (for anyone,
// at that price) or `<owner>><account>` (offered to that account for
// nothing). The policy sees only a transaction, so a write acting for a
// token rewrites it to the value it has: consensus checks that value, and the
// policy reads the owner from it. Every value read is parsed as untrusted:
// what does not parse is left out, never fatal.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Whether `handle` is one the policy accepts: lowercase letters, digits and `_`. */
export const isHandle = (handle) => typeof handle === "string" && /^[a-z0-9_]+$/.test(handle);

/** Whether `text` is an account address in its one canonical spelling, as the policy checks it. */
export function isAddress(text) {
  return (
    typeof text === "string" &&
    text.length === 59 &&
    text.startsWith("bafyrei") &&
    [...text.slice(7)].every((c) => BASE32.includes(c)) &&
    BASE32.indexOf(text[7]) < 8 &&
    BASE32.indexOf(text[58]) % 4 === 0
  );
}

/**
 * Stands for the signer in a lattice://write request (wallet.mjs
 * `writeRequestURI`): the wallet fills in the account the person chooses.
 */
export const ACCOUNT = "{account}";

/**
 * A token value as the policy reads it: `{ holder, price?, offer? }`, with
 * `holder` and any `offer` addresses; undefined when it does not parse.
 */
export function readToken(value) {
  if (typeof value !== "string") return undefined;
  const at = value.search(/[@>]/);
  if (at < 0) return isAddress(value) ? { holder: value } : undefined;
  const holder = value.slice(0, at);
  const rest = value.slice(at + 1);
  if (!isAddress(holder)) return undefined;
  if (value[at] === ">") return isAddress(rest) && rest !== holder ? { holder, offer: rest } : undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(rest) || BigInt(rest) >= 2n ** 63n) return undefined;
  return { holder, price: BigInt(rest) };
}

/** Token `key` as held: `{ value, owner, price?, offer? }`, or undefined. */
export async function heldToken(state, key) {
  const value = await state.get(key);
  const token = readToken(value);
  return token && { value, owner: token.holder, ...(token.price !== undefined && { price: token.price }), ...(token.offer && { offer: token.offer }) };
}

/** A token value: its holder, with a price for anyone or an offer to one taker, or neither. */
export function tokenValue(holder, { price, offer } = {}) {
  if (price !== undefined) {
    // A credit pays at most 2^63 - 1.
    if (typeof price !== "bigint" || price < 0n || price >= 2n ** 63n) throw new Error(`bad price: ${price}`);
    return `${holder}@${price}`;
  }
  if (offer === holder) throw new Error("an offer goes to someone else");
  return offer === undefined ? holder : `${holder}>${offer}`;
}

/** A token's terms checked: an offer goes to an address. */
export function checkedTerms(terms = {}) {
  if (terms.offer !== undefined && !isAddress(terms.offer)) throw new Error(`not an address: ${terms.offer}`);
  return terms;
}

/** What a taker pays for a token: its price, if not 0. */
export const paymentFor = (token) => (token.price > 0n ? [{ to: token.owner, amount: token.price }] : []);

/** Whether `account` may take `token`: it is for sale, or offered to `account`. */
export function takeable(token, account, what) {
  if (token.owner === account) throw new Error(`${what} is already yours`);
  if (token.price === undefined && token.offer !== account) throw new Error(`${what} is not for sale`);
}

// Writing. Each change names the value the writer read as the old one, so if
// the key changed since, consensus refuses it: nothing is overwritten unseen,
// and nobody pays a price they did not see.

export const write = (actions, payments = []) => ({ actions, payments });

/** One key's change from what was read to `newValue` (undefined deletes it). */
/** The most bytes the policy lets a key have, and a write store under one. */
export const MAX_KEY_BYTES = 512;
export const MAX_VALUE_BYTES = 16 * 1024;

const bytes = (text) => new TextEncoder().encode(text).length;

/** Refuses here, with the reason, a key or value the policy would refuse. */
function fits(key, value) {
  if (bytes(key) > MAX_KEY_BYTES) throw new Error(`${key.slice(0, 40)}…: a key is at most ${MAX_KEY_BYTES} bytes`);
  if (value !== undefined && bytes(value) > MAX_VALUE_BYTES) {
    throw new Error(`${key}: ${bytes(value)} bytes is too long, at most ${MAX_VALUE_BYTES}`);
  }
}

export const change = (key, oldValue, newValue) => {
  fits(key, newValue);
  return { key, ...(oldValue !== undefined && { oldValue }), ...(newValue !== undefined && { newValue }) };
};

/** A key rewritten to the value it has: shows the policy who holds it. */
export const unchanged = (key, value) => ({ key, oldValue: value, newValue: value });

// The keys a token's change calls for directly after it: its index keys and
// its pointer.
const FOLLOWS = /^(names|points)\//;

/**
 * One write of several, as one transaction. Each key is written once, where
 * it first comes (the policy reads the actions in order): a key rewritten
 * unchanged, to show its value, gives way to a real change of the same key,
 * and the keys that change calls for (index keys, the pointer) move up
 * with it, so they still follow it directly. Two real changes of one key
 * are an error. Payments go in the order of the
 * purchases they pay for, and purchases from one seller split by another's
 * are an error: the policy pays each seller's run of purchases from one
 * credit, and the wallet credits each seller once.
 */
export function combine(...writes) {
  const kept = [];
  const changed = []; // each write's real changes, to order its payments
  for (const w of writes) {
    let after = -1; // while a moved change's followers come: the last place taken
    const real = [];
    for (const action of w.actions) {
      const shows = action.oldValue !== undefined && action.oldValue === action.newValue;
      const index = kept.findIndex((a) => a.key === action.key);
      if (!shows) real.push(action);
      if (index === -1 && after >= 0 && FOLLOWS.test(action.key)) {
        kept.splice(++after, 0, action);
        continue;
      }
      after = -1;
      if (index === -1) {
        kept.push(action);
      } else if (!shows) {
        const first = kept[index];
        if (first.oldValue === undefined || first.oldValue !== first.newValue) throw new Error(`${action.key} is changed twice`);
        kept[index] = action;
        after = index;
      }
    }
    changed.push(real);
  }
  const at = (w) => Math.min(...changed[w].map((action) => kept.indexOf(action)));
  const order = writes.map((_, w) => w).sort((a, b) => at(a) - at(b) || a - b);
  const payments = order.flatMap((w) => writes[w].payments ?? []);
  const sellers = payments.map((p) => p.to).filter((to, i, all) => to !== all[i - 1]);
  if (new Set(sellers).size !== sellers.length) throw new Error("purchases from one seller must come together");
  // The policy lets a transaction claim one free name.
  if (kept.filter((a) => a.key.startsWith("name/") && a.oldValue === undefined && a.newValue !== undefined).length > 1) {
    throw new Error("one write claims at most one name");
  }
  return write(kept, payments);
}
