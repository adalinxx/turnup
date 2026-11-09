// Turnup in the browser. Everything shown is read from Lattice hosts and
// checked by CID; every change is signed in the person's Selfhold wallet,
// whose passkey holds their key, and its fee is paid with a few seconds of
// this device's work through a fee sponsor. No server, no coins, no sign-up.
import * as sdk from "./vendor/lattice-sdk.js";
import { selfhold } from "./vendor/selfhold.mjs";
import qrcode from "./vendor/qrcode.mjs";
import { photoVolume, preparePhoto, readPhoto } from "./vendor/moniker-sdk/src/photo.mjs";
import { store as storeFile, storageChain } from "./vendor/moniker-sdk/src/storage.mjs";
import { hasher } from "./vendor/moniker-sdk/vendor/work/hash.mjs";
import { accountIcon, shortAccount } from "./vendor/moniker-sdk/src/records/account.mjs";
import * as geo from "../client/geo.mjs";
import * as records from "../client/records.mjs";
import { matches } from "../client/match.mjs";
import { createPending } from "../client/pending.mjs";
import { inboxKey, restore, UNLOCK_TEXT } from "../client/seal.mjs";
import { createTurnup } from "../client/turnup.mjs";
import { EMOJI, ago, chainLabel, dateValue, day, esc, fromDateValue, itemHref, metres, osmLink, parseRoute, plural, whenText } from "./lib.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ------------------------------------------------------------------ settings

export const DEFAULTS = {
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  chain: "Nexus/testnet/turnup-b3494e",
  sponsor: "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor",
  view: { lat: 40.7411, lon: -73.9897, zoom: 14 },
};
const params = new URLSearchParams(location.search);
// A link may name other hosts, a chain, a sponsor or a wallet for this visit.
const nodes = (params.get("node") ?? "").split(",").filter(Boolean).map((n) => n.replace(/\/+$/, ""));
const NODES = nodes.length ? nodes : DEFAULTS.nodes;
const ROOT = (params.get("chain") || DEFAULTS.chain).split("/");
const SPONSOR = params.get("sponsor") || DEFAULTS.sponsor;
const WALLET = params.get("wallet") || undefined;

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`turnup:${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(`turnup:${key}`);
      else localStorage.setItem(`turnup:${key}`, JSON.stringify(value));
    } catch {}
  },
};

const pending = createPending(localStorage, `turnup:pending:${ROOT.join("/")}`);
const turnup = createTurnup({ sdk, root: ROOT, nodes: NODES, overlay: (path, state) => pending.over(path, state) });
const wallet = selfhold({ use: "window", ...(WALLET && { wallet: WALLET }), hosts: () => NODES, sponsor: () => SPONSOR });

// ------------------------------------------------------------------ who is here

let me = null; // the connected account, or null
let inbox = null; // my inbox key { privateKey, publicKey, seed }, once unlocked on this device

/**
 * Who is here: the account Selfhold connects to this site, else the one that
 * signed this device's inbox text (a signature proves it, though Selfhold
 * only counts the site connected after its first write).
 */
async function loadMe() {
  me = (await wallet.address().catch(() => null)) ?? store.get("me", null);
  inbox = null;
  const seed = me && store.get(`inbox:${me}`);
  if (seed) inbox = await restore(seed).catch(() => null);
}

/** Signs in (a passkey in Selfhold's window). Call from a click. */
async function signIn() {
  me = await wallet.connect();
  await loadMe();
  return me;
}

/**
 * Opens this account's messages on this device: Selfhold signs a fixed text,
 * and the inbox key is made from the signature. Call from a click.
 */
async function unlock() {
  const { publicKey, signature } = await wallet.signMessage({ text: UNLOCK_TEXT });
  const signer = sdk.addressFromMultikey(publicKey);
  if (me && signer !== me) throw new Error("Selfhold signed with a different account. Look again, then try again.");
  me = signer;
  inbox = await inboxKey(signature);
  store.set(`inbox:${me}`, inbox.seed);
  store.set("me", me);
  return inbox;
}

function signOut() {
  if (me) store.set(`inbox:${me}`, undefined);
  store.set("me", undefined);
  wallet.disconnect().catch(() => {});
  me = null;
  inbox = null;
}

/**
 * What still stands between this person and a write that others may answer:
 * "signin" (no account here), "unlock" (messages not opened on this device),
 * or null (ready).
 */
const nextStep = (needsInbox = true) => (!me ? "signin" : needsInbox && !inbox ? "unlock" : null);

/** One click's worth of getting ready; true when ready for the write itself. */
async function step(needsInbox = true) {
  const next = nextStep(needsInbox);
  if (next === "signin") {
    // One passkey prompt that both signs in and opens messages.
    if (needsInbox) await unlock();
    else await signIn();
    return false;
  }
  if (next === "unlock") {
    await unlock();
    return false;
  }
  return true;
}
const stepLabel = (action, needsInbox = true) =>
  ({ signin: "Continue with a passkey", unlock: "Open my messages" })[nextStep(needsInbox)] ?? action;
const stepNote = (needsInbox = true) =>
  ({
    signin: "Your passkey makes a free account in Selfhold, and opens your private messages. No coins, no email, no password.",
    unlock: "Selfhold signs once to open your private messages on this device.",
  })[nextStep(needsInbox)] ?? "";

// ------------------------------------------------------------------ writing

/** A reason a person can act on, from whatever went wrong. */
function problem(error) {
  const code = error?.code;
  if (code === "Closed" || code === "Declined" || code === "Rejected") return "Nothing was sent.";
  if (code === "NeedsCoins") {
    return {
      down: "The fee sponsor isn't answering, so this device's work can't pay the fee right now. Try again in a minute.",
      most: "The fee sponsor pays only so much for one change, and this costs more.",
    }[error.sponsor] ?? "The fee sponsor couldn't pay for this. Try again in a minute.";
  }
  if (code === "AccountChanged" || code === "NotConnected") return error.message;
  return String(error?.message ?? error).replace(/^Error: /, "");
}

/** Whether `account` may write on `path` now: its last write there landed or was dropped. */
async function canWrite(path) {
  const chain = path.join("/");
  const waiting = pending.waiting(chain, me);
  if (!waiting) return true;
  await pending.settle(chain, await turnup.chainState(path, { fresh: true }));
  return !pending.waiting(chain, me);
}

/**
 * Sends the writes `prepare(path)` makes on chain `where` (a path, or a
 * promise of one) through Selfhold, shown at once. `what` names it in the
 * "saving" line. Call it from a click before any other wait: Selfhold's
 * window opens at once (a browser blocks one opened later) and the write is
 * made while it opens. Throws with a readable reason.
 */
async function send(where, prepare, what, progress) {
  if (!me) throw new Error("Sign in first.");
  let path;
  let actions = [];
  const request = (async () => {
    path = await where;
    if (!(await canWrite(path))) throw new Error("Your last change is still being saved. This one can go once it lands, in a minute or two.");
    const writes = await prepare(path);
    actions = await records.changes(await turnup.chainState(path, { fresh: true }), writes);
    return actions.length ? { chainPath: path, actions } : null;
  })();
  // Before its first write Selfhold hasn't connected this site, though `me`
  // signed here: it then writes as the account its window holds, checked below.
  const connected = (await wallet.address().catch(() => null)) === me;
  const sent = await wallet.writeRecords(request, { ...(connected && { account: me }), progress });
  if (!sent) return null;
  if (sent.account && sent.account !== me) throw new Error("Selfhold wrote as a different account than the one signed in here. Sign out, then sign in again.");
  pending.add({
    chain: path.join("/"),
    account: me,
    what,
    sent: { cid: sent.transactionCID, nonce: sent.nonce, host: sent.host, account: me, at: Date.now() },
    actions: actions.map(({ key, newValue }) => ({ key, ...(newValue !== undefined && { newValue }) })),
  });
  showSaving();
  return sent;
}

/** The inbox key `a` published: on the root, else on `label`'s chain. */
async function boxFor(a, label = "") {
  const fromRoot = await turnup.boxOf(a, { fresh: true });
  if (fromRoot) return fromRoot;
  if (!label) return undefined;
  return records.boxOf(await turnup.state(turnup.chain(label), { fresh: true }), a);
}

/** My inbox key, to write beside a change on `path` when that chain doesn't have it yet. */
async function myBoxWrite(path) {
  if (!inbox) return undefined;
  const there = await records.boxOf(await turnup.chainState(path, { fresh: true }), me);
  return there === inbox.publicKey ? undefined : inbox.publicKey;
}

// ------------------------------------------------------------------ the saving line and toasts

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 4500);
}

function showSaving() {
  const mine = pending.all().filter((p) => p.account === me);
  const line = $("#saving");
  line.hidden = mine.length === 0;
  if (mine.length) line.innerHTML = `<span class="spin" aria-hidden="true"></span><span>Saving ${esc(mine.map((p) => p.what).join(", "))}… Others see it in a minute or two.</span>`;
}

/** Drops what landed; says so when a change was lost. */
async function settleAll() {
  const chains = new Set(pending.all().map((p) => p.chain));
  for (const chain of chains) {
    try {
      const lost = await pending.settle(chain, await turnup.chainState(chain.split("/"), { fresh: true }));
      for (const p of lost) toast(`Didn't save: ${p.what}. Try it again.`);
    } catch {}
  }
  showSaving();
}

