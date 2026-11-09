// <moniker-handle-picker> for any page: a dialog in which the connected
// account picks the @handle it shows in every app, from its names on
// Moniker, or claims a free one, without leaving your app. Register it once
// with a Moniker from createMoniker:
//
//   defineHandlePicker(moniker);
//   <moniker-handle-picker></moniker-handle-picker>
//   const handle = await picker.open();   // from a click; "ada" once shown, or undefined
//
// A free name is claimed, pointed at the account and shown, in one
// transaction; a name the account owns, or one pointed at it, is shown. The
// person approves either in their wallet (Selfhold). The dialog closes once
// the wallet has sent it, firing `moniker:sent` ({ account, handle }); a
// block later Moniker shows it, and `open()` resolves to the handle, firing
// `moniker:shown` ({ account, handle }). Closed before sending, it resolves
// to undefined. Writes go only from the account the dialog listed names for.
// Style it from outside with --moniker-ink, --moniker-muted,
// --moniker-accent, --moniker-accent-ink, --moniker-line, --moniker-surface
// and --moniker-bad.

import { isHandle } from "./records/shared.mjs";

const WALLET_URL = "https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce";
// How long to wait for Moniker to show a name sent, and how often to look.
const LANDS_WITHIN = 15 * 60_000;
const LOOK_EVERY = 3000;

const style = `
  :host { display: contents; }
  dialog { box-sizing: border-box; width: min(420px, calc(100vw - 32px)); padding: 20px; border-radius: 16px; font: inherit;
    border: 1px solid var(--moniker-line, #c9ccd4); background: var(--moniker-surface, Canvas); color: var(--moniker-ink, CanvasText); }
  dialog::backdrop { background: rgb(0 0 0 / 0.4); }
  form { display: flex; flex-direction: column; gap: 14px; margin: 0; }
  h2 { margin: 0; font-size: 1.2em; }
  p { margin: 0; }
  .muted { color: var(--moniker-muted, #5f6470); font-size: 0.9em; }
  fieldset { border: 0; padding: 0; margin: 0; }
  legend { font-weight: 600; font-size: 0.9em; padding: 0; margin-bottom: 4px; }
  .option { display: flex; gap: 8px; align-items: center; min-height: 40px; }
  label.field { display: flex; flex-direction: column; gap: 6px; font-size: 0.9em; font-weight: 600; }
  input[type=text] { box-sizing: border-box; min-height: 44px; padding: 0 12px; border-radius: 8px; font: inherit; font-weight: 400;
    border: 1px solid var(--moniker-line, #c9ccd4); background: transparent; color: inherit; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--moniker-accent, #1f3fbf); outline-offset: 2px; }
  .status { font-size: 0.9em; min-height: 1.35em; }
  .status.bad { color: var(--moniker-bad, #b3261e); }
  .status:empty { min-height: 0; }
  .buttons { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  button { min-height: 44px; padding: 0 18px; border-radius: 999px; font: inherit; font-weight: 700; cursor: pointer;
    border: 1px solid transparent; background: var(--moniker-accent, #1f3fbf); color: var(--moniker-accent-ink, #fff); }
  button.quiet { background: transparent; color: inherit; border-color: var(--moniker-line, #c9ccd4); }
  button:disabled { opacity: 0.6; cursor: default; }
  dialog[data-busy] { cursor: progress; }
  a { color: inherit; }
`;

/** `promise`, or a rejection after `ms`: a read that hangs doesn't hold the dialog forever. */
const within = (ms, promise) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("The node didn't answer in time. Try again.")), ms))]);

/** What went wrong, for a person. */
export function problem(error) {
  const text = String(error?.message ?? error);
  if (/just declined|ask again in a moment/i.test(text)) return "Selfhold waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied|cancel/i.test(text)) return "You declined it in Selfhold. Nothing was sent.";
  if (/locked/i.test(text)) return "Unlock Selfhold, then try again.";
  return text;
}

/**
 * The handle the person asked for: what they typed, else the name checked,
 * as `{ handle }`, or `{ error }` to say.
 */
export function chosenHandle(typed, checked) {
  const handle = String(typed ?? "").trim().replace(/^@/, "").toLowerCase() || checked;
  if (!handle) return { error: "Pick one of your names, or type a free one." };
  if (!isHandle(handle)) return { error: "A handle is lowercase letters, digits and _." };
  return { handle };
}

/**
 * What showing `handle` for `account` takes, given its Moniker entry
 * (`name()`), and the handle the account shows now: `"shown"` (nothing to
 * send), `"claim"` (free: claim, point and show it), `"show"` (owned by or
 * pointed at the account), or `{ refused }`, why not.
 */
export function stepFor(entry, account, handle, shownNow) {
  if (!entry) return "claim";
  if (entry.owner === account || entry.pointer === account) return shownNow === handle && entry.pointer === account ? "shown" : "show";
  if (entry.offer === account) return { refused: `@${handle} is offered to you: take it on Moniker first, then show it here.` };
  if (entry.price !== undefined) return { refused: `@${handle} is someone else's. It's for sale on Moniker for ${entry.price}.` };
  return { refused: `@${handle} is someone else's.` };
}

