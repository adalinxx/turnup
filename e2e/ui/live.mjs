// The published page as a person meets it: https://adalinxx.github.io/turnup/
// with the real Selfhold window (wallet.selfhold.app) and a new passkey, on
// the test network. They report a find in New York, which lands on the dr5
// area chain, and close it. No coins anywhere.
//
//   node e2e/ui/live.mjs
import { chromium, expect as baseExpect } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 60_000 });
const APP = process.env.TURNUP_APP ?? "https://adalinxx.github.io/turnup/app/";
const WALLET = "https://wallet.selfhold.app";
const started = Date.now();
const log = (text) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${text}`);

const browser = await chromium.launch({ ignoreDefaultArgs: ["--disable-popup-blocking"] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(60_000);
  await context.addInitScript((origin) => {
    if (location.origin === origin) window.close = () => {};
  }, WALLET);
  const appOrigin = new URL(APP).origin;
  await context.addInitScript((origin) => {
    if (location.origin !== origin) return;
    const open = window.open.bind(window);
    window.open = (url, _name, features) => {
      const to = new URL(url);
      const n = Number(sessionStorage.getItem("requests") ?? 0) + 1;
      sessionStorage.setItem("requests", String(n));
      to.searchParams.set("n", String(n));
      return open(to.href, "selfhold-test", features);
    };
  }, appOrigin);
  let wallet;
  context.on("page", async (popup) => {
    if (wallet || !(await popup.opener().catch(() => null))) return;
    wallet = popup;
    const cdp = await context.newCDPSession(popup);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    });
  });
  const page = await context.newPage();
  const errors = [];
  globalThis.livePage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  const panel = page.locator("#panel");
  const button = (name) => panel.getByRole("button", { name, exact: true });
  const inSelfhold = async (target) => {
    const n = Number(await page.evaluate(() => sessionStorage.getItem("requests") ?? 0)) + 1;
    await target.click();
    await expect.poll(() => wallet && new URL(wallet.url()).searchParams.get("n"), { timeout: 30_000 }).toBe(String(n));
    await wallet.bringToFront();
    return wallet;
  };
  const newestSent = () =>
    page.evaluate(() => Math.max(0, ...Object.entries(localStorage).filter(([k]) => k.startsWith("turnup:pending:")).flatMap(([, v]) => JSON.parse(v).map((p) => p.at))));
  // Approves in Selfhold, then waits until the page keeps the write as sent.
  const approve = async (target) => {
    const before = await newestSent();
    const opened = await inSelfhold(target);
    await opened.getByRole("button", { name: "Approve with your passkey" }).click();
    await page.bringToFront();
    await expect.poll(newestSent, { timeout: 120_000 }).toBeGreaterThan(before);
  };
  const landed = () =>
    expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("turnup:pending:")).length), { timeout: 20 * 60_000, intervals: [5000] }).toBe(0);

  await page.goto(APP);
  await page.evaluate(() => localStorage.setItem("turnup:view", JSON.stringify({ lat: 40.7359, lon: -73.9911, zoom: 17 })));
  await page.goto(`${APP}#/report/found`);
  await panel.getByRole("radio", { name: /Something else/ }).click();
  await panel.getByLabel("In a few words").fill("Live trial: grey umbrella");
  await panel.getByLabel(/^Describe it/).fill(`Posted by e2e/ui/live.mjs at ${new Date().toISOString()}; closed at once.`);
  log("1. a new passkey account in Selfhold, and its inbox");
  const opened = await inSelfhold(button("Continue with a passkey"));
  await opened.getByRole("button", { name: "Create an account" }).click();
  await opened.getByRole("button", { name: /^Sign/ }).click();
  await page.bringToFront();
  await expect(panel.locator("#r-status")).toHaveText("Signed in. Press the button again to post.");
  log("2. post it: Selfhold pays the fee with this device's work");
  await approve(button("Post"));
  await expect(page).toHaveURL(/#\/item\/dr5\//);
  log(`   shown at ${page.url().replace(/^[^#]*/, "")}`);
  await landed();
  log("3. landed; close it");
  await page.reload();
  await expect(panel.locator("h1")).toHaveText("Live trial: grey umbrella");
  await approve(button("It's back with its owner"));
  await landed();
  await page.reload();
  await expect(panel).toContainText("This has been returned to its owner.");
  const me = await page.evaluate(() => JSON.parse(localStorage.getItem("turnup:me")));
  for (const chain of ["Nexus/testnet/turnup-b3494e", "Nexus/testnet/turnup-b3494e/dr5"]) {
    const r = await fetch(`https://lattice-testnet-apps-ams.fly.dev/api/state/account/${me}?chainPath=${chain}`, { cache: "no-store" });
    const balance = r.ok ? (await r.json()).balance ?? "0" : "0";
    if (balance !== "0") throw new Error(`${me} holds ${balance} on ${chain}`);
  }
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  log(`done: ${me} posted and closed a find with no coins`);
} catch (error) {
  log(`FAILED: ${error.message.split("\n")[0]}`);
  const page = globalThis.livePage;
  if (page) {
    log(`at ${page.url().replace(/^[^#]*/, "")}\n${(await page.locator("#panel").innerText({ timeout: 3000 }).catch(() => "")).slice(0, 800)}`);
    log(`saving line: ${await page.locator("#saving").innerText({ timeout: 2000 }).catch(() => "")}`);
    log(`pending: ${await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("turnup:pending")).map(([, v]) => v).join(" ")).catch(() => "")}`);
    await page.screenshot({ path: process.env.UI_SHOT ?? "live-failure.png" }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
