import type { AiSettings } from "../../types/appTypes";

/**
 * 模型服务的**唯一**预设清单（02 §10.1）。
 *
 * 为什么要有这个文件：现状有两份互相矛盾的列表——`appShared.tsx` 里 6 项、
 * `OnboardingWindow.tsx` 里 4 项，同一个 provider 的 Base URL 与默认模型都不一样
 * （08 §2 的 FN-6）。用户在引导页配好的，到设置页会看到另一套值。
 *
 * 这里收敛成一份，引导页与设置页都从这里取。
 */

export interface ProviderPreset {
  value: AiSettings["provider"] | string;
  label: string;
  /** 选中后自动填入的 Base URL。 */
  baseUrl: string;
  /** 选中后自动填入的默认模型；本机服务留空，由后端探测。 */
  model: string;
  /** 是否需要 API Key。本机服务不需要。 */
  needsApiKey: boolean;
  /** 一句话说明，直接展示给用户。 */
  hint: string;
  /** 首次引导只展示无需填写高级连接参数的预设。 */
  showInOnboarding?: boolean;
}

export const providerPresets: ProviderPreset[] = [
  {
    value: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    needsApiKey: true,
    hint: "官方接口，需要一个 API Key。",
  },
  {
    value: "openai-compatible",
    label: "OpenAI 兼容 API",
    baseUrl: "",
    model: "",
    needsApiKey: true,
    hint: "适用于中转服务或其他兼容 Chat Completions 的服务，请填写 API 地址、模型名和密钥。",
    showInOnboarding: false,
  },
  {
    value: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
    needsApiKey: true,
    hint: "官方接口，需要一个 API Key。",
  },
  {
    value: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    needsApiKey: true,
    hint: "官方接口，需要一个 API Key。",
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    needsApiKey: true,
    hint: "官方接口，需要一个 API Key。",
  },
  {
    value: "dashscope",
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.6-plus",
    needsApiKey: true,
    hint: "阿里云百炼，需要一个 API Key。",
  },
  {
    value: "ollama",
    label: "本地 Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "",
    needsApiKey: false,
    hint: "跑在你自己电脑上，不需要 Key。",
  },
  {
    value: "lmstudio",
    label: "本地 LM Studio",
    baseUrl: "http://localhost:1234/v1",
    model: "",
    needsApiKey: false,
    hint: "跑在你自己电脑上，不需要 Key。",
  },
];

/** 首次引导不展示需要手动填写 Base URL / Model 的高级入口。 */
export const onboardingProviderPresets = providerPresets.filter(
  (preset) => preset.showInOnboarding !== false,
);

/** 「本地」这一类（不需要 Key、可以留空模型名）。 */
export const localProviderValues = providerPresets
  .filter((preset) => !preset.needsApiKey)
  .map((preset) => preset.value);

export function findProviderPreset(value: string): ProviderPreset | undefined {
  return providerPresets.find((preset) => preset.value === value);
}

/** 解析当前配置用的是哪个预设；自建端点会返回 undefined。 */
export function resolveProviderPreset(
  ai: Pick<AiSettings, "provider">,
): ProviderPreset | undefined {
  return findProviderPreset(ai.provider);
}
