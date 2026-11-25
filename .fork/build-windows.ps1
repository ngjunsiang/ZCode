# build-windows.ps1 — ZCodeR release build for Windows (fork 4.0.0 line, ADR-041).
#
# Builds the packaged desktop app from a checkout of the fork repo on Windows.
# Sibling of build-macos.sh / the Linux PKGBUILD (~/sysadmin/aur/zcoder/):
# all three bake the same production identity + force-update kill switch
# (ADR-024).
#
# Usage:
#   .fork\build-windows.ps1 [-Arch x64|arm64] [-Sign] [-SkipInstall]
#     -Arch  target CPU (default x64; arm64 Windows is not exercised by the
#            upstream installer tests — prefer x64)
#     -Sign  opt into code signing (requires ZCODE_ENABLE_WINDOWS_SIGN=1
#            semantics plus the repo's vsigntool infrastructure; without it
#            the build stays unsigned)
#     -SkipInstall  reuse an existing node_modules
#
# Prerequisites:
#   - mise (winget install jdx.mise, then reopen the shell) — mise.toml pins
#     node 24.22.1 (fork U86 CA fix) + pnpm 10.33.2; do NOT use corepack
#     (0.36 shims resolve the wrong pnpm and abort — Linux ADR-036 finding)
#   - Visual Studio Build Tools (C++ workload) for the node-pty native build
#   - Git long paths enabled: git config --global core.longpaths true
#   - The fork repo checked out at the release tag:
#       git clone https://github.com/ngjunsiang/ZCode
#       git checkout v4.0.0-fork.1     # requires the tag to be pushed
#     (.fork/ rides the patch branches; drop .fork/ from .git/info/exclude if
#     present — see the Windows-sync note in .fork/decisions.md ADR-017)
#
# Output: packages\desktop\dist\ZCode-<version>-win-x64.exe (NSIS installer).
#
# Install: quit any running ZCode, run the .exe. Production identity: same
# app name / userData / ~/.zcode / zcode:// handler as the official build —
# a drop-in replacement, not a side-by-side product.

param(
  [ValidateSet("x64", "arm64")][string]$Arch = "x64",
  [switch]$Sign,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "[zcoder-win] $m" }
function Fail($m) { Write-Error "[zcoder-win] FAIL: $m"; exit 1 }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $RepoRoot

if (-not (Get-Command mise -ErrorAction SilentlyContinue)) {
  Fail "mise not found: winget install jdx.mise (then reopen the shell)"
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git not found" }

# Fork provenance banner — the build bakes whatever is checked out.
Info "repo: $((git remote get-url origin) 2>$null)"
Info "HEAD: $(git log -1 --format='%h %s')"
Info "branch: $(git branch --show-current)  describe: $(git describe --tags 2>$null)"

Info "ensuring pinned toolchain (mise.toml)…"
mise install

if (-not $SkipInstall) {
  Info "pnpm install --frozen-lockfile (first run is slow; rebuilds node-pty)…"
  mise exec -- pnpm install --frozen-lockfile
}

if ($Sign) {
  $env:ZCODE_ENABLE_WINDOWS_SIGN = "1"
  Info "Windows signing ENABLED (uses the repo's vsigntool sign hook infrastructure)"
} else {
  Info "unsigned build (signing stays opt-in; set ZCODE_ENABLE_WINDOWS_SIGN=1 to enable)"
}

# Production identity + pacman-equivalent policy (ADR-024): the official
# server can never hard-block startup; auto-update stays off in fork builds.
$env:ZCODE_ENV = "production"
$env:ZCODE_SKIP_REMOTE_ASSETS = "1"
$env:ZCODE_FORCE_UPDATE_GUARD = "0"
mise exec -- pnpm bundle:desktop -- --os win --arch $Arch --target nsis

Info "artifacts:"
Get-ChildItem "packages\desktop\dist\ZCode-*-win-*.exe" | Format-Table Name, Length
Info "install: quit any running ZCode, then run the NSIS .exe above."