// ------------------------------------------------------------------ small views

const whoHTML = (a, { you = me } = {}) =>
  `<span class="who"><span class="icon">${accountIcon(a, 28)}</span><b>${a === you ? "You" : esc(shortAccount(a))}</b></span>`;

const typeTag = (it) =>
  it.status === "resolved"
    ? `<span class="tagline done">${it.type === "found" ? "Returned" : "Found again"}</span>`
    : `<span class="tagline ${it.type}">${it.type === "found" ? "Found" : "Lost"}</span>`;

const photoCache = new Map();
/** A blob URL for photo `cid`, read from any host and checked; undefined if it isn't one. */
function photoURL(cid) {
  if (!photoCache.has(cid)) {
    const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${NODES[0]}/volumes`, { chainPath: ROOT }));
    photoCache.set(
      cid,
      (async () => {
        for (const node of NODES) {
          try {
            const v = await new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: ROOT })).get(cid);
            const photo = readPhoto(sdk, v.rootBytes());
            if (photo) return URL.createObjectURL(new Blob([photo.bytes], { type: photo.type }));
          } catch {}
        }
        void volumes;
        return undefined;
      })(),
    );
  }
  return photoCache.get(cid);
}
/** Fills every `img[data-photo]` under `root` once its photo arrives. */
function fillPhotos(root) {
  for (const img of $$("img[data-photo]", root)) {
    photoURL(img.dataset.photo).then((url) => {
      if (url) img.src = url;
      else img.replaceWith(Object.assign(document.createElement("span"), { textContent: "📷", title: "Photo unavailable" }));
    });
  }
}

const thumbHTML = (it) => `<span class="thumb">${it.photos?.[0] ? `<img alt="" data-photo="${esc(it.photos[0])}">` : EMOJI[it.category] ?? "📦"}</span>`;

function itemRow(it, { from, note } = {}) {
  const where = it.place ? `${it.place} · ` : "";
  const distance = from ? ` · ${metres(geo.distance(from, it))}` : "";
  return `<a class="row" href="${itemHref(it)}">
    ${thumbHTML(it)}
    <span class="main"><span class="name">${esc(it.title)}</span>
    <span class="sub">${typeTag(it)} ${esc(where)}${esc(it.type === "found" ? "found" : "lost")} ${esc(whenText(it.when))}${esc(distance)}</span>
    ${note ? `<span class="sub">${note}</span>` : ""}</span></a>`;
}

// ------------------------------------------------------------------ the map

let map = null;
let markers = [];
let mapMoved = () => {};
function ensureMap() {
  if (map) return map;
  const saved = store.get("view", DEFAULTS.view);
  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([saved.lat, saved.lon], saved.zoom);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  let timer;
  map.on("moveend", () => {
    const c = map.getCenter();
    store.set("view", { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    clearTimeout(timer);
    timer = setTimeout(() => mapMoved(), 250);
  });
  const locate = document.createElement("button");
  locate.className = "locate";
  locate.type = "button";
  locate.setAttribute("aria-label", "Go to my location");
  locate.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
  locate.onclick = () => here().then((p) => map.setView([p.lat, p.lon], 16), (e) => toast(e.message));
  $("#map").append(locate);
  return map;
}
const pinIcon = (cls) => L.divIcon({ className: "", html: `<div class="pin ${cls}"></div>`, iconSize: [26, 26], iconAnchor: [13, 26] });
function setMarkers(items) {
  for (const m of markers) m.remove();
  markers = items.map((it) =>
    L.marker([it.lat, it.lon], { icon: pinIcon(it.type), title: it.title, keyboard: false })
      .on("click", () => (location.hash = itemHref(it)))
      .addTo(map),
  );
}
function boxOfMap() {
  const b = map.getBounds();
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
}

/** Where this device is, rounded to about 10 m. */
function here() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser can't tell where you are."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 1e4) / 1e4, lon: Math.round(p.coords.longitude * 1e4) / 1e4 }),
      () => reject(new Error("Couldn't get your location. Move the map instead.")),
      { timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

// ------------------------------------------------------------------ routes

const panel = () => $("#panel");
let generation = 0; // a view's async work stops writing once another view starts
function render(html, { withMap = false, tab } = {}) {
  document.body.classList.toggle("with-map", withMap);
  for (const a of $$("#tabs a")) a.toggleAttribute("aria-current", a.dataset.tab === tab), a.dataset.tab === tab && a.setAttribute("aria-current", "page");
  panel().innerHTML = html;
  panel().scrollTop = 0;
  if (withMap) {
    ensureMap();
    setTimeout(() => map.invalidateSize(), 0);
  }
  mapMoved = () => {};
}

async function route() {
  const gen = ++generation;
  const { name, args } = parseRoute(location.hash);
  const views = { home, report, edit: report, item, inbox: inboxView, tags, t: tagLanding, mine, about };
  const view = views[name] ?? home;
  try {
    await view(args, () => gen === generation, name);
  } catch (error) {
    if (gen !== generation) return;
    console.warn(error);
    render(`<div class="wrap"><p class="notice bad">${esc(problem(error))}</p><button class="btn quiet" onclick="location.reload()">Try again</button></div>`);
  }
  updateUnread();
}

// --- Nearby

let filter = { type: "all", category: "" };
async function home(_args, current) {
  render(
    `<div class="top"><span class="brand">${LOGO}<span>Turnup</span></span><a class="linkish" href="#/about">How it works</a></div>
    <div class="wrap" style="padding-bottom:8px">
      <div class="big-choices">
        <a class="big-choice lost" href="#/report/lost"><b>I lost something</b><span>Tell finders what to look for</span></a>
        <a class="big-choice found" href="#/report/found"><b>I found something</b><span>Help it get home</span></a>
      </div>
    </div>
    <div class="list-head">
      <div class="seg" role="group" aria-label="Show">
        ${["all", "lost", "found"].map((t) => `<button type="button" data-type="${t}" aria-pressed="${filter.type === t}">${{ all: "All", lost: "Lost", found: "Found" }[t]}</button>`).join("")}
      </div>
      <span class="small muted" id="count"></span>
    </div>
    <div class="chips" role="group" aria-label="Kind of thing">
      <button class="chip" type="button" data-category="" aria-pressed="${!filter.category}">Everything</button>
      ${records.CATEGORIES.map(([id, label]) => `<button class="chip" type="button" data-category="${id}" aria-pressed="${filter.category === id}">${EMOJI[id]} ${esc(label)}</button>`).join("")}
    </div>
    <div id="list"><div class="skeleton"></div><div class="skeleton"></div></div>
    <footer class="about">Everything here is on a public chain, read straight from it. Messages between finders and owners are private.</footer>`,
    { withMap: true, tab: "home" },
  );
  let items = [];
  const show = () => {
    const shown = items
      .filter((it) => filter.type === "all" || it.type === filter.type)
      .filter((it) => !filter.category || it.category === filter.category)
      .sort((x, y) => y.when - x.when || y.time - x.time);
    setMarkers(shown);
    const c = map.getCenter();
    $("#count").textContent = items.length ? `${shown.length} in view` : "";
    $("#list").innerHTML = shown.length
      ? shown.map((it) => itemRow(it, { from: { lat: c.lat, lon: c.lng } })).join("")
      : `<div class="empty">${items.length ? "Nothing like that in view." : "Nothing reported in this part of the map yet."}<span class="small">Move the map, or be the first to post here.</span></div>`;
    fillPhotos($("#list"));
  };
  for (const b of $$("[data-type]")) b.onclick = () => ((filter.type = b.dataset.type), $$("[data-type]").forEach((x) => x.setAttribute("aria-pressed", x === b)), show());
  for (const b of $$("[data-category]")) b.onclick = () => ((filter.category = b.dataset.category), $$("[data-category]").forEach((x) => x.setAttribute("aria-pressed", x === b)), show());
  const load = async () => {
    const cells = geo.cover(boxOfMap(), { max: 16, min: 3 });
    if (!cells) {
      setMarkers([]);
      $("#count").textContent = "";
      $("#list").innerHTML = `<div class="empty">Zoom in to see what's been lost and found here.</div>`;
      return;
    }
    const found = await turnup.itemsIn(cells);
    if (!current()) return;
    items = found;
    show();
  };
  mapMoved = () => load().catch((e) => current() && ($("#list").innerHTML = `<p class="notice bad" style="margin:16px">${esc(problem(e))}</p>`));
  await load();
}

