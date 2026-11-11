// Turnup's records through the chain's own policy module (chain/policy.wasm,
// Stoa's): every write a client makes is checked the way a node checks it,
// then applied to an in-memory state that the reads take.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as geo from "../client/geo.mjs";
import * as records from "../client/records.mjs";
import { inboxKey } from "../client/seal.mjs";
import { compare, matches } from "../client/match.mjs";

const sdk = await import(new URL("../app/vendor/lattice-sdk.js", import.meta.url));
const PATH = ["Nexus", "turnup"];
const spec = JSON.parse(readFileSync(new URL("../chain/spec.json", import.meta.url), "utf8"));
const policy = new WebAssembly.Module(readFileSync(new URL("../chain/policy.wasm", import.meta.url)));
const [ANA, BEN, CAT] = ["ana", "ben", "cat"];

const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; };
const i64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v)); return b; };
const target = spec.targetBlockTime;
const SPEC = Uint8Array.of(0xa1, 0x6f, ...new TextEncoder().encode("targetBlockTime"), 0x19, target >> 8, target & 0xff);

function admits(body, timestamp) {
  const text = new TextEncoder();
  const { bytes } = sdk.encodeTransactionBody(body);
  const parts = [
    text.encode("LWPCTX"), Uint8Array.of(0, 2, 0, 1, 0), new Uint8Array(8), i64(timestamp), u32(SPEC.length), SPEC,
    u32(PATH.length), ...PATH.flatMap((s) => [u32(text.encode(s).length), text.encode(s)]),
    Uint8Array.of(1), u32(bytes.length), bytes, Uint8Array.of(0, 0),
  ];
  const context = Uint8Array.from(parts.flatMap((p) => [...p]));
  const { exports } = new WebAssembly.Instance(policy);
  const pointer = exports.lattice_alloc(context.length);
  new Uint8Array(exports.memory.buffer).set(context, pointer);
  return exports.lattice_validate_transaction(pointer, context.length) === 1;
}

function chain() {
  const kv = new Map();
  let clock = 1_800_000_000_000;
  const state = {
    get: async (key) => kv.get(key),
    async *list(prefix) {
      for (const key of [...kv.keys()].sort()) if (key.startsWith(prefix)) yield [key, kv.get(key)];
    },
  };
  return {
    state, kv,
    tick: (ms) => (clock += ms),
    async write(signer, writes, { at } = {}) {
      clock += 1000;
      const actions = await records.changes(state, writes, at ?? clock - 500);
      const body = records.transaction({ owner: signer, actions, nonce: 0n, chainPath: PATH });
      if (!admits(body, clock)) return false;
      for (const a of actions) {
        if (kv.get(a.key) !== a.oldValue) return false;
        if (a.newValue === undefined) kv.delete(a.key);
        else kv.set(a.key, a.newValue);
      }
      return true;
    },
  };
}

// A signature is 64 bytes of hex; any fixed bytes stand in for one here.
const keyFor = (seed) => inboxKey(Buffer.alloc(64, seed).toString("hex"));
const PARK = { lat: 40.78123, lon: -73.96654 };
const WALLET_FOUND = { type: "found", category: "wallet", title: "Brown leather wallet", details: "Near the boathouse bench", place: "Central Park", ...PARK, when: 1_799_990_000_000, question: "What's on the library card?", held: "With me" };
const WALLET_LOST = { type: "lost", category: "wallet", title: "Lost my brown wallet", details: "Leather, has a library card", ...PARK, lat: 40.7835, when: 1_799_980_000_000, reward: "2,500" };

test("an item is listed where it is, and read back as written", async () => {
  const c = chain();
  assert.ok(await c.write(ANA, records.item(ANA, "i1", WALLET_FOUND, { photos: ["bafyphoto1"] })));
  const cell = geo.encode(PARK.lat, PARK.lon);
  const [it] = await records.itemsIn(c.state, [cell.slice(0, 4)]);
  assert.equal(it.title, "Brown leather wallet");
  assert.equal(it.lat, 40.781); // kept to about 100 m
  assert.equal(it.question, "What's on the library card?");
  assert.deepEqual(it.photos, ["bafyphoto1"]);
  assert.equal(it.reward, undefined, "a found item carries no reward");
  assert.equal(it.status, "open");
});

