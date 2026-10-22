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
  outerPosition: vi.fn(async () => ({ toLogical: () => ({ x: 1200, y: 700 }) })),
  setPosition: vi.fn(async () => {}),
}));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => native,
  currentMonitor: async () => ({ scaleFactor: 2, workArea: { position: { x: 0, y: 0 }, size: { width: 2880, height: 1800 } } }),
  LogicalSize: class { constructor(public width: number, public height: number) {} },
  LogicalPosition: class { constructor(public x: number, public y: number) {} },
}));


it("opens the adjacent workspace once, clamps to screen, then restores the chat size", async () => {
  const { result } = renderHook(() => useConversationSurface(vi.fn()));
  await act(async () => { expect(await result.current.setWorkspaceOpen(true)).toBe(true); });
  expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 880, height: 700 }));
  expect(native.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 560, y: 200 }));
  const count = native.setSize.mock.calls.length;
  await act(async () => { await result.current.setWorkspaceOpen(true); });
  expect(native.setSize).toHaveBeenCalledTimes(count);
  await act(async () => { await result.current.setWorkspaceOpen(false); });
  expect(native.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 480, height: 420 }));
  expect(native.setPosition).toHaveBeenLastCalledWith(expect.objectContaining({ x: 1200, y: 700 }));
});

it("reports resize errors and allows retry without changing native window controls", async () => {
  native.setSize.mockRejectedValueOnce(new Error("denied"));
  const onError = vi.fn();
  const { result } = renderHook(() => useConversationSurface(onError));
  await act(async () => { expect(await result.current.setWorkspaceOpen(true)).toBe(false); });
  expect(onError).toHaveBeenCalled();
  expect(result.current.pending).toBe(false);
  await act(async () => { expect(await result.current.setWorkspaceOpen(true)).toBe(true); });
  expect(native.setDecorations).not.toHaveBeenCalled();
  expect(native.setSkipTaskbar).not.toHaveBeenCalled();
});

it("keeps a wide native window unchanged when opening and closing its panel", async () => {
  native.innerSize.mockResolvedValueOnce({ toLogical: () => ({ width: 1200, height: 760 }) });
  native.outerPosition.mockResolvedValueOnce({ toLogical: () => ({ x: 0, y: 0 }) });
  const sizes = native.setSize.mock.calls.length;
  const positions = native.setPosition.mock.calls.length;
  const maximized = native.unmaximize.mock.calls.length;
  const { result } = renderHook(() => useConversationSurface(vi.fn()));
  await act(async () => { await result.current.setWorkspaceOpen(true); });
  await act(async () => { await result.current.setWorkspaceOpen(false); });
  expect(native.setSize).toHaveBeenCalledTimes(sizes);
  expect(native.setPosition).toHaveBeenCalledTimes(positions);
  expect(native.unmaximize).toHaveBeenCalledTimes(maximized);
});
