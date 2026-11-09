// Apps keep no key: every write goes to the person's Lattice wallet
// through `window.lattice.writeRecords`, which shows it, picks the nonce,
// signs with the connected account and sends it. The fee is the wallet's:
// the person sets it there, per chain, unless a request proposes one. The
// wallet debits that account for the payments plus the fee and credits each
// payee, the same body `transaction` below builds.

/**
 * The wallet request for `actions` on `chainPath`, paying `payments`
 * (`{ to, amount }`, as names.mjs `buy` returns them) from the connected
 * account. The wallet takes each payee once, so payments to one payee are
 * added together. Without `fee` the wallet uses the person's own; a `fee`
 * given is proposed, and the wallet shows it for approval.
 */
export function writeRequest(chainPath, { actions, payments = [] }, fee) {
  if (actions.length === 0) throw new Error("Nothing to write");
  const credits = new Map();
  for (const { to, amount } of payments) credits.set(to, (credits.get(to) ?? 0n) + amount);
  return {
    chainPath: [...chainPath],
    actions,
    ...(credits.size > 0 && { payments: [...credits].map(([to, amount]) => ({ to, amount: String(amount) })) }),
    ...(fee !== undefined && { fee: String(fee) }),
  };
}

/**
 * The write as a lattice://write request, for any wallet to sign as the
 * account the person chooses there: `{account}` in a key or new value stands
 * for it, and an action with `ifAbsent` is written only if its key holds
 * nothing. `fee` is proposed, as for `send`; without one the wallet uses its
 * own. The wallet picks the nonce. Hand it to the wallet in this
 * browser with `lattice.openRequest(uri)`, or show it as text or a QR code.
 */
export function writeRequestURI(chainPath, write, { fee, label, expiresAt = new Date(Date.now() + 15 * 60_000) } = {}) {
  const intent = { version: 1, ...writeRequest(chainPath, write, fee), expiresAt: expiresAt.toISOString(), ...(label && { label }) };
  const bytes = new TextEncoder().encode(JSON.stringify(intent));
  const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  return `lattice://write?v=1&intent=${base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

/** Asks the wallet to approve, sign and send the write. Resolves to `{ transactionCID }`. */
export const send = (lattice, chainPath, write, fee) => lattice.writeRecords(writeRequest(chainPath, write, fee));

/**
 * The same write as a transaction body signed for by `owner`, who pays the
 * fee and each payment: for scripts and tests that hold a key themselves.
 */
export function transaction({ owner, actions, payments = [], fee, nonce, chainPath }) {
  const credits = new Map();
  for (const { to, amount } of payments) credits.set(to, (credits.get(to) ?? 0n) + amount);
  const debit = fee + [...credits.values()].reduce((sum, amount) => sum + amount, 0n);
  return {
    accountActions: [
      ...(debit > 0n ? [{ owner, delta: -debit }] : []),
      ...[...credits].map(([to, amount]) => ({ owner: to, delta: amount })),
    ],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}
