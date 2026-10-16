import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Calendar bridge checks require macOS; skipped");
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "piko-calendar-test-"));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
try {
  for (const key of ["NSCalendarsUsageDescription", "NSCalendarsFullAccessUsageDescription", "NSCalendarsWriteOnlyAccessUsageDescription"]) {
    assert.ok(run("plutil", ["-extract", key, "raw", "-o", "-", "src-tauri/Info.plist"]).length);
  }
  const binary = path.join(directory, "calendar-bridge-smoke");
  run("clang", ["-fobjc-arc", "-framework", "Foundation", "-framework", "EventKit", "scripts/calendar-bridge-smoke.m", "-o", binary]);
  console.log(run(binary, []));
} finally {
  await rm(directory, { recursive: true, force: true });
}
