// <moniker-name address="…"> for any page: an account's verified @handle,
// beside the name your app knows it by, the handle linked to its Moniker
// page. Register it once with a Moniker from createMoniker:
//
//   defineMonikerName(moniker);
//   <moniker-name address="bafyrei…"></moniker-name>
//   <moniker-name address="bafyrei…" name="Dana Okafor" size="24" plain></moniker-name>   (no link)
//
// `name` is your app's own (a card on your chain); without it, the name on
// the account's Moniker card shows. Every @ and invisible control is dropped
// from either, so only a verified handle shows with an @. Style it from
// outside with CSS custom properties: --moniker-ink, --moniker-muted and
// --moniker-accent. The picture is the photo on the account's Moniker card,
// else the account's own pattern (accountIcon), the same in every app. Names
// in a feed share one read of the chain.
//
//   defineMonikerPhoto(moniker);
//   <moniker-photo address="bafyrei…" size="40"></moniker-photo>              (the picture alone)

import { accountIcon, shortAccount } from "./records/account.mjs";
import { displayName } from "./records/names.mjs";

const style = `
  :host { display: inline-flex; align-items: center; gap: 0.5em; font: inherit; color: var(--moniker-ink, inherit); min-width: 0; }
  a { display: inline-flex; align-items: center; gap: 0.5em; color: inherit; text-decoration: none; min-width: 0; }
  a:hover .name { text-decoration: underline; }
  .photo { flex: none; display: inline-flex; border-radius: 22%; overflow: hidden; }
  .photo img { display: block; object-fit: cover; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .handle { color: var(--moniker-accent, #1f3fbf); font-family: ui-monospace, monospace; font-size: 0.9em; white-space: nowrap; }
`;

/**
 * What a byline shows for `address`: `text` (the app's `name`, else the
 * card's, else `@handle`, else the short ID), `handle` (shown beside a name:
 * the verified `@handle`, or the short ID beside a card's name with no
 * handle, since anyone may copy a card's name and photo) and `avatar` (the
 * card's photo CID, if any).
 */
export function byline({ address, name, handle, profile }) {
  const own = displayName(name);
  const shown = own ?? displayName(profile?.name);
  const beside = handle ? `@${handle}` : shown && !own ? shortAccount(address) : undefined;
  return {
    text: shown ?? (handle ? `@${handle}` : shortAccount(address)),
    ...(shown && beside && { handle: beside }),
    ...(profile?.avatar && { avatar: profile.avatar }),
  };
}

// One read for every element drawn together: addresses gathered in a tick,
// per Moniker client.
const lookups = new WeakMap();
function lookupFor(moniker) {
  if (lookups.has(moniker)) return lookups.get(moniker);
  let waiting = new Map(); // address → [resolve]
  let scheduled = false;
  const lookup = (address) =>
    new Promise((resolve) => {
      waiting.set(address, [...(waiting.get(address) ?? []), resolve]);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(async () => {
        const batch = waiting;
        waiting = new Map();
        scheduled = false;
        const addresses = [...batch.keys()];
        const none = addresses.map(() => undefined);
        const [handles, profiles] = await Promise.all([moniker.handlesOf(addresses).catch(() => none), moniker.profiles(addresses).catch(() => none)]);
        addresses.forEach((address, i) => batch.get(address).forEach((done) => done({ handle: handles[i], profile: profiles[i] })));
      });
    });
  lookups.set(moniker, lookup);
  return lookup;
}

/** The picture for `address`: its pattern at once, its card's photo in its place once read, while `current()`. */
function picture(moniker, address, avatar, size, current) {
  const photo = document.createElement("span");
  photo.className = "photo";
  photo.innerHTML = accountIcon(address, size);
  photo.setAttribute("aria-hidden", "true");
  if (avatar) {
    moniker.photoURL(avatar).then((url) => {
      if (!url || !current()) return;
      const img = Object.assign(document.createElement("img"), { src: url, alt: "", width: size, height: size, decoding: "async" });
      // A photo that won't draw leaves the pattern.
      img.onload = () => current() && photo.replaceChildren(img);
    });
  }
  return photo;
}

/** An element class drawn by `draw(root, address, size, found, current)` once its account is looked up. */
function drawnElement(moniker, attributes, draw) {
  const lookup = lookupFor(moniker);
  return class extends HTMLElement {
    static observedAttributes = attributes;
    #drawn = 0;
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }
    connectedCallback() {
      this.#draw();
    }
    attributeChangedCallback() {
      if (this.isConnected) this.#draw();
    }
    async #draw() {
      const ticket = ++this.#drawn;
      const address = this.getAttribute("address") ?? "";
      const size = Number(this.getAttribute("size")) || 28;
      const root = this.shadowRoot;
      root.replaceChildren(Object.assign(document.createElement("style"), { textContent: style }));
      if (!address) return;
      const found = await lookup(address);
      if (ticket !== this.#drawn) return;
      draw.call(this, root, address, size, found, () => ticket === this.#drawn);
    }
  };
}

export function defineMonikerName(moniker, tag = "moniker-name") {
  if (customElements.get(tag)) return;
  customElements.define(
    tag,
    drawnElement(moniker, ["address", "name", "size", "plain"], function (root, address, size, { handle, profile }, current) {
      const shown = byline({ address, name: this.getAttribute("name"), handle, profile });
      // Only a handle has a page.
      const outer =
        this.hasAttribute("plain") || !handle
          ? document.createElement("span")
          : Object.assign(document.createElement("a"), { href: moniker.pageURL(`@${handle}`), target: "_blank", rel: "noopener" });
      outer.append(picture(moniker, address, shown.avatar, size, current), Object.assign(document.createElement("span"), { className: "name", textContent: shown.text }));
      if (shown.handle) outer.append(Object.assign(document.createElement("span"), { className: "handle", textContent: shown.handle }));
      root.append(outer);
    }),
  );
}

/** `<moniker-photo address size>`: the account's picture alone, as `<moniker-name>` draws it. */
export function defineMonikerPhoto(moniker, tag = "moniker-photo") {
  if (customElements.get(tag)) return;
  customElements.define(
    tag,
    drawnElement(moniker, ["address", "size"], (root, address, size, { profile }, current) => {
      root.append(picture(moniker, address, profile?.avatar, size, current));
    }),
  );
}
