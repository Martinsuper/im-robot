import { useCallback, useEffect, useRef, useState } from "react";
import { toUserMessage } from "../../lib/errors";
import { useToast } from "../../components/feedback/toastStore";
import { defaultAiSettings, defaultAppSettings } from "../app/appShared";
import {
  findProviderPreset,
  onboardingProviderPresets,
  type ProviderPreset,
} from "../app/providerPresets";
import { runCommand } from "../app/appRuntime";
import "./onboarding.css";

/**
 * 首次启动引导（05 §3）。
 *
 * 三条硬规则，改这个文件时请一起守住：
 * 1. **3 步，每步都能跳过**。跳过不写数据，保留 `defaultAiSettings` 的既有值。
 * 2. **不出现技术字段**。Base URL / Model / Temperature / Timeout 属于「设置 → 高级」
 *    （02 §10.2），这里一律由 `providerPresets` 自动带上，不展示给用户。
 * 3. provider 列表只有一份来源：`../app/providerPresets`（08 §2 FN-6）。
 */

const TOTAL_STEPS = 3;
/** 与「设置 → 关于 → 重新运行引导」共用；版本号变了才会重新触发。 */
const ONBOARDING_VERSION = "1.0";
const DEFAULT_COMPANION_NAME = "Piko";
/** 05 §4.1：名字 ≤ 16 字。 */
const MAX_NAME_LENGTH = 16;

/** 引导不收集、也不展示的那一半参数（高级设置）。沿用既有配置，避免重跑引导把它们重置掉。 */
interface AdvancedAiParams {
  speechModel: string;
  temperature: number;
  timeoutSeconds: number;
}

const FALLBACK_ADVANCED: AdvancedAiParams = {
  speechModel: defaultAiSettings.speechModel,
  temperature: defaultAiSettings.temperature,
  timeoutSeconds: defaultAiSettings.timeoutSeconds,
};

/**
 * 组装 `update_ai_settings` 的入参。
 *
 * 这是本文件里唯一允许出现 `baseUrl` / `model` / `temperature` / `timeoutSeconds`
 * 的地方：它们是命令参数，不出现在任何 label 或可见文案里。
 */
function buildAiInput(
  preset: ProviderPreset,
  apiKey: string,
  advanced: AdvancedAiParams,
) {
  return {
    provider: preset.value,
    baseUrl: preset.baseUrl,
    model: preset.model,
    speechModel: advanced.speechModel,
    temperature: advanced.temperature,
    timeoutSeconds: advanced.timeoutSeconds,
    // 本机服务不需要 Key；填空则「不改动」已存的密钥，而不是把它删掉。
    apiKey: preset.needsApiKey && apiKey.trim() ? apiKey.trim() : undefined,
  };
}

/**
 * 本机服务的端口级失败提示（02 §10.3 明确要求这种可行动文案）。
 * 非本机地址返回 null，交给 `toUserMessage` 处理。
 */
function describeLocalFailure(preset: ProviderPreset): string | null {
  try {
    const url = new URL(preset.baseUrl);
    const host = url.hostname.toLowerCase();
    if (
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "::1" &&
      host !== "[::1]"
    )
      return null;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    // 「本地 Ollama」→「Ollama」，读起来才像一句话。
    const service = preset.label.replace(/^本地\s*/, "");
    return `无法连接本机 ${port} 端口，请确认 ${service} 已启动。`;
  } catch {
    return null;
  }
}

/** 失败文案：本机服务优先给「去启动它」这种能照做的提示，其余走统一的人话化。 */
function describeConnectionFailure(
  error: unknown,
  preset: ProviderPreset,
): string {
  return (
    describeLocalFailure(preset) ??
    toUserMessage(error, "连不上这个服务，请检查后重试。")
  );
}

interface TestResult {
  tone: "idle" | "pending" | "success" | "error";
  text: string;
}

const IDLE_TEST: TestResult = { tone: "idle", text: "" };

interface OnboardingProps {
  onComplete: () => void;
  onSkip: () => void;
}

