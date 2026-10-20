// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PointerEvent } from "react";

const command = vi.hoisted(() => vi.fn(async () => [0, 0]));
vi.mock("../../app/appRuntime", () => ({
  isTauriRuntime: true, runCommand: command, reportCommandError: () => vi.fn(),
}));
import { usePetDrag } from "./usePetDrag";

it("captures dragging outside the pet and releases without opening chat; a tap still opens chat", async () => {
  const target = {
    setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
  };
  const event = (x: number) => ({
    button: 0, buttons: 1, pointerId: 1, screenX: x, screenY: 10,
    clientX: x, clientY: 10, currentTarget: target, preventDefault: vi.fn(),
  } as unknown as PointerEvent);
  const onClick = vi.fn();
  const onDragEnd = vi.fn();
  const hook = renderHook(() => usePetDrag({ onClick, onDragEnd }));
  await act(async () => { hook.result.current.handlers.onPointerDown(event(10)); });
  expect(target.setPointerCapture).toHaveBeenCalledWith(1);
  act(() => { hook.result.current.handlers.onPointerMove(event(400)); });
  expect(command).toHaveBeenCalledWith("move_pet", { x: 390, y: 0 });
  act(() => { hook.result.current.handlers.onPointerUp(event(400)); });
  expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(onDragEnd).toHaveBeenCalledOnce();
  expect(onClick).not.toHaveBeenCalled();
  await act(async () => { hook.result.current.handlers.onPointerDown(event(10)); });
  act(() => { hook.result.current.handlers.onPointerUp(event(10)); });
  expect(onClick).toHaveBeenCalledOnce();
  hook.unmount();
});

it("cancels a pending press without a click and ignores right-button drag starts", async () => {
  const onClick = vi.fn();
  const onLongPressEnd = vi.fn();
  const target = { setPointerCapture: vi.fn() };
  const event = (button: number) => ({
    button, pointerId: 1, screenX: 10, screenY: 10, clientX: 10, clientY: 10,
    currentTarget: target,
  } as unknown as PointerEvent);
  const hook = renderHook(() => usePetDrag({ onClick, onLongPressEnd }));
  act(() => { hook.result.current.handlers.onPointerDown(event(2)); });
  expect(target.setPointerCapture).not.toHaveBeenCalled();
  await act(async () => { hook.result.current.handlers.onPointerDown(event(0)); });
  expect(hook.result.current.isLongPressing).toBe(true);
  act(() => { hook.result.current.handlers.onPointerCancel(); });
  expect(hook.result.current.isLongPressing).toBe(false);
  expect(hook.result.current.isDragging).toBe(false);
  expect(onLongPressEnd).toHaveBeenCalledOnce();
  act(() => { hook.result.current.handlers.onPointerUp(event(0)); });
  expect(onClick).not.toHaveBeenCalled();
  hook.unmount();
});
