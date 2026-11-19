#!/usr/bin/env bash
# The standard check of the Dart code: `pnpm check:dart` (CI runs the same command).
# Runs each step in order, prints the time of each, stops at the first failure with its exit code.
# The Dart toolchain is the pinned one: $ILCHON_DART, else the Flutter SDK named in .fvmrc from the fvm
# cache, else `dart` on PATH. `pub get` refuses any other version through the sdk range in pubspec.yaml.
set -uo pipefail
cd "$(dirname "$0")/.."

pin="$(sed -n 's/.*"flutter" *: *"\([^"]*\)".*/\1/p' .fvmrc)"
fvm_dart="${FVM_CACHE_PATH:-$HOME/fvm}/versions/$pin/bin/cache/dart-sdk/bin/dart"
if [ -n "${ILCHON_DART:-}" ]; then DART="$ILCHON_DART"; elif [ -x "$fvm_dart" ]; then DART="$fvm_dart"; else DART=dart; fi

# The pinned Dart and a Chrome for the browser step must exist; say what is missing instead of failing in the middle.
if ! "$DART" --version >/dev/null 2>&1; then
  echo "check:dart: no Dart SDK. Install Flutter $pin with fvm, or set ILCHON_DART to its bin/cache/dart-sdk/bin/dart." >&2
  exit 127
fi
chrome="${CHROME_EXECUTABLE:-}"
if [ -z "$chrome" ]; then chrome="$(command -v google-chrome chromium chromium-browser chrome 2>/dev/null | head -n1)"; fi
if [ -z "$chrome" ] || ! [ -x "$chrome" ]; then
  echo "check:dart: no Chrome for the browser tests (dart2js, dart2wasm). Install Chrome or Chromium, or set CHROME_EXECUTABLE to a Chrome binary." >&2
  exit 127
fi

# Where the Dart code lives. Not `.`: the checkout also holds node_modules, build output and worktrees.
dirs=(packages tool)
# At most two test workers, as for every heavy local job.
workers=--concurrency=2

# Packages without Flutter: their tests run on the Dart VM and, tagged `web`, compiled to JS and Wasm in Chrome.
pure_packages=()
for pubspec in packages/*/pubspec.yaml; do
  grep -q 'sdk: flutter' "$pubspec" || pure_packages+=("$(dirname "$pubspec")")
done

vm_tests() { for d in "${pure_packages[@]}"; do (cd "$d" && [ ! -d test ] || "$DART" test "$workers") || return 1; done; }
# Exit code 79 is "no test carries the tag": fine for a package with nothing to compare across targets,
# a failure for the packages that must run on every target.
packages_with_web_tests=(packages/ilchon_core)
web_tests() {
  local rc must
  for d in "${pure_packages[@]}"; do
    (cd "$d" && [ ! -d test ] || "$DART" test "$workers" -p chrome -c dart2js,dart2wasm -t web)
    rc=$?
    must=0; [[ " ${packages_with_web_tests[*]} " == *" $d "* ]] && must=1
    if [ "$rc" -eq 79 ] && [ "$must" -eq 0 ]; then continue; fi
    [ "$rc" -eq 0 ] || return "$rc"
  done
}

STEPS=(
  "$DART pub get --enforce-lockfile"
  "$DART format --output=none --set-exit-if-changed ${dirs[*]}"
  "$DART analyze --fatal-infos ${dirs[*]}"
  "$DART run tool/check_arch.dart"
  "$DART test $workers tool"
  vm_tests
  web_tests
)

names=(); secs=(); total_start=$SECONDS
summary() {
  echo; echo "Step times:"
  for i in "${!names[@]}"; do printf '  %4ss  %s\n' "${secs[$i]}" "${names[$i]}"; done
  printf '  %4ss  total\n' "$((SECONDS - total_start))"
}
for step in "${STEPS[@]}"; do
  echo; echo "=== ${step/$DART/dart}"
  start=$SECONDS
  $step
  rc=$?
  names+=("${step/$DART/dart}"); secs+=("$((SECONDS - start))")
  if [ "$rc" -ne 0 ]; then summary; echo "FAILED: ${step/$DART/dart} (exit $rc)"; exit "$rc"; fi
done
summary
