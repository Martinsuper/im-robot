import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Sherpa native cache rejects empty and partially restored libraries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sherpa-cache-"));
  try {
    const binary = path.join(dir, process.platform === "win32" ? "test.exe" : "test");
    const source = fileURLToPath(new URL("../src-tauri/vendor/sherpa-onnx-sys/native_cache.rs", import.meta.url));
    const compile = spawnSync("rustc", ["--edition=2021", "--test", source, "-o", binary], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || String(compile.error));
    const run = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
