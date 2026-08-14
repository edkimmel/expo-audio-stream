#!/usr/bin/env node
/**
 * Run the on-device Maestro e2e suites on an iOS Simulator.
 * Same entry point locally and in CI.
 *
 * Boots a named simulator if none is attached, installs a Metro-free .app,
 * and runs Maestro. On failure: compact UI/log dump (not full hierarchy).
 *
 *   yarn e2e:ios
 *   yarn e2e:ios -- --skip-install
 *   yarn e2e:ios -- --keep-simulator   # leave the sim up after the run
 *   yarn e2e:ios -- --skip-sim         # simulator already booted (CI)
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(process.argv[1] ?? "."), "..");
process.chdir(ROOT);
process.env.PATH = `${join(homedir(), ".maestro", "bin")}:${process.env.PATH ?? ""}`;

const BUNDLE_ID = "com.edkimmel.audiostream.dev";

const PREFERRED_SIM_NAMES = [
  "iPhone 16",
  "iPhone 16e",
  "iPhone 17",
  "iPhone 15",
  "iPhone 17 Pro",
  "iPhone 16 Pro",
];

type SimDevice = {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
};

type Options = {
  app: string;
  flow: string;
  debugOutput: string;
  simName: string | undefined;
  simUdid: string | undefined;
  skipInstall: boolean;
  skipSim: boolean;
  keepSimulator: boolean;
  headless: boolean;
};

const USAGE = `Run the on-device Maestro e2e suites on an iOS Simulator.

Prerequisites:
  - Xcode + simctl (xcode-select -p)
  - maestro on PATH, or ~/.maestro/bin/maestro
  - a built simulator .app (Release, or Debug with JS bundled; no Metro)

Typical local loop:
  (cd example && npx expo prebuild --platform ios --no-install)
  (cd example && npx pod-install ios)
  (cd example/ios && WORKSPACE=$(ls -d *.xcworkspace | head -n1) && \\
     SCHEME="\${WORKSPACE%.xcworkspace}" && \\
     xcodebuild build -workspace "$WORKSPACE" -scheme "$SCHEME" \\
       -configuration Release \\
       -destination 'platform=iOS Simulator,name=<iPhone>' \\
       -derivedDataPath DerivedData \\
       CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO)
  yarn e2e:ios

Flags:
  --skip-install      assume the app is already installed
  --skip-sim          do not boot/stop a simulator; require one already booted
  --keep-simulator    leave the simulator running after the script exits
  --headless          do not open Simulator.app (also on when CI=true)
  --app PATH          override .app
  --flow PATH         override Maestro flow
  --debug-output DIR  override debug dir
  --sim-name NAME     preferred simulator name (default: first available iPhone)
  --sim-udid UDID     boot/use this UDID
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    app: process.env.APP ?? "",
    flow: process.env.FLOW ?? ".maestro/all-suites.yml",
    debugOutput: process.env.DEBUG_OUTPUT ?? "maestro-debug",
    simName: process.env.SIM_NAME,
    simUdid: process.env.SIM_UDID,
    skipInstall: false,
    skipSim: false,
    keepSimulator: false,
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
      case "--skip-sim":
        opts.skipSim = true;
        break;
      case "--keep-simulator":
        opts.keepSimulator = true;
        break;
      case "--headless":
        opts.headless = true;
        break;
      case "--app":
        opts.app = next();
        break;
      case "--flow":
        opts.flow = next();
        break;
      case "--debug-output":
        opts.debugOutput = next();
        break;
      case "--sim-name":
        opts.simName = next();
        break;
      case "--sim-udid":
        opts.simUdid = next();
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
  const result = spawnSync("/bin/sh", ["-c", `command -v ${JSON.stringify(bin)}`], {
    encoding: "utf8",
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
  opts: { ignoreStatus?: boolean; stdio?: "inherit" | "pipe"; timeoutMs?: number } = {}
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: opts.stdio === "inherit" ? "inherit" : "pipe",
    timeout: opts.timeoutMs,
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

function defaultAppPath(): string | undefined {
  const products = join(
    ROOT,
    "example/ios/DerivedData/Build/Products"
  );
  if (!existsSync(products)) return undefined;
  const configs = ["Release-iphonesimulator", "Debug-iphonesimulator"];
  for (const config of configs) {
    const dir = join(products, config);
    if (!existsSync(dir)) continue;
    const apps = readdirSync(dir).filter((name) => name.endsWith(".app"));
    if (apps[0]) return join(dir, apps[0]);
  }
  return undefined;
}

function listDevices(): SimDevice[] {
  const raw = run("xcrun", ["simctl", "list", "devices", "available", "-j"]).stdout;
  const parsed = JSON.parse(raw) as {
    devices: Record<string, Array<Record<string, unknown>>>;
  };
  const out: SimDevice[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    for (const device of devices) {
      if (device.isAvailable === false) continue;
      out.push({
        udid: String(device.udid ?? ""),
        name: String(device.name ?? ""),
        state: String(device.state ?? ""),
        runtime,
        isAvailable: true,
      });
    }
  }
  return out.filter((d) => d.udid);
}

function isIphone(device: SimDevice): boolean {
  return device.name.startsWith("iPhone");
}

function pickDevice(opts: Options, devices: SimDevice[]): SimDevice {
  if (opts.simUdid) {
    const match = devices.find((d) => d.udid === opts.simUdid);
    if (!match) fail(`simulator UDID not found: ${opts.simUdid}`);
    return match;
  }

  const booted = devices.filter((d) => d.state === "Booted");
  if (!opts.simName && booted.length === 1) return booted[0];
  if (!opts.simName && booted.length > 1) {
    return booted.find(isIphone) ?? booted[0];
  }

  const wanted = opts.simName;
  if (wanted) {
    const exact = devices.find((d) => d.name === wanted);
    if (exact) return exact;
    fail(
      `simulator named ${JSON.stringify(wanted)} not found. available: ${devices
        .map((d) => d.name)
        .join(", ")}`
    );
  }

  for (const name of PREFERRED_SIM_NAMES) {
    const match = devices.find((d) => d.name === name);
    if (match) return match;
  }
  const iphone = devices.find(isIphone);
  if (iphone) return iphone;
  if (devices[0]) return devices[0];
  fail("no available iOS Simulators. Install a runtime in Xcode → Settings → Platforms.");
}

function bootedDevices(devices: SimDevice[]): SimDevice[] {
  return devices.filter((d) => d.state === "Booted");
}

function bootSimulator(device: SimDevice, headless: boolean): void {
  if (device.state !== "Booted") {
    console.log(`booting simulator ${device.name} (${device.udid})`);
    run("xcrun", ["simctl", "boot", device.udid], { ignoreStatus: true });
  } else {
    console.log(`using already-booted simulator ${device.name} (${device.udid})`);
  }
  run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], { timeoutMs: 180_000 });
  if (!headless) {
    run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", device.udid], {
      ignoreStatus: true,
    });
  }
}

function stopSimulator(device: SimDevice | undefined, keep: boolean, weBooted: boolean): void {
  if (keep) {
    console.log("leaving simulator running (--keep-simulator)");
    return;
  }
  if (!device || !weBooted) return;
  console.log(`shutting down simulator ${device.name} (${device.udid})`);
  run("xcrun", ["simctl", "shutdown", device.udid], { ignoreStatus: true });
}

function grantMicrophone(udid: string): void {
  run("xcrun", ["simctl", "privacy", udid, "grant", "microphone", BUNDLE_ID], {
    ignoreStatus: true,
  });
}

function interestingDumpLine(id: string, text: string): boolean {
  return (
    id.includes("suite-status") ||
    id.includes("suite-link") ||
    ["PASS", "FAIL", "READY", "RUNNING"].includes(text) ||
    text.startsWith("✓") ||
    text.startsWith("✗") ||
    text.includes("got ") ||
    text.toLowerCase().includes("timeout") ||
    text.toLowerCase().includes("error")
  );
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) walkFiles(path, acc);
      else acc.push(path);
    } catch {
      // ignore races
    }
  }
  return acc;
}

function dumpMaestroDebug(debugOutput: string): void {
  const files = walkFiles(debugOutput).filter((path) =>
    /\.(json|xml|txt|log)$/i.test(path)
  );
  if (!files.length) return;
  console.log("==== maestro-debug interesting lines ====");
  for (const file of files) {
    let body = "";
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (body.length > 2_000_000) continue;
    const lines = body.split(/\r?\n/).filter((line) => {
      const id = line.match(/"(?:id|resource-id|identifier)"\s*:\s*"([^"]*)"/i)?.[1] ?? "";
      const text = line.match(/"(?:text|label|value)"\s*:\s*"([^"]*)"/i)?.[1] ?? line;
      return interestingDumpLine(id, text);
    });
    if (lines.length) {
      console.log(`-- ${file} --`);
      console.log(lines.slice(0, 80).join("\n"));
    }
  }
}

function dumpSimLogs(udid: string): void {
  console.log("==== simulator log tail ====");
  const result = run(
    "xcrun",
    [
      "simctl",
      "spawn",
      udid,
      "log",
      "show",
      "--last",
      "2m",
      "--style",
      "compact",
      "--predicate",
      'eventMessage CONTAINS[c] "pipeline" OR eventMessage CONTAINS[c] "audiostream" OR eventMessage CONTAINS[c] "expo" OR processImagePath CONTAINS[c] "expoaudiostream" OR subsystem CONTAINS[c] "com.facebook.react"',
    ],
    { ignoreStatus: true, timeoutMs: 20_000 }
  );
  const lines = (result.stdout || result.stderr || "")
    .split("\n")
    .filter((line) => line.trim())
    .slice(-200);
  if (lines.length) console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  need("xcrun");
  need("maestro");

  if (!existsSync(opts.flow)) fail(`Maestro flow not found: ${opts.flow}`);

  const app = opts.app || defaultAppPath();
  if (!opts.skipInstall) {
    if (!app || !existsSync(app)) {
      fail(
        [
          `app not found: ${opts.app || "example/ios/DerivedData/Build/Products/*-iphonesimulator/*.app"}`,
          "build it first, e.g.:",
          "  (cd example && npx expo prebuild --platform ios --no-install)",
          "  (cd example && npx pod-install ios)",
          "  (cd example/ios && WORKSPACE=$(ls -d *.xcworkspace | head -n1) && \\",
          '     SCHEME="${WORKSPACE%.xcworkspace}" && \\',
          "     xcodebuild build -workspace \"$WORKSPACE\" -scheme \"$SCHEME\" \\",
          "       -configuration Release \\",
          "       -destination 'platform=iOS Simulator,name=<iPhone>' \\",
          "       -derivedDataPath DerivedData \\",
          "       CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO)",
        ].join("\n")
      );
    }
  }

  const devices = listDevices();
  let device: SimDevice | undefined;
  let weBooted = false;

  if (opts.skipSim) {
    const booted = bootedDevices(devices);
    if (!booted.length) {
      fail("--skip-sim requires an already-booted simulator (`xcrun simctl list devices`)");
    }
    device = pickDevice({ ...opts, simName: opts.simName }, booted);
    console.log(`using already-booted simulator ${device.name} (${device.udid})`);
  } else {
    device = pickDevice(opts, devices);
    weBooted = device.state !== "Booted";
    process.on("exit", () => stopSimulator(device, opts.keepSimulator, weBooted));
    process.on("SIGINT", () => process.exit(130));
    process.on("SIGTERM", () => process.exit(143));
    bootSimulator(device, opts.headless);
  }

  if (!opts.skipInstall && app) {
    console.log(`installing ${app}`);
    run("xcrun", ["simctl", "install", device.udid, app], { stdio: "inherit" });
    grantMicrophone(device.udid);
  } else {
    console.log("skipping install (--skip-install)");
    grantMicrophone(device.udid);
  }

  mkdirSync(opts.debugOutput, { recursive: true });
  const maestro = run(
    "maestro",
    ["--device", device.udid, "test", opts.flow, "--debug-output", opts.debugOutput],
    { stdio: "inherit", ignoreStatus: true }
  );
  if (maestro.status !== 0) {
    dumpMaestroDebug(opts.debugOutput);
    dumpSimLogs(device.udid);
    console.log(`==== Maestro debug output: ${opts.debugOutput} ====`);
    process.exit(maestro.status);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
