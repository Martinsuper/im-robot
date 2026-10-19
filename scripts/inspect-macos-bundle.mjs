import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentRuntimeFiles } from "./agent-runtime-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin")
  throw new Error("macOS bundle inspection requires macOS");
const bundle = path.resolve(
  process.argv[2] ||
    path.join(root, "src-tauri/target/release/bundle/macos/Piko.app"),
);
const contents = path.join(bundle, "Contents");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command}: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}
function plist(key) {
  return run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    path.join(contents, "Info.plist"),
  ]);
}
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(plist("CFBundleShortVersionString"), pkg.version);
assert.equal(plist("CFBundleExecutable"), "im-robot");
for (const key of [
  "NSCalendarsUsageDescription",
  "NSCalendarsFullAccessUsageDescription",
  "NSCalendarsWriteOnlyAccessUsageDescription",
])
  assert.ok(plist(key));
const executable = path.join(contents, "MacOS/im-robot");
const architecture = run("file", [executable]);
assert.ok(
  architecture.includes(process.arch === "arm64" ? "arm64" : "x86_64"),
  architecture,
);
const runtime = path.join(contents, "Resources/agent-runtime");
for (const file of agentRuntimeFiles) {
  assert.deepEqual(
    readFileSync(path.join(runtime, file)),
    readFileSync(path.join(root, "agent", file)),
    `Stale or missing shipped source: ${file}`,
  );
}
const node = path.join(contents, "MacOS/piko-agent-node");
assert.ok(statSync(node).mode & 0o111, "Bundled Node must be executable");
const sdkVersion = JSON.parse(
  readFileSync(path.join(root, "agent/package.json"), "utf8"),
).dependencies["@earendil-works/pi-coding-agent"];
const output = run(
  node,
  [
    "--input-type=module",
    "-e",
    `
  import assert from 'node:assert/strict';
  import { readFile } from 'node:fs/promises';
  const sdk = await import('@earendil-works/pi-coding-agent');
  assert.equal(typeof sdk.createAgentSession, 'function');
  const pkg = JSON.parse(await readFile('node_modules/@earendil-works/pi-coding-agent/package.json', 'utf8'));
  assert.equal(pkg.version, ${JSON.stringify(sdkVersion)});
  await import('./sdk-adapter.mjs');
  await import('./protocol.mjs');
  console.log('Bundled Node/SDK/adapter/protocol OK', process.version, process.arch);
`,
  ],
  runtime,
);
console.log(output);
console.log(`macOS bundle verified: ${bundle}`);
console.log(
  "This inspection does not launch the desktop app or establish signing/notarization status.",
);
