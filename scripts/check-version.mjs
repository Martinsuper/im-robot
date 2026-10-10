import fs from "node:fs";

const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const inPackageSection = cargoToml.split("[package]")[1] ?? "";
const cargoVersion = inPackageSection
  .split(/\r?\n/)
  .find((line) => line.trim().startsWith("version = "))
  ?.split('"')[1];

const versions = {
  "package.json": packageVersion,
  "src-tauri/tauri.conf.json": tauriVersion,
  "src-tauri/Cargo.toml": cargoVersion,
};

if (!packageVersion || !tauriVersion || !cargoVersion) {
  console.error("版本号校验失败：有文件无法解析出版本号。");
  console.error(versions);
  process.exit(1);
}

const values = new Set(Object.values(versions));
if (values.size > 1) {
  console.error("版本号校验失败：三处版本号不一致，发布前必须统一：");
  for (const [file, version] of Object.entries(versions)) {
    console.error(`  ${file}: ${version}`);
  }
  process.exit(1);
}

console.log(`版本号校验通过：${packageVersion}`);
