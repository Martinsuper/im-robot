// One-time migration of the configured CLIProxyAPI key; never log credentials.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const source = process.argv[2] ?? path.join(os.homedir(), ".config/opencode/opencode.json");
const destination = process.argv[3] ?? path.join(os.homedir(), "Library/Application Support/com.duanluyao.imrobot/api-credentials.json");
if (fs.existsSync(destination)) {
  console.log("Credential configuration already exists; preserved.");
} else {
  const config = JSON.parse(fs.readFileSync(source, "utf8"));
  const key = config.provider?.cliproxy?.options?.apiKey;
  if (typeof key !== "string" || !key.trim() || key.startsWith("{env:") || key.startsWith("{file:")) {
    throw new Error("CLIProxyAPI has no directly configured API key to migrate.");
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.migration-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ apiKey: key.trim() }, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log("CLIProxyAPI key migrated to the Piko credential configuration.");
}
