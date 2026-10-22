#!/usr/bin/env bash
# Cold-visit benchmark: baseline vs opt4, with contamination guards.
set -uo pipefail
cd /home/kureshii/ngjunsiang/ZCode

run_config() {
  local name=$1 patch=$2
  echo "=== [$name] start $(date +%T) ==="
  if ! git diff --quiet -- packages/ui/src; then
    echo "[$name] tree dirty — resetting"
    git checkout -- packages/ui/src
  fi
  if [ -n "$patch" ]; then
    git apply "/tmp/zcode-prof/patches/$patch.patch" || { echo "[$name] APPLY FAILED"; return 1; }
    sleep 1
    for f in $(grep '^+++' "/tmp/zcode-prof/patches/$patch.patch" | sed 's|+++ b/||'); do
      MARK=$(grep -o 'bench opt[0-9]' "$f" | head -1)
      SERVED=$(curl -s "http://[::1]:5174/@fs/home/kureshii/ngjunsiang/ZCode/$f" | grep -c "$MARK")
      if [ "$SERVED" -eq 0 ]; then echo "[$name] VITE STALE for $f — ABORTING"; git apply -R "/tmp/zcode-prof/patches/$patch.patch"; return 1; fi
    done
    echo "[$name] vite serves patched modules"
  fi
  if ! bash /tmp/zcode-prof/launch.sh > /tmp/zcode-prof/launch-$name.log 2>&1; then
    echo "[$name] LAUNCH FAILED"
    [ -n "$patch" ] && git apply -R "/tmp/zcode-prof/patches/$patch.patch" || true
    return 1
  fi
  (cd /tmp/zcode-prof && node bench-cold.mjs > bench-$name.log 2>&1) || echo "[$name] bench rc nonzero"
  (cd /tmp/zcode-prof && node metrics-cold.mjs "$name" > metrics-$name.log 2>&1) || echo "[$name] metrics rc"
  cp /tmp/zcode-app.log /tmp/zcode-prof/app-log-$name.log
  if [ -n "$patch" ]; then
    git apply -R "/tmp/zcode-prof/patches/$patch.patch" || git checkout -- packages/ui/src
  fi
  git diff --quiet -- packages/ui/src || { echo "[$name] still dirty — resetting"; git checkout -- packages/ui/src; }
  echo "=== [$name] done $(date +%T) ==="
}

run_config cold-baseline ""
run_config cold-opt4 opt4
echo "COLD DONE $(date +%T)"
