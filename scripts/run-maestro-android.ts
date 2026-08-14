#!/usr/bin/env node
/**
 * Run the on-device Maestro e2e suites. Same entry point locally and in CI.
 *
 * Ensures an AVD exists (installing the system image if needed), boots it
 * when no device is already attached, installs the APK, and runs Maestro.
 * On failure: compact uiautomator dump + filtered logcat.
 *
 *   yarn e2e:android
 *   yarn e2e:android -- --skip-install
 *   yarn e2e:android -- --keep-emulator   # leave the AVD up after the run
 *   yarn e2e:android -- --skip-avd        # device already attached (CI)
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
process.chdir(ROOT);
process.env.PATH = `${join(homedir(), ".maestro", "bin")}:${process.env.PATH ?? ""}`;

type Options = {
  apk: string;
  flow: string;
  debugOutput: string;
  avdName: string;
  apiLevel: string;
  bootTimeoutSec: number;
  skipInstall: boolean;
  skipAvd: boolean;
  forceAvd: boolean;
  keepEmulator: boolean;
  headless: boolean;
};

const USAGE = `Run the on-device Maestro e2e suites.

Prerequisites:
  - Android SDK (ANDROID_HOME or ~/Library/Android/sdk)
  - Java (sdkmanager / emulator)
  - maestro on PATH, or ~/.maestro/bin/maestro
  - a built APK (default: example release)

Typical local loop:
  (cd example && npx expo prebuild --platform android --no-install)
  (cd example/android && ./gradlew assembleRelease)
  yarn e2e:android

Flags:
  --skip-install     assume the app is already installed
  --skip-avd         do not create/boot/stop an AVD; require a device on adb
  --force-avd        delete and recreate the e2e AVD
  --headless         no emulator window (also on when CI=true)
  --keep-emulator    leave the AVD running after the script exits
  --apk PATH         override APK
  --flow PATH        override Maestro flow
  --debug-output DIR override debug dir
  --avd-name NAME    override AVD name (default expo-audio-e2e)
  --api-level N      override API level (default 34)
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    apk:
      process.env.APK ??
      "example/android/app/build/outputs/apk/release/app-release.apk",
    flow: process.env.FLOW ?? ".maestro/all-suites.yml",
    debugOutput: process.env.DEBUG_OUTPUT ?? "maestro-debug",
    avdName: process.env.AVD_NAME ?? "expo-audio-e2e",
    apiLevel: process.env.API_LEVEL ?? "34",
    bootTimeoutSec: Number(process.env.BOOT_TIMEOUT ?? 600),
    skipInstall: false,
    skipAvd: false,
    forceAvd: false,
    keepEmulator: false,
    headless: process.env.CI === "true" || process.env.E2E_HEADLESS === "1",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) fail(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--skip-install":
        opts.skipInstall = true;
        break;
      case "--skip-avd":
        opts.skipAvd = true;
        break;
      case "--force-avd":
        opts.forceAvd = true;
        break;
      case "--keep-emulator":
        opts.keepEmulator = true;
        break;
      case "--headless":
        opts.headless = true;
        break;
      case "--apk":
        opts.apk = next();
        break;
      case "--flow":
        opts.flow = next();
        break;
      case "--debug-output":
        opts.debugOutput = next();
        break;
      case "--avd-name":
        opts.avdName = next();
        break;
      case "--api-level":
        opts.apiLevel = next();
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--":
        break;
      default:
        fail(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return opts;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function which(bin: string): string | undefined {
  const result = spawnSync("command", ["-v", bin], {
    encoding: "utf8",
    shell: true,
  });
  const path = result.stdout.trim();
  return result.status === 0 && path ? path : undefined;
}

function need(bin: string): string {
  const path = which(bin);
  if (!path) fail(`missing required tool: ${bin}`);
  return path;
}

function run(
  command: string,
  args: string[],
  opts: { ignoreStatus?: boolean; input?: string; stdio?: "inherit" | "pipe" } = {}
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    stdio: opts.stdio === "inherit" ? "inherit" : "pipe",
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  const status = result.status ?? 1;
  if (status !== 0 && !opts.ignoreStatus) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} exited ${status}${detail ? `\n${detail}` : ""}`);
  }
  return {
    status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function hostAbi(): "arm64-v8a" | "x86_64" {
  const arch = process.arch;
  if (arch === "arm64") return "arm64-v8a";
  if (arch === "x64") return "x86_64";
  fail(`unsupported host arch: ${arch}`);
}

function resolveAndroidHome(): string {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
    join(homedir(), "Android/Sdk"),
    "/usr/local/lib/android/sdk",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.env.ANDROID_HOME = candidate;
      process.env.ANDROID_SDK_ROOT = process.env.ANDROID_SDK_ROOT ?? candidate;
      return candidate;
    }
  }
  fail("ANDROID_HOME is not set and no SDK was found.");
}

function cmdlineToolBins(androidHome: string): string[] {
  const root = join(androidHome, "cmdline-tools");
  const bins: string[] = [];
  // Prefer `latest`, then any other installed cmdline-tools version
  // (GitHub-hosted images sometimes ship `latest-2` / a versioned dir).
  for (const name of ["latest", "latest-2"]) {
    const dir = join(root, name, "bin");
    if (existsSync(dir)) bins.push(dir);
  }
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry, "bin");
      if (existsSync(dir) && !bins.includes(dir)) bins.push(dir);
    }
  }
  const legacy = join(root, "bin");
  if (existsSync(legacy)) bins.push(legacy);
  return bins;
}

function prependSdkPath(androidHome: string): void {
  const extras = [
    ...cmdlineToolBins(androidHome),
    join(androidHome, "platform-tools"),
    join(androidHome, "emulator"),
  ].filter((dir) => existsSync(dir));
  process.env.PATH = `${extras.join(":")}:${process.env.PATH ?? ""}`;
}

function imageDir(
  androidHome: string,
  apiLevel: string,
  target: string,
  abi: string
): string {
  return join(androidHome, "system-images", `android-${apiLevel}`, target, abi);
}

function selectTarget(
  androidHome: string,
  apiLevel: string,
  abi: string
): string {
  for (const target of ["default", "google_apis", "google_apis_playstore"]) {
    if (existsSync(imageDir(androidHome, apiLevel, target, abi))) return target;
  }
  return abi === "x86_64" ? "default" : "google_apis";
}

function avdIni(avdName: string): string {
  return join(homedir(), ".android", "avd", `${avdName}.ini`);
}

function acceptLicenses(): void {
  run("sdkmanager", ["--licenses"], { ignoreStatus: true, input: "y\n".repeat(40) });
}

function emulatorBinary(androidHome: string): string {
  return join(androidHome, "emulator", "emulator");
}

function ensureSdkBits(androidHome: string, apiLevel: string): void {
  need("sdkmanager");
  need("avdmanager");
  acceptLicenses();

  const pkgs: string[] = [];
  if (!which("adb") && !existsSync(join(androidHome, "platform-tools", "adb"))) {
    pkgs.push("platform-tools");
  }
  if (!existsSync(emulatorBinary(androidHome))) {
    pkgs.push("emulator");
  }
  if (!existsSync(join(androidHome, "platforms", `android-${apiLevel}`))) {
    pkgs.push(`platforms;android-${apiLevel}`);
  }
  if (pkgs.length > 0) {
    console.log(`installing SDK packages: ${pkgs.join(" ")}`);
    run("sdkmanager", ["--install", ...pkgs], { stdio: "inherit" });
  }
  // Newly installed emulator/platform-tools won't be on PATH until we
  // re-scan ANDROID_HOME. Require the binaries only after that.
  prependSdkPath(androidHome);
  need("adb");
  need("emulator");
}

function ensureSystemImage(
  androidHome: string,
  apiLevel: string,
  target: string,
  abi: string
): string {
  const pkg = `system-images;android-${apiLevel};${target};${abi}`;
  if (!existsSync(imageDir(androidHome, apiLevel, target, abi))) {
    console.log(`installing system image: ${pkg}`);
    run("sdkmanager", ["--install", pkg], { stdio: "inherit" });
  }
  return pkg;
}

function ensureAvd(opts: Options, pkg: string): void {
  if (opts.forceAvd && existsSync(avdIni(opts.avdName))) {
    console.log(`deleting existing AVD ${opts.avdName}`);
    run("avdmanager", ["delete", "avd", "-n", opts.avdName], { ignoreStatus: true });
  }
  if (existsSync(avdIni(opts.avdName))) {
    console.log(`using existing AVD ${opts.avdName}`);
    return;
  }
  console.log(`creating AVD ${opts.avdName} (${pkg})`);
  run(
    "avdmanager",
    ["create", "avd", "--force", "-n", opts.avdName, "--package", pkg, "--device", "pixel"],
    { input: "no\n", stdio: "pipe" }
  );
}

function deviceOnline(): boolean {
  return run("adb", ["get-state"], { ignoreStatus: true }).status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForBoot(timeoutSec: number): Promise<void> {
  console.log(`waiting for emulator boot (timeout ${timeoutSec}s)`);
  run("adb", ["wait-for-device"]);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const boot = run("adb", ["shell", "getprop", "sys.boot_completed"], {
      ignoreStatus: true,
    })
      .stdout.replace(/\r/g, "")
      .trim();
    if (boot === "1") {
      console.log("emulator booted");
      return;
    }
    await sleep(2000);
  }
  fail(`emulator did not boot within ${timeoutSec}s`);
}

function disableAnimations(): void {
  for (const key of [
    "window_animation_scale",
    "transition_animation_scale",
    "animator_duration_scale",
  ]) {
    run("adb", ["shell", "settings", "put", "global", key, "0.0"], {
      ignoreStatus: true,
    });
  }
}

function startEmulator(opts: Options): ChildProcess {
  mkdirSync(opts.debugOutput, { recursive: true });
  const logPath = join(opts.debugOutput, "emulator.log");
  const log = createWriteStream(logPath);
  const args = [
    "-avd",
    opts.avdName,
    "-no-snapshot",
    "-no-boot-anim",
    "-camera-back",
    "none",
    ...(opts.headless ? ["-no-window", "-gpu", "swiftshader_indirect"] : ["-gpu", "auto"]),
  ];
  console.log(`starting emulator ${args.join(" ")}`);
  const child = spawn("emulator", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  // Piped stdio would otherwise pin the Node event loop after Maestro exits.
  child.unref();
  return child;
}

/** `adb emu avd name` → first line is the AVD, or empty on a physical device. */
function attachedAvdName(): string | undefined {
  const result = run("adb", ["emu", "avd", "name"], { ignoreStatus: true });
  if (result.status !== 0) return undefined;
  const name = result.stdout.split(/\r?\n/)[0]?.trim();
  return name && name !== "OK" ? name : undefined;
}

