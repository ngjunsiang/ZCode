# fork-local desktop dev launcher for Windows (tracked on patch/<release> branches — .fork/README.md).
# PowerShell 5.1+ compatible. Sibling of dev.sh (Linux/macOS); same semantics.
#
#   .fork\dev.ps1                  # cold launch, production backend + REAL ~\.zcode data
#   .fork\dev.ps1 -Isolated        # sandboxed data home (~\.zcode-dev-home)
#   .fork\dev.ps1 -Stack           # persistent build stack (tsup watch + vite; no Electron)
#   .fork\dev.ps1 -App             # launch Electron against a running -Stack (~5s per cycle)
#   .fork\dev.ps1 -OwnDeeplink     # during THIS session, route zcode:// OAuth callbacks into the dev
#                                  #   app (session-scoped HKCU handler; removed on exit)
#   .fork\dev.ps1 -DeeplinkRegister    # register manually (NO auto-cleanup!)
#   .fork\dev.ps1 -DeeplinkCleanup     # manually remove it (repair tool, safe anytime)
#   .fork\dev.ps1 -Check           # verify environment only
#   .fork\dev.ps1 -NoSetup         # skip setup checks
#   .fork\dev.ps1 -NoAgentCache    # stock uncached agent CLI build
#   .fork\dev.ps1 -FullSetup       # pnpm bootstrap (slow, thorough)
#
# Why -OwnDeeplink exists: OAuth sign-in completes via a zcode:// callback that
# Windows delivers to the registered URL-protocol handler — normally the
# INSTALLED official app (HKLM). The dev shell never receives it, so a login
# performed inside dev stays broken (401s). -OwnDeeplink registers a session-
# scoped HKCU handler (HKCU shadows HKLM) whose command launches
# `electron.exe packages\desktop <url>`; the dev app's single-instance lock
# forwards that into the running instance (second-instance → handleDeepLink).
# UNTESTED — first Windows run is its smoke test. PowerShell's finally may not
# run on Ctrl-C; a leftover registration is auto-healed by the next cold/-Stack
# run, and -DeeplinkCleanup is always available as the manual repair.
#
# Historical note: .fork\ used to be per-clone gitignored; since 2026-10-14 it arrives with
# file over or recreate it. Native-modules note: pnpm install rebuilds node-pty
# (desktop postinstall) and needs the VS Build Tools C++ workload.
[CmdletBinding()]
param(
  [switch]$Isolated,
  [switch]$NoSetup,
  [switch]$FullSetup,
  [switch]$Check,
  [switch]$NoAgentCache,
  [switch]$Stack,
  [switch]$App,
  [switch]$OwnDeeplink,
  [switch]$DeeplinkRegister,
  [switch]$DeeplinkCleanup
)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Info($msg) { Write-Host "[dev-fork] $msg" }
function Fail($msg) { Write-Host "[dev-fork] ERROR: $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command mise -ErrorAction SilentlyContinue)) {
  Fail "mise not found. Install it first: winget install jdx.mise (then reopen the shell)"
}
if ($Isolated) {
  $env:ZCODE_ENV = "test"
  if (-not $env:ZCODE_DATA_BASE_DIR) {
    $env:ZCODE_DATA_BASE_DIR = Join-Path $env:USERPROFILE ".zcode-dev-home"
  }
} else {
  $env:ZCODE_ENV = "production"
}

if (-not $NoSetup) {
  Info "Ensuring pinned toolchain (mise.toml: node 24.14.0 / pnpm 10.33.2)…"
  mise install
  if (-not (Test-Path "node_modules")) {
    Info "node_modules missing — installing workspace dependencies (first run, a few minutes)…"
    pnpm install
  }
  if ($FullSetup) {
    Info "Running full repo bootstrap (pnpm bootstrap)…"
    pnpm run bootstrap
  }
}

Info "toolchain ready: node $(node --version) / pnpm $(pnpm --version)"
if ($Check) {
  if (Test-Path "node_modules") { Info "node_modules: present" } else { Fail "node_modules: missing" }
  Info "check complete — launch with: .fork\dev.ps1 [-Isolated] [-Stack|-App] [-OwnDeeplink]"
  exit 0
}

