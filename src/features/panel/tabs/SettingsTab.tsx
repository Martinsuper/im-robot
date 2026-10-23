import { DataSettings } from "../DataSettings";
import { ModelSettingsDialog } from "../ModelSettingsDialog";
import "./settings.css";
import { SoulSettings } from "../../soul/SoulSettings";
import { useEffect, useRef, useState } from "react";
import {
  BellRing,
  MessageCircle,
  PawPrint,
  ShieldCheck,
  Volume2,
} from "lucide-react";
import { useStableEvent } from "../../../hooks/useStableEvent";
import { VersionSettings } from "../VersionSettings";
import { useTranslation } from "../../i18n/I18nProvider";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import {
  notificationPermissionLabel,
  type NotificationStatus,
} from "../notificationStatus";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { SettingsGroup } from "../PanelChrome";
import { EmptyState } from "../../../components/feedback/States";
import { useToast } from "../../../components/feedback/toastStore";
import { toUserMessage } from "../../../lib/errors";
import { usePreferenceDrafts } from "../usePreferenceDrafts";
import { useAppSettings } from "../settingsStore";

import type {
  AppSettings,
  QuietMode,
  SpeechModelDownloadProgress,
  SpeechModelStatus,
  Theme,
} from "../../../types/appTypes";
import {
  clearCustomPetImagePath,
  defaultAppSettings,
  formatBytes,
  getAvailablePetVisualStyleOptions,
  quietModeOptions,
  setCustomPetImagePath,
  setPetVisualStyle,
  useCustomPetImagePath,
  usePetVisualStyle,
} from "../../app/appShared";
import { isTauriRuntime, runCommand } from "../../app/appRuntime";

/**
 * 「设置」Tab（05 模块）。
 *
 * 只负责设置本身：分组、控件、即时保存。面板外壳（导航 / 主题 / 引导门禁）与
 * 「今天」「记录」的业务都住在别处，本文件不持有任何与它们有关的状态。
 *
 * 数据读取统一走 `useAppSettings()`（三个 Tab 共用一份缓存）；写入沿用
 * `useAutoSave` + `update_preferences` / `update_work_rhythm_preferences` /
 * `update_quiet_mode` 那套即时保存。
 */
