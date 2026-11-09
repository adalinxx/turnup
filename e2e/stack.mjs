// A private Turnup stack: one Lattice host mining Nexus, Turnup's root chain
// and one area chain under it (dr5, around New York), both from a fast test
// spec with Turnup's policy; public reads and submits at a fee of 1, as the
// testnet hosts take; a fee sponsor (lattice-sponsor) that pays that fee and
// keeps photos for work; Selfhold's window on localhost; and this repository
// served as GitHub Pages serves it, so the real app runs against all of it.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
//   LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor   (default: beside lattice)
//   LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web
//
// Run alone, it stays up and prints where everything is:
//   node e2e/stack.mjs
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = ["Nexus", "turnup"];
export const AREA = "dr5";
export const AREA_CHAIN = [...ROOT, AREA];
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../");
export const ports = { listen: 31001, rpc: 31080, publicRead: 31081, web: 31090, sponsor: 31091, wallet: 31092 };

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".md": "text/plain", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json" };

/** Serves `root`, the repository's by default, as GitHub Pages does. */
export function serve(port, root = repo) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(join(root, "/")) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

export async function until(label, condition, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await condition().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function start() {
  const sdk = await import(here("../app/vendor/lattice-sdk.js"));
  if (!process.env.LATTICE) throw new Error("LATTICE: the lattice command, built from lattice-node");
  const root = mkdtempSync(`${tmpdir()}/turnup-e2e-`);
  const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
  const configure = (edit) => {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    edit(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  };
  const minerKey = sdk.generatePrivateKey();
  const miner = sdk.accountFromPrivateKey(minerKey);
  lattice("init");
  configure((t) => {
    Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true });
    // As the testnet hosts: a fee of at least 1, which an account with no coins pays in work through the sponsor.
    t.minRelayFee = 1;
    // Reads are many (one per trie node): no rate ceilings in the way.
    t.publicReadExpensiveRate = 10000;
    t.publicReadRate = 10000;
    t.publicReadMaxRate = 100000;
    t.peers = [];
    t.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("up");
  // Turnup's spec with 2-second blocks: the policy's time window follows it.
  const spec = { ...JSON.parse(readFileSync(here("../chain/spec.json"), "utf8")), targetBlockTime: 2000, premine: 0 };
  writeFileSync(`${root}/turnup-test-spec.json`, JSON.stringify(spec));
  for (const chain of [ROOT, AREA_CHAIN]) lattice("child", "create", chain.join("/"), "--spec", `${root}/turnup-test-spec.json`, "--policy-module", here("../chain/policy.wasm"));
  configure((t) => {
    t.mine.recipients = Object.fromEntries([ROOT, AREA_CHAIN].map((chain) => [chain.join("/"), miner.address]));
  });
  lattice("mine", "start");
  const node = `http://127.0.0.1:${ports.publicRead}`;
  const balance = async (chain, address = miner.address) => {
    const r = await fetch(`${node}/api/state/account/${address}?chainPath=${chain.join("/")}`);
    return r.ok ? BigInt((await r.json()).balance ?? 0) : 0n;
  };
  await until("the root and the area chain fund the miner", async () => (await balance(ROOT)) > 1000n && (await balance(AREA_CHAIN)) > 1000n, 600);
  const web = await serve(ports.web);
  const walletWeb = process.env.LATTICE_WALLET_WEB && resolvePath(process.env.LATTICE_WALLET_WEB);
  const wallet = walletWeb ? await serve(ports.wallet, walletWeb) : null;

  // The sponsor pays a fee of 1 on both chains for small shares of work, and
  // keeps photos for work on the root. Its account is funded on each.
  const sponsorKey = `${root}/sponsor-key.json`;
  execFileSync(process.env.LATTICE, ["key", "generate", "--out", sponsorKey]);
  const sponsorAddress = JSON.parse(readFileSync(sponsorKey, "utf8")).address;
  for (const chain of [ROOT, AREA_CHAIN]) await transfer(sdk, node, miner, minerKey, sponsorAddress, 500n, chain);
  const log = openSync(`${root}/sponsor.log`, "a");
  const sponsor = spawn(process.env.LATTICE_SPONSOR || join(dirname(process.env.LATTICE), "lattice-sponsor"), [
    "--node", `http://127.0.0.1:${ports.rpc}`, "--cookie-file", `${root}/chains/Nexus/.cookie`, "--key", sponsorKey,
    "--share-work", "2^12", "--fee", "1", "--port", String(ports.sponsor),
    "--sell-storage", "--storage-rate", `${ROOT.join("/")}=1000000`, "--storage-file", `${root}/sponsor-storage.json`,
  ], { stdio: ["ignore", log, log] });
  const sponsorURL = `http://127.0.0.1:${ports.sponsor}`;
  await until("the sponsor prices both chains", async () => {
    for (const chain of [ROOT, AREA_CHAIN]) {
      const r = await fetch(`${sponsorURL}/work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain: chain.join("/") }) });
      if (!r.ok) return false;
    }
    return true;
  }, 180);

  const info = {
    root, node, rpc: `http://127.0.0.1:${ports.rpc}`, app: `http://127.0.0.1:${ports.web}/app/`,
    chain: ROOT.join("/"), area: AREA, minerKey: Buffer.from(minerKey).toString("hex"), miner: miner.address,
    sponsor: sponsorURL, sponsorAddress, walletPage: `http://localhost:${ports.wallet}/`,
  };
  return {
    info,
    lattice,
    stop: async () => {
      sponsor.kill();
      wallet?.close();
      web.close();
      try { lattice("mine", "stop"); } catch {}
      try { lattice("down"); } catch {}
    },
  };
}

/** The miner sends `amount` to `to` on `chain`, and it lands. */
async function transfer(sdk, node, miner, minerKey, to, amount, chain) {
  const read = async (address) => {
    const r = await fetch(`${node}/api/state/account/${address}?chainPath=${chain.join("/")}`);
    return r.ok ? r.json() : {};
  };
  const nonce = BigInt((await read(miner.address)).nonce ?? 0);
  const body = sdk.buildTransfer({ from: miner.address, to, amount, fee: 1n, nonce, chainPath: chain });
  const { publicKey, signature } = sdk.signTransactionBody(body, minerKey);
  const r = await fetch(`${node}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)) });
  if (!r.ok) throw new Error(`fund the sponsor: ${r.status} ${await r.text()}`);
  await until(`the sponsor's funds on ${chain.join("/")}`, async () => BigInt((await read(to)).balance ?? 0) >= amount);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stack = await start();
  const { info } = stack;
  const keep = `${info.root}/keep.json`;
  writeFileSync(keep, JSON.stringify(info, null, 2));
  const params = new URLSearchParams({ node: info.node, chain: info.chain, sponsor: info.sponsor, wallet: info.walletPage });
  console.log(`Turnup stack up. Open ${info.app}?${params}\nKEEP ${keep}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => (await stack.stop(), process.exit(130)));
}
