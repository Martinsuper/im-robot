import type { Dispatch, SetStateAction } from "react";
import type { AiSettings, AppSettings, OnboardingStatus, QuietMode, Theme } from "../../../types/appTypes";
import {
  defaultAppSettings,
  getAvailablePetVisualStyleOptions,
  live2dModelOptions,
  providerOptions,
  quietModeOptions,
  setLive2DModelId,
  setPetVisualStyle,
} from "../../app/appShared";
import type { Live2DModelId, PetVisualStyle } from "../../app/appShared";
import { reportCommandError, runCommand } from "../../app/appRuntime";

interface PreferencesSectionProps {
  className: string;
  companionName: string;
  theme: Theme;
  sensingPaused: boolean;
  setAppSettings: Dispatch<SetStateAction<AppSettings>>;
  petVisualStyle: PetVisualStyle;
  live2dModelId: Live2DModelId;
  customPetImagePath: string;
  chooseCustomPetImage: () => Promise<void>;
  clearCustomPetImage: () => void;
  autostartEnabled: boolean;
  toggleAutostart: () => Promise<void>;
  savePreferences: () => Promise<void>;
  refreshOnboardingStatus: () => Promise<OnboardingStatus>;
  preferencesStatus: string;
}

export function PreferencesSection({
  className,
  companionName,
  theme,
  sensingPaused,
  setAppSettings,
  petVisualStyle,
  live2dModelId,
  customPetImagePath,
  chooseCustomPetImage,
  clearCustomPetImage,
  autostartEnabled,
  toggleAutostart,
  savePreferences,
  refreshOnboardingStatus,
  preferencesStatus,
}: PreferencesSectionProps) {
  const availablePetVisualStyleOptions = getAvailablePetVisualStyleOptions(Boolean(customPetImagePath));
  const enabledLive2DModelOptions = live2dModelOptions.filter((option) => option.enabled);
  const disabledLive2DModelOptions = live2dModelOptions.filter((option) => !option.enabled);
  return (
    <section className={className}>
      <p className="eyebrow">PREFERENCES</p>
      <h2>个性化与系统</h2>
      <div className="settings-form">
        <label>
          <span>精灵名称</span>
          <input
            value={companionName}
            maxLength={24}
            onChange={(event) => setAppSettings((current) => ({ ...current, companionName: event.currentTarget.value }))}
          />
        </label>
        <label>
          <span>主题色</span>
          <select value={theme} onChange={(event) => setAppSettings((current) => ({ ...current, theme: event.currentTarget.value as Theme }))}>
            <option value="sage">鼠尾草绿</option>
            <option value="blue">湖水蓝</option>
            <option value="peach">暖桃色</option>
          </select>
        </label>
        <label>
          <span>精灵形象</span>
          <select
            value={petVisualStyle}
            onChange={(event) => setPetVisualStyle(event.currentTarget.value as PetVisualStyle)}
          >
            {availablePetVisualStyleOptions.map(({ label, value }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        {petVisualStyle === "character" ? (
          <label>
            <span>Live2D 模型</span>
            <select
              value={live2dModelId}
              onChange={(event) => setLive2DModelId(event.currentTarget.value as Live2DModelId)}
            >
              {enabledLive2DModelOptions.map(({ label, value, note }) => (
                <option key={value} value={value}>{label} · {note}</option>
              ))}
            </select>
          </label>
        ) : null}
        {petVisualStyle === "character" && disabledLive2DModelOptions.length ? (
          <p className="empty-state">
            {disabledLive2DModelOptions.map((option) => `${option.label}：${option.note}`).join("；")}
          </p>
        ) : null}
        <div className="custom-pet-picker">
          <span>{customPetImagePath ? customPetImagePath.split(/[\\/]/).pop() : "未选择自定义图片"}</span>
          <div>
            <button type="button" onClick={() => void chooseCustomPetImage()}>
              选择图片
            </button>
            <button type="button" className="is-secondary" onClick={clearCustomPetImage} disabled={!customPetImagePath}>
              清除
            </button>
          </div>
        </div>
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={!sensingPaused}
            onChange={(event) => setAppSettings((current) => ({ ...current, sensingPaused: !event.currentTarget.checked }))}
          />
          <span>主动感知</span>
        </label>
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={autostartEnabled}
            onChange={() => void toggleAutostart()}
          />
          <span>开机自动启动</span>
        </label>
        <button type="button" onClick={() => void savePreferences()}>
          保存个性化设置
        </button>
        <button
          type="button"
          onClick={() => {
            void runCommand<AppSettings>("reset_onboarding", undefined, {
              ...defaultAppSettings,
              companionName,
            }).then(() => refreshOnboardingStatus()).catch(reportCommandError("reset_onboarding"));
          }}
        >
          重新运行引导
        </button>
        {preferencesStatus && <p className="connection-status">{preferencesStatus}</p>}
      </div>
    </section>
  );
}

interface QuietModeSectionProps {
  className: string;
  quietMode: QuietMode;
  updateQuietMode: (mode: QuietMode) => void;
}

export function QuietModeSection({ className, quietMode, updateQuietMode }: QuietModeSectionProps) {
  return (
    <section className={className}>
      <p className="eyebrow">PERSONALITY</p>
      <h2>互动活泼度</h2>
      <div className="segmented-control" aria-label="互动活泼度">
        {quietModeOptions.map(({ label, value }) => (
          <button
            className={value === quietMode ? "is-active" : ""}
            key={value}
            type="button"
            onClick={() => updateQuietMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

interface BreakReminderSectionProps {
  className: string;
  breakRemindersEnabled: boolean;
  breakReminderIntervalMinutes: number;
  breakReminderCooldownMinutes: number;
  breakReminderQuietHoursEnabled: boolean;
  breakReminderQuietHoursStart: string;
  breakReminderQuietHoursEnd: string;
  setAppSettings: Dispatch<SetStateAction<AppSettings>>;
  saveWorkRhythmPreferences: () => Promise<void>;
}

export function BreakReminderSection({
  className,
  breakRemindersEnabled,
  breakReminderIntervalMinutes,
  breakReminderCooldownMinutes,
  breakReminderQuietHoursEnabled,
  breakReminderQuietHoursStart,
  breakReminderQuietHoursEnd,
  setAppSettings,
  saveWorkRhythmPreferences,
}: BreakReminderSectionProps) {
  return (
    <section className={className}>
      <p className="eyebrow">WORK RHYTHM</p>
      <h2>休息提醒</h2>
      <div className="settings-form">
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={breakRemindersEnabled}
            onChange={(event) => setAppSettings((current) => ({ ...current, breakRemindersEnabled: event.currentTarget.checked }))}
          />
          <span>开启休息提醒</span>
        </label>
        <div className="settings-form__row">
          <label>
            <span>提醒间隔（分钟）</span>
            <input
              type="number"
              min="15"
              max="240"
              step="5"
              value={breakReminderIntervalMinutes}
              onChange={(event) => setAppSettings((current) => ({ ...current, breakReminderIntervalMinutes: Number(event.currentTarget.value) }))}
            />
          </label>
          <label>
            <span>提醒冷却（分钟）</span>
            <input
              type="number"
              min="5"
              max="240"
              step="5"
              value={breakReminderCooldownMinutes}
              onChange={(event) => setAppSettings((current) => ({ ...current, breakReminderCooldownMinutes: Number(event.currentTarget.value) }))}
            />
          </label>
        </div>
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={breakReminderQuietHoursEnabled}
            onChange={(event) => setAppSettings((current) => ({ ...current, breakReminderQuietHoursEnabled: event.currentTarget.checked }))}
          />
          <span>启用静默时段</span>
        </label>
        <div className="settings-form__row">
          <label>
            <span>静默开始</span>
            <input
              type="time"
              value={breakReminderQuietHoursStart}
              onChange={(event) => setAppSettings((current) => ({ ...current, breakReminderQuietHoursStart: event.currentTarget.value }))}
            />
          </label>
          <label>
            <span>静默结束</span>
            <input
              type="time"
              value={breakReminderQuietHoursEnd}
              onChange={(event) => setAppSettings((current) => ({ ...current, breakReminderQuietHoursEnd: event.currentTarget.value }))}
            />
          </label>
        </div>
        <button type="button" onClick={() => void saveWorkRhythmPreferences()}>
          保存休息提醒设置
        </button>
        <p className="empty-state">提醒会根据今日输入、空闲状态和前台场景自动判断，只在适合的时候发声。</p>
      </div>
    </section>
  );
}

interface ModelProviderSectionProps {
  className: string;
  aiSettings: AiSettings;
  updateProvider: (provider: string) => void;
  updateAiField: <Key extends keyof AiSettings>(key: Key, value: AiSettings[Key]) => void;
  apiKey: string;
  setApiKey: Dispatch<SetStateAction<string>>;
  isTesting: boolean;
  testConnection: () => Promise<void>;
  connectionStatus: string;
}

export function ModelProviderSection({
  className,
  aiSettings,
  updateProvider,
  updateAiField,
  apiKey,
  setApiKey,
  isTesting,
  testConnection,
  connectionStatus,
}: ModelProviderSectionProps) {
  return (
    <section className={className}>
      <p className="eyebrow">MODEL PROVIDER</p>
      <h2>模型服务</h2>
      <div className="settings-form">
        <label>
          <span>服务类型</span>
          <select
            value={aiSettings.provider}
            onChange={(event) => updateProvider(event.currentTarget.value)}
          >
            {providerOptions.map(({ label, value }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Base URL</span>
          <input
            value={aiSettings.baseUrl}
            onChange={(event) => updateAiField("baseUrl", event.currentTarget.value)}
            placeholder="http://localhost:11434/v1"
          />
        </label>
        <label>
          <span>Model</span>
          <input
            value={aiSettings.model}
            onChange={(event) => updateAiField("model", event.currentTarget.value)}
            placeholder={aiSettings.provider === "lmstudio" ? "可留空，LM Studio 自动使用当前加载模型" : "gemma4:e4b"}
          />
        </label>
        <label>
          <span>API Key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder="本地 Ollama 可留空"
          />
        </label>
        <div className="settings-form__row">
          <label>
            <span>Temperature</span>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={aiSettings.temperature}
              onChange={(event) => updateAiField("temperature", Number(event.currentTarget.value))}
            />
          </label>
          <label>
            <span>超时秒数</span>
            <input
              type="number"
              min="5"
              max="600"
              value={aiSettings.timeoutSeconds}
              onChange={(event) =>
                updateAiField("timeoutSeconds", Number(event.currentTarget.value))
              }
            />
          </label>
        </div>
        <button type="button" disabled={isTesting} onClick={testConnection}>
          {isTesting ? "正在测试..." : "保存并测试连接"}
        </button>
        <p className="connection-status">{connectionStatus}</p>
      </div>
    </section>
  );
}

interface HtmlPreviewSectionProps {
  className: string;
  htmlPreviewEnabled: boolean;
  updateHtmlPreviewEnabled: (enabled: boolean) => Promise<void>;
}

export function HtmlPreviewSection({ className, htmlPreviewEnabled, updateHtmlPreviewEnabled }: HtmlPreviewSectionProps) {
  return (
    <section className={className}>
      <p className="eyebrow">OUTPUT PREVIEW</p>
      <h2>HTML 预览</h2>
      <div className="feature-toggle-card">
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={htmlPreviewEnabled}
            onChange={(event) => void updateHtmlPreviewEnabled(event.currentTarget.checked)}
          />
          <span>HTML 预览插件</span>
        </label>
        <p className="empty-state">开启后，气泡窗口会在检测到 HTML 片段时优先使用沙箱 iframe 预览。</p>
      </div>
    </section>
  );
}
