import { afterEach, expect, it, vi } from "vitest";
import { AutoSaveQueue } from "./autoSaveQueue";
afterEach(() => vi.useRealTimers());
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
it("keeps groups independent and flushes edits when leaving", async () => {
  const first = new AutoSaveQueue(); const second = new AutoSaveQueue();
  const saved: string[] = [];
  first.schedule(async () => { saved.push("preferences"); }, () => {}, () => {}, 10000);
  second.schedule(async () => { saved.push("rhythm"); }, () => {}, () => {}, 10000);
  await Promise.all([first.flush(), second.flush()]);
  expect(saved.sort()).toEqual(["preferences", "rhythm"]);
});
it("serializes saves and suppresses obsolete callbacks", async () => {
  const queue = new AutoSaveQueue(); const gate = deferred(); const saved: number[] = [];
  const oldSuccess = vi.fn(); const latestSuccess = vi.fn();
  queue.schedule(async () => { await gate.promise; saved.push(1); }, oldSuccess, vi.fn(), 10000);
  const first = queue.flush(); await Promise.resolve();
  queue.schedule(async () => { saved.push(2); }, latestSuccess, vi.fn(), 10000);
  const second = queue.flush(); await Promise.resolve(); expect(saved).toEqual([]);
  gate.resolve(); await Promise.all([first, second]);
  expect(saved).toEqual([1, 2]); expect(oldSuccess).not.toHaveBeenCalled(); expect(latestSuccess).toHaveBeenCalledOnce();
});
it("cancel invalidates running callbacks and removes pending edits", async () => {
  const queue = new AutoSaveQueue(); const gate = deferred(); const callback = vi.fn();
  queue.schedule(() => gate.promise, callback, callback, 10000);
  const running = queue.flush(); await Promise.resolve(); queue.cancel(); gate.resolve(); await running;
  expect(callback).not.toHaveBeenCalled();
  const effect = vi.fn(); queue.schedule(effect, callback, callback, 10000); queue.cancel(); await queue.flush(); expect(effect).not.toHaveBeenCalled();
});
it("reports a failure and continues saving", async () => {
  const queue = new AutoSaveQueue(); const failed = vi.fn(); const success = vi.fn();
  queue.schedule(async () => { throw new Error("disk full"); }, success, failed, 10000); await queue.flush();
  expect(failed).toHaveBeenCalledOnce();
  queue.schedule(async () => 2, success, failed, 10000); await queue.flush(); expect(success).toHaveBeenCalledWith(2);
});