function stopE2eAvd(opts: Options, child?: ChildProcess): void {
  if (opts.keepEmulator) {
    console.log("leaving emulator running (--keep-emulator)");
    return;
  }
  const name = attachedAvdName();
  if (name && name !== opts.avdName) {
    console.log(`leaving attached device ${name} running (not ${opts.avdName})`);
    return;
  }
  if (!name && !child) return;
  console.log(`stopping emulator ${opts.avdName}`);
  run("adb", ["emu", "kill"], { ignoreStatus: true });
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

function interestingDumpLine(rid: string, text: string): boolean {
  return (
    rid.includes("suite-status") ||
    ["PASS", "FAIL", "READY", "RUNNING"].includes(text) ||
    text.startsWith("✓") ||
    text.startsWith("✗") ||
    text.includes("got ") ||
    text.toLowerCase().includes("timeout") ||
    text.toLowerCase().includes("error")
  );
}

function dumpFailureUi(debugOutput: string): void {
  console.log("==== on-device suite status / failures ====");
  const dump = run(
    "adb",
    ["shell", "uiautomator", "dump", "/sdcard/uidump.xml"],
    { ignoreStatus: true }
  );
  if (dump.status !== 0) return;
  mkdirSync(debugOutput, { recursive: true });
  const local = join(debugOutput, "uidump.xml");
  run("adb", ["pull", "/sdcard/uidump.xml", local], { ignoreStatus: true });
  if (!existsSync(local)) return;
  const xml = readFileSync(local, "utf8");
  for (const match of xml.matchAll(/<node [^>]*>/g)) {
    const node = match[0];
    const rid = node.match(/resource-id="([^"]*)"/)?.[1] ?? "";
    const text = node.match(/text="([^"]*)"/)?.[1] ?? "";
    if (interestingDumpLine(rid, text)) {
      console.log(`${(rid || "-").padEnd(20)} ${text}`);
    }
  }
}

