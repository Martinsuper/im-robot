import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Create or resume a draft release; only an actual HTTP 404 permits creation. */
export function prepareRelease(repository, version, run = spawnSync) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) {
    throw new Error("Invalid release repository");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version ?? "")) {
    throw new Error("Invalid release version");
  }
  const endpoint = `repos/${repository}/releases`;
  const existing = run("gh", ["api", `${endpoint}/tags/v${version}`], { encoding: "utf8" });
  if (existing.error) throw existing.error;
  let result = existing;
  if (existing.status !== 0) {
    if (!/\(HTTP 404\)/.test(existing.stderr ?? "")) {
      throw new Error(existing.stderr || "Release lookup failed");
    }
    result = run("gh", ["api", endpoint, "--input", "-"], {
      encoding: "utf8",
      input: JSON.stringify({
        tag_name: `v${version}`,
        name: `Piko ${version}`,
        body: existsSync(`doc/releases/v${version}.md`)
          ? readFileSync(`doc/releases/v${version}.md`, "utf8")
          : "See the assets to download this version and install.",
        draft: true,
        prerelease: false,
      }),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || "Release creation failed");
  }
  const release = JSON.parse(result.stdout);
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.draft !== "boolean") {
    throw new Error("Invalid release metadata");
  }
  if (!release.draft) {
    throw new Error(`Release v${version} is already published; refusing to modify it`);
  }
  return release.id;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = prepareRelease(process.env.GH_REPO, process.env.RELEASE_VERSION);
  console.info(`Draft release ready: ${id}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `releaseId=${id}\n`);
}
