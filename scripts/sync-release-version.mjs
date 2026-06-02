import fs from "node:fs/promises";
import path from "node:path";

const refName = process.env.GITHUB_REF_NAME;

if (!refName) {
  throw new Error("GITHUB_REF_NAME is required");
}

const version = refName.startsWith("v") ? refName.slice(1) : refName;

if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  throw new Error(`Unsupported release tag version: ${refName}`);
}

const rootDir = process.cwd();

const rewriteJsonVersion = async (filePath) => {
  const content = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(content);
  data.version = version;
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const rewriteCargoVersion = async (filePath) => {
  const content = await fs.readFile(filePath, "utf8");
  const updated = content.replace(/^version\s*=\s*".*?"$/m, `version = "${version}"`);
  await fs.writeFile(filePath, updated);
};

await Promise.all([
  rewriteJsonVersion(path.join(rootDir, "package.json")),
  rewriteJsonVersion(path.join(rootDir, "package-lock.json")),
  rewriteJsonVersion(path.join(rootDir, "src-tauri", "tauri.conf.json")),
  rewriteCargoVersion(path.join(rootDir, "src-tauri", "Cargo.toml")),
]);
