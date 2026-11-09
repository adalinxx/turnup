// Small pure helpers for the page: text, dates, routes. No DOM here, so
// they are tested in Node.

/** `text` safe inside HTML text or a double-quoted attribute. */
export const esc = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else a date. */
export function ago(time, now = Date.now()) {
  const d = now - time;
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return day(time, now);
}

/** "Tue 3 Nov", with the year when it isn't this one. */
export function day(time, now = Date.now()) {
  const d = new Date(time);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(!sameYear && { year: "numeric" }) });
}

/** When something was lost or found, as a person says it. */
export function whenText(time, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return "today";
  if (time >= start.getTime() - DAY) return "yesterday";
  return `on ${day(time, now)}`;
}

/** A date input's value (local "YYYY-MM-DD") for `time`. */
export function dateValue(time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The time a date input's value stands for: now when it is today (or later,
 * which isn't allowed), else midday that day, local time. Undefined when the
 * value isn't a date.
 */
export function fromDateValue(value, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  if (Number.isNaN(d.getTime())) return undefined;
  return dateValue(d.getTime()) >= dateValue(now) ? now : d.getTime();
}

/** Metres as a person says them. */
export const metres = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`);

/** A picture for each kind of thing, for lists without a photo. */
export const EMOJI = {
  phone: "📱", wallet: "👛", keys: "🔑", bag: "🎒", cards: "🪪", electronics: "💻", jewelry: "💍", clothing: "🧥",
  glasses: "👓", pet: "🐾", bike: "🚲", toy: "🧸", documents: "📄", other: "📦",
};

/** The hash route as `{ name, args }`. */
export function parseRoute(hash) {
  const parts = String(hash ?? "").replace(/^#\/?/, "").split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [name = "home", ...args] = parts;
  return { name, args };
}

/** An item's route. The root chain is "-" in a route. */
export const itemHref = (it) => `#/item/${it.chain || "-"}/${encodeURIComponent(it.author)}/${encodeURIComponent(it.id)}`;
export const chainLabel = (arg) => (arg === "-" || !arg ? "" : arg);

/** Text with links made safe: escaped, with line breaks kept by CSS. */
export const textHTML = (text) => esc(text);

/** An OpenStreetMap link to a point, for a shared location. */
export const osmLink = (p) => `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(5)}&mlon=${p.lon.toFixed(5)}#map=18/${p.lat.toFixed(5)}/${p.lon.toFixed(5)}`;
