// RETIRED — do not wire this file into the build.
//
// The canonical Electron entry point is `electron-app/main.js`. The root
// package.json `main`, `electron:dev`, and `build:electron` all point there.
// This stub previously ran the server in-process without the security/tree-kill
// wiring that electron-app/main.js provides; it is kept only so stale references
// fail loudly instead of silently launching an unsafe path.

throw new Error(
  "electron/main.ts is retired. Use electron-app/main.js (root: pnpm electron:dev / pnpm build:electron)."
);

export {};