// --- Report and edit

async function report(args, current, name) {
  const editing = name === "edit";
  let before;
  let label = "";
  if (editing) {
    label = chainLabel(args[0]);
    if (!me) await loadMe();
    before = me && (await turnup.itemOf(label, me, args[1], { fresh: true }));
    if (!before) throw new Error("That post isn't yours, or it's gone.");
  }
  const type = before?.type ?? (args[0] === "found" ? "found" : "lost");
  const draft = store.get(`draft:${editing ? args[1] : type}`, null) ?? before ?? {};
  const v = (field) => esc(draft[field] ?? "");
  const isFound = () => $("#f-type [aria-pressed=true]").dataset.value === "found";
  render(
    `<div class="top"><a class="back" href="${editing ? itemHref({ ...before, chain: label }) : "#/"}">${BACK} ${editing ? "Back" : "Cancel"}</a></div>
    <form class="wrap" id="report" novalidate>
      <h1 class="title" id="r-title"></h1>
      ${editing ? "" : `<div class="seg big" role="group" aria-label="Lost or found" id="f-type">
        <button type="button" data-value="lost" aria-pressed="${type === "lost"}">I lost it</button>
        <button type="button" data-value="found" aria-pressed="${type === "found"}">I found it</button></div>`}
      <fieldset><legend>What is it?</legend>
        <div class="chips wrapping" role="radiogroup" aria-label="Kind of thing" id="f-category">
          ${records.CATEGORIES.map(([id, l]) => `<button type="button" class="chip" role="radio" data-value="${id}" aria-checked="${draft.category === id}">${EMOJI[id]} ${esc(l)}</button>`).join("")}
        </div>
      </fieldset>
      <label class="field">In a few words<input id="f-title" maxlength="${records.LIMITS.title}" value="${v("title")}" placeholder="e.g. Black iPhone in a green case" autocomplete="off"></label>
      <fieldset><legend id="where-legend">Where?</legend>
        <div class="pickmap" id="pickmap"><svg class="crosshair" width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 39s13-13.5 13-23A13 13 0 002 16c0 9.5 13 23 13 23z" fill="var(--accent)" stroke="#fff" stroke-width="2"/><circle cx="15" cy="16" r="5" fill="#fff"/></svg><div class="map-note"><span>Move the map to put the pin there</span></div></div>
        <div class="actions"><button type="button" class="btn quiet small" id="f-here">Use where I am</button></div>
        <label class="field"><span>Place <span class="hint">(optional)</span></span><input id="f-place" maxlength="${records.LIMITS.place}" value="${v("place")}" placeholder="e.g. Bus 14, back row · Corner café"></label>
        <p class="small muted">Only a rough spot is shown, to about 100 m.</p>
      </fieldset>
      <label class="field"><span id="when-label">When?</span><input id="f-when" type="date" value="${dateValue(draft.when ?? Date.now())}" max="${dateValue(Date.now())}"></label>
      <label class="field"><span>Describe it <span class="hint" id="details-hint"></span></span><textarea id="f-details" maxlength="${records.LIMITS.details}">${v("details")}</textarea></label>
      <div id="found-only">
        <label class="field"><span>Ask the owner <span class="hint">(recommended)</span></span><input id="f-question" maxlength="${records.LIMITS.question}" value="${v("question")}" placeholder="e.g. What's the lock screen picture?">
          <span class="hint">Something only the owner could answer. You'll see their answer privately.</span></label>
        <label class="field"><span>Where is it now?</span><input id="f-held" maxlength="${records.LIMITS.held}" value="${v("held") || (editing ? "" : "With me")}" placeholder="With me · Left at the front desk"></label>
      </div>
      <label class="field" id="lost-only"><span>Reward <span class="hint">(optional)</span></span><input id="f-reward" maxlength="${records.LIMITS.reward}" value="${v("reward")}" placeholder="e.g. Coffee and many thanks"></label>
      <fieldset><legend>Photos <span class="hint" style="font-weight:400">(optional, up to ${records.LIMITS.photos})</span></legend>
        <p class="small muted" id="photo-hint"></p>
        <div class="photos" id="f-photos"></div>
        <label class="btn quiet small" style="width:fit-content"><input type="file" accept="image/*" id="f-file" hidden>Add a photo</label>
      </fieldset>
      <p class="notice small">Everything above is public. Keep out names, numbers on cards, and anything only the owner should know.</p>
      <p class="status" id="r-status" role="status"></p>
      <p class="small muted" id="r-step"></p>
      <button class="btn accent wide" id="r-send" type="submit"></button>
    </form>`,
    { tab: editing ? "mine" : "home" },
  );
  let category = draft.category;
  let photos = [...(draft.photos ?? [])]; // CIDs kept by the sponsor
  let uploading = 0;
  const setType = () => {
    const found = editing ? type === "found" : isFound();
    $("#r-title").textContent = editing ? "Edit your post" : found ? "Report something you found" : "Report something you lost";
    $("#found-only").hidden = !found;
    $("#lost-only").hidden = found;
    $("#where-legend").textContent = found ? "Where did you find it?" : "Where did you lose it? Your best guess";
    $("#when-label").textContent = found ? "When did you find it?" : "When did you lose it?";
    $("#details-hint").textContent = found ? "(what anyone would see, leave out what only the owner knows)" : "(colour, brand, case, stickers…)";
    $("#photo-hint").textContent = found ? "A photo helps owners recognise it. Cover names, card numbers and faces first." : "A photo of the same thing, or one like it, helps finders.";
    updateButton();
  };
  const updateButton = () => {
    $("#r-send").textContent = uploading ? "Saving photos…" : stepLabel(editing ? "Save changes" : "Post");
    $("#r-send").disabled = uploading > 0;
    $("#r-step").textContent = stepNote();
  };
  const remember = () => {
    if (!current()) return;
    store.set(`draft:${editing ? args[1] : isFound() ? "found" : "lost"}`, collect());
  };
  const collect = () => ({
    type: editing ? type : isFound() ? "found" : "lost",
    category,
    title: $("#f-title").value,
    lat: pickmap.getCenter().lat,
    lon: pickmap.getCenter().lng,
    place: $("#f-place").value,
    when: fromDateValue($("#f-when").value),
    details: $("#f-details").value,
    question: $("#f-question").value,
    held: $("#f-held").value,
    reward: $("#f-reward").value,
    photos,
    status: before?.status,
    resolved: before?.resolved,
  });
  for (const b of $$("#f-type button")) b.onclick = () => {
    $$("#f-type button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    setType();
  };
  for (const b of $$("#f-category [role=radio]")) b.onclick = () => {
    category = b.dataset.value;
    $$("#f-category [role=radio]").forEach((x) => x.setAttribute("aria-checked", x === b));
    remember();
  };
  const view = store.get("view", DEFAULTS.view);
  const start = draft.lat !== undefined ? { lat: draft.lat, lon: draft.lon } : view;
  const pickmap = L.map("pickmap", { zoomControl: false, attributionControl: false }).setView([start.lat, start.lon], draft.lat !== undefined ? 17 : Math.max(15, view.zoom));
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(pickmap);
  pickmap.on("moveend", remember);
  $("#f-here").onclick = () => here().then((p) => pickmap.setView([p.lat, p.lon], 17), (e) => ($("#r-status").textContent = e.message));
  $("#report").oninput = remember;

  const showPhotos = () => {
    $("#f-photos").innerHTML = photos.map((cid, n) => `<div style="position:relative;flex:none;width:120px"><img alt="Photo ${n + 1}" data-photo="${esc(cid)}" style="width:120px"><button type="button" class="btn small quiet" data-remove="${n}" style="position:absolute;top:6px;right:6px;background:var(--bg);min-height:28px;padding:0 8px" aria-label="Remove photo ${n + 1}">✕</button></div>`).join("") +
      (uploading ? `<div class="thumb" style="width:120px;height:120px"><span class="spin"></span></div>` : "");
    fillPhotos($("#f-photos"));
    for (const b of $$("[data-remove]", $("#f-photos"))) b.onclick = () => (photos.splice(Number(b.dataset.remove), 1), showPhotos(), remember());
    $("#f-file").parentElement.hidden = photos.length + uploading >= records.LIMITS.photos;
    updateButton();
  };
  $("#f-file").onchange = async () => {
    const file = $("#f-file").files[0];
    $("#f-file").value = "";
    if (!file) return;
    uploading++;
    showPhotos();
    $("#r-status").className = "status";
    try {
      const photo = await preparePhoto(file, { pixels: 768 });
      const volume = photoVolume(sdk, photo.type, photo.bytes);
      const chain = await storageChain(SPONSOR, [ROOT.join("/")]);
      if (!chain) throw new Error("The photo keeper isn't taking photos right now.");
      await storeFile(SPONSOR, volume, { chain, hash: hasher, progress: ({ stage, done }) => current() && ($("#r-status").textContent = stage === "grind" ? `Saving the photo with this device's work… ${Math.round((done ?? 0) * 100)}%` : "Saving the photo…") });
      photoCache.set(volume.cid, Promise.resolve(URL.createObjectURL(new Blob([photo.bytes], { type: photo.type }))));
      photos.push(volume.cid);
      if (current()) $("#r-status").textContent = "";
    } catch (error) {
      if (current()) {
        $("#r-status").className = "status bad";
        $("#r-status").textContent = problem(error);
      }
    } finally {
      uploading--;
      if (current()) showPhotos(), remember();
    }
  };
  setType();
  showPhotos();

  $("#report").onsubmit = async (event) => {
    event.preventDefault();
    const status = $("#r-status");
    status.className = "status";
    const value = collect();
    try {
      records.itemValue(value);
    } catch (error) {
      status.className = "status bad";
      status.textContent = error.message;
      return;
    }
    $("#r-send").disabled = true;
    try {
      if (!(await step())) {
        status.textContent = "Signed in. Press the button again to post.";
        return;
      }
      if (editing && before.author !== me) throw new Error("This post belongs to another account.");
      const id = editing ? before.id : records.newId();
      // A new post goes on the area chain under its pin; an edit stays where it is.
      const at = turnup.chainAt(value);
      status.textContent = "Approve it in Selfhold…";
      const sent = await send(
        editing ? turnup.chain(label) : at.then((c) => c.path),
        async (path) => {
          if (editing && (await at).label !== label) throw new Error("A post can't move to another area. Delete it and post again.");
          const slots = before ? await records.photoSlots(await turnup.chainState(path, { fresh: true }), me, id) : 0;
          return records.item(me, id, value, { before, photos, slots, box: await myBoxWrite(path) });
        },
        value.type === "found" ? "your found post" : "your lost post",
        (p) => (status.textContent = p),
      );
      store.set(`draft:${editing ? args[1] : value.type}`, undefined);
      if (sent || editing) location.hash = itemHref({ chain: editing ? label : (await at).label, author: me, id });
    } catch (error) {
      status.className = "status bad";
      status.textContent = problem(error);
    } finally {
      if (current()) updateButton();
    }
  };
}

// --- An item

async function item(args, current) {
  const label = chainLabel(args[0]);
  const [author, id] = [args[1], args[2]];
  render(`<div class="top"><a class="back" href="#/">${BACK} Nearby</a></div><div class="skeleton"></div>`, { tab: "home" });
  if (!me) await loadMe();
  const it = await turnup.itemOf(label, author, id, { fresh: true });
  if (!current()) return;
  if (!it) {
    render(`<div class="top"><a class="back" href="#/">${BACK} Nearby</a></div><div class="empty">This post isn't here. It may have been deleted, or it's still on its way: try again in a minute.</div>`, { tab: "home" });
    return;
  }
  const mine = me === it.author;
  const isFound = it.type === "found";
  const resolved = it.status === "resolved";
  render(
    `<div class="top"><a class="back" href="${mine ? "#/mine" : "#/"}">${BACK} ${mine ? "My posts" : "Nearby"}</a>
      <button class="btn quiet small" type="button" id="share">Share</button></div>
    <div class="wrap">
      ${typeTag(it)}
      <h1 class="title">${esc(it.title)}</h1>
      ${resolved ? `<p class="notice good">${isFound ? "This has been returned to its owner." : "The owner has it back."}${it.resolved ? ` ${esc(day(it.resolved))}.` : ""}</p>` : ""}
      ${it.photos.length ? `<div class="photos ${it.photos.length === 1 ? "one" : ""}">${it.photos.map((cid, n) => `<img alt="Photo ${n + 1} of ${esc(it.title)}" data-photo="${esc(cid)}">`).join("")}</div>` : ""}
      <dl class="facts">
        <dt>What</dt><dd>${EMOJI[it.category]} ${esc(records.categoryName(it.category))}</dd>
        <dt>${isFound ? "Found" : "Lost"}</dt><dd>${esc(whenText(it.when))}${it.place ? ` · ${esc(it.place)}` : ""}</dd>
        ${isFound && it.held ? `<dt>Now</dt><dd>${esc(it.held)}</dd>` : ""}
        ${!isFound && it.reward ? `<dt>Reward</dt><dd>${esc(it.reward)}</dd>` : ""}
        <dt>Posted</dt><dd>${esc(ago(it.time))} by ${whoHTML(it.author)}</dd>
      </dl>
      ${it.details ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(it.details)}</p>` : ""}
      <div class="minimap" id="minimap" role="img" aria-label="Roughly where"></div>
      <div id="act"></div>
      <div id="matches"></div>
    </div>`,
    { tab: mine ? "mine" : "home" },
  );
  fillPhotos(panel());
  const mini = L.map("minimap", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, keyboard: false }).setView([it.lat, it.lon], 16);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mini);
  L.circle([it.lat, it.lon], { radius: 100, color: isFound ? "#13795B" : "#C2410C", weight: 2, fillOpacity: 0.12 }).addTo(mini);
  $("#share").onclick = async () => {
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: it.title, url });
      else {
        await navigator.clipboard.writeText(url);
        toast("Link copied");
      }
    } catch {}
  };

  if (mine) {
    $("#act").innerHTML = `<div class="actions">
        ${resolved ? `<button class="btn quiet" id="reopen">Reopen</button>` : `<button class="btn accent" id="resolve">${isFound ? "It's back with its owner" : "I got it back"}</button>`}
        <a class="btn quiet" href="#/edit/${it.chain || "-"}/${encodeURIComponent(it.id)}">Edit</a>
        <button class="btn danger" id="delete">Delete</button></div>
      <p class="status" id="i-status" role="status"></p>
      <a class="linkish" href="#/inbox">Messages about your posts →</a>`;
    const act = async (button, change, what, done) => {
      const status = $("#i-status");
      status.className = "status";
      button.disabled = true;
      try {
        status.textContent = "Approve it in Selfhold…";
        const path = turnup.chain(label);
        await send(path, async () => change(records.photoSlots(await turnup.chainState(path, { fresh: true }), me, it.id)), what, (p) => (status.textContent = p));
        done();
      } catch (error) {
        status.className = "status bad";
        status.textContent = problem(error);
        button.disabled = false;
      }
    };
    if ($("#resolve")) $("#resolve").onclick = () => act($("#resolve"), async (slots) => records.item(me, it.id, { ...it, status: "resolved", resolved: Date.now() }, { before: it, photos: it.photos, slots: await slots }), "marking it resolved", () => route());
    if ($("#reopen")) $("#reopen").onclick = () => act($("#reopen"), async (slots) => records.item(me, it.id, { ...it, status: "open" }, { before: it, photos: it.photos, slots: await slots }), "reopening it", () => route());
    // One press: approving in Selfhold is the confirmation.
    $("#delete").onclick = () => act($("#delete"), async (slots) => records.item(me, it.id, undefined, { before: it, slots: await slots }), "deleting the post", () => (location.hash = "#/mine"));
    // Possible matches, worked out here from the other kind of post nearby.
    if (!resolved) {
      $("#matches").innerHTML = `<h2 style="font-size:18px;margin-top:8px">Possible matches</h2><div class="skeleton"></div>`;
      const near = await turnup.itemsIn(geo.around(it, 3000) ?? []);
      if (!current()) return;
      const found = matches(it, near);
      $("#matches").innerHTML = `<h2 style="font-size:18px;margin-top:8px">Possible matches</h2>
        ${found.length ? `<p class="small muted">${isFound ? "Lost reports" : "Things found"} nearby that could be the same. Have a look, then message them.</p>
          <div style="margin:0 -16px">${found.map((m) => itemRow(m.item, { note: `<span class="reasons">${m.reasons.map((r) => `<span>${esc(r)}</span>`).join("")}</span>` })).join("")}</div>`
        : `<p class="small muted">Nothing yet. We'll show ${isFound ? "lost reports" : "finds"} here as people post them nearby.</p>`}`;
      fillPhotos($("#matches"));
    }
    return;
  }

  if (resolved) return;
  // Someone else's: claim a find, or say you found a loss.
  const claim = isFound;
  $("#act").innerHTML = `<div class="card soft" id="reach">
      <h2 style="font-size:18px">${claim ? "Is this yours?" : "Have you found this?"}</h2>
      <p class="small muted">${claim ? "Tell the finder how you know it's yours. Only they can read it." : "Tell the owner where it is. Only they can read it."}</p>
      ${claim && it.question ? `<label class="field"><span>The finder asks: ${esc(it.question)}</span><input id="m-answer" maxlength="300" autocomplete="off"></label>` : ""}
      <label class="field"><span>${claim ? "Your message" : "Your message"}</span><textarea id="m-text" maxlength="${records.LIMITS.message}" placeholder="${claim ? "Describe it, and when you can pick it up" : "Where you found it, and how they can get it"}"></textarea></label>
      ${claim ? "" : `<label class="check"><input type="checkbox" id="m-share"> Share where I am now</label>`}
      <p class="status" id="m-status" role="status"></p>
      <p class="small muted" id="m-step"></p>
      <button class="btn accent" id="m-send" type="button"></button>
    </div>`;
  const button = $("#m-send");
  const label2 = () => {
    button.textContent = stepLabel(claim ? "Send to the finder" : "Send to the owner");
    $("#m-step").textContent = stepNote();
  };
  label2();
  button.onclick = async () => {
    const status = $("#m-status");
    status.className = "status";
    button.disabled = true;
    try {
      const answer = $("#m-answer")?.value.trim();
      const text = [answer ? `Answer: ${answer}` : "", $("#m-text").value.trim()].filter(Boolean).join("\n\n");
      if (!text) throw new Error(claim ? "Say why it's yours." : "Say where it is.");
      if (!(await step())) {
        status.textContent = "Ready. Press send.";
        return;
      }
      if (me === it.author) return route();
      const about = { type: "item", chain: it.chain, author: it.author, id: it.id, title: it.title };
      status.textContent = "Approve it in Selfhold…";
      const shareIt = $("#m-share")?.checked;
      const sent = await send(ROOT, () => messageWrites(it.author, about, { text, ...(claim && { claim: true }) }, shareIt, it.chain), "your message", (p) => (status.textContent = p));
      if (sent) location.hash = `#/inbox/${encodeURIComponent(`${records.aboutKey(about)}|${it.author}`)}`;
    } catch (error) {
      status.className = "status bad";
      status.textContent = problem(error);
    } finally {
      if (current()) (button.disabled = false), label2();
    }
  };
}