export function defineHandlePicker(moniker, { tag = "moniker-handle-picker", wallet = () => globalThis.lattice, app, walletURL = WALLET_URL } = {}) {
  if (customElements.get(tag)) return;
  const pageOf = (handle) => (app ? `${app}#/${encodeURIComponent(`@${handle}`)}` : moniker.pageURL(`@${handle}`));

  customElements.define(
    tag,
    class extends HTMLElement {
      #dialog;
      #names;
      #typed;
      #status;
      #cancel;
      #send;
      #account = null; // the account the names were listed for
      #asking = false; // the wallet has been asked, and not answered
      #opened = 0; // one per open(): a later one ends what an earlier one waits for
      #done = null; // resolves the open() under way

      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = `
          <style>${style}</style>
          <dialog aria-labelledby="title">
            <form>
              <h2 id="title">Use a handle</h2>
              <p class="muted">A handle is a name you own on Moniker, the names chain Lattice apps share. Once shown, it appears beside your name in every app.</p>
              <div class="names"></div>
              <label class="field">Or claim a free one<input type="text" name="typed" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="yourname"></label>
              <p class="status" role="status"></p>
              <div class="buttons">
                <button type="button" class="quiet" data-close>Cancel</button>
                <button type="submit">Use handle</button>
              </div>
            </form>
          </dialog>`;
        this.#dialog = root.querySelector("dialog");
        this.#names = root.querySelector(".names");
        this.#typed = root.querySelector("input[name=typed]");
        this.#status = root.querySelector(".status");
        this.#cancel = root.querySelector("[data-close]");
        this.#send = root.querySelector("button[type=submit]");
        // Enter in a field sends, as Use handle does.
        root.querySelector("form").addEventListener("submit", (event) => {
          event.preventDefault();
          this.#press();
        });
        this.#cancel.addEventListener("click", () => this.#dialog.close());
        // While the wallet is asked, Escape doesn't close: its answer is still to come.
        this.#dialog.addEventListener("cancel", (event) => this.#asking && event.preventDefault());
        this.#dialog.addEventListener("close", () => {
          // Closed before anything was sent: nothing to wait for.
          if (this.#done) this.#finish(undefined);
        });
      }

      /**
       * Opens the dialog for the account connected in the wallet; call it
       * from a click, as a wallet connects only then. Resolves to the handle
       * once Moniker shows it, or undefined when closed first.
       */
      open() {
        if (this.#dialog.open) return this.#waiting;
        const ticket = ++this.#opened;
        this.#waiting = new Promise((resolve) => (this.#done = resolve));
        this.#typed.value = "";
        this.#say("");
        this.#lock(false);
        this.#names.replaceChildren(this.#note("Looking up your names…"));
        this.#dialog.showModal();
        this.#list(ticket);
        return this.#waiting;
      }
      #waiting = Promise.resolve(undefined);

      #finish(handle) {
        const done = this.#done;
        this.#done = null;
        done?.(handle);
      }
      #note(text) {
        return Object.assign(document.createElement("p"), { className: "muted", textContent: text });
      }
      #say(text, { bad = false } = {}) {
        this.#status.textContent = text;
        this.#status.classList.toggle("bad", bad);
      }
      /** Fields lock while it works; Cancel stays open until the wallet is asked. */
      #lock(on, { asking = false } = {}) {
        this.#asking = on && asking;
        this.#dialog.toggleAttribute("data-busy", this.#asking);
        for (const field of this.#dialog.querySelectorAll("input, button:not([data-close])")) field.disabled = on;
        this.#cancel.disabled = this.#asking;
      }

      /** The wallet's account now, connecting first if it hasn't this site; null when it can't be read. */
      async #accountNow({ connect = false } = {}) {
        const w = wallet();
        const address = await w?.address?.().catch(() => null);
        if (address || !connect) return address ?? null;
        return (await w?.connect?.().catch(() => null)) ?? null;
      }

      /** Lists the connected account's names, as radios, the one it shows now checked. */
      async #list(ticket) {
        const w = wallet();
        if (!w?.writeRecords) {
          this.#names.replaceChildren();
          const help = this.#note("");
          help.append("Using a handle needs Selfhold, a free browser extension. ");
          help.append(Object.assign(document.createElement("a"), { href: walletURL, target: "_blank", rel: "noopener", textContent: "Get Selfhold" }));
          help.append(", then reload this page.");
          this.#names.append(help);
          this.#lock(true);
          return;
        }
        const account = await this.#accountNow({ connect: true });
        if (ticket !== this.#opened || !this.#dialog.open) return;
        if (!account) {
          this.#names.replaceChildren();
          this.#say("Couldn't read Selfhold's account. Check Selfhold, then try again.", { bad: true });
          this.#lock(true);
          return;
        }
        this.#account = account;
        let names = [];
        let shownNow;
        let read = true;
        try {
          [names, shownNow] = await within(15_000, Promise.all([moniker.names(account), moniker.handleOf(account)]));
        } catch {
          // Not listed: a name can still be typed, and is checked when sent.
          read = false;
        }
        if (ticket !== this.#opened || !this.#dialog.open) return;
        if (names.length === 0) {
          this.#names.replaceChildren(this.#note(read
            ? "You have no names on Moniker yet. Claim a free one below."
            : "Couldn't list your names on Moniker. Type one of yours, or a free one, below."));
          this.#typed.focus();
          return;
        }
        const set = document.createElement("fieldset");
        set.append(Object.assign(document.createElement("legend"), { textContent: "Your names on Moniker" }));
        const checked = names.some((n) => n.handle === shownNow) ? shownNow : names[0].handle;
        for (const { handle } of names) {
          const option = Object.assign(document.createElement("label"), { className: "option" });
          const radio = Object.assign(document.createElement("input"), { type: "radio", name: "handle", value: handle, checked: handle === checked });
          option.append(radio, ` @${handle}${handle === shownNow ? " (shown now)" : ""}`);
          set.append(option);
        }
        this.#names.replaceChildren(set);
        this.#names.querySelector("input:checked")?.focus();
      }

      async #press() {
        if (!this.#dialog.open || this.#send.disabled) return;
        const ticket = this.#opened;
        const asked = chosenHandle(this.#typed.value, this.#names.querySelector("input[name=handle]:checked")?.value);
        if (asked.error) return this.#say(asked.error, { bad: true });
        const { handle } = asked;
        this.#say("");
        this.#lock(true);
        try {
          // Only from the account the names were listed for.
          const account = await this.#accountNow();
          if (ticket !== this.#opened) return;
          if (!account) throw new Error("Couldn't read Selfhold's account. Check Selfhold, then try again.");
          if (account !== this.#account) {
            this.#lock(false);
            this.#names.replaceChildren(this.#note("Looking up your names…"));
            this.#list(ticket);
            return this.#say("Selfhold is connected to another account now: its names are listed. Check, then try again.", { bad: true });
          }
          await within(15_000, moniker.state({ fresh: true }));
          const [entry, shownNow] = await within(15_000, Promise.all([moniker.name(handle), moniker.handleOf(account)]));
          if (ticket !== this.#opened || !this.#dialog.open) return;
          const step = stepFor(entry, account, handle, shownNow);
          if (step.refused) {
            this.#lock(false);
            this.#say(step.refused, { bad: true });
            if (entry) {
              this.#status.append(" ", Object.assign(document.createElement("a"), { href: pageOf(handle), target: "_blank", rel: "noopener", textContent: `See @${handle} on Moniker` }));
            }
            return;
          }
          if (step === "shown") {
            // Already so: nothing to ask the wallet.
            this.#shown(account, handle);
            return;
          }
          this.#lock(true, { asking: true });
          this.#say(step === "claim" ? "Approve it in Selfhold: Moniker gives you the name and shows it." : "Approve it in Selfhold: Moniker shows the name for you.");
          const w = wallet();
          // The wallet's account again, just before it is asked.
          if ((await this.#accountNow()) !== account) throw new Error("Selfhold is connected to another account now. Nothing was sent. Check, then try again.");
          await (step === "claim" ? moniker.claim(handle, { show: true }, { wallet: w }) : moniker.showName(handle, { wallet: w }));
          this.#lock(false);
          this.#sent(ticket, account, handle);
        } catch (error) {
          if (ticket !== this.#opened) return;
          this.#lock(false);
          this.#say(problem(error), { bad: true });
        }
      }

      /** Sent: the dialog closes, and Moniker is watched until it shows the name. */
      async #sent(ticket, account, handle) {
        const done = this.#done;
        this.#done = null; // closing now isn't closing before sending
        this.#dialog.close();
        this.dispatchEvent(new CustomEvent("moniker:sent", { bubbles: true, composed: true, detail: { account, handle } }));
        const started = Date.now();
        while (Date.now() - started < LANDS_WITHIN) {
          await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY));
          // A later open() asks again: this one stops watching.
          if (ticket !== this.#opened) return done?.(undefined);
          await moniker.state({ fresh: true }).catch(() => {});
          if ((await moniker.handleOf(account).catch(() => undefined)) === handle) {
            this.dispatchEvent(new CustomEvent("moniker:shown", { bubbles: true, composed: true, detail: { account, handle } }));
            return done?.(handle);
          }
        }
        done?.(undefined);
      }

      #shown(account, handle) {
        const done = this.#done;
        this.#done = null;
        this.#lock(false);
        this.#dialog.close();
        this.dispatchEvent(new CustomEvent("moniker:shown", { bubbles: true, composed: true, detail: { account, handle } }));
        done?.(handle);
      }
    },
  );
}
