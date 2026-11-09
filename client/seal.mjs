// Private messages between two accounts, kept on a public chain.
//
// Each account has an inbox key: an X25519 key pair. Its public half is a
// record anyone reads (`user/<a>/box`); its private half never leaves the
// device. It is derived from the account's signature over a fixed message,
// so the same wallet makes the same inbox key on any device, and nothing
// needs backing up. Ed25519 signatures are deterministic: one key, one text,
// one signature.
//
// A message is sealed once, for its recipient and its sender alike: a random
// content key encrypts the text (AES-GCM), and the content key is wrapped
// for each reader under a key agreed between a fresh ephemeral key and that
// reader's inbox key (X25519, then HKDF-SHA-256). Anyone sees who wrote to
// whom and when; nobody else sees what.
//
// X25519 is noble's (vendored), as some browsers still in use lack it in
// WebCrypto; HKDF and AES-GCM are WebCrypto's.
import { x25519 } from "../app/vendor/x25519.mjs";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** What the wallet signs to make the inbox key. Changing it changes every key. */
export const UNLOCK_TEXT =
  "Turnup inbox key v1\n\nSigning this opens your Turnup messages on this device. It can't move coins or write anything.";

const b64 = (bytes) => {
  let text = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (text) => {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};
export { b64 as toBase64url, unb64 as fromBase64url };

async function hkdf(secret, salt, info, length = 32) {
  const key = await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, key, length * 8));
}

/** An inbox key from 32 secret bytes: `{ privateKey, publicKey }` (privateKey bytes, publicKey base64url). */
const fromSeed = (seed) => ({ privateKey: seed, publicKey: b64(x25519.getPublicKey(seed)) });

/**
 * The inbox key of the wallet that made `signature` (hex) over UNLOCK_TEXT.
 * Also `seed`, base64url, to keep on this device and `restore` from.
 */
export async function inboxKey(signature) {
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) throw new Error("Not a signature");
  const bytes = Uint8Array.from(signature.match(/../g), (h) => parseInt(h, 16));
  const seed = await hkdf(bytes, enc.encode("turnup"), "inbox x25519 v1");
  return { ...fromSeed(seed), seed: b64(seed) };
}

/** An inbox key kept as its seed. */
export async function restore(seed) {
  const bytes = unb64(seed);
  if (bytes.length !== 32) throw new Error("Not an inbox seed");
  return { ...fromSeed(bytes), seed };
}

/** Whether `text` is an inbox public key as records hold it. */
export const isPublicKey = (text) => typeof text === "string" && /^[A-Za-z0-9_-]{43}$/.test(text);

async function wrapKey(privateKey, publicText, ephemeral) {
  const shared = x25519.getSharedSecret(privateKey, unb64(publicText));
  const bits = await hkdf(shared, unb64(ephemeral), "turnup wrap v1");
  return subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * `message` (any JSON value) sealed for `readers` = `{ <address>: <inbox public key> }`:
 * a string to keep in a record. Each reader opens it with their inbox key.
 */
export async function seal(message, readers) {
  const entries = Object.entries(readers);
  if (entries.length === 0) throw new Error("Nobody to seal for");
  for (const [, key] of entries) if (!isPublicKey(key)) throw new Error("Not an inbox key");
  const ephemeral = crypto.getRandomValues(new Uint8Array(32));
  const e = b64(x25519.getPublicKey(ephemeral));
  const content = crypto.getRandomValues(new Uint8Array(32));
  const n = crypto.getRandomValues(new Uint8Array(12));
  const contentKey = await subtle.importKey("raw", content, "AES-GCM", false, ["encrypt"]);
  const c = await subtle.encrypt({ name: "AES-GCM", iv: n }, contentKey, enc.encode(JSON.stringify(message)));
  const w = {};
  for (const [address, key] of entries) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(address) }, await wrapKey(ephemeral, key, e), content);
    w[address] = b64(new Uint8Array([...iv, ...new Uint8Array(wrapped)]));
  }
  return JSON.stringify({ v: 1, e, n: b64(n), c: b64(c), w });
}

/**
 * The message in `box` for `address`, opened with its inbox key `me`
 * (`{ privateKey }`), or undefined when it isn't sealed for them or doesn't
 * open. Never throws: boxes are written by anyone.
 */
export async function open(box, address, me) {
  try {
    const sealed = JSON.parse(box);
    if (sealed?.v !== 1 || typeof sealed.w?.[address] !== "string") return undefined;
    const wrapped = unb64(sealed.w[address]);
    const key = await wrapKey(me.privateKey, sealed.e, sealed.e);
    const content = await subtle.decrypt({ name: "AES-GCM", iv: wrapped.subarray(0, 12), additionalData: enc.encode(address) }, key, wrapped.subarray(12));
    const contentKey = await subtle.importKey("raw", content, "AES-GCM", false, ["decrypt"]);
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.n) }, contentKey, unb64(sealed.c));
    return JSON.parse(dec.decode(plain));
  } catch {
    return undefined;
  }
}