# ── zcode:// deep-link ownership (session-scoped HKCU registration) ──────────
$DeeplinkKey     = "HKCU:\Software\Classes\zcode\shell\open\command"
$DeeplinkRootKey = "HKCU:\Software\Classes\zcode"
$DeeplinkBackup  = Join-Path $PSScriptRoot ".deeplink-backup"
$DeeplinkStamp   = Join-Path $PSScriptRoot ".deeplink-registered"

function Get-OurCommandValue {
  $exe = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
  $desktop = Join-Path $RepoRoot "packages\desktop"
  return "`"$exe`" `"$desktop`" `"%1`""
}

function Get-CurrentDeeplinkValue {
  try {
    return (Get-ItemProperty -Path $DeeplinkKey -Name "(default)" -ErrorAction Stop)."(default)"
  } catch { return $null }
}

function Register-Deeplink {
  $exe = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
  if (-not (Test-Path $exe)) { Fail "electron.exe not found at $exe (run pnpm install first)" }
  New-Item -Path $DeeplinkRootKey -Force | Out-Null
  New-ItemProperty -Path $DeeplinkRootKey -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
  $previous = Get-CurrentDeeplinkValue
  $ours = Get-OurCommandValue
  if ($previous -and $previous -ne $ours) {
    Set-Content -Path $DeeplinkBackup -Value $previous
  }
  New-Item -Path $DeeplinkKey -Force | Out-Null
  Set-ItemProperty -Path $DeeplinkKey -Name "(default)" -Value $ours
  Set-Content -Path $DeeplinkStamp -Value "1"
  Info "dev zcode:// handler registered (HKCU → electron dev shell)"
  Info "caveat: while registered, official-app logins also land in dev; entry is removed on exit"
}