test("a reward is a whole number of coins, on a loss only; a receipt names who was paid", async () => {
  const c = chain();
  assert.ok(await c.write(ANA, records.item(ANA, "i1", WALLET_LOST)));
  assert.equal((await records.itemOf(c.state, ANA, "i1")).reward, "2500");
  for (const bad of ["coffee", "0", "-5", "1.5", "9223372036854775808"]) {
    assert.throws(() => records.itemValue({ ...WALLET_LOST, reward: bad }), /whole number of coins/, bad);
  }
  assert.equal(records.itemValue({ ...WALLET_LOST, reward: "  " }).reward, undefined, "no reward is fine");
  assert.equal(records.itemValue({ ...WALLET_FOUND, reward: "50" }).reward, undefined, "a find offers none");
  // A record written as text by another client is read as no reward.
  c.kv.set(`user/${BEN}/post/old`, JSON.stringify({ ...records.itemValue({ ...WALLET_LOST, reward: "" }), reward: "Coffee", time: 1 }));
  assert.equal((await records.itemOf(c.state, BEN, "old")).reward, undefined);

  // The receipt goes on the reward chain with the payment; the policy takes it there too.
  assert.ok(await c.write(ANA, records.rewardWrite(ANA, "i1", { to: BEN, amount: "2500", chain: "dr5" })));
  assert.deepEqual(await records.rewardOf(c.state, ANA, "i1"), { to: BEN, amount: "2500", chain: "dr5" });
  assert.equal(await records.rewardOf(c.state, ANA, "nope"), undefined);
  assert.deepEqual(await records.rewardsBy(c.state, ANA), [{ id: "i1", to: BEN, amount: "2500", chain: "dr5" }]);
  assert.equal(await c.write(BEN, [[`user/${ANA}/reward/i2`, JSON.stringify({ to: BEN, amount: "1", chain: "" })]]), false, "nobody writes another's receipt");
  assert.throws(() => records.rewardWrite(ANA, "i1", { to: ANA, amount: "5" }), /whoever gave it back/);
});

test("a resolved item leaves the map but stays readable; reopening lists it again", async () => {
  const c = chain();
  assert.ok(await c.write(ANA, records.item(ANA, "i1", WALLET_FOUND)));
  const before = await records.itemOf(c.state, ANA, "i1");
  assert.ok(await c.write(ANA, records.item(ANA, "i1", { ...WALLET_FOUND, status: "resolved" }, { before })));
  assert.deepEqual(await records.itemsIn(c.state, [geo.encode(PARK.lat, PARK.lon, 3)]), []);
  const resolved = await records.itemOf(c.state, ANA, "i1");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.time, before.time, "an edit keeps the post's time");
  assert.ok(await c.write(ANA, records.item(ANA, "i1", WALLET_FOUND, { before: resolved })));
  assert.equal((await records.itemsIn(c.state, [geo.encode(PARK.lat, PARK.lon, 3)])).length, 1);
});

test("moving an item moves its listing; deleting removes everything", async () => {
  const c = chain();
  assert.ok(await c.write(ANA, records.item(ANA, "i1", WALLET_FOUND, { photos: ["p1", "p2"] })));
  const before = await records.itemOf(c.state, ANA, "i1");
  const far = { ...WALLET_FOUND, lat: 40.70, lon: -74.01 };
  assert.ok(await c.write(ANA, records.item(ANA, "i1", far, { before, photos: ["p1"], slots: 2 })));
  assert.deepEqual(await records.itemsIn(c.state, [geo.encode(PARK.lat, PARK.lon, 5)]), []);
  assert.equal((await records.itemsIn(c.state, [geo.encode(40.70, -74.01, 5)]))[0].photos.length, 1);
  const moved = await records.itemOf(c.state, ANA, "i1");
  assert.ok(await c.write(ANA, records.item(ANA, "i1", undefined, { before: moved, slots: 1 })));
  assert.deepEqual([...c.kv.keys()], []);
});

