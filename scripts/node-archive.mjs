import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Extract an official Node distribution archive and return the extracted
 * `node` binary path.
 *
 * Windows deliberately uses the bundled bsdtar (`tar.exe`, shipped with
 * Windows 10 1803+ and all GitHub windows runners) instead of PowerShell's
 * `Expand-Archive`. The Archive module's `ExtractToDirectory` call does not
 * resolve on newer .NET runtimes (it throws "Cannot find an overload for
 * ExtractToDirectory and the argument count: 3"), and because PowerShell
 * cmdlet errors are non-terminating the process still exits 0 with nothing
 * extracted. The follow-up copy then failed with a bare ENOENT, which is how
 * the `rust (windows-latest)` job broke in CI. `tar -x` reads the same zip and
 * reports extraction failures through its exit code.
 */
export function extractNodeArchive({
  archivePath,
  destination,
  distribution,
  platform = process.platform,
  spawn = spawnSync,
  exists = existsSync,
}) {
  const windows = platform === "win32";
  const result = windows
    ? spawn("tar.exe", ["-xf", archivePath, "-C", destination], { stdio: "inherit" })
    : spawn("tar", ["-xzf", archivePath, "-C", destination], { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Unable to start tar for Node runtime: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Unable to extract Node runtime (tar exited ${result.status ?? "without a status"})`);
  }
  const binary = path.join(destination, distribution, windows ? "node.exe" : path.join("bin", "node"));
  // Guard against tools that exit 0 without writing anything: a missing binary
  // must fail here with a useful message, not later inside cpSync as ENOENT.
  if (!exists(binary)) {
    throw new Error(`Node runtime archive did not contain ${binary}`);
  }
  return binary;
}
