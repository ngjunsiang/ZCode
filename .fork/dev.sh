#!/usr/bin/env bash
# fork-local desktop dev launcher (tracked on patch/<release> branches — .fork/README.md).
#
# One command to go from "fresh clone" (or "this morning") to a running desktop
# app that contains the resumeTurn fork series.
#
#   .fork/dev.sh                  # cold launch, production backend + REAL ~/.zcode data (~20s warm cache)
#   .fork/dev.sh --isolated       # cold launch, sandboxed data home (~/.zcode-dev-home)
#   .fork/dev.sh --stack          # persistent build stack ONLY (tsup watch + vite; no Electron)
#   .fork/dev.sh --app            # launch Electron against a running --stack (~5s per test cycle)
#   .fork/dev.sh --own-deeplink   # during THIS session, route zcode:// OAuth callbacks into the dev
#                                 #   app (user-level zcode.desktop + forwarder; auto-removed on exit)
#   .fork/dev.sh --deeplink-register  # register the dev handler manually (NO auto-cleanup!)
#   .fork/dev.sh --deeplink-cleanup   # manually remove it (repair tool, safe anytime)
#   .fork/dev.sh --check          # verify environment readiness only, no launch
#   .fork/dev.sh --no-setup       # skip setup checks
#   .fork/dev.sh --no-agent-cache # stock uncached agent CLI build
#   .fork/dev.sh --full-setup     # one-time thorough setup (pnpm bootstrap; slow)
#
# Why --own-deeplink exists: OAuth sign-in completes via a zcode:// callback that
# the OS delivers to the registered handler — normally the INSTALLED official app
# (system /usr/share/applications/zcode.desktop). The dev shell never receives it,
# so a login performed inside dev stays broken (401s) until an official launch
# processes/refreshes the state. --own-deeplink registers a session-scoped
# user-level handler (user entries shadow system entries under XDG) whose
# forwarder launches `electron packages/desktop <url>`; the dev app's
# single-instance lock forwards that into the running instance (second-instance →
# handleDeepLink). The entry carries the official ownership marker
# ("Comment=ZCode Desktop App") so the installed app self-heals (removes it) if
# this session crashes, and it is removed when the dev.sh process exits.
#
# Caveats: while registered, ALL zcode:// callbacks (including official-app
# logins) land in dev — don't run the official app mid-session. Callbacks only
# complete while the dev session is alive (OAuth state expires after ~5 min).
#
# Fast test loop (recommended): keep `.fork/dev.sh --stack` running in one
# terminal; every test cycle = close the app, then `.fork/dev.sh --app` (~5s).
# The stack watches sources; CLI/renderer edits rebuild automatically — but a
# NEW agent-CLI bundle is staged only by --stack/--cold launches, so restart
# --stack after editing CLI sources. Mode (--isolated vs not) is stamped into
# out/.zcode-env; --app refuses to run against a stack of the other mode.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# mise installs to ~/.local/bin by default (mise.run script) and is not always on
# non-interactive PATH.
export PATH="$HOME/.local/bin:$PATH"

ISOLATED=0
SKIP_SETUP=0
FULL_SETUP=0
CHECK_ONLY=0
NO_AGENT_CACHE=0
STACK_MODE=0
APP_MODE=0
OWN_DEEPLINK=0
DEEPLINK_REGISTER_ONLY=0
DEEPLINK_CLEANUP_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --isolated)            ISOLATED=1 ;;
    --no-setup)            SKIP_SETUP=1 ;;
    --full-setup)          FULL_SETUP=1 ;;
    --check)               CHECK_ONLY=1 ;;
    --no-agent-cache)      NO_AGENT_CACHE=1 ;;
    --stack)               STACK_MODE=1 ;;
    --app)                 APP_MODE=1 ;;
    --own-deeplink)        OWN_DEEPLINK=1 ;;
    --deeplink-register)   DEEPLINK_REGISTER_ONLY=1 ;;
    --deeplink-cleanup)    DEEPLINK_CLEANUP_ONLY=1 ;;
    -h|--help)
      sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

fail() { echo "[dev-fork] ERROR: $*" >&2; exit 1; }
info() { echo "[dev-fork] $*"; }

if [ "$STACK_MODE" -eq 1 ] && [ "$APP_MODE" -eq 1 ]; then
  fail "--stack and --app are mutually exclusive"
fi

command -v mise >/dev/null 2>&1 || \
  fail "mise not found. Install it first: curl -fsSL https://mise.run | sh && eval \"\$(mise activate bash)\""

if [ "$ISOLATED" -eq 1 ]; then
  export ZCODE_ENV=test
  export ZCODE_DATA_BASE_DIR="${ZCODE_DATA_BASE_DIR:-$HOME/.zcode-dev-home}"
else
  export ZCODE_ENV=production
fi

# ── setup (idempotent; --no-setup skips; --app keeps it minimal) ─────────────
if [ "$SKIP_SETUP" -eq 0 ]; then
  mise install
  if [ ! -d node_modules ]; then
    info "node_modules missing — installing workspace dependencies (first run, a few minutes)…"
    mise exec -- pnpm install
  fi
  if [ "$FULL_SETUP" -eq 1 ]; then
    info "Running full repo bootstrap (pnpm bootstrap)…"
    mise exec -- pnpm run bootstrap
  fi
