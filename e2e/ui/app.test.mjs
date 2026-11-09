// Turnup in a browser, as each person who uses it, through Selfhold's window,
// against a private stack (../stack.mjs): a node with the Turnup root chain
// and one area chain (dr5, New York), a fee sponsor that also keeps photos,
// and Selfhold's window. Nobody holds coins.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor \
//   LATTICE_WALLET_WEB=<selfhold>/dist-web npm test
//
// TURNUP_KEEP=<keep.json> uses a stack already running (node e2e/stack.mjs).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 60_000 });
// A write lands within a few blocks; blocks come every couple of seconds here.
const LANDS = 240_000;

let stack;
const keep = process.env.TURNUP_KEEP
  ? JSON.parse(readFileSync(process.env.TURNUP_KEEP, "utf8"))
  : await new Promise((done, fail) => {
      stack = spawn(process.execPath, [fileURLToPath(new URL("../stack.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      stack.stdout.on("data", (chunk) => {
        out += chunk;
        process.stdout.write(chunk);
        const found = /^KEEP (.+)$/m.exec(out);
        if (found) done(JSON.parse(readFileSync(found[1], "utf8")));
      });
      stack.on("exit", (code) => fail(new Error(`the stack stopped (${code})`)));
    });
const params = new URLSearchParams({ node: keep.node, chain: keep.chain, sponsor: keep.sponsor, wallet: keep.walletPage });
const APP = `${keep.app}?${params}`;
const walletOrigin = new URL(keep.walletPage).origin;
const appPort = new URL(keep.app).port;

// Places, all inside the dr5 area chain but for SF, which has no area chain.
const UNION_SQUARE = { lat: 40.7359, lon: -73.9911 };
const NEAR_UNION_SQUARE = { lat: 40.7371, lon: -73.9897 };
const SAN_FRANCISCO = { lat: 37.7793, lon: -122.4193 };
// Somewhere nobody posts: a field in Kansas.
const NOWHERE = { lat: 38.5 + Math.random() / 10, lon: -98.5 + Math.random() / 10 };
// Titles carry this run's mark, so a stack can serve run after run.
const RUN = Math.random().toString(36).slice(2, 6);
const PHONE = `Black iPhone, green case ${RUN}`;
const LOST_PHONE = `iPhone 13 in a green case ${RUN}`;
const BAG = `Blue backpack ${RUN}`;

let browser;
const people = [];
before(async () => {
  // Pop-ups blocked as for anyone: Selfhold's window opens only from a click.
  browser = await chromium.launch({ ignoreDefaultArgs: ["--disable-popup-blocking"] });
});
after(async () => {
  await browser?.close();
  if (stack) {
    stack.kill();
    await new Promise((done) => stack.on("exit", done));
  }
});

/**
 * A person in their own browser profile, with their own passkey in
 * Selfhold's window: `{ page, wallet(), errors, at(point) }`.
 */
async function person(name, { viewport = { width: 390, height: 844 }, at = UNION_SQUARE } = {}) {
  const context = await browser.newContext({ viewport, geolocation: { latitude: at.lat, longitude: at.lon }, permissions: ["geolocation"] });
  // Selfhold's window stays open and every request reuses it, numbered, so
  // the passkey the virtual authenticator holds there is the same each time.
  await context.addInitScript((origin) => {
    if (location.origin === origin) window.close = () => {};
  }, walletOrigin);
  await context.addInitScript((port) => {
    if (location.port !== String(port)) return;
    const open = window.open.bind(window);
    window.open = (url, _name, features) => {
      const to = new URL(url);
      const n = Number(sessionStorage.getItem("requests") ?? 0) + 1;
      sessionStorage.setItem("requests", String(n));
      to.searchParams.set("n", String(n));
      return open(to.href, "selfhold-test", features);
    };
  }, appPort);
  context.setDefaultTimeout(60_000);
  const who = { name, context, errors: [], walletWindow: null, open: new Map() };
  // Requests not yet answered, by any page of this person's, to say what a stuck page waits on.
  context.on("request", (r) => who.open.set(r, Date.now()));
  context.on("requestfinished", (r) => who.open.delete(r));
  context.on("requestfailed", (r) => who.open.delete(r));
  context.on("page", async (popup) => {
    if (who.walletWindow || !(await popup.opener().catch(() => null))) return;
    who.walletWindow = popup;
    const cdp = await context.newCDPSession(popup);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    });
  });
  who.page = await context.newPage();
  if (process.env.UI_WATCHDOG) {
    // A page whose script never yields: pause it and say where.
    const cdp = await context.newCDPSession(who.page);
    await cdp.send("Debugger.enable");
    cdp.on("Debugger.paused", (e) => {
      console.error(`--- ${name}'s page is stuck at:\n${e.callFrames.slice(0, 12).map((f) => `${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/")}:${f.location.lineNumber + 1}`).join("\n")}`);
      cdp.send("Debugger.resume").catch(() => {});
    });
    const watch = setInterval(async () => {
      const alive = await Promise.race([who.page.evaluate(() => 1).catch(() => 1), new Promise((r) => setTimeout(() => r(0), 10_000))]);
      if (!alive) cdp.send("Debugger.pause").catch(() => {});
    }, 20_000);
    context.on("close", () => clearInterval(watch));
  }
  who.page.on("pageerror", (error) => who.errors.push(error.message));
  who.page.on("console", (m) => trace(who, `console.${m.type()} ${m.text()}`));
  who.page.on("framenavigated", (f) => f === who.page.mainFrame() && trace(who, `at ${f.url().replace(/^[^#]*/, "")}`));
  who.at = (point) => context.setGeolocation({ latitude: point.lat, longitude: point.lon });
  people.push(who);
  return who;
}

const test = (name, body) =>
  nodeTest(name, { timeout: 600_000 }, async () => {
    try {
      await body();
      for (const who of people) assert.deepEqual(who.errors, [], `${who.name}: no page errors`);
    } catch (error) {
      for (const who of people) {
        if (process.env.UI_SHOT) await who.page.screenshot({ path: `${process.env.UI_SHOT}/${who.name}.png` }).catch(() => {});
        error.message += `\n--- ${who.name} at ${who.page.url().replace(/^[^#]*/, "")}:\n${(await who.page.locator("#panel").innerText({ timeout: 2000 }).catch(() => "")).slice(0, 1200)}`;
        const waiting = [...who.open].filter(([, at]) => Date.now() - at > 5000).map(([r, at]) => `${Math.round((Date.now() - at) / 1000)}s ${r.method()} ${r.url()}`);
        if (waiting.length) error.message += `\n--- ${who.name} waits on:\n${waiting.join("\n")}`;
        if (who.walletWindow) error.message += `\n--- ${who.name}'s Selfhold window:\n${(await who.walletWindow.locator("body").innerText({ timeout: 2000 }).catch(() => "(closed)")).slice(0, 600)}`;
      }
      throw error;
    }
  });

/** Presses `button`, then waits for Selfhold's window to show that request. */
const trace = (who, text) => process.env.UI_TRACE && console.error(`${new Date().toISOString().slice(11, 19)} ${who.name}: ${text}`);
async function inSelfhold(who, button) {
  trace(who, `press ${button}`);
  const n = Number(await who.page.evaluate(() => sessionStorage.getItem("requests") ?? 0)) + 1;
  await button.click();
  await expect.poll(() => who.walletWindow && new URL(who.walletWindow.url()).searchParams.get("n"), { timeout: 30_000 }).toBe(String(n));
  trace(who, `Selfhold shows request ${n}`);
  await who.walletWindow.bringToFront();
  return who.walletWindow;
}
/** First press: make a passkey account in Selfhold and sign the inbox text. */
async function signUp(who, button) {
  const opened = await inSelfhold(who, button);
  await opened.getByRole("button", { name: "Create an account" }).click();
  await opened.getByRole("button", { name: /^Sign/ }).click();
  await who.page.bringToFront();
}
/** The time of the newest change this person's page keeps as on its way. */
const newestSent = (who) =>
  who.page.evaluate(() => Math.max(0, ...Object.entries(localStorage).filter(([k]) => k.startsWith("turnup:pending:")).flatMap(([, v]) => JSON.parse(v).map((p) => p.at))));
/** Presses `button`, approves in Selfhold, and waits until the page keeps the write as sent. */
async function approve(who, button) {
  const before = await newestSent(who);
  const opened = await inSelfhold(who, button);
  await opened.getByRole("button", { name: "Approve with your passkey" }).click();
  await who.page.bringToFront();
  await expect.poll(() => newestSent(who), { timeout: 120_000 }).toBeGreaterThan(before);
}
/** Waits until nothing this person sent is still on its way. */
async function landed(who) {
  trace(who, "waiting to land");
  await expect
    .poll(() => who.page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("turnup:pending:")).length), { timeout: LANDS, intervals: [1000] })
    .toBe(0);
}
/** Where the next map opens: the report form's pin starts at the map's last view. */
const lookAt = (who, point) =>
  who.page.evaluate(([lat, lon]) => localStorage.setItem("turnup:view", JSON.stringify({ lat, lon, zoom: 17 })), [point.lat, point.lon]);
