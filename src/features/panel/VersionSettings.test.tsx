// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VersionSettings } from "./VersionSettings";
const { command, listen, toast, openPath } = vi.hoisted(() => ({ command: vi.fn(), listen: vi.fn(), toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }, openPath: vi.fn() }));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true, runCommand: command }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath, openUrl: vi.fn() }));
vi.mock("../../components/feedback/toastStore", () => ({ useToast: () => toast }));
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
const release = { currentVersion: "1.0", latestVersion: "2.0", available: true, releaseUrl: "https://github.com/Martinsuper/im-robot/releases/latest", downloadUrl: "https://github.com/Martinsuper/im-robot/releases/download/v2/Piko_aarch64.dmg", assetName: "Piko_aarch64.dmg" };
beforeEach(() => { vi.clearAllMocks(); listen.mockResolvedValue(() => {}); command.mockImplementation(async name => name === "check_for_updates_extended" ? release : undefined); });
afterEach(cleanup);
it("shows progress only for its download and cancels using the same id", async () => {
  let finish!: (value: unknown) => void;
  command.mockImplementation(async name => name === "check_for_updates_extended" ? release : name === "download_update_asset" ? new Promise(resolve => { finish = resolve; }) : undefined);
  render(<VersionSettings />); fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  fireEvent.click(await screen.findByRole("button", { name: "下载更新" }));
  await waitFor(() => expect(command.mock.calls.some(c => c[0] === "download_update_asset")).toBe(true));
  const id = command.mock.calls.find(c => c[0] === "download_update_asset")![1].downloadId;
  const receive = listen.mock.calls[0][1];
  await act(async () => receive({ payload: { downloadId: "other", received: 99, total: 100 } }));
  expect(screen.getByRole("status").textContent).not.toContain("99%");
  await act(async () => receive({ payload: { downloadId: id, received: 50, total: 100 } }));
  expect(screen.getByRole("status").textContent).toContain("50%");
  fireEvent.click(screen.getByRole("button", { name: "取消下载" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("cancel_update_download", { downloadId: id }));
  await act(async () => finish({ filePath: "/tmp/verified.dmg", fileName: "verified.dmg" }));
  fireEvent.click(screen.getByRole("button", { name: "打开已下载文件" })); expect(openPath).toHaveBeenCalledWith("/tmp/verified.dmg");
});
it("offers the release page when the platform has no installer", async () => {
  command.mockResolvedValue({ ...release, downloadUrl: null, assetName: null });
  render(<VersionSettings />); fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  expect(await screen.findByText("没有适用于当前平台的安装包，请打开发布页下载。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "下载更新" })).toBeNull();
});