/** The writes for a sealed message to `to` about `about`, with this device's location when `shareIt`. */
async function messageWrites(to, about, body, shareIt, label = "") {
  const share = shareIt ? await here() : undefined;
  const theirs = await boxFor(to, label);
  if (!theirs) throw new Error("They can't receive messages yet. Try again later.");
  return records.message(me, records.newId(), to, { about, ...body, ...(share && { share }) }, { [me]: inbox.publicKey, [to]: theirs }, { box: await myBoxWrite(ROOT) });
}

// --- Messages

let unreadCount = 0;
const readMarks = () => store.get(`read:${me}`, {});
async function updateUnread() {
  if (!me || !inbox) {
    $("#unread").hidden = true;
    return;
  }
  try {
    const all = await turnup.messages(me, inbox);
    const marks = readMarks();
    unreadCount = records.threads(all, me).filter((t) => t.messages.some((m) => m.from !== me && m.time > (marks[t.key] ?? 0))).length;
    $("#unread").hidden = unreadCount === 0;
    $("#unread").textContent = String(unreadCount);
  } catch {}
}

async function inboxView(args, current) {
  if (!me) await loadMe();
  if (!me || !inbox) {
    render(
      `<div class="top"><h1 class="title">Messages</h1></div>
      <div class="wrap"><p class="lead">Messages between finders and owners are private: sealed so only the two of you can read them.</p>
      <p class="small muted">${esc(stepNote())}</p>
      <p class="status" id="u-status" role="status"></p>
      <button class="btn accent" id="u-go">${esc(stepLabel("Open messages"))}</button></div>`,
      { tab: "inbox" },
    );
    $("#u-go").onclick = async () => {
      try {
        await unlock();
        route();
      } catch (error) {
        $("#u-status").className = "status bad";
        $("#u-status").textContent = problem(error);
      }
    };
    return;
  }
  render(`<div class="top"><h1 class="title">Messages</h1></div><div class="skeleton"></div>`, { tab: "inbox" });
  const all = await turnup.messages(me, inbox, { fresh: true });
  if (!current()) return;
  const threads = records.threads(all, me);
  if (args[0]) return thread(threads, args[0], current);
  const marks = readMarks();
  render(
    `<div class="top"><h1 class="title">Messages</h1></div>
    ${threads.length
      ? threads.map((t) => {
          const last = t.messages[t.messages.length - 1];
          const unread = t.messages.some((m) => m.from !== me && m.time > (marks[t.key] ?? 0));
          const title = t.about.type === "tag" ? `Tag: ${t.about.name}` : t.about.title;
          return `<a class="row" href="#/inbox/${encodeURIComponent(t.key)}">
            <span class="who"><span class="icon" style="width:44px;height:44px">${accountIcon(t.with, 44)}</span></span>
            <span class="main"><span class="name">${unread ? "● " : ""}${esc(title || "A post")}</span>
            <span class="sub">${last.from === me ? "You: " : ""}${esc(last.body.text || (last.body.share ? "Shared a location" : ""))}</span></span>
            <span class="side">${esc(ago(last.time))}</span></a>`;
        }).join("")
      : `<div class="empty">No messages yet.<span class="small">When someone answers one of your posts or scans one of your tags, it shows here.</span></div>`}`,
    { tab: "inbox" },
  );
}

