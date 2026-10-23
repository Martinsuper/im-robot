// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import { defaultAppSettings } from "../app/appShared";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../app/appRuntime", () => ({ runCommand: command }));

const settings = { ...defaultAppSettings.ai, provider: "openai-compatible", baseUrl: "https://example.test/v1", model: "old-model" };
const props = { settings, apiKey: "draft-secret", useSavedKey: false, onChange: vi.fn() };

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    get length() { return values.size; },
    toJSON: () => Object.fromEntries(values),
  } });
  command.mockReset(); props.onChange.mockReset();
});
afterEach(cleanup);

describe("model discovery", () => {
  it("pins the saved model above the fetched alphabetical list", () => {
    window.localStorage.setItem(`piko-model-list:${JSON.stringify([settings.provider, settings.baseUrl])}`, '["alpha","z-current","beta"]');
    render(<ModelPicker {...props} settings={{ ...settings, model: "beta" }} apiKey="" useSavedKey currentModel="z-current" />);
    expect((screen.getAllByRole("radio")[0] as HTMLInputElement).value).toBe("z-current");
    expect(screen.getByText("当前使用")).toBeTruthy();
  });
  it("loads draft connection models, searches, selects and caches without credentials", async () => {
    command.mockResolvedValue([{ id: "beta" }, { id: "alpha" }, { id: "beta" }]);
    render(<ModelPicker {...props} />);
    await screen.findByRole("radio", { name: "alpha" });
    expect(command).toHaveBeenCalledWith("list_models", { input: {
      provider: settings.provider, baseUrl: settings.baseUrl, apiKey: "draft-secret", useSavedKey: false,
    } }, []);
    expect(command.mock.calls.every(([name]) => name === "list_models")).toBe(true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alp" } });
    expect(screen.queryByRole("radio", { name: "beta" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "alpha" }));
    expect(props.onChange).toHaveBeenCalledWith("alpha");
    expect(JSON.stringify(window.localStorage)).not.toContain("draft-secret");
  });

  it("uses a cached list immediately without refetching on reopen", () => {
    window.localStorage.setItem(`piko-model-list:${JSON.stringify([settings.provider, settings.baseUrl])}`, '["cached-model"]');
    render(<ModelPicker {...props} apiKey="" useSavedKey />);
    expect(screen.getByRole("radio", { name: "cached-model" })).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
  });

  it("keeps the selected model and supports manual input after a failure", async () => {
    command.mockRejectedValue(new Error("network unavailable"));
    render(<ModelPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("获取失败"));
    expect(screen.getByRole("radio", { name: "old-model" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "手动添加" }));
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "custom" } });
    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    expect(props.onChange).toHaveBeenCalledWith("custom");
    expect(JSON.stringify(window.localStorage)).toContain("custom");
  });

  it("ignores an old connection response after switching endpoints", async () => {
    let resolve!: (value: { id: string }[]) => void;
    command.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const view = render(<ModelPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "获取模型" }));
    view.rerender(<ModelPicker key="other" {...props} settings={{ ...settings, baseUrl: "https://other.test/v1" }} />);
    resolve([{ id: "wrong-connection-model" }]);
    await waitFor(() => expect(screen.queryByRole("radio", { name: "wrong-connection-model" })).toBeNull());
    expect(window.localStorage.length).toBe(0);
  });
});
