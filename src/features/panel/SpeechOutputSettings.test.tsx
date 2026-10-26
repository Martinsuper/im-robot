// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechOutputSettings } from "./SpeechOutputSettings";
const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../app/appRuntime", () => ({
  isTauriRuntime: true,
  runCommand: command,
}));
const current = {
  provider: "system",
  voice: "冰糖",
  style: "温柔自然",
  hasApiKey: false,
};
beforeEach(() => command.mockReset());
afterEach(cleanup);
describe("MiMo speech output", () => {
  it("saves a separate masked key and previews the selected voice", async () => {
    command.mockImplementation(async (name, args) =>
      name === "get_speech_output_settings"
        ? current
        : name === "update_speech_output_settings"
          ? { ...current, ...args.input, hasApiKey: true }
          : undefined,
    );
    render(<SpeechOutputSettings />);
    const provider = screen.getByLabelText("语音服务");
    await waitFor(() => expect(provider.hasAttribute("disabled")).toBe(false));
    fireEvent.change(provider, { target: { value: "mimo" } });
    const key = screen.getByLabelText("MiMo API Key") as HTMLInputElement;
    expect(key.type).toBe("password");
    fireEvent.change(key, { target: { value: "test-key" } });
    fireEvent.change(screen.getByLabelText("音色"), {
      target: { value: "茉莉" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并试听" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("update_speech_output_settings", {
        input: {
          provider: "mimo",
          voice: "茉莉",
          style: "温柔自然",
          apiKey: "test-key",
        },
      }),
    );
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        "speak_local_text",
        expect.any(Object),
      ),
    );
    expect(key.value).toBe("");
  });
  it("keeps an existing key when blank and clears it explicitly", async () => {
    const saved = { ...current, provider: "mimo", hasApiKey: true };
    command.mockImplementation(async (name, args) =>
      name === "get_speech_output_settings"
        ? saved
        : name === "update_speech_output_settings"
          ? { ...saved, ...args.input, hasApiKey: args.input.apiKey !== "" }
          : undefined,
    );
    render(<SpeechOutputSettings />);
    await screen.findByLabelText("MiMo API Key");
    fireEvent.click(screen.getByRole("button", { name: "保存语音设置" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("update_speech_output_settings", {
        input: {
          provider: "mimo",
          voice: "冰糖",
          style: "温柔自然",
          apiKey: null,
        },
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "删除 MiMo 密钥" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除 MiMo 密钥" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("update_speech_output_settings", {
        input: {
          provider: "system",
          voice: "冰糖",
          style: "温柔自然",
          apiKey: "",
        },
      }),
    );
  });
  it("allows cancelling while cloud synthesis is pending", async () => {
    command.mockImplementation(async (name, args) =>
      name === "get_speech_output_settings"
        ? current
        : name === "update_speech_output_settings"
          ? { ...current, ...args.input }
          : name === "speak_local_text"
            ? new Promise(() => {})
            : undefined,
    );
    render(<SpeechOutputSettings />);
    const button = screen.getByRole("button", { name: "保存并试听" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await screen.findByText("正在生成并播放试听…");
    fireEvent.click(screen.getByRole("button", { name: "停止试听" }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("stop_local_speech"),
    );
  });
});
