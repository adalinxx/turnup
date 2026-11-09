# Turnup

A lost and found that no company runs. Post what you lost or found, see
what turned up nearby, and talk privately to get it back. Nobody needs
coins, an email address or a password.

Turnup keeps its data on Lattice chains and has no server of its own. The
page reads every record from a node and checks it against the chain's own
hashes. Each person's key sits behind a passkey in their
[Selfhold](https://wallet.selfhold.app) wallet, which signs every change.
The fee is paid with a few seconds of the device's work, through a fee
sponsor.

## Using it

- **Nearby**: a map, with what was lost (amber) and found (green) in view.
  Filter by lost or found and by kind of thing.
- **I lost something / I found something**: kind of thing, a few words, a
  pin on the map (shown only to about 100 m), when, a description, and up to
  three photos. A finder can ask the owner a question only the owner could
  answer, and say where the thing is now. An owner can offer a reward. The
  form keeps a draft while you write.
- **A post**: anyone can press "Is this yours?" (on a find) or "Have you
  found this?" (on a loss) and send a private message. On your own post you
  see **possible matches**, worked out on your device from nearby posts of
  the other kind, with the reasons ("Same kind of thing", "120 m away",
  "Found a day later"). You can also mark it returned, reopen, edit or
  delete it.
- **Messages**: one thread per post and person. Messages are sealed so only
  the two of you can read them, and you can share where you are. A finder
  closes the post from the thread once the thing is handed over.
- **Tags**: make a QR tag for your keys, bag or laptop and print a sheet of
  them. Whoever scans it sees its name and your note, never your account,
  and can message you. You can mark a tag missing.

You sign in the first time you post or send something. One passkey prompt
makes a Selfhold account and opens your messages on that device. After
that, each change is one approval in Selfhold's window. It shows at once,
and lands in a block or two.

## How it is kept

- **Chains**: a root chain holds inbox keys, messages, tags, and posts from
  places that have no area chain. An **area chain** is a child of the root
  named by a geohash prefix of 2–4 characters (`dr5` is about 150 km around
  New York). Posts inside an area go on its chain, which people nearby can
  host. The page finds areas from the root's committed children and uses one
  only if it runs the root's exact spec (same policy, same rules).
- **Records** follow one ownership policy (the one Stoa and Rave use):
  every key is `user/<account>/…` or `index/…/<account>`, and the account
  must sign. `client/records.mjs` has the layout:
  - `user/<a>/post/<id>`: an item, tag or message.
  - `user/<a>/post/<id>/media/<n>`: an item's photos.
  - `user/<a>/box`: the account's inbox public key.
  - `index/geo/<g1>/…/<g6>/<id>/<a>`: where an open item is.
  - `index/inbox/<b>/<mid>/<a>`: a message for `b`.
- **Private messages** (`client/seal.mjs`): the inbox key is X25519, made
  from the wallet's deterministic signature over a fixed text, so the same
  passkey opens the same inbox on any device. A message's content key is
  wrapped for both sender and recipient (X25519, HKDF-SHA-256, AES-GCM).
  Anyone can see who wrote to whom and when, but not what.
- **Photos** are re-encoded on the device (which drops their location
  metadata), cropped square, and kept by the storage sponsor in exchange
  for the device's work.

## Running it

The page is static. Serve the repository root and open `/app/`:

```sh
python3 -m http.server 8765   # then open http://127.0.0.1:8765/app/
```

It reads the test network by default. A link may carry `?node=` (comma
separated), `?chain=`, `?sponsor=` and `?wallet=` for that visit.

## Tests

```sh
npm test                       # records, policy, sealing, matching
cd e2e/ui && npm install && \
  LATTICE=<lattice-node>/.build/debug/lattice \
  LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor \
  LATTICE_WALLET_WEB=<selfhold>/dist-web npm test
```

The UI tests start a private stack (`e2e/stack.mjs`): a node mining the root
and a `dr5` area chain, a fee sponsor, and Selfhold's window. They then act
as each person in their own browser with their own passkey: a visitor, a
finder, an owner, someone snooping on a thread, and a tag's finder. Nobody
in them holds coins.

## Licence

MIT. Vendored code keeps its own licence: Leaflet (BSD-2), noble curves
(MIT), qrcode-generator (MIT), the Lattice SDK, Selfhold's client and
moniker-sdk, and Schibsted Grotesk (OFL).
