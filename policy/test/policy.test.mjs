// Runs the built policy module the way the Lattice host does: allocate with
// `lattice_alloc`, write the canonical context, call the entrypoint. Bodies
// are encoded by the SDK, whose encoding is pinned to Lattice's vectors.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   node --test policy/test/policy.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

const { encodeTransactionBody } = await import(new URL("../../app/vendor/lattice-sdk.js", import.meta.url));
const module = new WebAssembly.Module(
  readFileSync(
    new URL("../target/wasm32-unknown-unknown/release/turnup_policy.wasm", import.meta.url),
  ),
);
// The value the module was built with.
const MIGRATED_FROM = readFileSync(new URL("../migrated-from", import.meta.url), "utf8").trimEnd();

const ALICE = "alice-address";
const BOB = "bob-address";
const PATH = ["Nexus", "turnup", "dr5"];

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

// The block the tests' transactions land in, and the chain's target block
// time (the spec's, in DAG-CBOR: {"targetBlockTime": 10000}).
const NOW = 1_800_000_000_000;
const TARGET = 10_000;
const WINDOW = 60 * TARGET;
const SPEC = Uint8Array.of(0xa1, 0x6f, ...new TextEncoder().encode("targetBlockTime"), 0x19, TARGET >> 8, TARGET & 0xff);

function i64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value));
  return bytes;
}

function context(bodyBytes, { version = 2, timestamp = NOW, spec = SPEC } = {}) {
  const text = new TextEncoder();
  const parts = [
    text.encode("LWPCTX"),
    Uint8Array.of(0, version, 0, 1, 0), // encoding version, ABI version, transaction scope
    new Uint8Array(8), // height
    i64(timestamp),
    u32(spec.length),
    spec,
    u32(PATH.length),
    ...PATH.flatMap((segment) => [u32(text.encode(segment).length), text.encode(segment)]),
  ];
  if (bodyBytes === undefined) parts.push(Uint8Array.of(0));
  else parts.push(Uint8Array.of(1), u32(bodyBytes.length), bodyBytes);
  parts.push(Uint8Array.of(0, 0)); // no action, no action index
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

// With CONTEXT_DIR set, every context is recorded with its verdict so
// host-check can replay it through Lattice's own evaluator.
const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function run(bytes) {
  const { exports } = new WebAssembly.Instance(module);
  const pointer = exports.lattice_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer).set(bytes, pointer);
  const accepted = exports.lattice_validate_transaction(pointer, bytes.length) === 1;
  if (contextDirectory) {
    const name = `${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`;
    writeFileSync(`${contextDirectory}/${name}`, bytes);
  }
  return accepted;
}