async function thread(threads, key, current) {
  const t = threads.find((x) => x.key === key);
  const [aboutPart, other] = [key.slice(0, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
  // A new conversation that hasn't landed yet: there's nothing to show but the composer.
  const about = t?.about ?? parseAbout(aboutPart);
  if (!about) throw new Error("That conversation isn't here.");
  const marks = readMarks();
  marks[key] = Date.now();
  store.set(`read:${me}`, marks);
  const it = about.type === "item" ? await turnup.itemOf(about.chain, about.author, about.id).catch(() => undefined) : undefined;
  const tag = about.type === "tag" ? await turnup.tagOf(about.author, about.id).catch(() => undefined) : undefined;
  if (!current()) return;
  const myItem = it && it.author === me;
  const subject = about.type === "tag" ? `Your tag “${about.name}”` : about.title;
  render(
    `<div class="top"><a class="back" href="#/inbox">${BACK} Messages</a></div>
    <div class="wrap" style="padding-bottom:8px">
      <div class="who">${whoHTML(other)}</div>
      ${it ? `<div style="margin:0 -16px">${itemRow(it)}</div>` : `<p class="small muted">About: ${esc(subject || "a post")}${tag ? "" : ""}</p>`}
      ${myItem && it.status === "open" ? `<div class="card soft"><p class="small">${it.type === "found" ? "Once you've handed it over, close the post so others stop asking." : "Got it back? Close the post so finders know."}</p>
        <button class="btn small" id="t-resolve">${it.type === "found" ? "It's back with its owner" : "I got it back"}</button><p class="status small" id="t-rstatus"></p></div>` : ""}
    </div>
    <div class="thread" id="thread">
      ${(t?.messages ?? []).map((m) => `<div class="bubble ${m.from === me ? "me" : "them"}">
        ${m.body.claim ? `<span class="kind">Claim</span>` : ""}
        ${m.body.text ? `<span>${esc(m.body.text)}</span>` : ""}
        ${m.body.share ? `<a href="${osmLink(m.body.share)}" target="_blank" rel="noopener">📍 Shared a location</a>` : ""}
        <span class="meta">${esc(ago(m.time))}</span></div>`).join("") || `<p class="small muted">No messages yet.</p>`}
    </div>
    <form class="composer" id="composer">
      <textarea id="c-text" maxlength="${records.LIMITS.message}" placeholder="Write a message" aria-label="Message"></textarea>
      <div class="row2"><label class="check"><input type="checkbox" id="c-share"> Share where I am</label><button class="btn accent small" id="c-send">Send</button></div>
      <p class="status" id="c-status" role="status"></p>
      <p class="small muted">Only the two of you can read this. Meet somewhere public to hand things over.</p>
    </form>`,
    { tab: "inbox" },
  );
  const status = $("#c-status");
  $("#composer").onsubmit = async (event) => {
    event.preventDefault();
    status.className = "status";
    const text = $("#c-text").value.trim();
    const shareIt = $("#c-share").checked;
    if (!text && !shareIt) return;
    $("#c-send").disabled = true;
    try {
      status.textContent = "Approve it in Selfhold…";
      await send(ROOT, () => messageWrites(other, about, { text }, shareIt, about.type === "item" ? about.chain : ""), "your message", (p) => (status.textContent = p));
      route();
    } catch (error) {
      status.className = "status bad";
      status.textContent = problem(error);
      $("#c-send").disabled = false;
    }
  };
  if ($("#t-resolve")) $("#t-resolve").onclick = async () => {
    const s = $("#t-rstatus");
    try {
      s.textContent = "Approve it in Selfhold…";
      const path = turnup.chain(it.chain);
      await send(path, async () => records.item(me, it.id, { ...it, status: "resolved", resolved: Date.now() }, { before: it, photos: it.photos, slots: await records.photoSlots(await turnup.chainState(path, { fresh: true }), me, it.id) }), "closing the post", (p) => (s.textContent = p));
      route();
    } catch (error) {
      s.className = "status small bad";
      s.textContent = problem(error);
    }
  };
}
function parseAbout(text) {
  const m = /^item:([^:]*):([^/]+)\/(.+)$/.exec(text) ?? /^tag:()([^/]+)\/(.+)$/.exec(text);
  if (!m) return undefined;
  return text.startsWith("item:") ? { type: "item", chain: m[1], author: m[2], id: m[3], title: "" } : { type: "tag", author: m[2], id: m[3], name: "" };
}

// --- Tags

const appBase = () => `${location.origin}${location.pathname}${location.search}`;
const tagURL = (t) => `${appBase()}#/t/${encodeURIComponent(t.author)}/${encodeURIComponent(t.id)}`;
const qrSVG = (text) => {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
};
const qrCard = (t) => `<div class="qr">${qrSVG(tagURL(t))}<span class="qr-label">If found, scan me</span><span class="qr-sub">${esc(t.name)} · Turnup</span></div>`;

async function tags(args, current) {
  if (!me) await loadMe();
  if (args[0] === "new") return newTag(current);
  render(`<div class="top"><h1 class="title">Tags</h1></div><div class="skeleton"></div>`, { tab: "tags" });
  const mineNow = me ? await turnup.mine(me, { fresh: true }) : { tags: [] };
  if (!current()) return;
  render(
    `<div class="top"><h1 class="title">Tags</h1>${mineNow.tags.length ? `<button class="btn quiet small" id="print">Print</button>` : ""}</div>
    <div class="wrap">
      <p class="lead">Stick a tag on your keys, bag or laptop. Whoever finds it scans it with their phone camera and can message you, without seeing who you are.</p>
      ${mineNow.tags.length ? `<div class="tags-grid">${mineNow.tags.map((t) => `<div style="display:flex;flex-direction:column;gap:6px">${qrCard(t)}
          <div class="small"><b>${esc(t.name)}</b>${t.missing ? ` · <span style="color:var(--lost);font-weight:700">Missing</span>` : ""}</div>
          <div class="actions"><button class="linkish small" data-missing="${esc(t.id)}">${t.missing ? "It's back" : "Mark missing"}</button>
          <a class="linkish small" href="${esc(tagURL(t))}">Open</a></div></div>`).join("")}</div>`
        : `<div class="empty">No tags yet.</div>`}
      <a class="btn accent" href="#/tags/new">Make a tag</a>
      <p class="status" id="tg-status" role="status"></p>
    </div>`,
    { tab: "tags" },
  );
  if ($("#print")) $("#print").onclick = () => {
    $("#print-sheet").innerHTML = mineNow.tags.flatMap((t) => Array.from({ length: 4 }, () => qrCard(t))).join("");
    window.print();
  };
  for (const b of $$("[data-missing]")) b.onclick = async () => {
    const t = mineNow.tags.find((x) => x.id === b.dataset.missing);
    const status = $("#tg-status");
    try {
      status.textContent = "Approve it in Selfhold…";
      await send(ROOT, () => records.tag(me, t.id, { ...t, missing: !t.missing }), t.missing ? "marking it found" : "marking it missing", (p) => (status.textContent = p));
      route();
    } catch (error) {
      status.className = "status bad";
      status.textContent = problem(error);
    }
  };
}

function newTag(current) {
  render(
    `<div class="top"><a class="back" href="#/tags">${BACK} Tags</a></div>
    <form class="wrap" id="tagform">
      <h1 class="title">Make a tag</h1>
      <label class="field">What does it go on?<input id="t-name" maxlength="${records.LIMITS.tagName}" placeholder="e.g. Blue backpack" autocomplete="off"></label>
      <label class="field"><span>A note for whoever finds it <span class="hint">(optional)</span></span><textarea id="t-note" maxlength="${records.LIMITS.tagNote}" placeholder="e.g. Thank you! There's a reward."></textarea></label>
      <p class="small muted">The finder sees the name and the note, never your account or contact details. You can print the tag after.</p>
      <p class="status" id="t-status" role="status"></p>
      <p class="small muted" id="t-step"></p>
      <button class="btn accent wide" id="t-send" type="submit"></button>
    </form>`,
    { tab: "tags" },
  );
  const label = () => {
    $("#t-send").textContent = stepLabel("Make the tag");
    $("#t-step").textContent = stepNote();
  };
  label();
  $("#tagform").onsubmit = async (event) => {
    event.preventDefault();
    const status = $("#t-status");
    status.className = "status";
    const draft = { name: $("#t-name").value, note: $("#t-note").value };
    $("#t-send").disabled = true;
    try {
      records.tag("x", "y", draft);
      if (!(await step())) {
        status.textContent = "Ready. Press the button again to make it.";
        return;
      }
      status.textContent = "Approve it in Selfhold…";
      await send(ROOT, async () => records.tag(me, records.newId(), draft, { box: await myBoxWrite(ROOT) }), "your tag", (p) => (status.textContent = p));
      location.hash = "#/tags";
    } catch (error) {
      status.className = "status bad";
      status.textContent = problem(error);
    } finally {
      if (current()) ($("#t-send").disabled = false), label();
    }
  };
}

async function tagLanding(args, current) {
  const [owner, id] = args;
  render(`<div class="skeleton"></div>`);
  if (!me) await loadMe();
  const t = await turnup.tagOf(owner, id, { fresh: true });
  if (!current()) return;
  if (!t) {
    render(`<div class="wrap"><span class="brand">${LOGO}<span>Turnup</span></span><p class="lead">This tag isn't active any more, or it's still on its way. Try again in a minute.</p><a class="btn quiet" href="#/report/found">Report what you found instead</a></div>`);
    return;
  }
  if (owner === me) {
    render(`<div class="wrap"><span class="brand">${LOGO}<span>Turnup</span></span><h1 class="title">This is your tag: ${esc(t.name)}</h1><p class="lead">This is what a finder sees when they scan it.</p><a class="btn quiet" href="#/tags">Your tags</a></div>`);
    return;
  }
  render(
    `<div class="wrap">
      <span class="brand">${LOGO}<span>Turnup</span></span>
      <h1 class="title">You found: ${esc(t.name)}</h1>
      ${t.missing ? `<p class="notice good">The owner is looking for this. Thank you for scanning!</p>` : ""}
      ${t.note ? `<div class="card soft"><span class="small muted">The owner says</span><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(t.note)}</p></div>` : ""}
      <p class="lead">Send the owner a message. They'll see it privately; neither of you sees the other's details unless you share them.</p>
      <label class="field">Message<textarea id="s-text" maxlength="${records.LIMITS.message}" placeholder="Where you found it, and how they can get it back"></textarea></label>
      <label class="check"><input type="checkbox" id="s-share"> Share where I am now</label>
      <p class="status" id="s-status" role="status"></p>
      <p class="small muted" id="s-step"></p>
      <button class="btn accent wide" id="s-send" type="button"></button>
      <p class="small muted">Turnup is a lost and found that no company runs. <a href="#/about">How it works</a></p>
    </div>`,
  );
  const button = $("#s-send");
  const label = () => {
    button.textContent = stepLabel("Send to the owner");
    $("#s-step").textContent = stepNote();
  };
  label();
  button.onclick = async () => {
    const status = $("#s-status");
    status.className = "status";
    const text = $("#s-text").value.trim();
    const shareIt = $("#s-share").checked;
    if (!text && !shareIt) {
      status.className = "status bad";
      status.textContent = "Write a few words, or share where you are.";
      return;
    }
    button.disabled = true;
    try {
      if (!(await step())) {
        status.textContent = "Ready. Press send.";
        return;
      }
      if (me === owner) return route();
      const about = { type: "tag", author: owner, id, name: t.name };
      status.textContent = "Approve it in Selfhold…";
      const sent = await send(ROOT, () => messageWrites(owner, about, { text }, shareIt), "your message", (p) => (status.textContent = p));
      if (sent) location.hash = `#/inbox/${encodeURIComponent(`${records.aboutKey(about)}|${owner}`)}`;
    } catch (error) {
      status.className = "status bad";
      status.textContent = problem(error);
    } finally {
      if (current()) (button.disabled = false), label();
    }
  };
}

// --- My posts

async function mine(_args, current) {
  if (!me) await loadMe();
  if (!me) {
    render(
      `<div class="top"><h1 class="title">My posts</h1></div>
      <div class="wrap"><p class="lead">Things you've reported lost or found show here.</p>
      <div class="big-choices"><a class="big-choice lost" href="#/report/lost"><b>I lost something</b></a><a class="big-choice found" href="#/report/found"><b>I found something</b></a></div>
      <p class="small muted">Already posted? Sign in with the passkey you used.</p>
      <p class="status" id="m-status"></p>
      <button class="btn quiet" id="m-in">Sign in with a passkey</button></div>`,
      { tab: "mine" },
    );
    $("#m-in").onclick = async () => {
      try {
        await signIn();
        route();
      } catch (error) {
        $("#m-status").className = "status bad";
        $("#m-status").textContent = problem(error);
      }
    };
    return;
  }
  render(`<div class="top"><h1 class="title">My posts</h1></div><div class="skeleton"></div>`, { tab: "mine" });
  const { items } = await turnup.mine(me, { fresh: true });
  if (!current()) return;
  const open = items.filter((it) => it.status === "open");
  const done = items.filter((it) => it.status !== "open");
  render(
    `<div class="top"><h1 class="title">My posts</h1><a class="btn quiet small" href="#/report/lost">New post</a></div>
    ${items.length ? "" : `<div class="empty">Nothing yet.<span class="small">Report something you lost or found and it shows here.</span></div>`}
    ${open.length ? `<div class="list-head"><b>Open</b></div>${open.map((it) => itemRow(it)).join("")}` : ""}
    ${done.length ? `<div class="list-head"><b>Closed</b></div>${done.map((it) => itemRow(it)).join("")}` : ""}
    <div class="wrap" style="margin-top:12px">
      <div class="card"><span class="small muted">Signed in as</span>${whoHTML(me, { you: null })}
        <p class="small muted">Your account lives in Selfhold, behind your passkey. ${inbox ? "Your messages are open on this device." : "Messages aren't opened on this device yet."}</p>
        <div class="actions"><button class="btn quiet small" id="m-out">Sign out</button></div></div>
    </div>`,
    { tab: "mine" },
  );
  fillPhotos(panel());
  $("#m-out").onclick = () => {
    signOut();
    route();
  };
}

// --- About

function about() {
  render(
    `<div class="top"><a class="back" href="#/">${BACK} Nearby</a></div>
    <div class="wrap">
      <span class="brand">${LOGO}<span>Turnup</span></span>
      <h1 class="title">A lost and found that no company runs</h1>
      <ol class="steps">
        <li><b>Post what you lost or found.</b> A rough spot on the map, when, and what it looks like. A photo if you have one.</li>
        <li><b>See what turned up nearby.</b> Your posts show possible matches: the same kind of thing, close by, found after you lost it.</li>
        <li><b>Talk privately.</b> Claims and replies are sealed so only the two people talking can read them. A finder asks a question only the owner can answer.</li>
        <li><b>Tag your things.</b> A printed QR tag lets whoever finds your keys message you, without seeing who you are.</li>
      </ol>
      <h2 style="font-size:18px">How is it free, with no company?</h2>
      <p>Posts live on <a href="https://lattice.build" target="_blank" rel="noopener">Lattice</a>, a public chain that anyone can read and host. Each city-sized area can have its own chain, run by people nearby. This page reads it directly and checks everything it reads.</p>
      <p>Your account is a passkey in <a href="https://wallet.selfhold.app" target="_blank" rel="noopener">Selfhold</a>. Each change you make is paid for with a few seconds of your device's work, not money.</p>
      <h2 style="font-size:18px">Staying safe</h2>
      <ul class="steps"><li>Never pay to "file a report" or to get something back.</li><li>Ask a question only the owner can answer before handing anything over.</li><li>Meet somewhere public, or leave it at a front desk.</li></ul>
      <p class="small muted">This is a trial on Lattice's test network: posts may be reset.</p>
    </div>`,
  );
}

// ------------------------------------------------------------------ icons

const BACK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2.2" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const LOGO = '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/><path d="M9 18.5a7 7 0 1 0 2-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M7 9.5v5h5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ------------------------------------------------------------------ start

addEventListener("hashchange", route);
await loadMe();
showSaving();
route();
// While open: drop what landed, and look for new messages.
setInterval(async () => {
  if (document.hidden) return;
  const before = pending.all().length;
  turnup.refresh();
  await settleAll();
  await updateUnread();
  if (before !== pending.all().length) route();
}, 20_000);
