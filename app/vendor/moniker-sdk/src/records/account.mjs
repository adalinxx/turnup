// How to show an account ID, which is a CID: "bafyrei" (the same for every
// account, block and transaction) and then 52 random base32 characters.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const PREFIX = "bafyrei";

/** The random part of an account ID: what follows the prefix every CID shares. */
const randomPart = (address) => {
  const text = String(address);
  return text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
};

/**
 * An account ID short enough for a row: both ends of its random part
 * ("bc6g…mbbt6a"). For recognizing, not checking: show the whole ID where
 * people check who owns what.
 */
export function shortAccount(address) {
  const rest = randomPart(address);
  return rest.length > 12 ? `${rest.slice(0, 4)}…${rest.slice(-6)}` : rest;
}

/**
 * A 5 by 5 mirrored pattern drawn from an account ID, as SVG markup: the same
 * picture for the same account everywhere. It is drawn from the middle of the
 * ID, which the short form hides, so an ID made to share both ends with
 * another still looks different. Only numbers reach the markup.
 */
export function accountIcon(address, size = 24) {
  const bits = [...randomPart(address).slice(20, 25).padEnd(5, "a")].reduce(
    (n, c) => n * 32 + Math.max(0, BASE32.indexOf(c)),
    0,
  ); // 25 bits: 15 for the cells, 10 for the hue
  const hue = Math.floor(((bits >>> 15) % 1024) * (360 / 1024));
  const px = Math.max(1, Math.round(Number(size) || 24));
  let cells = "";
  for (let i = 0; i < 15; i++) {
    if (!((bits >>> i) & 1)) continue;
    const row = i % 5;
    const col = Math.floor(i / 5); // 0, 1, 2: the middle column, then mirrored pairs
    for (const x of new Set([2 - col, 2 + col])) cells += `<rect x="${x}" y="${row}" width="1" height="1"/>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="-0.5 -0.5 6 6" shape-rendering="crispEdges" aria-hidden="true">` +
    `<rect x="-0.5" y="-0.5" width="6" height="6" fill="hsl(${hue} 45% 90%)"/>` +
    `<g fill="hsl(${hue} 55% 42%)">${cells}</g></svg>`
  );
}