function Unregister-Deeplink {
  if (-not (Test-Path $DeeplinkStamp)) { return }
  $current = Get-CurrentDeeplinkValue
  $ours = Get-OurCommandValue
  if ($null -ne $current -and $current -ne $ours) {
    Info "deeplink registration was replaced by another handler; leaving it untouched"
    Remove-Item $DeeplinkStamp -Force -ErrorAction SilentlyContinue
    return
  }
  if (Test-Path $DeeplinkBackup) {
    Set-ItemProperty -Path $DeeplinkKey -Name "(default)" -Value (Get-Content $DeeplinkBackup -Raw).Trim()
    Remove-Item $DeeplinkBackup -Force -ErrorAction SilentlyContinue
  } else {
    Remove-Item -Path $DeeplinkRootKey -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $DeeplinkStamp -Force -ErrorAction SilentlyContinue
  Info "dev zcode:// handler unregistered — official (HKLM) handler restored"
}

# PowerShell 的 finally 在 Ctrl-C 下不可靠：残留注册由下一次 cold/-Stack 启动自愈。
if ((Test-Path $DeeplinkStamp) -and -not $OwnDeeplink -and -not $DeeplinkRegister -and -not $App) {
  Info "healing leftover deeplink registration from a previous session…"
  Unregister-Deeplink
}

if ($DeeplinkCleanup) {
  Unregister-Deeplink
  exit 0
}
if ($DeeplinkRegister) {
  Register-Deeplink
  Info "registered WITHOUT auto-cleanup — run .fork\dev.ps1 -DeeplinkCleanup when done"
  exit 0
}
if ($App -and $OwnDeeplink) {
  Info "-OwnDeeplink is managed by your -Stack session; ignoring it for -App"
  $OwnDeeplink = $false
}

# ── -App: reuse a running -Stack, launch Electron only ───────────────────────
if ($App) {
  $desktopDir = Join-Path $RepoRoot "packages\desktop"
  $probe = New-Object Net.Sockets.TcpClient
  $stackUp = $false
  try {
    $probe.Connect("127.0.0.1", 5174)
    $stackUp = $probe.Connected
  } catch { $stackUp = $false } finally { $probe.Close() }
  if (-not $stackUp) {
    Fail "no -Stack running (vite :5174 unreachable). Start it first: .fork\dev.ps1 -Stack$(if ($Isolated) { ' -Isolated' })"
  }
  if (-not (Test-Path (Join-Path $desktopDir "out\main\index.js")) -or
      -not (Test-Path (Join-Path $desktopDir "out\.zcode-env"))) {
    Fail "stack artifacts missing under packages\desktop\out — restart .fork\dev.ps1 -Stack"
  }
  $stamped = (Get-Content (Join-Path $desktopDir "out\.zcode-env") -Raw).Trim()
  if ($stamped -ne $env:ZCODE_ENV) {
    Fail "stack was started with ZCODE_ENV=$stamped but you asked for $env:ZCODE_ENV. Restart -Stack with the matching mode flag."
  }
  Info "Launching Electron against the running stack (ZCODE_ENV=$env:ZCODE_ENV)…"
  node (Join-Path $desktopDir "scripts\dev.mjs")
  exit $LASTEXITCODE
}

# ── cold launch / -Stack: build, then run ─────────────────────────────────────
Info "Preparing desktop runtime assets…"
pnpm --filter "@zcode/desktop" run pre-dev

if ($NoAgentCache) {
  Info "Building agent CLI from scratch (stock path, uncached)…"
  node scripts\build-desktop-agent-cli.mjs
} else {
  # turbo.json 的 build:desktop-agent 不覆盖两个 MCP plugin runtime；分两类处理：
  # node-repl-host 产物在 dist/**（turbo 可缓存）；browser-use-plugin 的
  # scripts/browser-client.mjs 是构建产物且不在 dist/**，保持每次重build兜底。
  Info "Building MCP plugin runtimes…"
  pnpm exec turbo --skip-infer --cwd apps/zcode-cli run build --filter=@zcode/node-repl-host
  pnpm --filter "@zcode/browser-use-plugin" run build
  Info "Building agent CLI (turbo cache — seconds when CLI sources unchanged)…"
  $env:ZCODE_DESKTOP_AGENT_BUILD_MODE = "turbo"
  node scripts\build-desktop-agent-cli.mjs
}

# ZCODE_ENV 通过 tsup define 烤进 bundle；-App 靠这个 stamp 校验栈的模式。
# v3.15.1 起 pre-dev 会 rm -rf out\，写 stamp 前必须先建目录（与 dev.sh 的 mkdir 修复同因）。
$outDir = Join-Path $RepoRoot "packages\desktop\out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Set-Content -Path (Join-Path $outDir ".zcode-env") -Value $env:ZCODE_ENV

if ($OwnDeeplink) { Register-Deeplink }

if ($Stack) {
  Info "Starting persistent build stack (tsup watch + vite :5174; NO Electron)…"
  Info "Launch the app with: .fork\dev.ps1 -App$(if ($Isolated) { ' -Isolated' })"
  Push-Location (Join-Path $RepoRoot "packages\desktop")
  try {
    pnpm exec concurrently -k -n tsup,vite `
      "pnpm exec tsup --watch src --watch ../services/src --watch ../server/src --watch ../shared/src --watch ../rpc/src --watch ../client/src --watch ../provider/src --watch ../provider-node/src --ignore-watch 'mock-cdn/**' --ignore-watch 'bundled-agents/**' --ignore-watch '.e2e-cache/**' --ignore-watch '.e2e-artifacts/**' --ignore-watch '.e2e-home-*/**' --ignore-watch 'dist-cua-helper/**'" `
      "pnpm exec vite dev"
  } finally {
    Pop-Location
    if ($OwnDeeplink) { Unregister-Deeplink }
  }
  exit 0
}

Info "Launching desktop dev (ZCODE_ENV=$env:ZCODE_ENV, data home: $(if ($env:ZCODE_DATA_BASE_DIR) { $env:ZCODE_DATA_BASE_DIR } else { '~\.zcode' }))…"
if (-not $Isolated) {
  Info "(use -Isolated for a sandboxed data home; -Stack + -App for fast test cycles)"
}
try {
  pnpm --filter "@zcode/desktop" run dev:runtime
} finally {
  if ($OwnDeeplink) { Unregister-Deeplink }
}
exit $LASTEXITCODE
