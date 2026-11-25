#!/usr/bin/env bash
# Launch the profiling dev app instance against the running stack. Idempotent-ish:
# kills any previous instance from /tmp/zcode-prof/app.pid first.
set -euo pipefail
PIDFILE=/tmp/zcode-prof/app.pid
if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null || true
    # wait for the MAIN process (title "Zcode Prof") to fully exit: it holds the CDP port
    for i in $(seq 1 20); do
      kill -0 "$OLD" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$OLD" 2>/dev/null || true
  fi
fi
# kill every remaining process of this benchmark identity (main title + utility children),
# then WAIT for full teardown: the host holds ~/.zcode sqlite handles and a fast relaunch crashes it.
for i in $(seq 1 30); do
  REM=$(ps -eo pid,cmd | grep -E "zcode-prof-userdata|^ *[0-9]+ Zcode Prof" | grep -v grep | awk '{print $1}' || true)
  if [ -z "$REM" ]; then break; fi
  for p in $REM; do kill "$p" 2>/dev/null || true; done
  sleep 1
done
for i in $(seq 1 10); do
  REM=$(ps -eo pid,cmd | grep -E "zcode-prof-userdata|^ *[0-9]+ Zcode Prof" | grep -v grep | awk '{print $1}' || true)
  if [ -z "$REM" ]; then break; fi
  for p in $REM; do kill -9 "$p" 2>/dev/null || true; done
  sleep 1
done
# wait for the CDP port to be free before relaunching
for i in $(seq 1 15); do
  if ! ss -tln | grep -q ':9231 '; then break; fi
  sleep 1
done
sleep 2
# user request 2026-10-14: 2s heads-up before each test launch (focus flicker is annoying)
notify-send --expire-time 2000 "ZCode benchmark" "Launching offscreen test app (brief focus flicker possible)." 2>/dev/null || true
: > /tmp/zcode-app.log
cd /home/kureshii/ngjunsiang/ZCode/packages/desktop
# Xvfb isolation: the app renders to an offscreen X display so it never steals the
# user's Wayland-session focus; Xvfb windows are always "visible" (no occlusion throttling).
PATH="$HOME/.local/bin:$PATH" DISPLAY=:99 ELECTRON_OZONE_PLATFORM_HINT=x11 \
  ELECTRON_RENDERER_URL="http://[::1]:5174" \
  ZCODE_DESKTOP_APPLICATION_NAME="Zcode Prof" \
  ZCODE_DESKTOP_USER_DATA_DIR=/tmp/zcode-prof-userdata \
  nohup /home/kureshii/ngjunsiang/ZCode/node_modules/electron/dist/electron . --remote-debugging-port=9231 --disable-gpu \
  >> /tmp/zcode-app.log 2>&1 &
echo $! > "$PIDFILE"
# wait for CDP browser endpoint (window/page may come later; bench waits for those)
for i in $(seq 1 150); do
  if curl -s --max-time 2 http://127.0.0.1:9231/json/version | grep -q '"Browser"'; then
    echo "cdp up after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "cdp did not come up" >&2
tail -5 /tmp/zcode-app.log >&2
exit 1