fi

NODE_VERSION="$(mise exec -- node --version)"
info "toolchain ready: node ${NODE_VERSION} / pnpm $(mise exec -- pnpm --version)"

if [ "$CHECK_ONLY" -eq 1 ]; then
  [ -d node_modules ] && info "node_modules: present" || fail "node_modules: missing"
  info "check complete — launch with: .fork/dev.sh [--isolated] [--stack|--app] [--own-deeplink]"
  exit 0
fi

# ── zcode:// deep-link ownership (Linux only; see header comment) ────────────
DEEPLINK_USER_ENTRY="${XDG_DATA_HOME:-$HOME/.local/share}/applications/zcode.desktop"
DEEPLINK_FORWARDER="$REPO_ROOT/.fork/zcode-dev-deeplink-forwarder.sh"
DEEPLINK_ELECTRON_BIN="$REPO_ROOT/node_modules/electron/dist/electron"
DEEPLINK_APP_DIR="$REPO_ROOT/packages/desktop"

# 判定条件与 desktopLinuxDeepLinkRegistration.ts 的 ownership marker 对齐：
# 官方应用启动遇到带此标记的用户级条目会主动移除（崩溃残留自愈，防遮蔽系统安装）。
deeplink_entry_matches_ours() {
  [ -f "$DEEPLINK_USER_ENTRY" ] \
    && grep -q "^Comment=ZCode Desktop App$" "$DEEPLINK_USER_ENTRY" \
    && grep -qF "$DEEPLINK_FORWARDER" "$DEEPLINK_USER_ENTRY"
}

deeplink_cleanup() {
  if deeplink_entry_matches_ours; then
    rm -f "$DEEPLINK_USER_ENTRY"
    update-desktop-database "$(dirname "$DEEPLINK_USER_ENTRY")" 2>/dev/null || true
    info "dev zcode:// handler unregistered — system handler (official app) restored"
  fi
}

deeplink_register() {
  [ "$(uname)" = "Linux" ] || fail "--own-deeplink/--deeplink-register is Linux-only (Windows/macOS keep using the installed app's handler)"
  [ -x "$DEEPLINK_ELECTRON_BIN" ] || fail "electron binary not found at $DEEPLINK_ELECTRON_BIN (run pnpm install first)"
  if [ -f "$DEEPLINK_USER_ENTRY" ] && ! deeplink_entry_matches_ours; then
    fail "user-level zcode.desktop already exists and is not ours ($DEEPLINK_USER_ENTRY) — inspect it first; refusing to clobber"
  fi
  cat > "$DEEPLINK_FORWARDER" <<EOF
#!/usr/bin/env bash
# generated by .fork/dev.sh --own-deeplink; forwards zcode:// callbacks into the dev app.
exec "$DEEPLINK_ELECTRON_BIN" "$DEEPLINK_APP_DIR" "\$@"
EOF
  chmod +x "$DEEPLINK_FORWARDER"
  cat > "$DEEPLINK_USER_ENTRY" <<EOF
[Desktop Entry]
Name=ZCode Dev (fork)
Comment=ZCode Desktop App
Exec="$DEEPLINK_FORWARDER" %U
Terminal=false
Type=Application
Icon=zcode
Categories=Development;
MimeType=x-scheme-handler/zcode;
EOF
  update-desktop-database "$(dirname "$DEEPLINK_USER_ENTRY")" 2>/dev/null || true
  xdg-mime default zcode.desktop x-scheme-handler/zcode || fail "xdg-mime failed — dev handler not registered"
  info "dev zcode:// handler registered ($DEEPLINK_USER_ENTRY → forwarder)"
  info "caveat: while registered, official-app logins also land in dev; entry is removed on exit"
}

if [ "$DEEPLINK_CLEANUP_ONLY" -eq 1 ]; then
  deeplink_cleanup
  exit 0
fi
if [ "$DEEPLINK_REGISTER_ONLY" -eq 1 ]; then
  deeplink_register
  info "registered WITHOUT auto-cleanup — run .fork/dev.sh --deeplink-cleanup when done"
  exit 0
fi
if [ "$APP_MODE" -eq 1 ] && [ "$OWN_DEEPLINK" -eq 1 ]; then
  info "--own-deeplink is managed by your --stack session; ignoring it for --app"
  OWN_DEEPLINK=0
fi

# ── --app: reuse a running --stack, launch Electron only (~5s) ───────────────
if [ "$APP_MODE" -eq 1 ]; then
  DESKTOP_DIR="$REPO_ROOT/packages/desktop"
  STAMP_FILE="$DESKTOP_DIR/out/.zcode-env"
  if ! curl -s -o /dev/null --max-time 2 http://localhost:5174; then
    fail "no --stack running (vite :5174 unreachable). Start it first: .fork/dev.sh --stack${ISOLATED:+ --isolated}"
  fi
  if [ ! -f "$DESKTOP_DIR/out/main/index.js" ] || [ ! -f "$STAMP_FILE" ]; then
    fail "stack artifacts missing under packages/desktop/out — restart .fork/dev.sh --stack"
  fi
  STAMPED_ENV="$(cat "$STAMP_FILE")"
  if [ "$STAMPED_ENV" != "$ZCODE_ENV" ]; then
    fail "stack was started with ZCODE_ENV=$STAMPED_ENV but you asked for $ZCODE_ENV. Restart --stack with the matching mode flag."
  fi
  info "Launching Electron against the running stack (ZCODE_ENV=$ZCODE_ENV)…"
  exec mise exec -- node "$DESKTOP_DIR/scripts/dev.mjs"
