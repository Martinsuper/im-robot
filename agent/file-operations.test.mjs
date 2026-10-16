import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileOperations } from "./file-operations.mjs";

async function setup(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), "piko-file-checkpoint-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, file: path.join(cwd, "result.txt"), args: { path: "result.txt", content: "expected" } };
}
test("a crash after the effect is reconciled without repeating the write", async (t) => {
  const { cwd, file, args } = await setup(t);
  const first = new FileOperations(cwd, "task");
  await assert.rejects(first.execute("write", args, cwd, async () => { await writeFile(file, args.content); throw new Error("simulated process failure"); }, async () => {}));
  const next = new FileOperations(cwd, "task", { resuming: true });
  const result = await next.execute("write", args, cwd, () => assert.fail("must not replay"), () => assert.fail("must not ask for an already satisfied effect"));
  assert.equal(result.details.verification.state, "verified");
  assert.equal(result.details.verification.reused, true);
});
test("an approved operation with unchanged pre-state resumes once and verifies content", async (t) => {
  const { cwd, file, args } = await setup(t);
  await assert.rejects(new FileOperations(cwd, "task").execute("write", args, cwd, async () => { throw new Error("failed before side effect"); }, async () => {}));
  const result = await new FileOperations(cwd, "task", { resuming: true }).execute("write", args, cwd, async () => { await writeFile(file, args.content); return { content: [] }; }, () => assert.fail("exact approved operation may resume"));
  assert.equal(result.details.verification.state, "verified");
});
test("external modifications prevent automatic replay", async (t) => {
  const { cwd, file, args } = await setup(t);
  await assert.rejects(new FileOperations(cwd, "task").execute("write", args, cwd, async () => { throw new Error("crash"); }, async () => {}));
  await writeFile(file, "external changes");
  await assert.rejects(new FileOperations(cwd, "task", { resuming: true }).execute("write", args, cwd, () => assert.fail("must not execute"), () => assert.fail("must not approve")), /检查点不一致/);
  assert.equal(await readFile(file, "utf8"), "external changes");
});
test("steering revokes reusable authorization for an unfinished operation", async (t) => {
  const { cwd, file, args } = await setup(t);
  await assert.rejects(new FileOperations(cwd, "task").execute("write", args, cwd, async () => { throw new Error("crash"); }, async () => {}));
  const next = new FileOperations(cwd, "task", { resuming: true }); next.revokeAuthorization();
  let approvals = 0;
  await next.execute("write", args, cwd, async () => { await writeFile(file, args.content); return { content: [] }; }, async () => { approvals++; });
  assert.equal(approvals, 1);
});