test("the chain refuses a write to someone else's keys, and a post with a time it can't hold", async () => {
  const c = chain();
  assert.equal(await c.write(BEN, records.item(ANA, "i1", WALLET_FOUND)), false, "Ben can't post as Ana");
  assert.equal(await c.write(ANA, records.item(ANA, "i1", WALLET_FOUND), { at: 1_900_000_000_000 }), false, "a time ahead of the block");
  assert.equal(await c.write(ANA, records.item(ANA, "i1", WALLET_FOUND), { at: 1_700_000_000_000 }), false, "a time long before the block");
  assert.ok(await c.write(ANA, records.item(ANA, "i1", WALLET_FOUND)));
  // Ben lists Ana's item as lost in another cell: a listing that disagrees with its record doesn't count.
  assert.equal(await c.write(BEN, [[`index/geo/d/r/5/r/u/7/i1/${ANA}`, "found"]]), false, "the listing is Ana's to write");
  assert.ok(await c.write(BEN, [[`index/geo/d/r/5/r/u/7/i1/${BEN}`, "found"]]));
  // Only Ana's own listing counts: Ben's names no item of his.
  assert.deepEqual((await records.itemsIn(c.state, ["dr5ru"])).map((it) => it.author), [ANA]);
});

test("drafts are checked before anything is sent", () => {
  assert.throws(() => records.itemValue({ ...WALLET_FOUND, title: " " }), /few words/);
  assert.throws(() => records.itemValue({ ...WALLET_FOUND, category: "spaceship" }), /kind of thing/);
  assert.throws(() => records.itemValue({ ...WALLET_FOUND, lat: 91 }), /pin/);
  assert.throws(() => records.itemValue({ ...WALLET_FOUND, title: "x".repeat(81) }), /80/);
  assert.throws(() => records.itemValue({ ...WALLET_FOUND, when: undefined }), /when/);
  assert.equal(records.itemValue({ ...WALLET_LOST, question: "secret?" }).question, undefined, "a lost report asks no question");
});

test("messages open only for the two people in them, and group into threads", async () => {
  const c = chain();
  const [ana, ben, cat] = await Promise.all([keyFor(1), keyFor(2), keyFor(3)]);
  assert.ok(await c.write(ANA, records.item(ANA, "i1", WALLET_FOUND, { box: ana.publicKey })));
  assert.ok(await c.write(BEN, records.boxWrite(BEN, ben.publicKey)));
  const about = { type: "item", chain: "", author: ANA, id: "i1", title: "Brown leather wallet" };
  const keys = { [BEN]: await records.boxOf(c.state, BEN), [ANA]: await records.boxOf(c.state, ANA) };
  assert.ok(await c.write(BEN, await records.message(BEN, "m1", ANA, { about, text: "It's mine: the card says Benjamin Okafor", claim: true }, keys)));
  assert.ok(await c.write(ANA, await records.message(ANA, "m2", BEN, { about, text: "Great, meet at the boathouse at 5?" }, keys)));
  // Cat claims too.
  assert.ok(await c.write(CAT, await records.message(CAT, "m3", ANA, { about, text: "Mine!", claim: true }, { [CAT]: cat.publicKey, [ANA]: ana.publicKey })));

  const forAna = await records.messages(c.state, ANA, ana);
  assert.deepEqual(forAna.map((m) => m.mid), ["m1", "m2", "m3"]);
  const threads = records.threads(forAna, ANA);
  assert.equal(threads.length, 2, "one thread per claimant");
  assert.deepEqual(threads.find((t) => t.with === BEN).messages.map((m) => m.body.text), ["It's mine: the card says Benjamin Okafor", "Great, meet at the boathouse at 5?"]);
  assert.equal(threads.find((t) => t.with === BEN).messages[0].body.claim, true);

  const forBen = await records.messages(c.state, BEN, ben);
  assert.deepEqual(forBen.map((m) => m.mid), ["m1", "m2"], "Ben reads his own and Ana's answer, not Cat's");
  assert.deepEqual(await records.messages(c.state, CAT, cat).then((all) => all.map((m) => m.mid)), ["m3"]);
  // The record itself says nothing readable.
  assert.doesNotMatch(c.kv.get(`user/${BEN}/post/m1`), /Okafor|wallet/);
});

