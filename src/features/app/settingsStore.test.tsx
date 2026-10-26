// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings } from "./appShared";
const { listen, command } = vi.hoisted(() => ({ listen: vi.fn(), command: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("./appRuntime", () => ({ isTauriRuntime: true, runCommand: command }));
beforeEach(() => { vi.resetModules(); listen.mockReset(); command.mockReset(); });
afterEach(cleanup);
it("registers once for concurrent consumers and ignores a stale initial load", async () => {
  let subscribed!: (dispose: () => void) => void; let loaded!: (value: unknown) => void;
  let receive!: (event: { payload: unknown }) => void;
  listen.mockImplementation((_name, callback) => { receive = callback; return new Promise(resolve => { subscribed = resolve; }); });
  command.mockImplementation(() => new Promise(resolve => { loaded = resolve; }));
  const { useAppSettings } = await import("./settingsStore");
  const first = renderHook(useAppSettings); const second = renderHook(useAppSettings);
  expect(listen).toHaveBeenCalledOnce(); expect(command).not.toHaveBeenCalled();
  await act(async () => subscribed(() => {})); expect(command).toHaveBeenCalledOnce();
  await act(async () => { receive({ payload: { ...defaultAppSettings, companionName: "new" } }); loaded({ ...defaultAppSettings, companionName: "old" }); });
  expect(first.result.current.settings.companionName).toBe("new"); expect(second.result.current.settings.companionName).toBe("new");
});
it("handles a failed subscription and retries on reload", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  listen.mockRejectedValueOnce(new Error("not ready")).mockResolvedValue(() => {});
  command.mockResolvedValue({ ...defaultAppSettings, companionName: "recovered" });
  const { useAppSettings } = await import("./settingsStore"); const hook = renderHook(useAppSettings);
  await waitFor(() => expect(error).toHaveBeenCalled());
  await act(async () => hook.result.current.reload());
  expect(hook.result.current.settings.companionName).toBe("recovered"); expect(listen).toHaveBeenCalledTimes(2);
  error.mockRestore();
});
