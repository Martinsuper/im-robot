import { describe, expect, it } from "vitest";
import { defaultAiSettings } from "./appShared";
import {
  findProviderPreset,
  localProviderValues,
  providerPresets,
} from "./providerPresets";

describe("Provider 定义", () => {
  it("前端预设包含后端支持的 Ollama，并使用本地默认语义", () => {
    expect(findProviderPreset("ollama")).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      model: "",
      needsApiKey: false,
    });
    expect(localProviderValues).toContain("ollama");
  });

  it("默认配置与 Ollama 预设一致", () => {
    expect(defaultAiSettings).toMatchObject({
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "",
    });
  });

  it("区分 OpenAI 官方服务与自定义兼容端点", () => {
    expect(findProviderPreset("openai")).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      needsApiKey: true,
    });
    expect(
      providerPresets.find(({ value }) => value === "openai-compatible"),
    ).toMatchObject({
      label: "OpenAI 兼容 API",
      baseUrl: "",
      model: "",
      needsApiKey: true,
      showInOnboarding: false,
    });
  });
});
