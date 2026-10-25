# Electron 42 migration recon (2026-10-25)

> **Outcome 2026-10-25: NOT adopted** — see ADR-033 in the hydra line's
> `.fork/decisions.md`. The maintainer declined ownership of the major-bump
> maintenance for now and chose to stay on Electron 41 with an elevated
> watch on the eMudhra/emSign CA-compromise exposure (first fixed Electron:
> 42.11.16; this branch's pin, 42.11.18, targets a fixed runtime). This
> branch is preserved as the pre-validated migration map; start here if any
> watch trigger fires.

Recon branch `recon/electron-42`, cut from `0352d809` (hydra/patch/3.16.2 tip).
Not for merge as-is — this is a probe: it bumps the pins, runs the gates, and
records what breaks. Real migration follows this map.

## The change (this branch)

- `packages/desktop/package.json`: `electron 41.0.3 → 42.11.18` (latest 42.x,
  dist-tag `42-x-y`; 42.0.0 released 2026-05-07).
- `packages/desktop/electron-builder.config.js`: `electronVersion` bumped in
  lockstep (must always move with the pin — builder can't infer it under pnpm).
- `pnpm-lock.yaml`: peer-suffix/hash updates only. Total diff: 3 files.

## Verified green on this machine (Linux/glibc, node 24.14 via mise)

- `pnpm install` (49.6s). Electron 42 npm package ships **no lifecycle scripts
  at all** (`scripts: {}`): the postinstall binary download is gone. Nothing
  populates `node_modules/electron/dist/` or `path.txt` anymore.
- `node-pty` postinstall `electron-rebuild` **succeeds** against 42 headers
  → `node_modules/node-pty/build/Release/pty.node`. Native ABI unchanged:
  42 bundles Node 24.19.0 (41 had 24.14.0 — same major, N-API intact,
  `ELECTRON_RUN_AS_NODE` agent bundle unaffected).
- Binary smoke: `electron --version` → v42.11.18 (after manual install step,
  see below). `ELECTRON_RUN_AS_NODE=1 electron -e …` works.
- `pnpm typecheck`: clean across all desktop tsconfigs (no removed-API usage).
  Typings diff 41→42: zero removed top-level exported names; 42.0 removals
  (`session.clearStorageData` `quotas`, `ELECTRON_SKIP_BINARY_DOWNLOAD`,
  offscreen deviceScaleFactor default → 1.0, macOS UNNotification) do not
  touch code paths here (we pass only `storages`; offscreen is fixtures-only;
  no `ELECTRON_SKIP_BINARY_DOWNLOAD` in runtime code — it appears only in the
  e2e helper's error message text and vendored docs).
- `pnpm lint` (oxlint): 0 errors.
- Targeted vitest (29/29 pass): about, devElectronAppBundle, e2eElectronBinary,
  bundleMirrorFallback, node-pty-package-assets, desktop-native-package-policy,
  desktopTrayMenuIdempotence (N18). The "41.0.3" strings in about.test.ts are
  inputs derived from package.json, not hardcoded expectations — they followed
  the bump. Note: `pluginSandbox/clearOrder.test.ts` is outside the root
  vitest include (`test/**`) and did not run here (unchanged behavior).

## Key mechanism finding: `install.js` still ships and still works

Electron 42 removed the *postinstall wiring*, not the installer script.
`node node_modules/electron/install.js` with `ELECTRON_MIRROR` set downloads
the binary and writes `dist/` + `path.txt` (verified from npmmirror).

Consequences:

- `test/e2e/helpers/e2e-electron-binary.ts` fallback (runs install.js when the
  binary is missing) **survives** — its `install.js` precondition still holds.
  But it is now the *only* population path in E2E.
- `scripts/dev.mjs` resolves `node_modules/electron/dist/electron` and falls
  back to bare `electron` on PATH when dist/ is missing. On a fresh 42 install
  that fallback silently targets an arbitrary system binary. Should become a
  hard error (or trigger install.js) in the real migration.

## Breakage inventory / migration checklist

1. **Install flow (the real work).** bootstrap, CI, and the zcode-hydra
   PKGBUILD must add an explicit `node node_modules/electron/install.js`
   (or the blessed on-demand fetch) after `pnpm install`. Without it: no
   `dist/`, dev/e2e/packaging all fail or misbehave.
2. **dev.mjs PATH fallback hazard** — see above; make it fail loudly.
3. **THIRD-PARTY-NOTICES.md** still lists electron@41.0.3; regeneration via
   `node scripts/licenses.mjs notices` **fails on this machine for
   pre-existing reasons** (stale `@napi-rs/canvas-linux-x64-musl@0.1.100`
   override — musl optionals never install on glibc; reproduced identically on
   the pristine 41 tree with the pins stashed). Needs a CI/musl-capable env.
   Not caused by this bump.
4. **wdio-electron-service@9.2.1** (pnpm-patched CDP bridge) — untested at
   runtime here; confirm its supported-Electron matrix covers 42 / Chromium
   148 before trusting `pnpm test:e2e:serial`.
5. **@arms/rum-electron@0.0.3** (pnpm-patched) parses Crashpad minidumps for
   `process_type` — revalidate crash metrics on 42 (Chromium 146 → 148).
6. **playwright-core pinned 1.59.1** (runtime dep): `_electron.launch`
   (auto-update smoke) and browserView injected-script source resolution may
   need a coordinated bump for Chromium 148.
7. **KDE tray re-verification** — U66/N18 was proven against 41.0.3 + KDE
   (decisions.md:715-747); the DBusMenu staleness class (electron#21499) may
   differ on 42. Re-run the tray matrix on the hydra line.
8. **electron-builder bundle run untested** (pacman/AppImage/deb/rpm); also
   re-audit the rpm glibc-floor comment — it cites Electron 41's ELF needs
   (electron-builder.config.js ~:896).
9. **Upstream divergence.** zai-org/ZCode still pins 41.0.3 (checked via
   GitHub API 2026-10-25). A fork-local bump is divergence on
   `packages/desktop/package.json` (already U15-patched) until upstream moves;
   every vendor pull carries merge friction + re-validation.
10. 41.x point releases exist up to 41.10.7 — only relevant if the CA-store
    fix were ever backported; per the threat model it is 42+ only.

## Not exercised here (needs real runs before any merge)

App boot (`pnpm dev:desktop`), wdio E2E suite, packaging bundle, auto-update
smokes, ARMS crash pipeline, KDE tray behavior.
