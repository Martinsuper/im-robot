// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceSettings } from "./DeviceSettings";
const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../app/appRuntime", () => ({
  isTauriRuntime: true,
  runCommand: command,
}));
const idle = {
  running: false,
  port: 19388,
  pairingCode: null,
  pairingSeconds: 0,
  deviceId: null,
  deviceName: null,
  connected: false,
  battery: null,
  firmware: null,
  error: null,
  pendingDevice: null,
  pendingRequest: null,
};
beforeEach(() => command.mockReset());
afterEach(cleanup);
describe("Passport settings", () => {
  it("starts the bridge, creates an expiring code, and stops it", async () => {
    command.mockImplementation(async (name: string) => {
      if (name === "start_device_bridge") return { ...idle, running: true };
      if (name === "begin_device_pairing")
        return {
          ...idle,
          running: true,
          pairingCode: "1234abcd",
          pairingSeconds: 300,
        };
      return idle;
    });
    render(<DeviceSettings />);
    const toggle = screen.getByRole("checkbox", { name: "开启局域网设备连接" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    fireEvent.click(
      await screen.findByRole("button", { name: "生成手动配对码" }),
    );
    expect(await screen.findByText("1234abcd")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText("1234abcd")).toBeNull());
    expect(command).toHaveBeenCalledWith("stop_device_bridge");
  });
  it("requires a local confirmation to forget a paired device", async () => {
    command.mockImplementation(async (name: string) =>
      name === "forget_device"
        ? idle
        : {
            ...idle,
            running: true,
            deviceId: "passport-1",
            deviceName: "Piko Passport",
            connected: true,
            battery: 85,
          },
    );
    render(<DeviceSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "解除配对" }));
    expect(command).not.toHaveBeenCalledWith("forget_device");
    fireEvent.click(screen.getByRole("button", { name: "确认解除配对" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith("forget_device"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "解除配对" })).toBeNull(),
    );
  });
  it("shows bind failures without claiming the service is running", async () => {
    command
      .mockResolvedValueOnce(idle)
      .mockRejectedValueOnce(new Error("设备端口被占用"));
    render(<DeviceSettings />);
    const toggle = screen.getByRole("checkbox");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "设备端口被占用",
    );
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });
  it("approves the exact discovered request without typing a pairing code", async () => {
    const nonce = "a".repeat(32);
    command.mockImplementation(async () => ({
      ...idle,
      running: true,
      pendingDevice: "passport-f414dc",
      pendingRequest: nonce,
    }));
    render(<DeviceSettings />);
    fireEvent.click(
      await screen.findByRole("button", { name: "连接旧版设备" }),
    );
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("begin_device_pairing", {
        requestId: nonce,
      }),
    );
    expect(screen.getByText(/passport-f414dc/)).toBeTruthy();
  });
});
