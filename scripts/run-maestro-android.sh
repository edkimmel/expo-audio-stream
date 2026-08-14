#!/usr/bin/env bash
# Run the on-device Maestro e2e suites against a connected Android device
# or emulator. Same entry point as CI (.github/workflows/ci.yml).
#
# These suites live in the example app and exercise the real native module
# (pipeline drain, binary push, mic). Maestro is the driver — not Playwright.
#
# Prerequisites:
#   - adb on PATH, with a device/emulator already booted (`adb devices`)
#   - maestro on PATH  (https://maestro.mobile.dev  — `curl -Ls "https://get.maestro.mobile.dev" | bash`)
#   - a built APK (default: example release, signed with the debug keystore)
#
# Typical local loop:
#   (cd example && npx expo prebuild --platform android --no-install)
#   (cd example/android && ./gradlew assembleRelease)
#   yarn e2e:android
#
# Env / flags:
#   APK              path to the APK (default: example release output)
#   FLOW             Maestro flow (default: .maestro/all-suites.yml)
#   DEBUG_OUTPUT     Maestro debug dir (default: maestro-debug)
#   --skip-install   assume the app is already installed
#   --apk PATH       override APK
#   --flow PATH      override flow

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APK="${APK:-example/android/app/build/outputs/apk/release/app-release.apk}"
FLOW="${FLOW:-.maestro/all-suites.yml}"
DEBUG_OUTPUT="${DEBUG_OUTPUT:-maestro-debug}"
SKIP_INSTALL=0

usage() {
  sed -n '2,28p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1; shift ;;
    --apk) APK="$2"; shift 2 ;;
    --flow) FLOW="$2"; shift 2 ;;
    --debug-output) DEBUG_OUTPUT="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage 1
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required tool: $1" >&2
    exit 1
  fi
}

need adb
need maestro

if ! adb get-state >/dev/null 2>&1; then
  echo "no Android device/emulator visible to adb." >&2
  echo "start one (Android Studio AVD, or \`emulator -avd <name>\`) and retry." >&2
  adb devices -l >&2 || true
  exit 1
fi

if [[ ! -f "$FLOW" ]]; then
  echo "Maestro flow not found: $FLOW" >&2
  exit 1
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  if [[ ! -f "$APK" ]]; then
    echo "APK not found: $APK" >&2
    echo "build it first, e.g.:" >&2
    echo "  (cd example && npx expo prebuild --platform android --no-install)" >&2
    echo "  (cd example/android && ./gradlew assembleRelease)" >&2
    exit 1
  fi
  echo "installing $APK"
  adb install -r "$APK"
else
  echo "skipping install (--skip-install)"
fi

set +e
maestro test "$FLOW" --debug-output "$DEBUG_OUTPUT"
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  echo "==== UI hierarchy at failure ===="
  maestro hierarchy || true
  echo "==== logcat tail ===="
  adb logcat -d | grep -iE 'expo|audiostream|pipeline|ReactNative|AndroidRuntime|maestro' | tail -n 200 || true
  echo "==== Maestro debug output: $DEBUG_OUTPUT ===="
  exit "$status"
fi