/** Someone who comes by once: their browser closes after `body`, pass or fail. */
async function briefly(name, body) {
  const who = await person(name);
  try {
    await body(who);
  } finally {
    await who.context.close();
    people.splice(people.indexOf(who), 1);
  }
}
const go = (who, hash = "") => who.page.goto(`${APP}${hash}`);
const panel = (who) => who.page.locator("#panel");
const button = (who, name) => panel(who).getByRole("button", { name, exact: true });

let fay, owen;
let fayItem; // the href of Fay's find

test("a visitor sees an empty map and how it works", async () => {
  await briefly("visitor", async (visitor) => {
  await go(visitor);
  await lookAt(visitor, NOWHERE);
  await visitor.page.reload();
  await expect(panel(visitor)).toContainText("Nothing reported in this part of the map yet.");
  await panel(visitor).getByRole("link", { name: "How it works" }).click();
  await expect(panel(visitor).locator("h1")).toHaveText("A lost and found that no company runs");
  });
});

test("a finder with no coins posts what they found", async () => {
  fay = await person("fay");
  await go(fay);
  await lookAt(fay, UNION_SQUARE);
  await panel(fay).getByRole("link", { name: /I found something/ }).click();
  await expect(panel(fay).locator("h1")).toHaveText("Report something you found");
  // Nothing chosen yet: says what's missing.
  await panel(fay).getByRole("button", { name: /^(Post|Continue with a passkey)$/ }).click();
  await expect(panel(fay).locator("#r-status")).toHaveText(/what kind of thing/i);
  await panel(fay).getByRole("radio", { name: /Phone/ }).click();
  await panel(fay).getByLabel("In a few words").fill(PHONE);
  await panel(fay).getByLabel(/^Place/).fill("Bench by the Union Square subway entrance");
  await panel(fay).getByLabel(/^Describe it/).fill("Cracked corner. Green silicone case with a sticker.");
  await panel(fay).getByLabel(/^Ask the owner/).fill("What's the lock screen picture?");
  await panel(fay).getByLabel("Where is it now?").fill("With me");
  await expect(button(fay, "Continue with a passkey")).toBeVisible();
  await signUp(fay, button(fay, "Continue with a passkey"));
  await expect(panel(fay).locator("#r-status")).toHaveText("Signed in. Press the button again to post.");
  // The form kept everything.
  await expect(panel(fay).getByLabel("In a few words")).toHaveValue(PHONE);
  await approve(fay, button(fay, "Post"));
  // Shown at once, on the area chain, while it lands.
  await expect(fay.page).toHaveURL(/#\/item\/dr5\//);
  fayItem = new URL(fay.page.url()).hash;
  await expect(panel(fay).locator("h1")).toHaveText(PHONE);
  await expect(fay.page.locator("#saving")).toContainText("Saving your found post");
  await landed(fay);
  await expect(fay.page.locator("#saving")).toBeHidden();
  await fay.page.reload();
  await expect(panel(fay).locator("h1")).toHaveText(PHONE);
  await expect(panel(fay)).toContainText("Possible matches");
  await expect(panel(fay)).toContainText("Nothing yet.");
});

test("an owner posts their loss and sees the find as a possible match", async () => {
  owen = await person("owen", { at: NEAR_UNION_SQUARE });
  await go(owen);
  await lookAt(owen, NEAR_UNION_SQUARE);
  // The find is on the map near here.
  await owen.page.reload();
  await expect(panel(owen).locator("#list")).toContainText(PHONE);
  await panel(owen).getByRole("link", { name: /I lost something/ }).click();
  await expect(panel(owen).locator("h1")).toHaveText("Report something you lost");
  await panel(owen).getByRole("radio", { name: /Phone/ }).click();
  await panel(owen).getByLabel("In a few words").fill(LOST_PHONE);
  await panel(owen).getByLabel(/^Reward/).fill("Coffee and many thanks");
  // A finder's question is only for finds.
  await expect(panel(owen).getByLabel(/^Ask the owner/)).toBeHidden();
  await signUp(owen, button(owen, "Continue with a passkey"));
  await approve(owen, button(owen, "Post"));
  await expect(owen.page).toHaveURL(/#\/item\/dr5\//);
  await expect(panel(owen).locator("h1")).toHaveText(LOST_PHONE);
  // Worked out on this device from what's posted nearby, before the post even lands.
  const match = panel(owen).locator("#matches .row").filter({ hasText: PHONE });
  await expect(match).toBeVisible();
  await expect(match).toContainText("Same kind of thing");
  await expect(match).toContainText(/\d+ m away/);
  await landed(owen);
});

test("the owner claims the find, answering the finder's question privately", async () => {
  await panel(owen).locator("#matches .row").filter({ hasText: PHONE }).click();
  await expect(panel(owen).locator("h1")).toHaveText(PHONE);
  await expect(panel(owen)).toContainText("Is this yours?");
  await panel(owen).getByLabel("The finder asks: What's the lock screen picture?").fill("My dog Biscuit on a beach");
  await panel(owen).getByLabel("Your message").fill("It's mine, I lost it this morning. I can pick it up anywhere near Union Square.");
  await approve(owen, button(owen, "Send to the finder"));
  await expect(owen.page).toHaveURL(/#\/inbox\//);
  const sent = panel(owen).locator(".bubble.me");
  await expect(sent).toContainText("Answer: My dog Biscuit on a beach");
  await expect(sent.locator(".kind")).toHaveText("Claim");
  await landed(owen);
});

test("someone else can't read the claim", async () => {
  await briefly("mallory", async (mallory) => {
  // Mallory goes straight to the thread's address.
  await go(mallory, new URL(owen.page.url()).hash);
  await expect(panel(mallory)).toContainText("Messages between finders and owners are private");
  await signUp(mallory, button(mallory, "Continue with a passkey"));
  await expect(panel(mallory)).not.toContainText("Biscuit");
  await expect(panel(mallory).locator(".bubble")).toHaveCount(0);
  });
});

test("the finder reads the claim, replies, and marks it returned", async () => {
  await go(fay);
  await expect(fay.page.locator("#unread")).toHaveText("1", { timeout: LANDS });
  await fay.page.locator("#tabs").getByRole("link", { name: /Messages/ }).click();
  const row = panel(fay).locator(".row").filter({ hasText: PHONE });
  await expect(row).toContainText("It's mine");
  await row.click();
  const claim = panel(fay).locator(".bubble.them");
  await expect(claim).toContainText("Answer: My dog Biscuit on a beach");
  await expect(claim.locator(".kind")).toHaveText("Claim");
  await expect(fay.page.locator("#unread")).toBeHidden();
  await panel(fay).getByLabel("Message").fill("That's it! I'm at the café on 14th until 5.");
  await panel(fay).getByLabel("Share where I am").check();
  await approve(fay, button(fay, "Send"));
  await expect(panel(fay).locator(".bubble.me")).toContainText("I'm at the café on 14th");
  await expect(panel(fay).locator(".bubble.me").getByRole("link", { name: /Shared a location/ })).toHaveAttribute("href", /openstreetmap\.org\/\?mlat=40\.73/);
  await landed(fay);
  await approve(fay, button(fay, "It's back with its owner"));
  await landed(fay);
  await go(fay, fayItem);
  await expect(panel(fay)).toContainText("This has been returned to its owner.");
  await expect(panel(fay).locator(".tagline")).toHaveText("Returned");
  // No longer listed.
  await go(fay);
  await expect(panel(fay).locator("#list")).not.toContainText(PHONE);
  await expect(panel(fay).locator("#list")).toContainText(LOST_PHONE);
});

test("the owner reads the reply and closes their post", async () => {
  await go(owen, "#/inbox");
  await expect(panel(owen).locator(".row").filter({ hasText: PHONE })).toContainText("I'm at the café", { timeout: LANDS });
  await go(owen, "#/mine");
  await panel(owen).locator(".row").filter({ hasText: LOST_PHONE }).click();
  await approve(owen, button(owen, "I got it back"));
  await landed(owen);
  await owen.page.reload();
  await expect(panel(owen)).toContainText("The owner has it back.");
  await go(owen, "#/mine");
  await expect(panel(owen)).toContainText("Closed");
});

let tagLink;
test("an owner tags their bag; whoever finds it messages them without seeing who they are", async () => {
  await go(owen, "#/tags");
  await panel(owen).getByRole("link", { name: "Make a tag" }).click();
  await panel(owen).getByLabel("What does it go on?").fill(BAG);
  await panel(owen).getByLabel(/^A note for whoever finds it/).fill("Thank you! There's a reward.");
  await approve(owen, button(owen, "Make the tag"));
  await expect(owen.page).toHaveURL(/#\/tags$/);
  await expect(panel(owen).locator(".qr svg")).toHaveCount(1);
  tagLink = await panel(owen).getByRole("link", { name: "Open" }).getAttribute("href");
  await landed(owen);

  // Fay scans it: the QR code is the link.
  await fay.page.goto(tagLink);
  await expect(panel(fay).locator("h1")).toHaveText(`You found: ${BAG}`);
  await expect(panel(fay)).toContainText("Thank you! There's a reward.");
  await expect(panel(fay)).not.toContainText(owen.name);
  await panel(fay).getByLabel("Message").fill("Found it on the L train, Bedford Av. I'm leaving it with the station agent.");
  await approve(fay, button(fay, "Send to the owner"));
  await expect(fay.page).toHaveURL(/#\/inbox\//);
  await landed(fay);

  await go(owen, "#/inbox");
  const row = panel(owen).locator(".row").filter({ hasText: `Tag: ${BAG}` });
  await expect(row).toContainText("L train", { timeout: LANDS });
  // The owner's own tag shows what a finder sees.
  await owen.page.goto(tagLink);
  await expect(panel(owen).locator("h1")).toHaveText(`This is your tag: ${BAG}`);
});

test("addresses that lead nowhere say so", async () => {
  const id = fayItem.split("/").pop();
  const faysAccount = fayItem.split("/")[3];
  await go(owen, `#/item/dr5/${faysAccount}/no-such-post`);
  await expect(panel(owen)).toContainText("This post isn't here.");
  // Only its author can edit a post.
  await go(owen, `#/edit/dr5/${id}`);
  await expect(panel(owen)).toContainText("That post isn't yours, or it's gone.");
  await go(owen, `#/t/${faysAccount}/no-such-tag`);
  await expect(panel(owen)).toContainText("This tag isn't active any more");
  await go(owen, "#/no-such-page");
  await expect(panel(owen).getByRole("link", { name: /I lost something/ })).toBeVisible();
});

test("a post's text is shown as text, and an account sends one change at a time per chain", async () => {
  const title = `<img src=x onerror="document.title='owned'"> keys ${RUN}`;
  await go(owen);
  await lookAt(owen, SAN_FRANCISCO);
  await panel(owen).getByRole("link", { name: /I found something/ }).click();
  await panel(owen).getByRole("radio", { name: /Keys/ }).click();
  await panel(owen).getByLabel("In a few words").fill(title);
  await approve(owen, button(owen, "Post"));
  // San Francisco has no area chain: the post is on the root.
  await expect(owen.page).toHaveURL(/#\/item\/-\//);
  await expect(panel(owen).locator("h1")).toHaveText(title);
  await expect(panel(owen).locator("h1 img")).toHaveCount(0);
  assert.notEqual(await owen.page.title(), "owned");
  // A tag is on the root too, where the post is still on its way.
  await go(owen, "#/tags/new");
  await panel(owen).getByLabel("What does it go on?").fill(`Keyring ${RUN}`);
  await button(owen, "Make the tag").click();
  await expect(panel(owen).locator("#t-status")).toHaveText(/Your last change is still being saved/);
  await landed(owen);
  // Once it lands, the tag goes.
  await approve(owen, button(owen, "Make the tag"));
  await expect(owen.page).toHaveURL(/#\/tags$/);
  await landed(owen);
});

test("a draft survives a reload; an edit and a deletion show at once and land", async () => {
  await go(owen);
  await lookAt(owen, NEAR_UNION_SQUARE);
  await panel(owen).getByRole("link", { name: /I lost something/ }).click();
  await panel(owen).getByRole("radio", { name: /Wallet/ }).click();
  await panel(owen).getByLabel("In a few words").fill(`Brown leather wallet ${RUN}`);
  await owen.page.reload();
  await expect(panel(owen).getByLabel("In a few words")).toHaveValue(`Brown leather wallet ${RUN}`);
  await expect(panel(owen).getByRole("radio", { name: /Wallet/ })).toHaveAttribute("aria-checked", "true");
  await approve(owen, button(owen, "Post"));
  await expect(panel(owen).locator("h1")).toHaveText(`Brown leather wallet ${RUN}`);
  await landed(owen);
  // The draft is gone once posted.
  await go(owen, "#/report/lost");
  await expect(panel(owen).getByLabel("In a few words")).toHaveValue("");

  await go(owen, "#/mine");
  await panel(owen).locator(".row").filter({ hasText: `Brown leather wallet ${RUN}` }).click();
  await panel(owen).getByRole("link", { name: "Edit" }).click();
  await expect(panel(owen).locator("h1")).toHaveText("Edit your post");
  await panel(owen).getByLabel("In a few words").fill(`Brown wallet with a bus pass ${RUN}`);
  await approve(owen, button(owen, "Save changes"));
  await expect(panel(owen).locator("h1")).toHaveText(`Brown wallet with a bus pass ${RUN}`);
  await landed(owen);
  await owen.page.reload();
  await expect(panel(owen).locator("h1")).toHaveText(`Brown wallet with a bus pass ${RUN}`);

  await approve(owen, button(owen, "Delete"));
  await expect(owen.page).toHaveURL(/#\/mine$/);
  await expect(panel(owen)).not.toContainText(`Brown wallet with a bus pass ${RUN}`);
  await landed(owen);
  await owen.page.reload();
  await expect(panel(owen)).not.toContainText(`Brown wallet with a bus pass ${RUN}`);
});

test("closing Selfhold's window sends nothing", async () => {
  await briefly("quinn", async (quinn) => {
    await go(quinn, "#/tags/new");
    await panel(quinn).getByLabel("What does it go on?").fill("Laptop");
    const opened = await inSelfhold(quinn, button(quinn, "Continue with a passkey"));
    await opened.close();
    await expect(panel(quinn).locator("#t-status")).toHaveText("Nothing was sent.");
    await expect(button(quinn, "Continue with a passkey")).toBeEnabled();
  });
});

test("on a wide screen the list sits beside the map", async () => {
  await briefly("desk", async (desk) => {
    await desk.page.setViewportSize({ width: 1280, height: 800 });
    await go(desk);
    const map = await desk.page.locator("#map").boundingBox();
    const side = await desk.page.locator("#side").boundingBox();
    assert.ok(map.width > 600 && side.width < 500 && map.x >= side.x + side.width - 1, "panel on the left, map on the right");
  });
});
