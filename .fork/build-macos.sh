#!/usr/bin/env bash
# build-macos.sh — ZCodeR release build for macOS (fork 4.0.0 line, ADR-041).
#
# Builds the packaged desktop app from a checkout of the fork repo on a Mac.
# Sibling of build-windows.ps1 / the Linux PKGBUILD (~/sysadmin/aur/zcoder/):
# all three bake the same production identity + force-update kill switch
# (ADR-024) so pacman/homebrew/manual installs behave identically.
#
# Usage:
#   .fork/build-macos.sh [--arch arm64|x64] [--sign] [--skip-install]
#     --arch   target CPU (default arm64 = Apple Silicon; pass x64 for Intel)
#     --sign   opt into code signing (needs ZCODE_ENABLE_MAC_SIGN=1 semantics:
#              exports it for you if APPLE_SIGNING_IDENTITY or CSC_NAME is set)
#     --skip-install  reuse an existing node_modules (rebuilds only)
#
# Prerequisites:
#   - Xcode Command Line Tools (xcode-select --install) — node-pty native build
#   - mise (brew install mise) — the repo's mise.toml pins node 24.22.1 (fork
#     U86 CA fix over upstream's 24.14.0) + pnpm 10.33.2; do NOT use corepack
#     (0.36 shims resolve the wrong pnpm and abort — Linux ADR-036 finding)
#   - The fork repo checked out at the release tag:
#       git clone https://github.com/ngjunsiang/ZCode
#       git checkout v4.0.0-fork.1        # requires the tag to be pushed
#     (or work from an existing local checkout and pass no args)
#
# Output: packages/desktop/dist/ZCode-<version>-mac-<arch>.dmg (+ .zip)
set -euo pipefail

ARCH="arm64"
SIGN=0
SKIP_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="${2:?arch required}"; shift 2 ;;
    --sign) SIGN=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

say() { printf '[zcoder-macos] %s\n' "$*"; }
fail() { printf '[zcoder-macos] FAIL: %s\n' "$*" >&2; exit 1; }

command -v mise >/dev/null 2>&1 || fail "mise not found: brew install mise"
command -v xcode-select >/dev/null 2>&1 || fail "Xcode CLT missing: xcode-select --install"

# Fork provenance banner — the build bakes whatever is checked out; make the
# state visible in the log so a stray checkout cannot ship silently.
say "repo: $(git remote get-url origin 2>/dev/null || echo '(no origin)')"
say "HEAD: $(git log -1 --format='%h %s')"
say "branch: $(git branch --show-current)  describe: $(git describe --tags 2>/dev/null || echo '(no tag)')"

say "ensuring pinned toolchain (mise.toml)…"
mise install

if [ "$SKIP_INSTALL" -eq 0 ]; then
  say "pnpm install --frozen-lockfile (first run is slow)…"
  mise exec -- pnpm install --frozen-lockfile
fi

if [ "$SIGN" -eq 1 ]; then
  if [ -n "${APPLE_SIGNING_IDENTITY:-${CSC_NAME:-}}" ]; then
    export ZCODE_ENABLE_MAC_SIGN=1
    say "mac signing ENABLED (identity: ${APPLE_SIGNING_IDENTITY:-${CSC_NAME}})"
  else
    fail "--sign requested but APPLE_SIGNING_IDENTITY / CSC_NAME is not set"
  fi
else
  say "unsigned build (signing stays opt-in; set APPLE_SIGNING_IDENTITY + --sign to enable)"
fi

# Production identity + pacman-equivalent policy (ADR-024): the official
# server can never hard-block startup; auto-update stays off in fork builds.
ZCODE_ENV=production ZCODE_SKIP_REMOTE_ASSETS=1 ZCODE_FORCE_UPDATE_GUARD=0 \
  mise exec -- pnpm bundle:desktop -- --os mac --arch "$ARCH"

say "artifacts:"
ls -lh packages/desktop/dist/ZCode-*-mac-*.{dmg,zip} 2>/dev/null || true
say "install: open the .dmg and drag ZCode to /Applications (replaces the official app — same userData / ~/.zcode / zcode:// handler; quit the official app first)."
