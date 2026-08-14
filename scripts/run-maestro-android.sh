#!/usr/bin/env bash
# Run the on-device Maestro e2e suites. Same entry point locally and in CI.
#
# Ensures an AVD exists (installing the system image if needed), boots it
# when no device is already attached, installs the APK, and runs Maestro.
# On failure: UI hierarchy + filtered logcat to stdout.
#
# Prerequisites:
#   - Android SDK (ANDROID_HOME or ~/Library/Android/sdk)
#   - Java (sdkmanager / emulator)
#   - maestro on PATH, or ~/.maestro/bin/maestro
#   - a built APK (default: example release)
#
# Typical local loop:
#   (cd example && npx expo prebuild --platform android --no-install)
#   (cd example/android && ./gradlew assembleRelease)
#   yarn e2e:android
#
# Env / flags:
#   APK, FLOW, DEBUG_OUTPUT, AVD_NAME, API_LEVEL, ANDROID_HOME
#   --skip-install     assume the app is already installed
#   --force-avd        delete and recreate the e2e AVD
#   --headless         no emulator window (also on when CI=true)
#   --keep-emulator    leave the AVD running after the script exits
#   --apk / --flow     override paths

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.maestro/bin:${PATH}"

APK="${APK:-example/android/app/build/outputs/apk/release/app-release.apk}"
FLOW="${FLOW:-.maestro/all-suites.yml}"
DEBUG_OUTPUT="${DEBUG_OUTPUT:-maestro-debug}"
export DEBUG_OUTPUT
AVD_NAME="${AVD_NAME:-expo-audio-e2e}"
API_LEVEL="${API_LEVEL:-34}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-600}"
SKIP_INSTALL=0
FORCE_AVD=0
KEEP_EMULATOR=0
HEADLESS=0
if [[ "${CI:-}" == "true" || "${E2E_HEADLESS:-}" == "1" ]]; then
  HEADLESS=1
fi

STARTED_EMULATOR=0
EMU_PID=""

usage() {
  sed -n '2,28p' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1; shift ;;
    --force-avd) FORCE_AVD=1; shift ;;
    --keep-emulator) KEEP_EMULATOR=1; shift ;;
    --headless) HEADLESS=1; shift ;;
    --apk) APK="$2"; shift 2 ;;
    --flow) FLOW="$2"; shift 2 ;;
    --debug-output) DEBUG_OUTPUT="$2"; shift 2 ;;
    --avd-name) AVD_NAME="$2"; shift 2 ;;
    --api-level) API_LEVEL="$2"; shift 2 ;;
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

host_abi() {
  case "$(uname -m)" in
    arm64|aarch64) echo arm64-v8a ;;
    x86_64|amd64) echo x86_64 ;;
    *)
      echo "unsupported host arch: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

