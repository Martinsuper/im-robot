// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../app/appShared";
import { ChatModelMenu } from "./ChatModelMenu";

const { command, applyServer } = vi.hoisted(() => ({ command: vi.fn(), applyServer: vi.fn() }));
const settings = { ...defaultAppSettings, hasApiKey: true, ai: { ...defaultAppSettings.ai, model: "first", baseUrl: "https://example.test/v1" } };
vi.mock("../app/appRuntime", () => ({ runCommand: command }));
vi.mock("../app/settingsStore", () => ({ useAppSettings: () => ({ settings, applyServer }), parseAppSettings: (raw: unknown) => raw }));

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => '["first","second"]' } });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  command.mockReset(); applyServer.mockReset();
});
afterEach(cleanup);

function openDialog() { fireEvent.click(screen.getByRole("button", { name: "选择模型：first" })); }

it("saves the selected model without replacing credentials or other parameters", async () => {
  command.mockResolvedValue({ ...settings, ai: { ...settings.ai, model: "second" } });
  render(<ChatModelMenu disabled={false} />);
  openDialog();
  fireEvent.click(screen.getByRole("radio", { name: "second" }));
  fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
  await waitFor(() => expect(applyServer).toHaveBeenCalledOnce());
  expect(command).toHaveBeenCalledWith("update_ai_settings", { input: { ...settings.ai, model: "second", apiKey: undefined } }, expect.anything());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps a failed save visible without publishing settings", async () => {
  command.mockRejectedValue(new Error("save failed"));
  render(<ChatModelMenu disabled={false} />);
  openDialog();
  fireEvent.click(screen.getByRole("radio", { name: "second" }));
  fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(applyServer).not.toHaveBeenCalled();
});

it("discards draft edits on cancel and restores them from saved settings on reopen", () => {
  render(<ChatModelMenu disabled={false} />);
  openDialog();
  fireEvent.click(screen.getByRole("radio", { name: "second" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(command).not.toHaveBeenCalled();
  openDialog();
  expect((screen.getByRole("radio", { name: "first" }) as HTMLInputElement).checked).toBe(true);
});

it("never saves the old credential for a different endpoint", async () => {
  command.mockResolvedValue(settings);
  render(<ChatModelMenu disabled={false} />);
  openDialog();
  fireEvent.click(screen.getByRole("tab", { name: "连接配置" }));
  fireEvent.change(screen.getByLabelText("API 地址"), { target: { value: "https://other.test/v1" } });
  fireEvent.click(screen.getByRole("button", { name: "保存并使用" }));
  await waitFor(() => expect(command).toHaveBeenCalled());
  expect(command.mock.calls[0][1].input.apiKey).toBeNull();
});

it("keeps connection drafts and model selection across keyboard tab switches", () => {
  render(<ChatModelMenu disabled={false} />);
  openDialog();
  const modelsTab = screen.getByRole("tab", { name: "选择模型" });
  fireEvent.keyDown(modelsTab, { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "连接配置" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.change(screen.getByLabelText("API 地址"), { target: { value: "https://draft.test/v1" } });
  fireEvent.click(modelsTab);
  expect(screen.queryByRole("textbox", { name: "API 地址" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "连接配置" }));
  expect((screen.getByLabelText("API 地址") as HTMLInputElement).value).toBe("https://draft.test/v1");
  expect(screen.getByRole("dialog").className).toContain(`panel-shell--${settings.theme}`);
  expect(command).not.toHaveBeenCalled();
});

it("does not open settings while a reply is running", () => {
  render(<ChatModelMenu disabled />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型：first" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
