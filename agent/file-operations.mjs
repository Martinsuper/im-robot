import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
const digest = (text) => createHash("sha256").update(text).digest("hex");
async function snapshot(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("目标不是可安全验收的文本文件，或文件超过 20MB");
    const content = await readFile(file, "utf8");
    return { hash: digest(content), content };
  } catch (error) { if (error.code === "ENOENT") return { hash: null, content: null }; throw error; }
}
async function canonicalPath(target) {
  let cursor = target;
  const suffix = [];
  for (;;) {
    try { return path.join(await realpath(cursor), ...suffix); }
    catch (error) {
      if (error.code !== "ENOENT" || path.dirname(cursor) === cursor) throw error;
      suffix.unshift(path.basename(cursor)); cursor = path.dirname(cursor);
    }
  }
}
export class FileOperations {
  constructor(dataDir, root, { resuming = false } = {}) {
    this.directory = path.join(dataDir, "operations", digest(root)); this.resuming = resuming; this.reuseAuthorization = resuming;
  }
  revokeAuthorization() { this.reuseAuthorization = false; }
  async execute(tool, args, cwd, run, approve) {
    const target = path.resolve(cwd, args.path);
    const canonical = await canonicalPath(target);
    const operationKey = digest(JSON.stringify([tool, canonical, tool === "write" ? args.content : [args.oldText, args.newText]]));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const recordPath = path.join(this.directory, `${operationKey}.json`);
    let record;
    try { record = JSON.parse(await readFile(recordPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("操作检查点损坏，已阻止修改，请先核对文件"); }
    const before = await snapshot(canonical);
    let expected;
    if (tool === "write") expected = digest(args.content);
    else if (before.content !== null && typeof args.oldText === "string" && args.oldText.length && before.content.split(args.oldText).length === 2) {
      expected = digest(before.content.replace(args.oldText, args.newText));
    } else expected = record?.expected;
    const decorate = (result, verification) => ({ ...result, details: { ...result.details, verification },
      content: [...(result.content || []), { type: "text", text: verification.state === "verified" ? `已读回文件并核验内容${verification.reused ? "，未重复执行修改" : ""}。` : "文件操作未获得完整的读回验收，请先核对结果。" }] });
    if (expected && before.hash === expected) {
      return decorate({ content: [] }, { state: "verified", kind: "file-content", reused: true });
    }
    if (this.resuming && record && before.hash !== record.before) throw new Error("文件状态与检查点不一致，无法安全重放，请先只读核对后提出新的操作要求");
    if (!(this.reuseAuthorization && record?.approved && before.hash === record.before)) await approve();
    const save = async (value) => {
      const temporary = `${recordPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, recordPath);
    };
    record = { before: before.hash, expected, approved: true, state: "started" };
    await save(record); // Write-ahead checkpoint before any side effect.
    const result = await run();
    const after = await snapshot(canonical);
    const verification = { state: expected && after.hash === expected ? "verified" : "unknown", kind: "file-content", reused: false };
    await save({ ...record, state: verification.state });
    return decorate(result, verification);
  }
}