resolve_android_home() {
  if [[ -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME" ]]; then
    return
  fi
  if [[ -n "${ANDROID_SDK_ROOT:-}" && -d "$ANDROID_SDK_ROOT" ]]; then
    export ANDROID_HOME="$ANDROID_SDK_ROOT"
    return
  fi
  for candidate in \
    "${HOME}/Library/Android/sdk" \
    "${HOME}/Android/Sdk" \
    /usr/local/lib/android/sdk; do
    if [[ -d "$candidate" ]]; then
      export ANDROID_HOME="$candidate"
      return
    fi
  done
  echo "ANDROID_HOME is not set and no SDK was found." >&2
  exit 1
}

prepend_sdk_path() {
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
  export PATH="${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"
  if [[ -d "${ANDROID_HOME}/cmdline-tools/latest/bin" ]]; then
    export PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${PATH}"
  elif [[ -d "${ANDROID_HOME}/cmdline-tools/bin" ]]; then
    export PATH="${ANDROID_HOME}/cmdline-tools/bin:${PATH}"
  fi
}

image_dir() {
  local target="$1" abi="$2"
  echo "${ANDROID_HOME}/system-images/android-${API_LEVEL}/${target}/${abi}"
}

# Prefer an already-installed API image for this ABI; otherwise pick a
# target we can download (default on x86_64 CI, google_apis on Apple silicon).
select_target() {
  local abi="$1" target
  for target in default google_apis google_apis_playstore; do
    if [[ -d "$(image_dir "$target" "$abi")" ]]; then
      echo "$target"
      return
    fi
  done
  if [[ "$abi" == "x86_64" ]]; then
    echo default
  else
    echo google_apis
  fi
}

avd_exists() {
  [[ -f "${HOME}/.android/avd/${AVD_NAME}.ini" ]]
}

ensure_sdk_bits() {
  need sdkmanager
  need avdmanager
  need emulator
  yes | sdkmanager --licenses >/dev/null || true
  local pkgs=()
  command -v adb >/dev/null 2>&1 || pkgs+=("platform-tools")
  [[ -x "${ANDROID_HOME}/emulator/emulator" ]] || pkgs+=("emulator")
  [[ -d "${ANDROID_HOME}/platforms/android-${API_LEVEL}" ]] || \
    pkgs+=("platforms;android-${API_LEVEL}")
  if [[ ${#pkgs[@]} -gt 0 ]]; then
    echo "installing SDK packages: ${pkgs[*]}"
    sdkmanager --install "${pkgs[@]}"
  fi
}

ensure_system_image() {
  local target="$1" abi="$2"
  if [[ -d "$(image_dir "$target" "$abi")" ]]; then
    return
  fi
  local pkg="system-images;android-${API_LEVEL};${target};${abi}"
  echo "installing system image: $pkg"
  sdkmanager --install "$pkg"
}

ensure_avd() {
  local target="$1" abi="$2"
  local pkg="system-images;android-${API_LEVEL};${target};${abi}"
  if [[ "$FORCE_AVD" -eq 1 ]] && avd_exists; then
    echo "deleting existing AVD $AVD_NAME"
    avdmanager delete avd -n "$AVD_NAME" || true
  fi
  if avd_exists; then
    echo "using existing AVD $AVD_NAME"
    return
  fi
  echo "creating AVD $AVD_NAME ($pkg)"
  echo no | avdmanager create avd \
    --force \
    -n "$AVD_NAME" \
    --package "$pkg" \
    --device pixel
}

device_online() {
  adb get-state >/dev/null 2>&1
}

wait_for_boot() {
  local deadline=$((SECONDS + BOOT_TIMEOUT))
  echo "waiting for emulator boot (timeout ${BOOT_TIMEOUT}s)"
  adb wait-for-device
  while (( SECONDS < deadline )); do
    local boot
    boot="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$boot" == "1" ]]; then
      echo "emulator booted"
      return 0
    fi
    sleep 2
  done
  echo "emulator did not boot within ${BOOT_TIMEOUT}s" >&2
  return 1
}

start_emulator() {
  local log="${DEBUG_OUTPUT}/emulator.log"
  mkdir -p "$DEBUG_OUTPUT"
  local opts=(-avd "$AVD_NAME" -no-snapshot -no-boot-anim -camera-back none)
  if [[ "$HEADLESS" -eq 1 ]]; then
    opts+=(-no-window -gpu swiftshader_indirect)
  else
    opts+=(-gpu auto)
  fi
  echo "starting emulator ${opts[*]}"
  emulator "${opts[@]}" >"$log" 2>&1 &
  EMU_PID=$!
  STARTED_EMULATOR=1
  wait_for_boot
  adb shell settings put global window_animation_scale 0.0 || true
  adb shell settings put global transition_animation_scale 0.0 || true
  adb shell settings put global animator_duration_scale 0.0 || true
}

cleanup() {
  if [[ "$STARTED_EMULATOR" -eq 1 && "$KEEP_EMULATOR" -eq 0 ]]; then
    echo "stopping emulator"
    adb emu kill >/dev/null 2>&1 || true
    if [[ -n "$EMU_PID" ]] && kill -0 "$EMU_PID" >/dev/null 2>&1; then
      kill "$EMU_PID" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

resolve_android_home
prepend_sdk_path
need adb
need maestro

if [[ ! -f "$FLOW" ]]; then
  echo "Maestro flow not found: $FLOW" >&2
  exit 1
fi

ABI="$(host_abi)"
TARGET="$(select_target "$ABI")"
ensure_sdk_bits
ensure_system_image "$TARGET" "$ABI"
ensure_avd "$TARGET" "$ABI"

if device_online; then
  echo "using already-attached device ($(adb get-serialno 2>/dev/null || echo unknown))"
else
  start_emulator
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
  echo "==== on-device suite status / failures ===="
  # Full `maestro hierarchy` is huge and looks hung; dump the compact
  # uiautomator tree and print the suite-status + per-test details.
  if adb shell uiautomator dump /sdcard/uidump.xml >/dev/null 2>&1; then
    adb pull /sdcard/uidump.xml "${DEBUG_OUTPUT}/uidump.xml" >/dev/null 2>&1 || true
    python3 - <<'PY' || true
import re, pathlib, os
p = pathlib.Path(os.environ.get("DEBUG_OUTPUT", "maestro-debug")) / "uidump.xml"
if not p.exists():
    raise SystemExit
xml = p.read_text(errors="replace")
for m in re.finditer(r'<node [^>]*>', xml):
    n = m.group(0)
    rid = re.search(r'resource-id="([^"]*)"', n)
    text = re.search(r'text="([^"]*)"', n)
    rid_s = rid.group(1) if rid else ""
    text_s = text.group(1) if text else ""
    if "suite-status" in rid_s or text_s in ("PASS", "FAIL", "READY", "RUNNING") or text_s.startswith("✓") or text_s.startswith("✗") or "got " in text_s or "timeout" in text_s.lower() or "error" in text_s.lower():
        print(f"{rid_s or '-':20} {text_s}")
PY
  fi
  echo "==== logcat tail ===="
  adb logcat -d | grep -iE 'expo|audiostream|pipeline|ReactNative|AndroidRuntime|maestro' | tail -n 200 || true
  echo "==== Maestro debug output: $DEBUG_OUTPUT ===="
  exit "$status"
fi