export function OnboardingWindow({ onComplete, onSkip }: OnboardingProps) {
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [companionName, setCompanionName] = useState(DEFAULT_COMPANION_NAME);
  const [providerValue, setProviderValue] = useState(
    onboardingProviderPresets[0].value,
  );
  const [apiKey, setApiKey] = useState("");
  const [test, setTest] = useState<TestResult>(IDLE_TEST);
  const [testing, setTesting] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const preset =
    findProviderPreset(providerValue) ?? onboardingProviderPresets[0];

  // 高级参数：挂载时读一次既有配置，之后原样回传。读不到就用默认值，不阻塞引导。
  const advancedRef = useRef<AdvancedAiParams>(FALLBACK_ADVANCED);
  useEffect(() => {
    let cancelled = false;
    void runCommand("get_settings", undefined, defaultAppSettings)
      .then((settings) => {
        const ai = settings?.ai;
        if (cancelled || !ai) return;
        advancedRef.current = {
          speechModel: ai.speechModel || FALLBACK_ADVANCED.speechModel,
          temperature: Number.isFinite(ai.temperature)
            ? ai.temperature
            : FALLBACK_ADVANCED.temperature,
          timeoutSeconds: Number.isFinite(ai.timeoutSeconds)
            ? ai.timeoutSeconds
            : FALLBACK_ADVANCED.timeoutSeconds,
        };
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleProviderChange = useCallback((value: string) => {
    setProviderValue(value);
    setTest(IDLE_TEST);
  }, []);

  /** 测试连接：先落盘再真连一次，成功/失败都给一句人话。 */
  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setTest({ tone: "pending", text: "正在连接…" });
    try {
      await runCommand("update_ai_settings", {
        input: buildAiInput(preset, apiKey, advancedRef.current),
      });
      const models = await runCommand(
        "list_models",
        undefined,
        [],
      );
      const names = (models ?? []).map((model) => model.id).filter(Boolean);
      if (!names.length) {
        setTest({ tone: "success", text: "连上了，但没找到可用模型。" });
        return;
      }
      const shown = names.slice(0, 3).join("、");
      setTest({
        tone: "success",
        text:
          names.length > 3
            ? `连上了，可以用：${shown} 等 ${names.length} 个模型。`
            : `连上了，可以用：${shown}。`,
      });
    } catch (error) {
      setTest({
        tone: "error",
        text: describeConnectionFailure(error, preset),
      });
    } finally {
      setTesting(false);
    }
  }, [preset, apiKey]);

  /** 第 2 步主按钮：保存后进入第 3 步。保存失败只提示，不拦住流程。 */
  const handleSaveAi = useCallback(async () => {
    try {
      await runCommand("update_ai_settings", {
        input: buildAiInput(preset, apiKey, advancedRef.current),
      });
    } catch (error) {
      toast.error(
        toUserMessage(error, "设置没保存成功，可以稍后在「设置」里再配一次。"),
      );
    }
    setStep(3);
  }, [preset, apiKey, toast]);

  /** 「跳过，先用本地的」：什么都不写，保留既有默认值（约束 3）。 */
  const handleSkipAi = useCallback(() => {
    setTest(IDLE_TEST);
    setStep(3);
  }, []);

  /** 整个引导的出口：记一次完成，然后立刻把对话窗口开出来（约束 6）。 */
  const handleFinish = useCallback(async () => {
    setFinishing(true);
    const name = companionName.trim() || DEFAULT_COMPANION_NAME;
    try {
      await runCommand("complete_onboarding", {
        companionName: name,
        onboardingVersion: ONBOARDING_VERSION,
      });
      await runCommand("show_bubble");
      onComplete();
    } catch (error) {
      toast.error(
        toUserMessage(error, "引导没结束成功，请再点一次「开始使用」。"),
      );
    } finally {
      setFinishing(false);
    }
  }, [companionName, onComplete, toast]);

  /** 任何一步都能整体跳过（约束 3 / 05 §3.3）。 */
  const handleSkipOnboarding = useCallback(async () => {
    try {
      await runCommand("skip_onboarding");
    } catch {
      // 后端没记住也要让用户进得去：面板会按本地状态刷新。
    }
    onSkip();
  }, [onSkip]);

  return (
    <main className="onb-shell">
      <div className="onb-card">
        <header className="onb-head">
          <div>
            <p className="onb-step-badge">
              步骤 {step} / {TOTAL_STEPS}
            </p>
            <h1 className="onb-title">欢迎使用 Piko</h1>
          </div>
          <button
            type="button"
            className="onb-btn onb-btn--quiet"
            onClick={() => void handleSkipOnboarding()}
          >
            跳过引导
          </button>
        </header>

        {step === 1 ? (
          <section className="onb-body" aria-labelledby="onb-step-title">
            <h2 className="onb-step-title" id="onb-step-title">
              先给它起个名字
            </h2>
            <p className="onb-hint">
              以后改名字也很容易，「设置 → 伙伴」里随时能改。
            </p>
            <div className="onb-field">
              <label className="onb-label" htmlFor="onb-companion-name">
                它的名字
              </label>
              <input
                id="onb-companion-name"
                className="onb-input"
                type="text"
                value={companionName}
                onChange={(event) => setCompanionName(event.target.value)}
                placeholder={DEFAULT_COMPANION_NAME}
                maxLength={MAX_NAME_LENGTH}
                autoFocus
              />
            </div>
            <footer className="onb-foot">
              <button
                type="button"
                className="onb-btn onb-btn--ghost"
                onClick={() => setStep(2)}
              >
                以后再说
              </button>
              <button
                type="button"
                className="onb-btn onb-btn--primary"
                onClick={() => setStep(2)}
              >
                继续
              </button>
            </footer>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onb-body" aria-labelledby="onb-step-title">
            <h2 className="onb-step-title" id="onb-step-title">
              连接一个 AI（可跳过）
            </h2>
            <div className="onb-field">
              <label className="onb-label" htmlFor="onb-provider">
                选择服务
              </label>
              <select
                id="onb-provider"
                className="onb-select"
                value={providerValue}
                onChange={(event) => handleProviderChange(event.target.value)}
              >
                {onboardingProviderPresets.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="onb-hint">{preset.hint}</p>
            </div>

            {/* 本机服务：没有 Key 输入框，只剩这句说明（约束 2）。 */}
            {preset.needsApiKey ? (
              <div className="onb-field">
                <label className="onb-label" htmlFor="onb-api-key">
                  API Key
                </label>
                <input
                  id="onb-api-key"
                  className="onb-input"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="粘贴你的 Key"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="onb-hint">只存在你这台电脑上，不会上传到别处。</p>
              </div>
            ) : (
              <p className="onb-local-note">跑在你自己电脑上，不需要 Key。</p>
            )}

            <button
              type="button"
              className="onb-btn onb-btn--ghost"
              onClick={() => void handleTestConnection()}
              disabled={testing}
            >
              {testing ? "正在连接…" : "测试连接"}
            </button>

            <p
              className={`onb-result${test.tone === "idle" ? "" : ` onb-result--${test.tone}`}`}
              role="status"
              aria-live="polite"
            >
              {test.text}
            </p>

            <footer className="onb-foot">
              <button
                type="button"
                className="onb-btn onb-btn--ghost"
                onClick={handleSkipAi}
              >
                跳过，先用本地的
              </button>
              <button
                type="button"
                className="onb-btn onb-btn--primary"
                onClick={() => void handleSaveAi()}
              >
                完成
              </button>
            </footer>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="onb-body" aria-labelledby="onb-step-title">
            <h2 className="onb-step-title" id="onb-step-title">
              认识一下{companionName.trim() ? ` ${companionName.trim()}` : ""}
            </h2>
            <ul className="onb-checklist">
              <li>
                <span className="onb-check" aria-hidden="true">
                  ✓
                </span>
                点击 Piko 就能聊天
              </li>
              <li>
                <span className="onb-check" aria-hidden="true">
                  ✓
                </span>
                拖文件给它可以帮你读
              </li>
              <li>
                <span className="onb-check" aria-hidden="true">
                  ✓
                </span>
                说「提醒我…」它会记住
              </li>
            </ul>
            <footer className="onb-foot">
              <button
                type="button"
                className="onb-btn onb-btn--primary"
                onClick={() => void handleFinish()}
                disabled={finishing}
              >
                开始使用
              </button>
            </footer>
          </section>
        ) : null}
      </div>
    </main>
  );
}
