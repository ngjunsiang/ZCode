#!/usr/bin/env bash
# Run benchmark for each config sequentially: apply patch -> launch -> bench -> metrics -> revert.
set -uo pipefail
cd /home/kureshii/ngjunsiang/ZCode
mkdir -p /tmp/zcode-prof/patches

run_config() {
  local name=$1 patch=$2
  echo "=== [$name] start $(date +%T) ==="
  # contamination guard: start from a clean ui tree, no exceptions
  if ! git diff --quiet -- packages/ui/src; then
    echo "[$name] tree dirty before apply — resetting packages/ui/src"
    git checkout -- packages/ui/src
  fi
  if [ -n "$patch" ]; then
    git apply "/tmp/zcode-prof/patches/$patch.patch" || { echo "[$name] APPLY FAILED"; return 1; }
  fi
  if ! bash /tmp/zcode-prof/launch.sh > /tmp/zcode-prof/launch-$name.log 2>&1; then
    echo "[$name] LAUNCH FAILED"; tail -3 /tmp/zcode-prof/launch-$name.log
    [ -n "$patch" ] && git apply -R "/tmp/zcode-prof/patches/$patch.patch" || true
    return 1
  fi
  (cd /tmp/zcode-prof && node bench.mjs > bench-$name.log 2>&1) || echo "[$name] bench non-zero rc"
  (cd /tmp/zcode-prof && node metrics.mjs "$name" > metrics-$name.log 2>&1) || echo "[$name] metrics rc"
  if [ -n "$patch" ]; then
    git apply -R "/tmp/zcode-prof/patches/$patch.patch" || { echo "[$name] REVERT FAILED"; git checkout -- packages/ui/src; }
  fi
  if ! git diff --quiet -- packages/ui/src; then
    echo "[$name] tree still dirty after revert — resetting"
    git checkout -- packages/ui/src
  fi
  echo "=== [$name] done $(date +%T) ==="
}

run_config opt1 opt1
run_config opt2 opt2
run_config opt3 opt3
run_config opt4 opt4
run_config opt5 opt5
run_config baseline2 ""
echo "ALL DONE $(date +%T)"
