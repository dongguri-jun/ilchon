#!/usr/bin/env bash
# `pnpm check`: runs every no-network check in order, prints the time each step took, stops at the
# first failure with that step's exit code. The step list below is the only place that names them.
# Fast checks come first so a failure shows up early; the slow ones (boot, guard, engine) come last.
# Run: pnpm check   (CI runs the same command)
set -uo pipefail
cd "$(dirname "$0")/.."

STEPS=(
  typecheck
  check:lint
  check:match
  check:currency
  check:storage
  check:seed
  check:list
  check:bolt11
  check:relays
  check:nostr-profile
  check:history
  check:i18n
  check:i18n-table
  check:inbox
  check:trade
  check:lnurl
  check:onchain
  check:vectors
  check:support-log
  check:csp
  check:a11y
  check:tokens
  check:boot
  check:guard
  check:engine
)

names=()
secs=()
total_start=$SECONDS

summary() {
  echo
  echo "Step times:"
  local i
  for i in "${!names[@]}"; do
    printf '  %4ss  %s\n' "${secs[$i]}" "${names[$i]}"
  done
  printf '  %4ss  total\n' "$((SECONDS - total_start))"
}

for step in "${STEPS[@]}"; do
  echo
  echo "=== pnpm $step"
  start=$SECONDS
  pnpm "$step"
  rc=$?
  names+=("$step")
  secs+=("$((SECONDS - start))")
  if [ "$rc" -ne 0 ]; then
    summary
    echo "FAILED at pnpm $step (exit $rc)"
    exit "$rc"
  fi
done

summary
