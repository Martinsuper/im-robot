import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { extractNodeArchive } from "./node-archive.mjs";

const distribution = "node-v22.23.3-win-x64";

test("Windows extracts with the bundled tar instead of Expand-Archive", () => {
  const calls = [];
  const binary = extractNodeArchive({
    archivePath: "C:\\tmp\\node.zip",
    destination: "C:\\tmp\\out",
    distribution,
    platform: "win32",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
    exists: () => true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "tar.exe");
  assert.deepEqual(calls[0].args, ["-xf", "C:\\tmp\\node.zip", "-C", "C:\\tmp\\out"]);
  assert.equal(binary, path.join("C:\\tmp\\out", distribution, "node.exe"));
});

test("a non-zero tar exit is reported instead of ignored", () => {
  assert.throws(
    () => extractNodeArchive({
      archivePath: "/tmp/node.tar.gz",
      destination: "/tmp/out",
      distribution: "node-v22.23.3-linux-x64",
      platform: "linux",
      spawn: () => ({ status: 2 }),
      exists: () => true,
    }),
    /tar exited 2/,
  );
});

test("a silent extraction failure fails before the binary copy", () => {
  // Regression for the windows-latest CI failure: the extractor exited 0
  // without writing anything and the copy surfaced only a bare ENOENT.
  assert.throws(
    () => extractNodeArchive({
      archivePath: "C:\\tmp\\node.zip",
      destination: "C:\\tmp\\out",
      distribution,
      platform: "win32",
      spawn: () => ({ status: 0 }),
      exists: () => false,
    }),
    /Node runtime archive did not contain .*node\.exe$/,
  );
});

test("a tar that cannot be started is reported", () => {
  assert.throws(
    () => extractNodeArchive({
      archivePath: "/tmp/node.tar.gz",
      destination: "/tmp/out",
      distribution: "node-v22.23.3-linux-x64",
      platform: "linux",
      spawn: () => ({ error: new Error("spawn tar ENOENT") }),
      exists: () => true,
    }),
    /Unable to start tar for Node runtime: spawn tar ENOENT/,
  );
});

test("extracts a real Node-style tarball", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "node-archive-"));
  const name = "node-v22.23.3-linux-x64";
  try {
    mkdirSync(path.join(directory, name, "bin"), { recursive: true });
    writeFileSync(path.join(directory, name, "bin", "node"), "#!/bin/sh\n");
    const archivePath = path.join(directory, "node.tar.gz");
    const tar = spawnSync("tar", ["-czf", archivePath, "-C", directory, name], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);

    const output = path.join(directory, "out");
    mkdirSync(output);
    const binary = extractNodeArchive({ archivePath, destination: output, distribution: name });
    assert.equal(binary, path.join(output, name, "bin", "node"));
    assert.ok(existsSync(binary));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
