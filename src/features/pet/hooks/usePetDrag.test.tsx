// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PointerEvent } from "react";

const command = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>, fallback?: unknown) => Promise<number[]>>(async () => [0, 0]));
vi.mock("../../app/appRuntime", () => ({
  isTauriRuntime: true,
  runCommand: command,
  reportCommandError: () => vi.fn(),
}));
import { usePetDrag } from "./usePetDrag";

it("captures dragging outside the pet and releases without opening chat; a tap still opens chat", async () => {
  const target = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  };
  const event = (x: number) =>
    ({
      button: 0,
      buttons: 1,
      pointerId: 1,
      screenX: x,
      screenY: 10,
      clientX: x,
      clientY: 10,
      currentTarget: target,
      preventDefault: vi.fn(),
    }) as unknown as PointerEvent;
  const onClick = vi.fn();
  const onDragEnd = vi.fn();
  const hook = renderHook(() => usePetDrag({ onClick, onDragEnd }));
  await act(async () => {
    hook.result.current.handlers.onPointerDown(event(10));
  });
  expect(target.setPointerCapture).toHaveBeenCalledWith(1);
  await act(async () => {
    hook.result.current.handlers.onPointerMove(event(400));
  });
  expect(command).toHaveBeenCalledWith("move_pet", { x: 390, y: 0 });
  act(() => {
    hook.result.current.handlers.onPointerUp(event(400));
  });
  expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
  expect(onDragEnd).toHaveBeenCalledOnce();
  expect(onClick).not.toHaveBeenCalled();
  await act(async () => {
    hook.result.current.handlers.onPointerDown(event(10));
  });
  act(() => {
    hook.result.current.handlers.onPointerUp(event(10));
  });
  expect(onClick).toHaveBeenCalledOnce();
  hook.unmount();
});

it("cancels a pending press without a click and ignores right-button drag starts", async () => {
  const onClick = vi.fn();
  const onLongPressEnd = vi.fn();
  const target = { setPointerCapture: vi.fn() };
  const event = (button: number) =>
    ({
      button,
      pointerId: 1,
      screenX: 10,
      screenY: 10,
      clientX: 10,
      clientY: 10,
      currentTarget: target,
    }) as unknown as PointerEvent;
  const hook = renderHook(() => usePetDrag({ onClick, onLongPressEnd }));
  act(() => {
    hook.result.current.handlers.onPointerDown(event(2));
  });
  expect(target.setPointerCapture).not.toHaveBeenCalled();
  await act(async () => {
    hook.result.current.handlers.onPointerDown(event(0));
  });
  expect(hook.result.current.isLongPressing).toBe(true);
  act(() => {
    hook.result.current.handlers.onPointerCancel();
  });
  expect(hook.result.current.isLongPressing).toBe(false);
  expect(hook.result.current.isDragging).toBe(false);
  expect(onLongPressEnd).toHaveBeenCalledOnce();
  act(() => {
    hook.result.current.handlers.onPointerUp(event(0));
  });
  expect(onClick).not.toHaveBeenCalled();
  hook.unmount();
});

it("snaps after a slow drag using the visible character bounds", async () => {
  command.mockClear();
  let now = 0;
  const timer = vi
    .spyOn(performance, "now")
    .mockImplementation(() => (now += 10000));
  const target = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({
      left: 63,
      top: 94,
      right: 197,
      bottom: 254,
    }),
  };
  const event = (x: number) =>
    ({
      button: 0,
      buttons: 1,
      pointerId: 1,
      screenX: x,
      screenY: 100,
      clientX: x,
      clientY: 100,
      currentTarget: target,
      preventDefault: vi.fn(),
    }) as unknown as PointerEvent;
  const hook = renderHook(() => usePetDrag({}));
  try {
    await act(async () => {
      hook.result.current.handlers.onPointerDown(event(100));
    });
    await act(async () => {
      hook.result.current.handlers.onPointerMove(event(120));
    });
    await act(async () => {
      hook.result.current.handlers.onPointerUp(event(120));
    });
    expect(command).toHaveBeenLastCalledWith("move_pet", {
      x: 0,
      y: 0,
      snapInsets: [63, 94, window.innerWidth - 197, window.innerHeight - 254],
    });
  } finally {
    hook.unmount();
    timer.mockRestore();
  }
});

it("waits for the initial position before applying a fast drag and release", async () => {
  command.mockClear();
  let resolvePosition!: (position: number[]) => void;
  command.mockImplementationOnce(
    () =>
      new Promise<number[]>((resolve) => {
        resolvePosition = resolve;
      }),
  );
  const target = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  };
  const event = (x: number) =>
    ({
      button: 0,
      buttons: 1,
      pointerId: 1,
      screenX: x,
      screenY: 100,
      currentTarget: target,
      preventDefault: vi.fn(),
    }) as unknown as PointerEvent;
  const hook = renderHook(() => usePetDrag({}));
  await act(async () => {
    hook.result.current.handlers.onPointerDown(event(100));
  });
  act(() => {
    hook.result.current.handlers.onPointerMove(event(140));
  });
  act(() => {
    hook.result.current.handlers.onPointerUp(event(140));
  });
  expect(command).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolvePosition([300, 200]);
  });
  expect(command).toHaveBeenCalledWith("move_pet", { x: 340, y: 200 });
  expect(
    command.mock.calls.some(
      (call) => call[0] === "move_pet" && "snapInsets" in (call[1] as object),
    ),
  ).toBe(true);
  hook.unmount();
});

it("drops old queued moves when another gesture starts during slow native movement", async () => {
  command.mockClear();
  let releaseMove!: (position: number[]) => void;
  command.mockImplementationOnce(async () => [0, 0]);
  command.mockImplementationOnce(
    () =>
      new Promise<number[]>((resolve) => {
        releaseMove = resolve;
      }),
  );
  const target = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  };
  const event = (x: number) =>
    ({
      button: 0,
      buttons: 1,
      pointerId: 1,
      screenX: x,
      screenY: 100,
      currentTarget: target,
      preventDefault: vi.fn(),
    }) as unknown as PointerEvent;
  const hook = renderHook(() => usePetDrag({}));
  await act(async () => {
    hook.result.current.handlers.onPointerDown(event(100));
  });
  await act(async () => {
    hook.result.current.handlers.onPointerMove(event(120));
  });
  act(() => {
    hook.result.current.handlers.onPointerMove(event(140));
  });
  act(() => {
    hook.result.current.handlers.onPointerCancel();
  });
  act(() => {
    hook.result.current.handlers.onPointerDown(event(200));
  });
  await act(async () => {
    releaseMove([20, 0]);
  });
  expect(command).not.toHaveBeenCalledWith("move_pet", { x: 40, y: 0 });
  expect(
    command.mock.calls.filter((call) => call[0] === "get_pet_position"),
  ).toHaveLength(2);
  hook.unmount();
});