test("a message whose listing names someone else, or that doesn't open, is skipped", async () => {
  const c = chain();
  const [ana, ben] = await Promise.all([keyFor(1), keyFor(2)]);
  const about = { type: "tag", author: ANA, id: "t1", name: "Keys" };
  // Ben writes to Cat but lists it in Ana's inbox.
  const writes = await records.message(BEN, "m1", CAT, { about, text: "hi" }, { [BEN]: ben.publicKey, [CAT]: ana.publicKey });
  writes[1] = [`index/inbox/${ANA}/m1/${BEN}`, "1"];
  assert.ok(await c.write(BEN, writes));
  assert.deepEqual(await records.messages(c.state, ANA, ana), []);
  // Garbage in a message record.
  assert.ok(await c.write(BEN, [[`user/${BEN}/post/m2`, JSON.stringify({ kind: "msg", to: ANA, box: "{nope" })], [`index/inbox/${ANA}/m2/${BEN}`, "1"]]));
  assert.deepEqual(await records.messages(c.state, ANA, ana), []);
  await assert.rejects(() => records.message(ANA, "m", ANA, { about, text: "me" }, {}), /That's you/);
});

test("tags", async () => {
  const c = chain();
  const ana = await keyFor(1);
  assert.ok(await c.write(ANA, records.tag(ANA, "t1", { name: "Blue backpack", note: "Reward: coffee on me" }, { box: ana.publicKey })));
  assert.deepEqual(await records.tagOf(c.state, ANA, "t1"), { author: ANA, id: "t1", time: (await records.tagOf(c.state, ANA, "t1")).time, name: "Blue backpack", note: "Reward: coffee on me", missing: false });
  assert.ok(await c.write(ANA, records.tag(ANA, "t1", { name: "Blue backpack", missing: true })));
  assert.equal((await records.tagOf(c.state, ANA, "t1")).missing, true);
  const mine = await records.by(c.state, ANA);
  assert.equal(mine.tags.length, 1);
  assert.equal(mine.items.length, 0);
  assert.throws(() => records.tag(ANA, "t2", { name: "" }), /Name/);
});

test("matches pair a loss with a later find nearby, and say why", () => {
  const lost = { ...records.itemValue(WALLET_LOST), author: BEN, id: "l1" };
  const found = { ...records.itemValue(WALLET_FOUND), author: ANA, id: "f1" };
  const m = compare(lost, found);
  assert.ok(m);
  assert.equal(m.reasons[0], "Same kind of thing");
  assert.match(m.reasons[1], /^\d+ m away$/);
  assert.match(m.reasons.join(" "), /Found a day later|Found the same day/);
  assert.match(m.reasons.join(" "), /brown|leather|card/);
  assert.equal(compare(lost, { ...found, when: lost.when - 3 * 86400000 }), undefined, "found before it was lost");
  assert.equal(compare(lost, { ...found, category: "keys" }), undefined, "another kind of thing");
  assert.equal(compare(lost, { ...found, lat: 40.9 }), undefined, "too far");
  assert.equal(compare(lost, { ...found, author: BEN }), undefined, "your own post");
  assert.ok(compare(lost, { ...found, category: "other" }), "something else may be anything");
  assert.equal(matches(found, [lost, { ...lost, id: "l2", lat: 40.79, title: "phone" }])[0].item.id, "l1");
});

test("inbox keys come from a signature: the same one every time", async () => {
  const a = await keyFor(7);
  const b = await keyFor(7);
  assert.equal(a.publicKey, b.publicKey);
  assert.notEqual((await keyFor(8)).publicKey, a.publicKey);
  await assert.rejects(() => inboxKey("zz"), /signature/);
});
