// Possible matches between a lost report and found items, or the other way
// round: worked out on the reader's device from what is on the chain, with
// the reasons shown, never a bare score. A match is a suggestion; only the
// people talking decide whether a thing is someone's.

import { distance } from "./geo.mjs";

/** How far apart a lost and a found report may be and still be suggested, in metres. */
export const RADIUS = 3000;
const DAY = 24 * 3600 * 1000;

const STOP = new Set("a an the my his her their our your and or of with in on at to for from by is it its this that black white".split(" "));
const words = (item) =>
  new Set(
    `${item.title} ${item.details ?? ""} ${item.place ?? ""}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );

/**
 * Whether `other` could be the same thing as `mine`, and why:
 * `{ item, metres, reasons: [string], score }`, or undefined. Lost and found
 * pair only one way: the find must come after the loss (a day's slack for
 * clocks and guesses), in the same kind of thing (or "something else"),
 * within RADIUS.
 */
export function compare(mine, other) {
  if (mine.type === other.type || mine.author === other.author) return undefined;
  const lost = mine.type === "lost" ? mine : other;
  const found = mine.type === "found" ? mine : other;
  if (found.when < lost.when - DAY) return undefined;
  const sameKind = lost.category === found.category;
  if (!sameKind && lost.category !== "other" && found.category !== "other") return undefined;
  const metres = distance(lost, found);
  if (metres > RADIUS) return undefined;
  const reasons = [];
  if (sameKind) reasons.push("Same kind of thing");
  reasons.push(metres < 150 ? "Same spot" : metres < 1000 ? `${Math.round(metres / 10) * 10} m away` : `${(metres / 1000).toFixed(1)} km away`);
  const days = Math.max(0, Math.round((found.when - lost.when) / DAY));
  reasons.push(days === 0 ? "Found the same day" : days === 1 ? "Found a day later" : `Found ${days} days later`);
  const mineWords = words(mine);
  const shared = [...words(other)].filter((w) => mineWords.has(w));
  if (shared.length) reasons.push(`Both say “${shared.slice(0, 3).join("”, “")}”`);
  const score = (sameKind ? 2 : 0) + (1 - metres / RADIUS) * 2 + Math.max(0, 1 - days / 14) + shared.length;
  return { item: other, metres, reasons, score };
}

/** The best matches for `mine` among `others`, best first. */
export function matches(mine, others, limit = 6) {
  return others
    .map((other) => compare(mine, other))
    .filter(Boolean)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}
