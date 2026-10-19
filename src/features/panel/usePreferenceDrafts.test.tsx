// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../app/appShared";
import { usePreferenceDrafts } from "./usePreferenceDrafts";
const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../app/appRuntime", () => ({ runCommand: command }));
beforeEach(() => {
  vi.useFakeTimers();
  command.mockReset().mockImplementation(async (_name, { input }) => ({ ...defaultAppSettings, ...input }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("saves two groups changed within the same debounce interval", async () => {
  const hook = renderHook(() => usePreferenceDrafts(defaultAppSettings));
  act(() => { hook.result.current.updatePreferences({ companionName: "Mochi" }); hook.result.current.updateWorkRhythm({ breakReminderIntervalMinutes: 60 }); });
  await act(async () => vi.advanceTimersByTimeAsync(401));
  expect(command.mock.calls.map(c => c[0]).sort()).toEqual(["update_preferences", "update_work_rhythm_preferences"]);
  expect(hook.result.current.companionName).toBe("Mochi");
});
it("invalid rhythm input never cancels a valid edit in another group", async () => {
  const hook = renderHook(() => usePreferenceDrafts(defaultAppSettings));
  act(() => { hook.result.current.updatePreferences({ companionName: "Mochi" }); hook.result.current.updateWorkRhythm({ breakReminderQuietHoursStart: "invalid" }); });
  await act(async () => vi.advanceTimersByTimeAsync(401));
  expect(command).toHaveBeenCalledTimes(1); expect(command.mock.calls[0][0]).toBe("update_preferences");
});
it("leaving the tab flushes pending valid edits", async () => {
  const hook = renderHook(() => usePreferenceDrafts(defaultAppSettings));
  act(() => hook.result.current.updatePreferences({ companionName: "Saved on leave" }));
  hook.unmount(); await act(async () => { await Promise.resolve(); });
  expect(command).toHaveBeenCalledOnce();
});