function body(actions, signers = [ALICE], extra = {}) {
  return encodeTransactionBody({
    accountActions: [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers,
    nonce: 7n,
    chainPath: PATH,
    ...extra,
  }).bytes;
}

const accepts = (actions, signers, extra) => run(context(body(actions, signers, extra)));
const post = (fields = {}) => JSON.stringify({ title: "hello", time: NOW - 1000, ...fields });

test("an author writes, edits and deletes their own records", () => {
  assert.ok(accepts([{ key: `user/${ALICE}/post/1`, newValue: post() }]));
  assert.ok(accepts([{ key: `user/${ALICE}/post/1`, oldValue: post(), newValue: post({ title: "hello, world" }) }]));
  assert.ok(accepts([{ key: `user/${ALICE}/post/1`, oldValue: post({ title: "hello, world" }) }]));
  assert.ok(accepts([{ key: `user/${ALICE}/profile`, newValue: '{"name":"Alice"}' }]));
  assert.ok(accepts([{ key: `user/${ALICE}`, newValue: "x" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/anything/a/client/invents`, newValue: "x" }]));
});

test("nobody writes or deletes another author's records", () => {
  assert.ok(!accepts([{ key: `user/${BOB}/post/1`, newValue: "forged" }]));
  assert.ok(!accepts([{ key: `user/${BOB}/post/1`, oldValue: "hello" }]));
  assert.ok(!accepts([{ key: `user/${BOB}/profile`, newValue: "{}" }]));
  // Naming yourself later in someone else's namespace does not make it yours.
  assert.ok(!accepts([{ key: `user/${BOB}/${ALICE}`, newValue: "x" }]));
  // One bad action rejects the whole transaction.
  assert.ok(
    !accepts([
      { key: `user/${ALICE}/post/1`, newValue: post() },
      { key: `user/${BOB}/post/1`, newValue: "not mine" },
    ]),
  );
});

test("an index entry belongs to the writer named in its last segment", () => {
  assert.ok(
    accepts([
      { key: `index/post/1/${ALICE}`, newValue: "1" },
      { key: `index/comment/${BOB}/1/2/${ALICE}`, newValue: "1" },
      { key: `index/vote/${BOB}/1/${ALICE}`, newValue: "1" },
      { key: `index/moderator/${ALICE}`, newValue: "1" },
    ]),
  );
  assert.ok(!accepts([{ key: `index/vote/${ALICE}/1/${BOB}`, newValue: "1" }]));
  assert.ok(!accepts([{ key: `index/vote/${ALICE}/1/${BOB}`, oldValue: "1" }]));
  assert.ok(!accepts([{ key: `index/moderator/${BOB}`, newValue: "1" }]));
  // An index key needs a topic as well as an owner.
  assert.ok(!accepts([{ key: `index/${ALICE}`, newValue: "1" }]));
  assert.ok(!accepts([{ key: "index", newValue: "1" }]));
});

test("any one of several signers may own a key", () => {
  assert.ok(accepts([{ key: `user/${BOB}/post/1`, newValue: post() }], [ALICE, BOB]));
});

test("keys outside the two shapes are rejected", () => {
  for (const key of [ALICE, `${ALICE}/post/1`, `post/${ALICE}/1`, "user", "user/", `users/${ALICE}`, `/user/${ALICE}`]) {
    assert.ok(!accepts([{ key, newValue: "x" }]), key);
  }
});

test("the policy puts no limit on key or value size", () => {
  assert.ok(accepts([{ key: `user/${ALICE}/${"i".repeat(5000)}`, newValue: "x".repeat(200000) }]));
});

test("coin actions pass untouched", () => {
  assert.ok(accepts([]));
  assert.ok(
    accepts([], [ALICE], {
      accountActions: [
        { owner: ALICE, delta: -1000n },
        { owner: BOB, delta: 998n },
      ],
      depositActions: [{ nonce: 1n, demander: ALICE, amountDemanded: 5n, amountDeposited: 5n }],
    }),
  );
});

test("a malformed or unknown context is rejected", () => {
  const good = body([{ key: `user/${ALICE}/post/1`, newValue: post() }]);
  assert.ok(run(context(good)));
  assert.ok(!run(context(good, { version: 1 })));
  assert.ok(!run(context(undefined)));
  assert.ok(!run(context(good.slice(0, good.length - 3))));
  assert.ok(!run(context(good).slice(0, 40)));
  assert.ok(!run(new Uint8Array(0)));
});

test("a post states its time: no later than its block, at most 60 target block times before", () => {
  const created = (time) => accepts([{ key: `user/${ALICE}/post/1`, newValue: post({ time }) }]);
  assert.ok(created(NOW));
  assert.ok(created(NOW - WINDOW));
  assert.ok(!created(NOW + 1), "after its block");
  assert.ok(!created(NOW - WINDOW - 1), "too long before its block");
  // The window is the chain's: a slower chain allows more.
  const slow = Uint8Array.of(0xa1, 0x6f, ...new TextEncoder().encode("targetBlockTime"), 0x1a, 0, 0x01, 0x86, 0xa0); // 100000
  const early = body([{ key: `user/${ALICE}/post/1`, newValue: post({ time: NOW - WINDOW - 1 }) }]);
  assert.ok(run(context(early, { spec: slow })));
  assert.ok(!run(context(early, { spec: Uint8Array.of(0xa0) })), "a spec without targetBlockTime");
});

test("a post's time is one plain top-level whole number", () => {
  const created = (json) => accepts([{ key: `user/${ALICE}/post/1`, newValue: json }]);
  const t = NOW - 1000;
  assert.ok(created(`{"title":"a","nested":{"time":1},"time":${t}}`));
  assert.ok(created(` { "body" : "x\\"y" , "time" : ${t} } `));
  assert.ok(!created(`{"title":"no time"}`));
  assert.ok(!created(`{"time":${t},"time":${t}}`), "twice");
  assert.ok(!created(`{"\\u0074ime":${t}}`), "escaped key");
  assert.ok(!created(`{"time":${t}.5}`));
  assert.ok(!created(`{"time":"${t}"}`));
  assert.ok(!created(`{"time":-${t}}`));
  assert.ok(!created(`{"time":${t}} trailing`));
  assert.ok(!created("hello"), "not JSON");
});

test("a changed post keeps its time; media, indexes and deletions are left alone", () => {
  const key = `user/${ALICE}/post/1`;
  const was = post({ time: NOW - WINDOW * 5 });
  assert.ok(accepts([{ key, oldValue: was, newValue: post({ time: NOW - WINDOW * 5, title: "edited" }) }]));
  assert.ok(!accepts([{ key, oldValue: was, newValue: post({ time: NOW - 1000, title: "edited" }) }]));
  assert.ok(accepts([{ key, oldValue: was }]));
  assert.ok(accepts([{ key: `user/${ALICE}/post/1/media/0`, newValue: "bafy" }]));
  assert.ok(accepts([{ key: `index/post/1/${ALICE}`, newValue: "1" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/profile`, newValue: "{}" }]));
});

test("a post with no id is refused, time or not", () => {
  assert.ok(!accepts([{ key: `user/${ALICE}/post/`, newValue: post() }]));
  assert.ok(!accepts([{ key: `user/${ALICE}/post/`, newValue: post({ time: 9007199254740991 }) }]));
});

// `migrated-from`: CI runs this file twice, with the module built from an
// empty `policy/migrated-from` and from one holding a value.
const migrate = (change, signers) => accepts([{ key: "migrated-from", ...change }], signers);

test("migrated-from holds the built-in value, written once by anyone, never changed or deleted", { skip: !MIGRATED_FROM }, () => {
  assert.ok(migrate({ newValue: MIGRATED_FROM }));
  assert.ok(migrate({ newValue: MIGRATED_FROM }, [BOB]), "any signer");
  assert.ok(accepts([{ key: "migrated-from", newValue: MIGRATED_FROM }, { key: `user/${ALICE}/profile`, newValue: "{}" }]));
  assert.ok(!migrate({ newValue: `${MIGRATED_FROM} ` }), "not quite the value");
  assert.ok(!migrate({ newValue: MIGRATED_FROM.slice(0, -1) }));
  assert.ok(!migrate({ newValue: "" }));
  assert.ok(!migrate({}), "no value at all");
  assert.ok(!migrate({ oldValue: MIGRATED_FROM, newValue: MIGRATED_FROM }), "rewritten");
  assert.ok(!migrate({ oldValue: MIGRATED_FROM, newValue: "elsewhere" }), "changed");
  assert.ok(!migrate({ oldValue: MIGRATED_FROM }), "deleted");
  // One bad action rejects the whole transaction.
  assert.ok(!accepts([{ key: "migrated-from", newValue: MIGRATED_FROM }, { key: `user/${BOB}/x`, newValue: "x" }]));
});

test("a chain that carries on from none refuses migrated-from", { skip: !!MIGRATED_FROM }, () => {
  for (const change of [{ newValue: "" }, { newValue: "Nexus/testnet/turnup-b3494e@1" }, { oldValue: "" }, {}]) {
    assert.ok(!migrate(change), JSON.stringify(change));
  }
});

test("only the exact key is special", () => {
  for (const key of ["migrated-from/", "migrated-from/x", "migrated-fro", "Migrated-from", "x/migrated-from"]) {
    assert.ok(!accepts([{ key, newValue: MIGRATED_FROM || "x" }]), key);
  }
});
