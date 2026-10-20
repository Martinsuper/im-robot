// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useConversationSurface } from "./useConversationSurface";

const native = vi.hoisted(() => ({
  innerSize: vi.fn(async () => ({ toLogical: () => ({ width: 480, height: 420 }) })),
  scaleFactor: vi.fn(async () => 2),
  setDecorations: vi.fn(async () => {}),
  setSkipTaskbar: vi.fn(async () => {}),
  setSize: vi.fn(async () => {}),
  isFullscreen: vi.fn(async () => true),
  setFullscreen: vi.fn(async () => {}),
  isMaximized: vi.fn(async () => true),
  unmaximize: vi.fn(async () => {}),
}));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => native,
  LogicalSize: class { constructor(public width: number, public height: number) {} },
}));

it("expands and returns to the original quick size without replacing the conversation", async () => {
  const onError = vi.fn();
  const { result } = renderHook(() => useConversationSurface(onError));
  await act(() => result.current.toggle());
  expect(result.current.expanded).toBe(true);
  expect(native.setDecorations).toHaveBeenLastCalledWith(true);
  expect(native.setSkipTaskbar).toHaveBeenLastCalledWith(false);
  expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 860, height: 700 }));
  await act(() => result.current.toggle());
  expect(result.current.expanded).toBe(false);
  expect(native.setFullscreen).toHaveBeenCalledWith(false);
  expect(native.unmaximize).toHaveBeenCalled();
  expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 480, height: 420 }));
  expect(onError).not.toHaveBeenCalled();
});

it("reports native errors and releases the pending lock", async () => {
  native.setDecorations.mockRejectedValueOnce(new Error("denied"));
  const onError = vi.fn();
  const { result } = renderHook(() => useConversationSurface(onError));
  await act(() => result.current.toggle());
  expect(onError).toHaveBeenCalled();
  expect(result.current.expanded).toBe(false);
  expect(result.current.pending).toBe(false);
});
