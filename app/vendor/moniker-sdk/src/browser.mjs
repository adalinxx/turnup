// Moniker in a browser page, with the Lattice SDK included:
//
//   import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.3.0/src/browser.mjs";
//   const moniker = createMoniker();          // or createMoniker({ nodes, chain })
//   defineMonikerName(moniker);               // then <moniker-name address="…">
//   defineHandlePicker(moniker);              // then <moniker-handle-picker>, and picker.open() from a click
//   defineMonikerPhoto(moniker);              // then <moniker-photo address="…" size="40">
//
// Photos are kept with this device's work, on its graphics chip where the
// page can use one, else its processor (vendor/work/).
import * as sdk from "../vendor/lattice-sdk.js";
import { hasher } from "../vendor/work/hash.mjs";
import { createMoniker as monikerOver } from "./index.mjs";

export * from "./index.mjs";
export { defineMonikerName, defineMonikerPhoto } from "./element.mjs";
export { defineHandlePicker } from "./picker.mjs";
export { workDevice } from "../vendor/work/hash.mjs";
export const createMoniker = (options = {}) => monikerOver({ sdk, hash: hasher, ...options });
