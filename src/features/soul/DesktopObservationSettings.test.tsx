// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopObservationSettings } from "./DesktopObservationSettings";
const state = vi.hoisted(() => ({ command: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true, runCommand: state.command }));
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../components/feedback/toastStore", () => ({ useToast: () => state.toast }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
beforeEach(() => { state.command.mockImplementation((name: string) => Promise.resolve(name === "soul_desktop_status" ? { enabled: false, capture_permission: true, model: "chat", checks_remaining: 12, last_error: null } : undefined)); });
it("saves frequency and exclusions with the loaded revision, without enabling observation", async () => {
  state.command.mockResolvedValueOnce({ revision: 4, frequency: "natural", excluded_apps: ["Safari"] });
  render(<DesktopObservationSettings />);
  fireEvent.change(await screen.findByLabelText("soul.desktop.frequency"), { target: { value: "quiet" } });
  fireEvent.change(screen.getByLabelText("soul.desktop.excluded"), { target: { value: "  Safari \n\n 微信 " } });
  state.command.mockResolvedValueOnce({ revision: 5, frequency: "quiet", excluded_apps: ["Safari", "微信"] });
  fireEvent.click(screen.getByRole("button", { name: "soul.desktop.save" }));
  await waitFor(() => expect(state.command).toHaveBeenLastCalledWith("soul_update_desktop_settings", { input: { revision: 4, frequency: "quiet", excluded_apps: ["Safari", "微信"], model: "" } }));
  await waitFor(() => expect(state.toast.success).toHaveBeenCalled());
  expect(state.command).not.toHaveBeenCalledWith("soul_update_settings", expect.anything());
});
it("shows unavailable settings instead of claiming observation works", async () => {
  state.command.mockRejectedValueOnce(new Error("storage_unavailable"));
  render(<DesktopObservationSettings />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "soul.desktop.loadFailed");
  expect(screen.queryByRole("button", { name: "soul.desktop.save" })).toBeNull();
});
it("keeps unsaved exclusions on a revision conflict", async () => {
  state.command.mockResolvedValueOnce({ revision: 4, frequency: "natural", excluded_apps: [] });
  render(<DesktopObservationSettings />);
  fireEvent.change(await screen.findByLabelText("soul.desktop.excluded"), { target: { value: "Terminal" } });
  state.command.mockRejectedValueOnce(new Error("settings_conflict"));
  fireEvent.click(screen.getByRole("button", { name: "soul.desktop.save" }));
  await waitFor(() => expect(state.toast.error).toHaveBeenCalled());
  expect(screen.getByLabelText("soul.desktop.excluded")).toHaveProperty("value", "Terminal");
});

it("tests an independent vision model using synthetic data without saving settings", async () => {
  state.command.mockResolvedValueOnce({ revision: 4, frequency: "natural", excluded_apps: [], model: "" });
  render(<DesktopObservationSettings />);
  fireEvent.change(await screen.findByLabelText("soul.desktop.model"), { target: { value: "vision-model" } });
  fireEvent.click(screen.getByRole("button", { name: "soul.desktop.testModel" }));
  await waitFor(() => expect(state.command).toHaveBeenCalledWith("soul_test_desktop_model", { model: "vision-model" }));
  await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith("soul.desktop.testPassed"));
  expect(state.command).not.toHaveBeenCalledWith("soul_update_desktop_settings", expect.anything());
});
it("explains failed image recognition instead of claiming the connection supports vision", async () => {
  state.command.mockResolvedValueOnce({ revision: 4, frequency: "natural", excluded_apps: [], model: "" });
  render(<DesktopObservationSettings />);
  await screen.findByLabelText("soul.desktop.model");
  state.command.mockRejectedValueOnce(new Error("desktop_test_vision_failed"));
  fireEvent.click(screen.getByRole("button", { name: "soul.desktop.testModel" }));
  await waitFor(() => expect(state.toast.error).toHaveBeenCalledWith("soul.desktop.errors.desktop_test_vision_failed"));
});

it("distinguishes an autonomous silent decision from a blocked observation", async () => {
  state.command.mockImplementation((name: string) => Promise.resolve(name === "soul_desktop_status" ? {
    enabled: true, capture_permission: true, model: "vision", checks_remaining: 11, last_error: null,
    diagnostics: { stage: "unchanged_scene", model_requests: 1, last_decision: "silent" },
  } : { revision: 1, frequency: "natural", excluded_apps: [], model: "vision" }));
  render(<DesktopObservationSettings />);
  expect(await screen.findByText(/soul.desktop.stages.unchanged_scene/)).toHaveProperty("textContent", expect.stringContaining("soul.desktop.decisions.silent"));
  expect(screen.getByText(/soul.desktop.stages.unchanged_scene/)).toHaveProperty("textContent", expect.stringContaining("1"));
});

it("arms one speech test without changing autonomous observation preferences", async () => {
  state.command.mockImplementation((name: string) => Promise.resolve(name === "soul_desktop_status" ? {
    enabled: true, capture_permission: true, model: "vision", checks_remaining: 10, last_error: null,
  } : { revision: 2, frequency: "natural", excluded_apps: [], model: "vision" }));
  render(<DesktopObservationSettings />);
  const button = await screen.findByRole("button", { name: "soul.desktop.testSpeech" });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
  await waitFor(() => expect(state.command).toHaveBeenCalledWith("soul_test_desktop_speech"));
  expect(state.command).not.toHaveBeenCalledWith("soul_update_desktop_settings", expect.anything());
  await waitFor(() => expect(state.toast.success).toHaveBeenCalledWith("soul.desktop.speechArmed"));
});
