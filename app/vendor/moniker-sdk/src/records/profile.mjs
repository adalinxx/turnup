// An account's default profile card on Moniker, read from a state view
// `{ get(key), list(prefix) }` (see state.mjs) and written as
// `{ actions }` for the wallet (see wallet.mjs).
//
// Key:
//   user/<a>/profile   the card, one JSON value:
//                      { name, description, avatar, url, links: [{ label, url }] }
//
// The card is a default any app may show; apps may keep their own on their
// own chains. It holds no handle: the verified handle is `user/<a>/name` and
// `points/<h>` (names.mjs), and a `handle` an old card carries is ignored.
// Only the account writes its card, but it writes what it likes, so every
// value is parsed as untrusted: what does not parse is left out, never fatal.
import { displayName, fieldKey } from "./names.mjs";
import { change, isAddress, write } from "./shared.mjs";

export const profileKey = (account) => fieldKey(account, "profile");

/** The card's fields this SDK reads and writes. Others a card carries are kept on write; `handle` is dropped. */
export const CARD_FIELDS = ["name", "description", "avatar", "url", "links"];

/** The most characters a display name, a bio and a link's label keep, and the most links a card shows. */
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 280;
export const MAX_LABEL = 40;
export const MAX_LINKS = 8;

/** Whether `url` is a web address a client may link to: http or https only. */
export function isWebURL(url) {
  if (typeof url !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Whether `cid` is the CID of a file's root block: CIDv1, DAG-CBOR, SHA-256,
 * in base32. Account IDs are CIDs of that kind too, so the same check.
 */
export const isPhotoCID = isAddress;

/** `text`'s first `max` characters, by code point, so none is cut in half. */
const clip = (text, max) => [...text].slice(0, max).join("");

/** `text` trimmed, or undefined when it is not a string or is empty. */
const filled = (text) => (typeof text === "string" && text.trim() !== "" ? text.trim() : undefined);

const parseObject = (value) => {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** The card's links, in the owner's order: entries that are not a label and a web address are left out. */
const readLinks = (links) =>
  Array.isArray(links)
    ? links
        .filter((link) => filled(link?.label) && isWebURL(link.url))
        .slice(0, MAX_LINKS)
        .map(({ label, url }) => ({ label: clip(label.trim(), MAX_LABEL), url }))
    : [];

/**
 * A card value as apps show it: `{ name?, description?, avatar?, url?,
 * links? }` with only what parses, or undefined when nothing does. The name
 * is cleaned as `displayName` cleans it, so it never poses as a handle.
 */
export function readCard(value) {
  const card = typeof value === "string" ? parseObject(value) : undefined;
  if (!card) return undefined;
  const name = displayName(card.name);
  const description = filled(card.description);
  const links = readLinks(card.links);
  const read = {
    ...(name && { name: clip(name, MAX_NAME) }),
    ...(description && { description: clip(description, MAX_DESCRIPTION) }),
    ...(isPhotoCID(card.avatar) && { avatar: card.avatar }),
    ...(isWebURL(card.url) && { url: card.url }),
    ...(links.length > 0 && { links }),
  };
  return Object.keys(read).length > 0 ? read : undefined;
}

/** `account`'s card, as `readCard` reads it; undefined when it has none. */
export const profileOf = async (state, account) => readCard(await state.get(profileKey(account)));

/** `profileOf` for many accounts, in order, from one state: for a feed. */
export const profilesOf = (state, accounts) => Promise.all(accounts.map((account) => profileOf(state, account)));

// Writing.

/** One field of a card to write, checked; undefined removes it. */
function checkedField(field, value) {
  if (value === undefined || value === null || value === "" || (field === "links" && Array.isArray(value) && value.length === 0)) return undefined;
  if (field === "name") {
    const name = displayName(value);
    if (name && [...name].length > MAX_NAME) throw new Error(`name: at most ${MAX_NAME} characters`);
    return name;
  }
  if (field === "description") {
    if (typeof value !== "string") throw new Error("description: text");
    const description = filled(value);
    if (description && [...description].length > MAX_DESCRIPTION) throw new Error(`description: at most ${MAX_DESCRIPTION} characters`);
    return description;
  }
  if (field === "avatar") {
    if (!isPhotoCID(value)) throw new Error(`avatar: not a photo's CID: ${value}`);
    return value;
  }
  if (field === "url") {
    if (!isWebURL(value)) throw new Error(`url: ${value} is not an http or https address`);
    return value;
  }
  if (field === "links") {
    if (!Array.isArray(value)) throw new Error("links: a list of { label, url }");
    if (value.length > MAX_LINKS) throw new Error(`links: at most ${MAX_LINKS}`);
    return value.map(({ label, url } = {}) => {
      if (!filled(label)) throw new Error("links: every link needs a label");
      if ([...label.trim()].length > MAX_LABEL) throw new Error(`links: a label is at most ${MAX_LABEL} characters`);
      if (!isWebURL(url)) throw new Error(`links: ${url} is not an http or https address`);
      return { label: label.trim(), url };
    });
  }
  throw new Error(`${field}: not a card field`);
}

/**
 * Changes `account`'s card: each field `card` names (`name`, `description`,
 * `avatar`, `url`, `links`) is set, or removed when undefined, null, "" or
 * an empty list; fields it doesn't name are kept, and so are fields this SDK
 * doesn't know, but not an old card's `handle`. An empty card is deleted.
 * The change names the card it read, so if the card changed since, consensus
 * refuses it. Nothing to write when nothing changes.
 */
export async function setProfile(state, account, card) {
  if (!isAddress(account)) throw new Error(`not an address: ${account}`);
  const key = profileKey(account);
  const oldValue = await state.get(key);
  const { handle, ...next } = parseObject(oldValue) ?? {};
  for (const [field, value] of Object.entries(card ?? {})) {
    const checked = checkedField(field, value);
    if (checked === undefined) delete next[field];
    else next[field] = checked;
  }
  const newValue = Object.keys(next).length > 0 ? JSON.stringify(next) : undefined;
  if (newValue === oldValue) return write([]);
  return write([change(key, oldValue, newValue)]);
}

/** Deletes `account`'s card. */
export async function clearProfile(state, account) {
  const oldValue = await state.get(profileKey(account));
  return write(oldValue === undefined ? [] : [change(profileKey(account), oldValue, undefined)]);
}