fi

# ── cold launch / --stack: build, then run ───────────────────────────────────
info "Preparing desktop runtime assets…"
mise exec -- pnpm --filter @zcode/desktop run pre-dev

if [ "$NO_AGENT_CACHE" -eq 1 ]; then
  info "Building agent CLI from scratch (stock path, uncached)…"
  mise exec -- node scripts/build-desktop-agent-cli.mjs
else
  # turbo.json 的 build:desktop-agent 不覆盖两个 MCP plugin runtime，默认路径有
  # artifact 校验（缺了 = Helper ready 但 CUA 工具缺失的半启动态）。分两类处理：
  # - node-repl-host 产物全在 dist/** → turbo 内容哈希缓存（热 ~0.5s）
  # - browser-use-plugin 的 scripts/browser-client.mjs 是构建产物且不在 dist/**，
  #   turbo 不缓存它 → 保持每次重build（~1.3s，廉价兜底）。
  info "Building MCP plugin runtimes…"
  mise exec -- pnpm exec turbo --skip-infer --cwd apps/zcode-cli run build --filter=@zcode/node-repl-host
  mise exec -- pnpm --filter @zcode/browser-use-plugin run build
  info "Building agent CLI (turbo cache — seconds when CLI sources unchanged)…"
  ZCODE_DESKTOP_AGENT_BUILD_MODE=turbo mise exec -- node scripts/build-desktop-agent-cli.mjs
fi

# ZCODE_ENV 通过 tsup define 烤进 bundle；--app 靠这个 stamp 校验栈的模式。
# Bugfix: v3.15.1 起 pre-dev 会 rm -rf out/（干净重建，tsup watch 稍后才重建产物），
# stamp 落盘前必须先建目录，否则 echo 重定向直接失败（v3.14.3 时代 out/ 常驻磁盘所以没炸过）。
mkdir -p packages/desktop/out
echo "$ZCODE_ENV" > packages/desktop/out/.zcode-env

# --own-deeplink 需要在脚本退出时反注册；trap 不穿透 exec，因此该模式下改为
# 前台运行 + EXIT trap：Ctrl-C/正常退出都会先反注册再结束。
if [ "$OWN_DEEPLINK" -eq 1 ]; then
  deeplink_register
  trap deeplink_cleanup EXIT
fi

if [ "$STACK_MODE" -eq 1 ]; then
  info "Starting persistent build stack (tsup watch + vite :5174; NO Electron)…"
  info "Launch the app with: .fork/dev.sh --app${ISOLATED:+ --isolated}"
  cd packages/desktop
  if [ "$OWN_DEEPLINK" -eq 1 ]; then
    mise exec -- pnpm exec concurrently -k -n tsup,vite \
      "pnpm exec tsup --watch src --watch ../services/src --watch ../server/src --watch ../shared/src --watch ../rpc/src --watch ../client/src --watch ../provider/src --watch ../provider-node/src --ignore-watch 'mock-cdn/**' --ignore-watch 'bundled-agents/**' --ignore-watch '.e2e-cache/**' --ignore-watch '.e2e-artifacts/**' --ignore-watch '.e2e-home-*/**' --ignore-watch 'dist-cua-helper/**'" \
      "pnpm exec vite dev"
    exit 0
  fi
  exec mise exec -- pnpm exec concurrently -k -n tsup,vite \
    "pnpm exec tsup --watch src --watch ../services/src --watch ../server/src --watch ../shared/src --watch ../rpc/src --watch ../client/src --watch ../provider/src --watch ../provider-node/src --ignore-watch 'mock-cdn/**' --ignore-watch 'bundled-agents/**' --ignore-watch '.e2e-cache/**' --ignore-watch '.e2e-artifacts/**' --ignore-watch '.e2e-home-*/**' --ignore-watch 'dist-cua-helper/**'" \
    "pnpm exec vite dev"
fi

info "Launching desktop dev (ZCODE_ENV=$ZCODE_ENV, data home: ${ZCODE_DATA_BASE_DIR:-~/.zcode})…"
if [ "$ISOLATED" -eq 0 ]; then
  info "(use --isolated for a sandboxed data home; --stack + --app for fast test cycles)"
fi
if [ "$OWN_DEEPLINK" -eq 1 ]; then
  set +e
  mise exec -- pnpm --filter @zcode/desktop run dev:runtime
  LAUNCH_RC=$?
  set -e
  exit "$LAUNCH_RC"
fi
exec mise exec -- pnpm --filter @zcode/desktop run dev:runtime