export function SettingsTab() {
  const toast = useToast();
  const { t } = useTranslation();
  const statusLabels = useStableEvent(() => t);
  const { settings, applyServer } = useAppSettings();

  const {
    companionName,
    theme,
    sensingPaused,
    breakRemindersEnabled,
    breakReminderIntervalMinutes,
    breakReminderCooldownMinutes,
    breakReminderQuietHoursEnabled,
    breakReminderQuietHoursStart,
    breakReminderQuietHoursEnd,
    updatePreferences,
    updateWorkRhythm,
  } = usePreferenceDrafts(settings);
  const [quietMode, setQuietMode] = useState<QuietMode>(settings.quietMode);
  const aiSettings = settings.ai;
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [agentAutoApproveCommands, setAgentAutoApproveCommands] = useState(
    settings.agentAutoApproveCommands ?? false,
  );
  const [savingCommandPermission, setSavingCommandPermission] = useState(false);

  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [shortcutDraft, setShortcutDraft] = useState<string | null>(null);
  const [isSavingShortcut, setIsSavingShortcut] = useState(false);
  /** 两段式确认：第一次点击只变成「确认清空」，再点才执行（00 §5.9 可逆原则）。 */
  const [confirmClear, setConfirmClear] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState("尚未授权");
  const [notificationDetails, setNotificationDetails] =
    useState<NotificationStatus>();
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationQueryError, setNotificationQueryError] = useState("");

  const [speechModels, setSpeechModels] = useState<SpeechModelStatus[]>([]);
  const [speechModelProgress, setSpeechModelProgress] = useState<
    Record<string, SpeechModelDownloadProgress>
  >({});
  const [downloadingSpeechModelId, setDownloadingSpeechModelId] = useState("");

  const petVisualStyle = usePetVisualStyle();
  const customPetImagePath = useCustomPetImagePath();
  const availablePetVisualStyleOptions = getAvailablePetVisualStyleOptions(
    Boolean(customPetImagePath),
  );

  // Model drafts live in ModelSettingsDialog; synchronize the immediate preferences here.
  const appliedSettingsRef = useRef<AppSettings | null>(null);
  useEffect(() => {
    if (appliedSettingsRef.current === settings) return;
    appliedSettingsRef.current = settings;

    setQuietMode(settings.quietMode);
    setAgentAutoApproveCommands(settings.agentAutoApproveCommands ?? false);
  }, [settings]);

  // 语音模型、启动与通知状态。
  useEffect(() => {
    void loadSpeechModels();

    if (isTauriRuntime) {
      void isEnabled()
        .then(setAutostartEnabled)
        .catch((error) => {
          toast.error(
            `${statusLabels()("settings.feedback.autostartReadFailed", "开机启动状态读取失败")}：${toUserMessage(error)}`,
          );
        });
      void refreshNotificationStatus();
    }

    if (!isTauriRuntime) return;
    const unlistenSpeechModelProgress = listen<SpeechModelDownloadProgress>(
      "speech-model-download-progress",
      (event) => {
        setSpeechModelProgress((current) => ({
          ...current,
          [event.payload.modelId]: event.payload,
        }));
        if (event.payload.completed) {
          setDownloadingSpeechModelId("");
          void loadSpeechModels();
        }
      },
    );
    return () => {
      void unlistenSpeechModelProgress
        .then((dispose) => dispose())
        .catch(() => undefined);
    };
  }, [toast, statusLabels]);

  function updateQuietMode(mode: QuietMode) {
    setQuietMode(mode);
    void runCommand(
      "update_quiet_mode",
      { quietMode: mode },
      {
        ...defaultAppSettings,
        quietMode: mode,
        ai: aiSettings,
      },
    );
  }

  async function loadSpeechModels() {
    const models = await runCommand(
      "get_speech_model_status",
      undefined,
      [
        {
          id: "base",
          name: "Whisper Base",
          fileName: "ggml-base.bin",
          downloadUrl: "",
          downloaded: false,
          byteSize: 0,
        },
      ],
    );
    setSpeechModels(models as SpeechModelStatus[]);
  }

  async function downloadSpeechModel(modelId: string) {
    setDownloadingSpeechModelId(modelId);
    try {
      const model = await runCommand(
        "download_speech_model",
        {
          input: { modelId },
        },
      );
      setSpeechModels((current) =>
        current.map((item) => (item.id === model.id ? (model as SpeechModelStatus) : item)),
      );
      toast.success(
        `${model.name} ${t("settings.feedback.modelReady", "已可用")}`,
      );
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setDownloadingSpeechModelId("");
      void loadSpeechModels();
    }
  }

  async function chooseCustomPetImage() {
    if (!isTauriRuntime) return;
    const path = await open({
      multiple: false,
      filters: [
        { name: "图片文件", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      ],
    });
    if (typeof path !== "string") return;
    setCustomPetImagePath(path);
    setPetVisualStyle("custom");
  }

  function clearCustomPetImage() {
    clearCustomPetImagePath();
  }

  /**
   * 导出我的数据（05 §4.4）。
   *
   * `export_to_file` 会写一份包含设置 / 对话 / 提醒 / 日程 / 专注记录的 JSON。
   * 注意它**不含 API Key**（密钥存在钥匙串里），这一点在界面上要说清楚，
   * 否则用户会以为导出的是完整备份。
   */
  /**
   * R4-2：修改全局快捷键。
   * 失败时后端会回滚并给人话原因，这里把错误显示出来即可。
   */
  async function saveGlobalShortcut() {
    const next = (shortcutDraft ?? "").trim();
    if (!next) return;
    setIsSavingShortcut(true);
    try {
      await runCommand("update_global_shortcut", { shortcut: next });
      setShortcutDraft(null);
      toast.success(t("settings.feedback.shortcutSaved", "快捷键已更新"));
    } catch (error) {
      toast.error(
        toUserMessage(
          error,
          t("settings.feedback.shortcutFailed", "快捷键更新失败，请重试。"),
        ),
      );
      setShortcutDraft(null);
    } finally {
      setIsSavingShortcut(false);
    }
  }

  async function clearMyData() {
    setIsClearing(true);
    try {
      const result = await runCommand(
        "clear_my_data",
        undefined,
        {
          backupDir: "",
          cleared: [],
        },
      );
      toast.show({
        message: t(
          "settings.feedback.cleared",
          "已清空 {count} 类数据，备份在 backups 目录",
        ).replace("{count}", String(((result as { cleared: string[] } | null)?.cleared ?? []).length)),
        tone: "success",
      });
      setConfirmClear(false);
      // 记录 Tab 监听 memos-updated / chat-history-updated，会自己刷新
    } catch (error) {
      toast.error(
        toUserMessage(
          error,
          t("settings.feedback.clearFailed", "清空失败，未做任何删除。"),
        ),
      );
    } finally {
      setIsClearing(false);
    }
  }

  async function toggleAutostart() {
    try {
      if (autostartEnabled) {
        await disable();
      } else {
        await enable();
      }
      setAutostartEnabled(!autostartEnabled);
    } catch (error) {
      toast.error(
        `${t("settings.feedback.autostartSaveFailed", "开机启动设置失败")}：${toUserMessage(error)}`,
      );
    }
  }

  async function refreshNotificationStatus() {
    try {
      const status = await runCommand(
        "get_notification_status",
      );
      setNotificationDetails(status);
      setNotificationPermission(notificationPermissionLabel(status));
      setNotificationQueryError("");
    } catch (error) {
      setNotificationPermission("读取失败");
      setNotificationQueryError(toUserMessage(error, "无法读取系统通知权限。"));
    }
  }

  async function enableNotifications() {
    setNotificationBusy(true);
    try {
      const status = await runCommand(
        "request_notification_permission",
      );
      setNotificationDetails(status);
      setNotificationPermission(notificationPermissionLabel(status));
    } catch (error) {
      toast.error(
        toUserMessage(
          error,
          t(
            "settings.feedback.notificationFailed",
            "通知权限申请失败，请重试。",
          ),
        ),
      );
    } finally {
      setNotificationBusy(false);
    }
  }

  async function testNotification() {
    setNotificationBusy(true);
    try {
      await runCommand("send_test_notification");
      toast.success(
        t(
          "settings.feedback.notificationSent",
          "测试通知已提交，请检查屏幕右上角或通知中心。",
        ),
      );
    } catch (error) {
      toast.error(
        toUserMessage(
          error,
          t(
            "settings.feedback.testNotificationFailed",
            "测试通知发送失败，请重试。",
          ),
        ),
      );
    } finally {
      await refreshNotificationStatus();
      setNotificationBusy(false);
    }
  }

  async function updateAgentAutoApproveCommands(enabled: boolean) {
    setAgentAutoApproveCommands(enabled);
    setSavingCommandPermission(true);
    try {
      const next = await runCommand(
        "update_agent_auto_approve_commands",
        { enabled },
        {
          ...settings,
          agentAutoApproveCommands: enabled,
        },
      );
      applyServer(next as AppSettings);
      toast.success(
        enabled
          ? t(
              "settings.feedback.autoApproveEnabled",
              "已开启命令自动批准，下次任务起生效",
            )
          : t(
              "settings.feedback.autoApproveDisabled",
              "已恢复逐次确认，下次任务起生效",
            ),
      );
    } catch (error) {
      setAgentAutoApproveCommands(settings.agentAutoApproveCommands ?? false);
      toast.error(
        toUserMessage(
          error,
          t("settings.feedback.permissionFailed", "命令权限设置保存失败"),
        ),
      );
    } finally {
      setSavingCommandPermission(false);
    }
  }

  /** 「关于 → 重新运行引导」。门禁本身在 shell（PanelWindow），这里只负责重置。 */
  async function rerunOnboarding() {
    try {
      await runCommand("reset_onboarding", undefined, {
        ...defaultAppSettings,
        companionName,
        ai: aiSettings,
      });
      toast.success(
        t(
          "settings.feedback.onboardingReset",
          "引导已重置，重新打开面板后生效。",
        ),
      );
    } catch (error) {
      toast.error(
        `${t("settings.feedback.onboardingFailed", "重置引导失败")}：${toUserMessage(error)}`,
      );
    }
  }

  return (
    <div className="tab tab--settings">
      <SettingsGroup
        id="companion"
        icon={<PawPrint size={15} />}
        title="日常与外观"
        description="名字、形象和互动方式"
        status={`${sensingPaused ? "感知已暂停" : "感知已开启"} · ${quietModeOptions.find((option) => option.value === quietMode)?.label ?? "平衡"}`}
      >
        <div className="settings-actions settings-pet-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => void runCommand("show_pet")}
          >
            显示伙伴
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => void runCommand("hide_pet")}
          >
            隐藏伙伴
          </button>
        </div>

        <section className="panel-card">
          <div className="settings-form">
            <label>
              <span>精灵名称</span>
              <input
                value={companionName}
                maxLength={24}
                onChange={(event) =>
                  updatePreferences({
                    companionName: event.currentTarget.value,
                  })
                }
              />
            </label>
            <label>
              <span>主题色</span>
              <select
                value={theme}
                onChange={(event) =>
                  updatePreferences({
                    theme: event.currentTarget.value as Theme,
                  })
                }
              >
                <option value="sage">鼠尾草绿</option>
                <option value="blue">湖水蓝</option>
                <option value="peach">暖桃色</option>
              </select>
            </label>
            <label>
              <span>精灵形象</span>
              <select
                value={petVisualStyle}
                onChange={(event) =>
                  setPetVisualStyle(
                    event.currentTarget.value as typeof petVisualStyle,
                  )
                }
              >
                {availablePetVisualStyleOptions.map(({ label, value }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="custom-pet-picker">
              <span>
                {customPetImagePath
                  ? customPetImagePath.split(/[\\/]/).pop()
                  : "未选择自定义图片"}
              </span>
              <div>
                <button
                  type="button"
                  onClick={() => void chooseCustomPetImage()}
                >
                  选择图片
                </button>
                <button
                  type="button"
                  className="is-secondary"
                  onClick={clearCustomPetImage}
                  disabled={!customPetImagePath}
                >
                  清除
                </button>
              </div>
            </div>
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={!sensingPaused}
                onChange={(event) =>
                  updatePreferences({
                    sensingPaused: !event.currentTarget.checked,
                  })
                }
              />
              <span>主动感知</span>
            </label>
          </div>
        </section>

        <section className="panel-card">
          <h2>互动方式</h2>
          <div className="settings-form">
            <div className="segmented-control" aria-label="安静模式">
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
          </div>
        </section>
      </SettingsGroup>
      <SettingsGroup
        id="ai"
        icon={<MessageCircle size={15} />}
        title="AI 与对话"
        description="模型连接与对话偏好"
        status={settings.ai.model || "未选择模型"}
      >
        <section className="panel-card model-connection-entry">
          <div><strong>{settings.ai.model || "选择你的 AI 模型"}</strong><p>{settings.ai.baseUrl || "配置 API 连接，获取可用模型"}</p></div>
          <button type="button" onClick={() => setModelSettingsOpen(true)}>模型与 API</button>
        </section>
        {modelSettingsOpen && <ModelSettingsDialog initialTab="connection" onClose={() => setModelSettingsOpen(false)} />}
        <details className="settings-subgroup">
          <summary>语音输入</summary>
          <div className="settings-subgroup__body">
            {speechModels.length ? (
              <div className="speech-model-list">
                {speechModels.map((model) => {
                  const progress = speechModelProgress[model.id];
                  const percent =
                    progress?.percent === undefined
                      ? undefined
                      : Math.round(progress.percent * 100);
                  const isDownloading = downloadingSpeechModelId === model.id;
                  return (
                    <div className="speech-model-item" key={model.id}>
                      <div>
                        <strong>
                          {model.name}
                          {model.id === "sense-voice" ? (
                            <span className="speech-model-item__badge">
                              中文优化
                            </span>
                          ) : null}
                        </strong>
                        <span>
                          {model.downloaded
                            ? `${formatBytes(model.byteSize)} · 已下载`
                            : "未下载"}
                          {isDownloading && percent !== undefined
                            ? ` · ${percent}%`
                            : ""}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={
                          model.downloaded || Boolean(downloadingSpeechModelId)
                        }
                        onClick={() => void downloadSpeechModel(model.id)}
                      >
                        {model.downloaded
                          ? "已下载"
                          : isDownloading
                            ? "下载中..."
                            : "下载"}
                      </button>
                    </div>
                  );
                })}
                {speechModels.some(
                  (model) => model.id === "sense-voice" && !model.downloaded,
                ) ? (
                  <p className="settings-note">
                    「SenseVoice 中文优化」—— 阿里 FunAudioLLM
                    出品，专为中文设计，字错率比 Whisper
                    低一半以上，且几乎不出繁体字。
                  </p>
                ) : null}
              </div>
            ) : (
              <EmptyState
                icon={<Volume2 size={20} />}
                title="还没有可下载的语音模型"
                description="连接成功后这里会列出可用模型。"
              />
            )}
          </div>
        </details>
      </SettingsGroup>
      <SettingsGroup
        id="notify"
        icon={<BellRing size={15} />}
        title="提醒与陪伴"
        description="休息提醒、通知和主动聊天"
        status={`${breakRemindersEnabled ? "休息提醒开启" : "休息提醒关闭"} · ${breakReminderQuietHoursEnabled ? `免打扰 ${breakReminderQuietHoursStart}–${breakReminderQuietHoursEnd}` : "免打扰关闭"}`}
      >
        <section className="panel-card">
          <h2>休息提醒</h2>
          <div className="settings-form">
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={breakRemindersEnabled}
                onChange={(event) =>
                  updateWorkRhythm({
                    breakRemindersEnabled: event.currentTarget.checked,
                  })
                }
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
                  onChange={(event) =>
                    updateWorkRhythm({
                      breakReminderIntervalMinutes: Number(
                        event.currentTarget.value,
                      ),
                    })
                  }
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
                  onChange={(event) =>
                    updateWorkRhythm({
                      breakReminderCooldownMinutes: Number(
                        event.currentTarget.value,
                      ),
                    })
                  }
                />
              </label>
            </div>
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={breakReminderQuietHoursEnabled}
                onChange={(event) =>
                  updateWorkRhythm({
                    breakReminderQuietHoursEnabled: event.currentTarget.checked,
                  })
                }
              />
              <span>启用静默时段</span>
            </label>
            <div className="settings-form__row">
              <label>
                <span>静默开始</span>
                <input
                  type="time"
                  value={breakReminderQuietHoursStart}
                  onChange={(event) =>
                    updateWorkRhythm({
                      breakReminderQuietHoursStart: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                <span>静默结束</span>
                <input
                  type="time"
                  value={breakReminderQuietHoursEnd}
                  onChange={(event) =>
                    updateWorkRhythm({
                      breakReminderQuietHoursEnd: event.currentTarget.value,
                    })
                  }
                />
              </label>
            </div>
          </div>
        </section>

        <section className="panel-card">
          <h2>通知权限</h2>
          <div className="settings-form">
            <div className="settings-readonly">
              <span>系统通知</span>
              <strong>{notificationPermission}</strong>
            </div>
            {notificationPermission === "已授权" ? null : (
              <button
                type="button"
                disabled={notificationBusy || !isTauriRuntime}
                onClick={() => void enableNotifications()}
              >
                去开启
              </button>
            )}
            <button
              type="button"
              disabled={!isTauriRuntime}
              onClick={() =>
                void runCommand("open_notification_settings").catch((error) =>
                  toast.error(toUserMessage(error)),
                )
              }
            >
              打开系统通知设置
            </button>
            <details className="settings-subgroup">
              <summary>通知排查</summary>
              <div className="settings-subgroup__body">
                <div className="settings-actions">
                  <button
                    type="button"
                    disabled={notificationBusy || !isTauriRuntime}
                    onClick={() => void testNotification()}
                  >
                    发送测试通知
                  </button>
                  <button
                    type="button"
                    disabled={notificationBusy || !isTauriRuntime}
                    onClick={() => void refreshNotificationStatus()}
                  >
                    重新检查权限
                  </button>
                </div>
              </div>
            </details>
            {notificationQueryError ? (
              <p role="alert" className="settings-note">
                {notificationQueryError}
              </p>
            ) : null}
            {notificationDetails?.lastError ? (
              <p role="alert" className="settings-note">
                最近发送失败：{notificationDetails.lastError}
              </p>
            ) : null}
            <p className="settings-note">
              若已授权但未出现横幅，请在系统通知设置中为 Piko
              开启横幅，并检查专注模式与通知摘要。
            </p>
          </div>
        </section>
        <details className="settings-subgroup">
          <summary>主动聊天与人格</summary>
          <div className="settings-subgroup__body">
            <SoulSettings />
          </div>
        </details>
      </SettingsGroup>
      <SettingsGroup
        id="system"
        icon={<ShieldCheck size={15} />}
        title="系统与数据"
        description="启动、快捷键、备份与更新"
        status={`${autostartEnabled ? "开机启动开启" : "开机启动关闭"} · 备份与权限`}
      >
        <section className="panel-card">
          <h2>命令执行权限</h2>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={agentAutoApproveCommands}
              disabled={savingCommandPermission}
              onChange={(event) =>
                void updateAgentAutoApproveCommands(event.currentTarget.checked)
              }
            />
            <span>始终自动批准命令执行</span>
          </label>
          <p className="settings-note">
            开启后，Shell
            命令直接执行，无需逐次确认，下次任务起生效，重启后仍保留。执行详情与停止按钮仍可用；文件读写、备忘录、日历和提醒保留原有确认规则。
          </p>
        </section>

        <section className="panel-card">
          <h2>开机与驻留</h2>
          <div className="settings-form">
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={autostartEnabled}
                onChange={() => void toggleAutostart()}
              />
              <span>开机自动启动</span>
            </label>
          </div>
        </section>

        <section className="panel-card">
          <h2>全局快捷键</h2>
          <div className="settings-form">
            <label>
              <span>打开对话窗口</span>
              <input
                value={shortcutDraft ?? settings.globalShortcut}
                onChange={(event) =>
                  setShortcutDraft(event.currentTarget.value)
                }
                placeholder="CmdOrCtrl+Shift+Space"
                aria-label="全局快捷键"
              />
            </label>
            {shortcutDraft !== null &&
            shortcutDraft !== settings.globalShortcut ? (
              <div className="settings-subgroup">
                <button
                  type="button"
                  onClick={() => void saveGlobalShortcut()}
                  disabled={isSavingShortcut}
                >
                  {isSavingShortcut ? "保存中…" : "保存快捷键"}
                </button>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => setShortcutDraft(null)}
                >
                  取消
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel-card">
          <h2>清空我的数据</h2>
          <div className="settings-form">
            <p className="settings-note">
              清空提醒、日程、备忘、对话与专注记录。会先自动备份，可从 backups
              目录找回。设置与 Piko 记住的内容不受影响。
            </p>
            {confirmClear ? (
              <div className="settings-subgroup">
                <button
                  type="button"
                  disabled={isClearing}
                  onClick={() => void clearMyData()}
                >
                  {isClearing ? "清空中…" : "确认清空"}
                </button>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => setConfirmClear(false)}
                >
                  取消
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmClear(true)}>
                清空我的数据…
              </button>
            )}
          </div>
        </section>
        <details className="settings-subgroup">
          <summary>备份与恢复</summary>
          <div className="settings-subgroup__body">
            <DataSettings />
          </div>
        </details>
        <details className="settings-subgroup">
          <summary>关于与更新</summary>
          <div className="settings-subgroup__body">
            <VersionSettings />

            <section className="panel-card">
              <h2>重新运行引导</h2>
              <div className="settings-form">
                <button type="button" onClick={() => void rerunOnboarding()}>
                  重新运行引导
                </button>
              </div>
            </section>
          </div>
        </details>
      </SettingsGroup>
    </div>
  );
}
