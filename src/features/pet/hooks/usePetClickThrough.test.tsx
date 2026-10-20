// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PointerEvent } from "react";

const native = vi.hoisted(() => ({
  cursor: vi.fn(async () => ({ x: 100, y: 200 })),
  origin: vi.fn(async () => ({ x: 100, y: 200 })),
  scale: vi.fn(async () => 2),
  ignore: vi.fn(async (_ignore: boolean) => {}),
}));
vi.mock("../../app/appRuntime", () => ({ isTauriRuntime: true }));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: native.cursor,
  getCurrentWindow: () => ({
    innerPosition: native.origin,
    scaleFactor: native.scale,
    setIgnoreCursorEvents: native.ignore,
  }),
}));
import { usePetClickThrough } from "./usePetClickThrough";

function region(left = 70, top = 80, width = 120, height = 130) {
  const element = document.createElement("div");
  element.dataset.petInteractive = "";
  element.getBoundingClientRect = () => ({ left, top, right: left + width, bottom: top + height, width, height } as DOMRect);
  document.body.append(element);
  return element;
}
function press(button = 0) {
  return { button, target: null } as unknown as PointerEvent<HTMLElement>;
}
async function tick() {
  await act(async () => { await vi.advanceTimersByTimeAsync(25); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  native.cursor.mockResolvedValue({ x: 100, y: 200 });
  native.origin.mockResolvedValue({ x: 100, y: 200 });
  native.scale.mockResolvedValue(2);
  native.ignore.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it("passes blank space through, restores on OS cursor entry at 2x scale, and avoids redundant writes", async () => {
  region();
  const hook = renderHook(() => usePetClickThrough());
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(true);
  const calls = native.ignore.mock.calls.length;
  await tick();
  expect(native.ignore).toHaveBeenCalledTimes(calls);
  native.cursor.mockResolvedValue({ x: 300, y: 400 });
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(false);
  hook.unmount();
});

it.each([1, 1.5, 2])("converts negative desktop origins at scale %s", async (scale) => {
  region();
  native.origin.mockResolvedValue({ x: -1000, y: -500 });
  native.scale.mockResolvedValue(scale);
  native.cursor.mockResolvedValue({ x: -1000 + 100 * scale, y: -500 + 100 * scale });
  const hook = renderHook(() => usePetClickThrough());
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(false);
  hook.unmount();
});

it("tracks reminder appearance, removal and zero-size hidden elements", async () => {
  const hook = renderHook(() => usePetClickThrough());
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(true);
  const notice = region(0, 0, 30, 30);
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(false);
  notice.remove();
  region(0, 0, 0, 0);
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(true);
  hook.unmount();
});

it.each(["onPointerUpCapture", "onPointerCancelCapture"] as const)("keeps dragging interactive outside the pet until %s", async (release) => {
  region();
  native.cursor.mockResolvedValue({ x: 300, y: 400 });
  const hook = renderHook(() => usePetClickThrough());
  await tick();
  hook.result.current.onPointerDownCapture(press());
  native.cursor.mockResolvedValue({ x: 100, y: 200 });
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(false);
  hook.result.current[release]();
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(true);
  hook.unmount();
});

it("does not latch a right-button press while a native context menu is opening", async () => {
  const hook = renderHook(() => usePetClickThrough());
  hook.result.current.onPointerDownCapture(press(2));
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(true);
  hook.unmount();
});

it.each(["cursor", "origin", "scale"] as const)("restores interaction on %s query failure and recovers on the next poll", async (query) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  native[query].mockRejectedValueOnce(new Error("query failed"));
  const hook = renderHook(() => usePetClickThrough());
  await act(async () => { await Promise.resolve(); });
  expect(native.ignore).toHaveBeenLastCalledWith(false);
  expect(log).toHaveBeenCalledOnce();
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(true);
  hook.unmount();
});

it("recovers when a native ignore write fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  native.ignore.mockRejectedValueOnce(new Error("write failed"));
  const hook = renderHook(() => usePetClickThrough());
  await act(async () => { await Promise.resolve(); });
  expect(native.ignore).toHaveBeenLastCalledWith(false);
  await tick();
  expect(native.ignore).toHaveBeenLastCalledWith(true);
  hook.unmount();
});

it("does not overlap slow queries and does not apply a stale query after unmount", async () => {
  const pending = deferred<{ x: number; y: number }>();
  native.cursor.mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => usePetClickThrough());
  await tick();
  await tick();
  expect(native.cursor).toHaveBeenCalledOnce();
  hook.unmount();
  await act(async () => { pending.resolve({ x: 100, y: 200 }); });
  expect(native.ignore.mock.calls.every(([value]) => value === false)).toBe(true);
  const calls = native.ignore.mock.calls.length;
  await tick();
  expect(native.ignore).toHaveBeenCalledTimes(calls);
});

it("restores input after an in-flight ignore write finishes following unmount", async () => {
  const pending = deferred<void>();
  native.ignore.mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => usePetClickThrough());
  await act(async () => { await Promise.resolve(); });
  expect(native.ignore).toHaveBeenLastCalledWith(true);
  hook.unmount();
  await act(async () => { pending.resolve(); });
  expect(native.ignore).toHaveBeenLastCalledWith(false);
});

it("undoes an in-flight ignore write immediately if a drag begins during it", async () => {
  const pending = deferred<void>();
  native.ignore.mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => usePetClickThrough());
  await act(async () => { await Promise.resolve(); });
  hook.result.current.onPointerDownCapture(press());
  await act(async () => { pending.resolve(); });
  expect(native.ignore).toHaveBeenLastCalledWith(false);
  hook.unmount();
});
