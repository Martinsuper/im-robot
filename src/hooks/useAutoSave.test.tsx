// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAutoSave } from "./useAutoSave";
const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../components/feedback/toastStore", () => ({ useToast: () => ({ error }) }));
it("flushes on unmount, suppresses component callbacks, and keeps app-level failure feedback", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const persist = vi.fn(() => pending); const rollback = vi.fn(); const success = vi.fn();
  const hook = renderHook(() => useAutoSave());
  act(() => hook.result.current.schedule(persist, { rollback, onSuccess: success }));
  hook.unmount();
  await act(async () => { await Promise.resolve(); reject(new Error("save unavailable")); });
  expect(persist).toHaveBeenCalledOnce(); expect(rollback).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
});
