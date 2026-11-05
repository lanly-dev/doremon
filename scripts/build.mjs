#!/usr/bin/env node
/**
 * Builds the Doremon desktop executable with the Neutralino CLI.
 *
 *   node scripts/build.mjs            # dist/ with the platform binary + resources.neu
 *   node scripts/build.mjs --single   # one self-contained executable
 *   node scripts/build.mjs --clean    # wipe dist/ before building
 *   node scripts/build.mjs --no-update # never run `neu update`
 *
 * Every build also writes resources/js/build-info.json (the git commit it was
 * made from) so the running app can show its own version in the footer.
 *
 * npm run build / npm run build:single wrap the two common cases.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const args = process.argv.slice(2);
const wantSingle = args.includes("--single") || args.includes("--embed");
const wantClean = args.includes("--clean");
const noUpdate = args.includes("--no-update");

const BUILD_INFO = "resources/js/build-info.json";

const PLATFORM_BINARY = {
  win32: "neutralino-win_x64.exe",
  darwin: "neutralino-mac_x64",
  linux: "neutralino-linux_x64",
};

const CONFIG = "neutralino.config.json";
const CLIENT_LIB = "resources/js/neutralino.js";

function log(message) {
  console.log(`\n\u001b[36m>\u001b[0m ${message}`);
}

function fail(message) {
  console.error(`\u001b[31mBuild failed:\u001b[0m ${message}`);
  process.exit(1);
}

/** Runs the Neutralino CLI through npx, inheriting the terminal. */
function neu(argv) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npx, ["--yes", "@neutralinojs/neu@latest", ...argv], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) fail(result.error.message);
  return result.status ?? 1;
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch (error) {
    fail(`cannot read ${CONFIG}: ${error.message}`);
  }
}

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function walk(dir, depth = 0) {
  if (!existsSync(dir) || depth > 3) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, depth + 1);
    return [{ path: full, size: statSync(full).size }];
  });
}

if (!existsSync(CONFIG)) fail(`${CONFIG} not found in ${root}`);
const config = readConfig();

function git(argv) {
  const result = spawnSync("git", argv, { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

/** Stamps the bundle with the commit it was built from (shown in the footer). */
function writeBuildInfo() {
  const commit = git(["rev-parse", "HEAD"]);
  const info = {
    commit,
    commitShort: commit.slice(0, 7),
    version: String(config.version || ""),
    notes: git(["log", "-1", "--format=%s"]),
    builtAt: new Date().toISOString(),
    dirty: git(["status", "--porcelain"]).length > 0,
  };
  writeFileSync(BUILD_INFO, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}
const binaryName = config?.cli?.binaryName ?? "app";
const platformBinary = PLATFORM_BINARY[process.platform];

log(`Building ${config.applicationId ?? "app"} ${config.version ?? ""} with Neutralino (${process.platform}/${process.arch})`);

// Binaries and the client library are fetched per machine by `neu update`.
const missing = [];
if (!existsSync(CLIENT_LIB)) missing.push(CLIENT_LIB);
if (platformBinary && !existsSync(join("bin", platformBinary))) {
  missing.push(join("bin", platformBinary));
}
if (missing.length > 0) {
  if (noUpdate) fail(`missing ${missing.join(", ")} (rerun without --no-update)`);
  log(`Fetching Neutralino binaries and client library (${missing.join(", ")})`);
  if (neu(["update"]) !== 0) fail("neu update failed");
} else {
  log("Neutralino binaries already present");
}

if (wantClean && existsSync("dist")) {
  log("Removing dist/");
  rmSync("dist", { recursive: true, force: true });
}

const buildInfo = writeBuildInfo();
log(`Stamped ${buildInfo.commitShort || "(no git commit)"} · ${buildInfo.notes || "no message"}`);

const buildArgs = ["build", "--release", ...(wantSingle ? ["--embed-resources"] : [])];
log(`neu ${buildArgs.join(" ")}`);
if (neu(buildArgs) !== 0) fail(`neu ${buildArgs.join(" ")} exited with an error`);

// Report what actually landed in dist/ rather than trusting the CLI's wording.
const files = walk("dist").sort((a, b) => b.size - a.size);
if (files.length === 0) fail("neu build reported success but dist/ is empty");

const executables = files.filter((file) =>
  process.platform === "win32" ? file.path.endsWith(".exe") : !/\.(neu|zip|txt)$/.test(file.path),
);

console.log(`\n\u001b[32mBuilt\u001b[0m ${relative(root, resolve("dist"))}/`);
for (const file of files) {
  console.log(`  ${humanSize(file.size).padStart(9)}  ${relative(root, file.path)}`);
}

for (const exe of executables) {
  console.log(`\nRun it: ${relative(root, exe.path)}`);
}
if (wantSingle) {
  console.log("Single-file build: everything including resources is inside the executable.");
} else if (files.some((file) => file.path.endsWith("resources.neu"))) {
  console.log("Keep resources.neu in the same folder as the executable when you move it.");
}
console.log("");
