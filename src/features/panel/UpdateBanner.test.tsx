// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateBanner } from "./UpdateBanner";
const { command, listen, settingsRef } = vi.hoisted(() => ({
  command: vi.fn(),
  listen: vi.fn(),
  settingsRef: { skippedUpdateVersion: "" },
}));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true, runCommand: command }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
vi.mock("../app/settingsStore", () => ({ useAppSettings: () => ({ settings: settingsRef }) }));
const release = { currentVersion: "1.3.0", latestVersion: "1.4.0", available: true, releaseUrl: "https://github.com/Martinsuper/im-robot/releases/latest", releaseNotes: null, downloadUrl: null, assetName: null };
beforeEach(() => {
  vi.clearAllMocks();
  settingsRef.skippedUpdateVersion = "";
  listen.mockResolvedValue(() => {});
  command.mockImplementation(async name => name === "get_last_update_status" ? null : undefined);
});
afterEach(cleanup);
it("stays hidden until an update is available", async () => {
  const { container } = render(<UpdateBanner onOpenSettings={() => {}} />);
  expect(container.textContent).toBe("");
  await act(async () => listen.mock.calls[0][1]({ payload: { ...release, available: false } }));
  expect(container.textContent).toBe("");
  await act(async () => listen.mock.calls[0][1]({ payload: release }));
  expect(screen.getByRole("status").textContent).toContain("v1.4.0");
});
it("reconciles the cached status after subscribing", async () => {
  command.mockImplementation(async name => name === "get_last_update_status" ? release : undefined);
  render(<UpdateBanner onOpenSettings={() => {}} />);
  expect(await screen.findByRole("status").then(node => node.textContent)).toContain("发现新版本");
});
it("navigates to settings and skips the version persistently", async () => {
  const onOpenSettings = vi.fn();
  render(<UpdateBanner onOpenSettings={onOpenSettings} />);
  await act(async () => listen.mock.calls[0][1]({ payload: release }));
  fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
  expect(onOpenSettings).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "跳过此版本" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("update_skipped_update_version", { version: "1.4.0" }));
  expect(screen.queryByRole("status")).toBeNull();
});
it("stays silent for a version the user already skipped", async () => {
  settingsRef.skippedUpdateVersion = "1.4.0";
  const { container } = render(<UpdateBanner onOpenSettings={() => {}} />);
  await act(async () => listen.mock.calls[0][1]({ payload: release }));
  expect(container.textContent).toBe("");
});
