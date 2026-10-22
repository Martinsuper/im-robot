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
  const next = new FileOperations(cwd, "task", { resuming: true }); await next.revokeAuthorization();
  let approvals = 0;
  await next.execute("write", args, cwd, async () => { await writeFile(file, args.content); return { content: [] }; }, async () => { approvals++; });
  assert.equal(approvals, 1);
});

test("a completed target removed by someone else is not silently recreated", async (t) => {
  const { cwd, file, args } = await setup(t);
  await new FileOperations(cwd, "task").execute("write", args, cwd, async () => { await writeFile(file, args.content); return { content: [] }; }, async () => {});
  await rm(file);
  await assert.rejects(new FileOperations(cwd, "task", { resuming: true }).execute("write", args, cwd, () => assert.fail("must not recreate"), () => assert.fail("must not reuse permission")), /检查点不一致/);
});
test("raw bytes must match; invalid UTF-8 is not equivalent to replacement characters", async (t) => {
  const { cwd, file } = await setup(t);
  await writeFile(file, Buffer.from([255]));
  let writes = 0;
  const result = await new FileOperations(cwd, "task").execute("write", { path: "result.txt", content: "�" }, cwd, async () => { writes++; await writeFile(file, "�"); return { content: [] }; }, async () => {});
  assert.equal(writes, 1); assert.equal(result.details.verification.reused, false);
});
test("revocation remains effective after restarting the runner", async (t) => {
  const { cwd, file, args } = await setup(t);
  const original = new FileOperations(cwd, "task");
  await assert.rejects(original.execute("write", args, cwd, async () => { throw new Error("crash"); }, async () => {}));
  await original.revokeAuthorization();
  let approvals = 0;
  await new FileOperations(cwd, "task", { resuming: true }).execute("write", args, cwd, async () => { await writeFile(file, args.content); return { content: [] }; }, async () => { approvals++; });
  assert.equal(approvals, 1);
});

async function sdkEdit(cwd, args) {
  const { fileTools, normalizeEditArguments } = await import('./sdk-adapter.mjs');
  return fileTools(cwd).find(tool => tool.name === 'edit').execute('regression', normalizeEditArguments(args));
}

test('SDK batch edits verify BOM, CRLF and literal replacement text, then resume without replay', async (t) => {
  const { cwd, file } = await setup(t);
  await writeFile(file, '\uFEFFalpha\r\nbeta\r\n');
  const args = { path: 'result.txt', edits: [{ oldText: 'alpha', newText: '$& first' }, { oldText: 'beta', newText: 'second' }] };
  const result = await new FileOperations(cwd, 'task').execute('edit', args, cwd, () => sdkEdit(cwd, args), async () => {});
  assert.equal(await readFile(file, 'utf8'), '\uFEFF$& first\r\nsecond\r\n');
  assert.equal(result.details.verification.state, 'verified');
  const resumed = await new FileOperations(cwd, 'task', { resuming: true }).execute('edit', args, cwd, () => assert.fail('must not replay'), () => assert.fail('already applied'));
  assert.equal(resumed.details.verification.reused, true);
});

test('changed batch edits cannot reuse authorization after a crash', async (t) => {
  const { cwd, file } = await setup(t);
  await writeFile(file, 'before');
  const original = { path: 'result.txt', edits: [{ oldText: 'before', newText: 'approved' }] };
  await assert.rejects(new FileOperations(cwd, 'task').execute('edit', original, cwd, async () => { throw Error('crash'); }, async () => {}));
  const changed = { path: 'result.txt', edits: [{ oldText: 'before', newText: 'not approved' }] };
  let approvals = 0;
  await assert.rejects(new FileOperations(cwd, 'task', { resuming: true }).execute('edit', changed, cwd, () => assert.fail('must not run'), async () => { approvals++; throw Error('denied'); }), /denied/);
  assert.equal(approvals, 1);
  assert.equal(await readFile(file, 'utf8'), 'before');
  const resumed = await new FileOperations(cwd, 'task', { resuming: true }).execute('edit', original, cwd, () => sdkEdit(cwd, original), () => assert.fail('same edit already approved'));
  assert.equal(resumed.details.verification.state, 'verified');
});

test('batch edit crash after writing reconciles the completed effect', async (t) => {
  const { cwd, file } = await setup(t);
  await writeFile(file, 'before');
  const args = { path: 'result.txt', edits: [{ oldText: 'before', newText: 'after' }] };
  await assert.rejects(new FileOperations(cwd, 'task').execute('edit', args, cwd, async () => { await sdkEdit(cwd, args); throw Error('crash'); }, async () => {}));
  const result = await new FileOperations(cwd, 'task', { resuming: true }).execute('edit', args, cwd, () => assert.fail('must not replay'), () => assert.fail('already applied'));
  assert.equal(result.details.verification.state, 'verified');
});
