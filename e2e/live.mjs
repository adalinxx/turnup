// Turnup as a person meets it now: the deployed hosts, the deployed fee
// sponsor and the test network's chains, not a private stack. A new account
// with no coins grinds shares for the sponsor, has it price and co-sign a
// post, and sends it to iad: first a find in New York, which belongs on the
// dr5 area chain, then its inbox key on the root. It waits for each to land
// and reads them back from ams, through the same client the page uses, which
// must find the area chain by itself. Each step that fails says which.
//
//   node e2e/live.mjs
//
// It posts one real find, titled "Live check", resolved at once.
import { createHash } from "node:crypto";
import * as sdk from "../app/vendor/lattice-sdk.js";
import * as records from "../client/records.mjs";
import { inboxKey } from "../client/seal.mjs";
import { createTurnup } from "../client/turnup.mjs";

const NODE = "https://lattice-testnet-apps-iad.fly.dev";
const SECOND = "https://lattice-testnet-apps-ams.fly.dev";
const SPONSOR = "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor";
const ROOT = ["Nexus", "testnet", "turnup-b3494e"];
// A deploy restarts the sponsor for a minute or two; blocks are minutes apart.
const UNPRICEABLE_MINUTES = 5;
const LAND_MINUTES = 20;

const started = Date.now();
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);
const fail = (message) => {
  throw new Error(`${message} (after ${((Date.now() - started) / 60_000).toFixed(1)} min)`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(path, body) {
  const deadline = Date.now() + UNPRICEABLE_MINUTES * 60_000;
  for (;;) {
    const response = await fetch(`${SPONSOR}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (response.ok) return JSON.parse(text);
    if (response.status === 503 && Date.now() < deadline) {
      await sleep(5000);
      continue;
    }
    throw Object.assign(new Error(`sponsor ${path}: ${response.status} ${text.trim()}`), { status: response.status });
  }
}

/** The nonces in `work`'s range whose SHA-256 over its prefix and the nonce (8 bytes, big-endian) is at or under its share target. */
function* shares(work) {
  const prefix = Buffer.from(work.prefixHex, "hex");
  const target = BigInt(`0x${work.shareTarget}`);
  const input = Buffer.alloc(prefix.length + 8);
  prefix.copy(input);
  for (let n = BigInt(work.startNonce), end = n + BigInt(work.count); n < end; n++) {
    input.writeBigUInt64BE(n, prefix.length);
    if (BigInt(`0x${createHash("sha256").update(input).digest("hex")}`) <= target) yield n;
  }
}

/** `draft` with the sponsor's fee debit and signature, earned with shares of work, as Selfhold's window does. */
async function sponsored(draft, chain) {
  const toWire = (body) => sdk.transactionPayload({}, body).transaction.body;
  const fromWire = (body) => ({ ...body, accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: BigInt(a.delta) })), nonce: BigInt(body.nonce) });
  let client;
  for (let round = 0; round < 20; round++) {
    if (client) {
      try {
        const answer = await ask("sponsor", { client, transaction: { signatures: {}, body: toWire(draft) } });
        return { body: fromWire(answer.transaction.body), signatures: answer.transaction.signatures };
      } catch (error) {
        if (error.status === 400 && /client token/.test(error.message)) client = undefined;
        else if (error.status !== 402) throw error;
      }
    }
    const work = await ask("work", { ...(client && { client }), chain: chain.join("/") });
    client = work.client;
    for (const nonce of shares(work)) {
      try {
        const { credit } = await ask("shares", { assignment: work.assignment, nonce: String(nonce) });
        if (BigInt(credit) >= BigInt(work.fee)) break;
      } catch (error) {
        if (error.status === 400 || error.status === 410) break;
        throw error;
      }
    }
  }
  fail("the sponsor never co-signed in 20 rounds");
}

async function send(me, chain, actions) {
  const draft = records.transaction({ owner: me.address, actions, nonce: 0n, chainPath: chain });
  const { body, signatures } = await sponsored(draft, chain);
  const { publicKey, signature } = sdk.signTransactionBody(body, me.privateKey);
  const response = await fetch(`${NODE}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sdk.transactionPayload({ ...signatures, [publicKey]: signature }, body)), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) fail(`iad refused it on ${chain.join("/")}: ${response.status} ${text.trim()}`);
  log(`  sent ${JSON.parse(text).transactionCID}`);
}

async function until(label, check) {
  const deadline = Date.now() + LAND_MINUTES * 60_000;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) fail(`${label}: not within ${LAND_MINUTES} min`);
    await sleep(10_000);
  }
}

const me = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const reader = createTurnup({ sdk, root: ROOT, nodes: [SECOND], freshFor: 0 });
const write = createTurnup({ sdk, root: ROOT, nodes: [NODE], freshFor: 0 });
log(`account ${me.address} (no coins)`);

log("1. ams lists the New York area chain under the root, running the root's spec");
const areas = await reader.areas();
if (!areas.has("dr5")) fail(`areas found: ${[...areas.keys()].join(", ") || "none"}`);
const where = { lat: 40.7359, lon: -73.9911 };
const at = await reader.chainAt(where);
if (at.label !== "dr5") fail(`Union Square went to "${at.label || "the root"}"`);

log("2. a find in New York, sponsored, on dr5");
const id = records.newId();
const draft = { type: "found", category: "other", title: "Live check", ...where, when: Date.now(), details: `Posted by e2e/live.mjs at ${new Date().toISOString()}.`, status: "resolved" };
const actions = await records.changes(await write.chainState(at.path, { fresh: true }), records.item(me.address, id, draft));
await send(me, at.path, actions);

log("3. it lands, and ams reads it back");
const found = await until("the find on ams", () => reader.itemOf("dr5", me.address, id, { fresh: true }));
log(`  read back "${found.title}" (${found.status}) from ams`);

log("4. a write on the root, sponsored: the account's inbox key");
const box = (await inboxKey(Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("hex"))).publicKey;
await send(me, ROOT, await records.changes(await write.chainState(ROOT, { fresh: true }), records.boxWrite(me.address, box)));
await until("the inbox key on ams", async () => (await reader.boxOf(me.address, { fresh: true })) === box);
log("  read back from ams");

const balance = async (chain) => BigInt((await (await fetch(`${NODE}/api/state/account/${me.address}?chainPath=${chain.join("/")}`, { cache: "no-store" })).json()).balance ?? 0);
if ((await balance(ROOT)) !== 0n || (await balance(at.path)) !== 0n) fail("the account holds coins");
log("done: no coins held, both chains written");