function dumpLogcat(): void {
  console.log("==== logcat tail ====");
  const logcat = run("adb", ["logcat", "-d"], { ignoreStatus: true }).stdout;
  const keep = /expo|audiostream|pipeline|ReactNative|AndroidRuntime|maestro/i;
  const lines = logcat.split("\n").filter((line) => keep.test(line)).slice(-200);
  if (lines.length) console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  prependSdkPath(resolveAndroidHome());
  need("adb");
  need("maestro");

  if (!existsSync(opts.flow)) fail(`Maestro flow not found: ${opts.flow}`);

  let emulator: ChildProcess | undefined;
  if (opts.skipAvd) {
    if (!deviceOnline()) {
      fail("--skip-avd requires an already-attached device (`adb devices`)");
    }
    const serial = run("adb", ["get-serialno"], { ignoreStatus: true }).stdout.trim();
    const avd = attachedAvdName();
    console.log(
      `using already-attached device (${serial || "unknown"}${avd ? `, avd=${avd}` : ""})`
    );
  } else {
    const androidHome = resolveAndroidHome();
    prependSdkPath(androidHome);
    const abi = hostAbi();
    const target = selectTarget(androidHome, opts.apiLevel, abi);
    ensureSdkBits(androidHome, opts.apiLevel);
    const pkg = ensureSystemImage(androidHome, opts.apiLevel, target, abi);
    ensureAvd(opts, pkg);

    const startedEmulator = !deviceOnline();
    process.on("exit", () => stopE2eAvd(opts, emulator));
    process.on("SIGINT", () => process.exit(130));
    process.on("SIGTERM", () => process.exit(143));

    if (startedEmulator) {
      emulator = startEmulator(opts);
      await waitForBoot(opts.bootTimeoutSec);
      disableAnimations();
    } else {
      const serial = run("adb", ["get-serialno"], { ignoreStatus: true }).stdout.trim();
      const avd = attachedAvdName();
      console.log(
        `using already-attached device (${serial || "unknown"}${avd ? `, avd=${avd}` : ""})`
      );
    }
  }

  if (!opts.skipInstall) {
    if (!existsSync(opts.apk)) {
      fail(
        [
          `APK not found: ${opts.apk}`,
          "build it first, e.g.:",
          "  (cd example && npx expo prebuild --platform android --no-install)",
          "  (cd example/android && ./gradlew assembleRelease)",
        ].join("\n")
      );
    }
    console.log(`installing ${opts.apk}`);
    run("adb", ["install", "-r", opts.apk], { stdio: "inherit" });
  } else {
    console.log("skipping install (--skip-install)");
  }

  const maestro = run(
    "maestro",
    ["test", opts.flow, "--debug-output", opts.debugOutput],
    { stdio: "inherit", ignoreStatus: true }
  );
  if (maestro.status !== 0) {
    dumpFailureUi(opts.debugOutput);
    dumpLogcat();
    console.log(`==== Maestro debug output: ${opts.debugOutput} ====`);
    process.exit(maestro.status);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
