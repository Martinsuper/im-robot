// @vitest-environment jsdom
import { act, useCallback } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useTauriEventSubscription } from "./useTauriEventSubscription";

const listenMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("../../app/appRuntime", () => ({
  isTauriRuntime: true,
}));

type Registration = {
  payload: unknown;
  handlers: Set<(event: { payload: unknown }) => void>;
};

const registrations: Registration[] = [];

function registerEvent(): Registration {
  const registration: Registration = { payload: undefined, handlers: new Set() };
  registrations.push(registration);
  listenMock.mockImplementationOnce(
    (_name: string, handler: (event: { payload: unknown }) => void) => {
      registration.handlers.add(handler);
      const unlisten: UnlistenFn = () => {
        registration.handlers.delete(handler);
      };
      return Promise.resolve(unlisten);
    }
  );
  return registration;
}

function emit(registration: Registration, payload: unknown) {
  for (const handler of registration.handlers) {
    handler({ payload });
  }
}

describe("useTauriEventSubscription", () => {
  beforeEach(() => {
    registrations.length = 0;
    listenMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not resubscribe when the handler identity stays stable across renders", async () => {
    const registration = registerEvent();
    const { rerender } = renderHook(({ value }: { value: number }) => {
      // 本地 hook 将 handler 纳入 effect 依赖：调用方需保证 handler 身份稳定，
      // 仅在真正的依赖变化时才重新订阅。
      const handler = useCallback(() => {
        void value;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      useTauriEventSubscription<number>("chat-event", handler);
    }, { initialProps: { value: 1 } });

    await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
    rerender({ value: 2 });
    rerender({ value: 3 });
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(registration.handlers.size).toBe(1);
  });

  it("invokes the latest handler closure with the event payload", async () => {
    const first = registerEvent();
    const second = registerEvent();
    const seen: number[] = [];
    const { rerender } = renderHook(({ value }: { value: number }) => {
      useTauriEventSubscription<number>("chat-event", (payload) => {
        seen.push(payload + value);
      });
    }, { initialProps: { value: 1 } });

    rerender({ value: 10 });
    await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    // 本地 hook 在 handler 变化时重新订阅：旧订阅已注销，新订阅持有最新闭包
    expect(first.handlers.size).toBe(0);
    act(() => emit(second, 5));
    expect(seen).toEqual([15]);
  });

  it("unlistens on unmount after the registration resolved", async () => {
    const registration = registerEvent();
    const { unmount } = renderHook(() => {
      useTauriEventSubscription<number>("chat-event", () => undefined);
    });
    await waitFor(() => expect(registration.handlers.size).toBe(1));

    unmount();
    expect(registration.handlers.size).toBe(0);
  });

  it("unlistens exactly once even when unmounting before registration resolves", async () => {
    const handlers = new Set<(event: { payload: unknown }) => void>();
    let releaseUnlisten: ((unlisten: UnlistenFn) => void) | null = null;
    listenMock.mockImplementationOnce((_name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.add(handler);
      return new Promise<UnlistenFn>((resolve) => {
        releaseUnlisten = resolve;
      });
    });

    const { unmount } = renderHook(() => {
      useTauriEventSubscription<number>("chat-event", () => undefined);
    });
    unmount();

    // listen() promise 在卸载之后才 resolve，也必须恰好注销一次
    await act(async () => {
      releaseUnlisten?.(() => handlers.clear());
    });
    expect(handlers.size).toBe(0);
  });
});
