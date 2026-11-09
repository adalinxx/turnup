// An account's photo: the `avatar` of its card (records/profile.mjs) names
// it by CID, and the bytes live off the chain, in lattice-storage's file
// layout: one Volume of one DAG-CBOR block `{ type, size, bytes }` (older
// files, as Murmur keeps them, `{ type, bytes }`). A storage sponsor keeps it
// for good, paid with the owner's work (storage.mjs), and serves it from its
// node. A reader fetches it by CID from any host and checks it against the
// CID, then checks it is a photo: a raster type, never SVG, whose bytes are
// that type, and small.
//
// Browser-safe: base64 through btoa, which Node has too. `preparePhoto`
// needs a browser's canvas.

/** The types a photo may be: raster only, never SVG. */
export const PHOTO_TYPES = ["image/webp", "image/png", "image/jpeg"];

/** The most bytes a photo may hold, written or read. */
export const MAX_PHOTO_BYTES = 256 * 1024;

/** How many pixels across `preparePhoto` makes a photo. */
export const PHOTO_PIXELS = 512;

const toBase64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

const startsWith = (bytes, prefix, at = 0) => prefix.every((byte, i) => bytes[at + i] === byte);
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));

/** Whether `bytes` begin as a file of `type` does, so a photo is the type it says. */
export function isType(type, bytes) {
  if (type === "image/png") return startsWith(bytes, [0x89, ...ascii("PNG\r\n"), 0x1a, 0x0a]);
  if (type === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (type === "image/webp") return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
  return false;
}

/** Refuses, with the reason, a photo this SDK would not show. */
function checkedPhoto(type, bytes) {
  if (!PHOTO_TYPES.includes(type)) throw new Error("A photo is a WebP, PNG or JPEG picture.");
  if (!(bytes instanceof Uint8Array) || !isType(type, bytes)) throw new Error(`That isn't a ${type.slice(6).toUpperCase()} picture.`);
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error(`A photo is at most ${MAX_PHOTO_BYTES / 1024} KB.`);
}

/** The Volume for a photo, as a storage sponsor's `POST /store` and a node's `POST /pins` take it: `{ cid, entries }`. */
export function photoVolume(sdk, type, bytes) {
  checkedPhoto(type, bytes);
  const block = sdk.encodeDagCbor({ bytes, size: BigInt(bytes.length), type });
  const cid = sdk.cidV1DagCbor(block);
  return { cid, entries: { [cid]: toBase64(block) } };
}

/**
 * The photo in a block read for its CID, `{ type, bytes }`, or undefined when
 * it is not one this SDK shows: not exactly `{ type, size, bytes }` or `{
 * type, bytes }`, a size that isn't the bytes', a type not in PHOTO_TYPES,
 * bytes that aren't that type, or over MAX_PHOTO_BYTES. The block must have
 * been checked against its CID by whoever read it (the SDK's VolumeClient
 * does).
 */
export function readPhoto(sdk, block) {
  let file;
  try {
    file = sdk.decodeDagCbor(block);
  } catch {
    return undefined;
  }
  if (typeof file !== "object" || file === null) return undefined;
  const keys = Object.keys(file).sort().join(",");
  if (keys !== "bytes,size,type" && keys !== "bytes,type") return undefined;
  const { type, bytes, size } = file;
  if (typeof type !== "string" || !(bytes instanceof Uint8Array)) return undefined;
  if (size !== undefined && !((typeof size === "bigint" || Number.isSafeInteger(size)) && BigInt(size) === BigInt(bytes.length))) return undefined;
  try {
    checkedPhoto(type, bytes);
  } catch {
    return undefined;
  }
  return { type, bytes };
}

/**
 * A chosen picture as a photo, in a browser: cropped to its middle square,
 * at most `pixels` across, re-encoded (which drops its metadata, such as
 * where it was taken) as WebP where the browser writes it, else JPEG, and at
 * most MAX_PHOTO_BYTES. Resolves to `{ type, bytes }`.
 */
export async function preparePhoto(file, { pixels = PHOTO_PIXELS } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That isn't a picture this browser can read.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const [x, y] = [(bitmap.width - side) / 2, (bitmap.height - side) / 2];
  let across = Math.min(pixels, side);
  for (let tries = 0; tries < 6; tries++, across = Math.round(across * 0.75)) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.max(1, across);
    canvas.getContext("2d").drawImage(bitmap, x, y, side, side, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.72]) {
      let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (blob?.type !== "image/webp") blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_PHOTO_BYTES) return { type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) };
    }
  }
  throw new Error("That picture couldn't be made small enough.");
}
